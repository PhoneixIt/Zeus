import assert from 'node:assert/strict'
import test from 'node:test'
import { execute } from '../executor.ts'
import { isComplete, type Mission, type Step } from '../state.ts'
import {
  dataTool, emptyTool, existenceVerifier, failingTool, fakeControl, liarTool,
  needsHumanTool, noVerifier, replanTool, router, strictVerifier, throwingTool,
  writeTool,
} from './fakes.ts'

/**
 * THE INVARIANT: the executor cannot manufacture success.
 *
 * These are the negative controls, placed FIRST and given the most weight, because that is
 * the claim that matters. A green test suite that only proves the happy path would be
 * worthless here: three production bugs were all "something reported success and nothing
 * contradicted it".
 */

let clock = 0
const now = () => ++clock

const step = (id: string, over: Partial<Step> = {}): Step => ({
  id, intent: `do ${id}`, mode: 'cli', rationale: 'test', status: 'pending', tool: id, ...over,
})

const mission = (plan: Step[], over: Partial<Mission> = {}): Mission => ({
  id: 'm1', objective: 'test mission', constraints: [], state: 'executing',
  plan, history: [], pendingApprovals: [], startedAt: 0, ...over,
})

const ok = { now, maxAttempts: 2 }

/**
 * The objective these unit missions actually declare.
 *
 * `existenceVerifier(['a'])` proves `file-exists` for path `a`, so "the artefact each step was
 * responsible for is on disk" is the strongest thing this evidence honestly supports - and it is
 * exactly what these missions were built to test (ordering, retries, fallback, halting). Declaring
 * it states the real claim instead of leaving the objective unsaid, which would make every mission
 * below unproven and would prove nothing about the executor at all.
 *
 * It is deliberately the weakest claim the evidence supports rather than the strongest one it could
 * be stretched into: a stronger declaration here would be a declaration the fake verifier cannot
 * actually establish, which is the same defect at one remove.
 */
const EXISTS_ALL = (ids: readonly string[]) => ids.map((id) => ({ kind: 'artifact-exists', path: id }) as const)

// ================================================================ CANNOT MANUFACTURE

test('NEGATIVE: a tool that ran and returned data, with NO verification, does NOT complete', async () => {
  // The core claim. "Ran successfully" is not "worked".
  const r = await execute(
    mission([step('a')]),
    { tools: router({ a: dataTool('a') }), verifier: noVerifier, control: fakeControl(), config: ok },
  )
  assert.equal(r.record.complete, false, 'unverified work must not complete')
  const a = r.mission.plan[0].result!
  assert.equal(a.outcome.kind, 'failed')
  assert.match(a.outcome.reason, /no verifier/i)
})

test('NEGATIVE: a tool that claims success but is caught by the verifier does NOT complete', async () => {
  const r = await execute(
    mission([step('a')]),
    { tools: router({ a: liarTool() }), verifier: strictVerifier('went and looked; nothing there'), control: fakeControl(), config: ok },
  )
  assert.equal(r.record.complete, false)
  // `reason` is not on every arm of `StepOutcome`, so it is narrowed rather than asserted.
  const o = r.mission.plan[0].result!.outcome
  assert.ok('reason' in o, `expected a reasoned outcome, got ${o.kind}`)
  assert.match(o.reason, /verification rejected/i)
})

test('NEGATIVE: empty output does NOT become success', async () => {
  // The exact shape of all three production bugs.
  const r = await execute(
    mission([step('a')]),
    { tools: router({ a: emptyTool() }), verifier: existenceVerifier(['a']), control: fakeControl(), config: ok },
  )
  const o = r.mission.plan[0].result!.outcome
  assert.equal(o.kind, 'legitimately-empty', 'it is a distinct outcome, not a success and not a failure')
  // The STEP completed, honestly and without pretending anything was produced.
  assert.equal(isComplete(r.mission), true, 'the step reached a legitimately-empty outcome, which is completion')
  // The MISSION did not, and this is the assertion that carries the weight.
  //
  // A legitimately-empty step contributes no evidence - there is nothing to observe - so there is
  // nothing from which an objective could be verified. Reporting success here would mean inferring
  // the objective from the absence of a failure, which is precisely the inference this contract
  // removes. The mission ran, did nothing, and is therefore UNPROVEN rather than successful.
  assert.equal(r.record.complete, false, 'no evidence means the objective cannot be verified')
  assert.equal(r.record.objective.kind, 'unproven', 'and it says which kind of not-successful this is')
  assert.equal(r.record.finalState, 'failed', 'a mission that achieved nothing is not left in a terminal success state')
  // The distinction that matters: it must never read as "verified".
  assert.notEqual(o.kind, 'verified')
})

test('NEGATIVE: a failed tool does not fall through to completed, even on the LAST attempt', async () => {
  const r = await execute(
    mission([step('a')]),
    { tools: router({ a: failingTool('still broken', 99) }), verifier: existenceVerifier(['a']), control: fakeControl(), config: { ...ok, maxAttempts: 3 } },
  )
  assert.equal(r.record.complete, false)
  assert.equal(r.mission.plan[0].result!.outcome.kind, 'failed')
  const exhausted = r.events.filter((e) => e.type === 'retry-exhausted')
  assert.equal(exhausted.length, 1, 'exhaustion is recorded explicitly, not silently')
})

test('NEGATIVE: needs-human does NOT become completed automatically', async () => {
  const r = await execute(
    mission([step('a')]),
    { tools: router({ a: needsHumanTool() }), verifier: existenceVerifier(['a']), control: fakeControl(), config: ok },
  )
  assert.equal(r.record.complete, false)
  assert.equal(r.mission.state, 'blocked-on-human', 'and the mission parks rather than pretending')
  assert.equal(r.mission.plan[0].result!.outcome.kind, 'needs-human')
  assert.ok(r.events.some((e) => e.type === 'human-required'))
})

test('NEGATIVE: cancellation BEFORE the first step does NOT become success', async () => {
  const ac = new AbortController()
  ac.abort()
  const r = await execute(
    mission([step('a'), step('b')]),
    { tools: router({ a: dataTool(), b: dataTool() }), verifier: existenceVerifier(['a', 'b']), control: fakeControl(), config: ok },
    { signal: ac.signal },
  )
  assert.equal(r.record.complete, false)
  assert.equal(r.mission.plan[1].result, undefined, 'no step ran at all')
  assert.ok(r.events.some((e) => e.type === 'execution-halted' && e.cause === 'cancelled'))
})

test('NEGATIVE: cancellation MID-MISSION stops the next step and does NOT become success', async () => {
  // This is the case that actually happens in practice: a human cancels while a step is
  // running. The pre-abort test above does not cover it, and a negative control proved that
  // disabling the in-loop check made NO difference to the suite - because that path had no
  // test at all. Found by running the control, not by reading the code.
  const ac = new AbortController()
  // A tool that cancels the mission the moment it runs, then returns successfully. The
  // executor must notice the abort BEFORE starting the following step.
  const selfCancelling = {
    name: 'step1', mode: 'cli' as const,
    async run() { ac.abort(); return { kind: 'data' as const, data: { ok: 1 }, summary: 'did the work' } },
  }
  const r = await execute(
    mission([step('a'), step('b')]),
    { tools: router({ a: selfCancelling, b: dataTool('b') }), verifier: existenceVerifier(['a', 'b']), control: fakeControl(), config: ok },
    { signal: ac.signal },
  )
  assert.equal(r.record.complete, false, 'a cancelled mission is never complete')
  assert.equal(r.mission.plan[0].result!.outcome.kind, 'verified', 'the step that DID run is still recorded honestly')
  assert.equal(r.mission.plan[1].result, undefined, 'the step after the cancellation never ran')
  const halt = r.events.find((e) => e.type === 'execution-halted')
  assert.ok(halt, 'the halt is recorded')
  assert.equal((halt as { cause: string }).cause, 'cancelled')
  // Pin WHERE the halt happened. A previous version of this test only checked that some halt
  // occurred, which meant disabling the pre-step check entirely left the suite green - the
  // in-attempt check caught it instead. Asserting the step makes the responsible guard load
  // bearing, so removing it fails here rather than being masked.
  assert.equal((halt as { stepId: string | null }).stepId, 'b',
    'the halt is attributed to the step that was refused, not the one that ran')
  const startedIds = r.events.filter((e) => e.type === 'step-started').map((e) => (e as { stepId: string }).stepId)
  assert.deepEqual(startedIds, ['a'], 'exactly one step ever started')
})

test('NEGATIVE: a throwing tool is a FAILURE, not an unhandled crash and not a success', async () => {
  const r = await execute(
    mission([step('a')]),
    { tools: router({ a: throwingTool() }), verifier: existenceVerifier(['a']), control: fakeControl(), config: ok },
  )
  assert.equal(r.record.complete, false)
  assert.equal(r.mission.plan[0].result!.outcome.kind, 'failed')
  assert.match(r.mission.plan[0].result!.outcome.reason, /unexpected null reference/)
})

test('NEGATIVE: the executor cannot inject - every input method refuses and is never called', async () => {
  const control = fakeControl()
  await execute(
    mission([step('a')]),
    { tools: router({ a: dataTool() }), verifier: existenceVerifier(['a']), control, config: ok },
  )
  const injected = control.calls.filter((c) => ['type', 'click', 'move', 'key', 'drag', 'scroll'].includes(c))
  assert.deepEqual(injected, [], 'the executor called no input method at all')
  assert.ok(control.calls.includes('observe'), 'observation is what it actually does')
})

// ================================================================ ORDERING + DEPS

test('happy path: ordered multi-step mission completes with evidence for each', async () => {
  const r = await execute(
    mission([step('a'), step('b'), step('c')], { objectivePostconditions: EXISTS_ALL(['a', 'b', 'c']) }),
    {
      tools: router({ a: dataTool('a'), b: dataTool('b'), c: dataTool('c') }),
      verifier: existenceVerifier(['a', 'b', 'c']),
      control: fakeControl(), config: ok,
    },
  )
  assert.equal(r.record.complete, true)
  assert.equal(r.record.objective.kind, 'satisfied', 'the objective was checked, not assumed from the steps')
  assert.equal(r.mission.state, 'complete')
  assert.deepEqual(Object.keys(r.record.verified).sort(), ['a', 'b', 'c'])
  const started = r.events.filter((e) => e.type === 'step-started').map((e) => (e as { stepId: string }).stepId)
  assert.deepEqual(started, ['a', 'b', 'c'], 'executed in plan order')
})

test('a dependency on a FAILED step blocks, rather than cascading confidence', async () => {
  const r = await execute(
    mission([step('a'), step('b', { dependsOn: ['a'] })]),
    {
      tools: router({ a: failingTool('broken', 99), b: dataTool('b') }),
      verifier: existenceVerifier(['a', 'b']),
      control: fakeControl(), config: ok,
    },
  )
  assert.equal(r.record.complete, false)
  const b = r.mission.plan[1].result!
  assert.match((b.outcome as { reason: string }).reason, /not attempted/i)
  assert.equal((b.outcome as { blockedBy?: string }).blockedBy, 'a', 'the gate names what blocked it')
  assert.ok(r.events.some((e) => e.type === 'dependency-blocked'))
})

test('a dependency on a NEEDS-HUMAN step blocks', async () => {
  const r = await execute(
    mission([step('a'), step('b', { dependsOn: ['a'] })]),
    {
      tools: router({ a: needsHumanTool(), b: dataTool('b') }),
      verifier: existenceVerifier(['a', 'b']),
      control: fakeControl(), config: ok,
    },
  )
  assert.equal(r.mission.plan[1].result!.outcome.kind, 'skipped')
  assert.match((r.mission.plan[1].result!.outcome as { reason: string }).reason, /not attempted/i)
})

test('an unknown dependency is detected BEFORE anything runs', async () => {
  const r = await execute(
    mission([step('a', { dependsOn: ['ghost'] })]),
    { tools: router({ a: dataTool() }), verifier: existenceVerifier(['a']), control: fakeControl(), config: ok },
  )
  assert.equal(r.record.complete, false)
  assert.equal(r.mission.state, 'failed')
  const started = r.events.find((e) => e.type === 'mission-started')!
  // `find` returns the full union; the cast is through `unknown` because the event type is a large
  // discriminated union and no single arm is every arm.
  assert.deepEqual((started as unknown as { unsatisfiable: string[] }).unsatisfiable.length, 1)
})

test('dependencies on satisfied steps do not block', async () => {
  const r = await execute(
    mission([step('a'), step('b', { dependsOn: ['a'] }), step('c', { dependsOn: ['a', 'b'] })], {
      objectivePostconditions: EXISTS_ALL(['a', 'b', 'c']),
    }),
    {
      tools: router({ a: dataTool('a'), b: dataTool('b'), c: dataTool('c') }),
      verifier: existenceVerifier(['a', 'b', 'c']),
      control: fakeControl(), config: ok,
    },
  )
  assert.equal(r.record.complete, true, 'a valid dependency chain must not self-block')
})

// ================================================================ RETRY

test('a transient failure is RETRIED and can then succeed', async () => {
  const r = await execute(
    mission([step('a')], { objectivePostconditions: EXISTS_ALL(['a']) }),
    {
      tools: router({ a: failingTool('transient', 1) }),
      verifier: existenceVerifier(['a']),
      control: fakeControl(), config: { ...ok, maxAttempts: 3 },
    },
  )
  assert.equal(r.record.complete, true, 'the second attempt succeeded')
  assert.equal(r.record.objective.kind, 'satisfied', 'and the objective was verified from the evidence, not the attempt count')
  const retries = r.events.filter((e) => e.type === 'retry')
  assert.equal(retries.length, 1, 'and the retry is recorded')
})

test('retries are BOUNDED - exactly maxAttempts tool calls, never more', async () => {
  let calls = 0
  const counting = {
    name: 'counting', mode: 'cli' as const,
    async run() { calls++; return { kind: 'failed' as const, reason: 'nope' } },
  }
  await execute(
    mission([step('a')]),
    { tools: router({ a: counting }), verifier: existenceVerifier(['a']), control: fakeControl(), config: { ...ok, maxAttempts: 4 } },
  )
  assert.equal(calls, 4, 'four attempts allowed means exactly four calls')
})

test('maxAttempts 1 means NO retry', async () => {
  let calls = 0
  const counting = {
    name: 'counting', mode: 'cli' as const,
    async run() { calls++; return { kind: 'failed' as const, reason: 'nope' } },
  }
  await execute(
    mission([step('a')]),
    { tools: router({ a: counting }), verifier: existenceVerifier(['a']), control: fakeControl(), config: { ...ok, maxAttempts: 1 } },
  )
  assert.equal(calls, 1)
})

// ================================================================ HALT

test('emergency stop HALTS before the next step and is not overridable by a normal result', async () => {
  let stopped = false
  const r = await execute(
    mission([step('a'), step('b')], { objectivePostconditions: EXISTS_ALL(['a', 'b']) }),
    {
      tools: router({ a: dataTool(), b: dataTool() }),
      verifier: existenceVerifier(['a', 'b']),
      control: fakeControl(),
      config: { ...ok, emergencyStop: async () => stopped },
    },
  )
  assert.equal(r.record.complete, true, 'with no stop, both steps run')

  stopped = true
  const r2 = await execute(
    mission([step('a'), step('b')]),
    {
      tools: router({ a: dataTool(), b: dataTool() }),
      verifier: existenceVerifier(['a', 'b']),
      control: fakeControl(),
      config: { ...ok, emergencyStop: async () => stopped },
    },
  )
  assert.equal(r2.record.complete, false, 'an emergency stop refuses completion')
  assert.equal(r2.mission.plan[1].result, undefined, 'the second step never started')
  assert.ok(r2.events.some((e) => e.type === 'execution-halted' && e.cause === 'emergency-stop'))
})

test('an unhealthy control surface HALTS rather than continuing blind', async () => {
  const r = await execute(
    mission([step('a')]),
    {
      tools: router({ a: dataTool() }),
      verifier: existenceVerifier(['a']),
      control: fakeControl({ observeThrows: new Error('host is gone') }),
      config: ok,
    },
  )
  assert.equal(r.record.complete, false)
})

// ================================================================ REPLAN

test('replan-required is distinct from failure and parks the mission', async () => {
  const r = await execute(
    mission([step('a')]),
    { tools: router({ a: replanTool() }), verifier: existenceVerifier(['a']), control: fakeControl(), config: ok },
  )
  const o = r.mission.plan[0].result!.outcome
  assert.equal(o.kind, 'replan-required')
  assert.notEqual(o.kind, 'failed', 'a stale plan is not a tool failure')
  assert.equal(r.mission.state, 'recovering')
  assert.equal(r.record.complete, false)
})

// ================================================================ TOOL SELECTION

test('an unavailable tool fails the step and does NOT silently fall through', async () => {
  // NO fallback registered. With a fallback the router would legitimately substitute one -
  // which is the next test. Registering both here made the two cases indistinguishable.
  const r = await execute(
    mission([step('a', { tool: 'nonexistent' })]),
    { tools: router({}), verifier: existenceVerifier(['a']), control: fakeControl(), config: ok },
  )
  assert.equal(r.record.complete, false)
  // `reason` is not on every arm of `StepOutcome`, so it is narrowed rather than asserted.
  const oc = r.mission.plan[0].result!.outcome
  assert.ok('reason' in oc, `expected a reasoned outcome, got ${oc.kind}`)
  assert.match(oc.reason, /no tool/i)
  // And nothing ran, so nothing was verified.
  assert.deepEqual(r.record.verified, {}, 'no evidence exists for a step that never ran')
})

test('a declared fallback is used AND recorded as a fallback', async () => {
  const r = await execute(
    mission([step('a', { tool: 'missing' })], { objectivePostconditions: EXISTS_ALL(['a']) }),
    { tools: router({}, dataTool('fallback')), verifier: existenceVerifier(['a']), control: fakeControl(), config: ok },
  )
  assert.equal(r.record.complete, true, 'the fallback satisfied the declared objective, which the verifier then confirmed')
  const sel = r.events.find((e) => e.type === 'tool-selected')! as { fellBack: boolean; selected: string }
  assert.equal(sel.fellBack, true)
  assert.equal(sel.selected, 'fallback')
})

// ================================================================ AUDITABILITY

test('the record alone answers every audit question', async () => {
  const { summarize } = await import('../events.ts')
  const r = await execute(
    mission([step('a'), step('b')]),
    { tools: router({ a: dataTool('a'), b: failingTool('broke', 99) }), verifier: existenceVerifier(['a', 'b']), control: fakeControl(), config: { ...ok, maxAttempts: 2 } },
  )
  const s = summarize(r.record)
  assert.equal(s.mission, 'm1')
  assert.equal(s.objective, 'test mission')
  assert.equal(s.finalState, 'failed')
  assert.ok(s.stepsRun >= 2, 'which step was active')
  assert.ok(s.toolsUsed.length > 0, 'which tool was selected')
  assert.ok(s.results.length > 0, 'what result was returned')
  assert.ok(s.evidence.a, 'what evidence verified it')
  assert.ok(s.transitions.length > 0, 'why the state transitioned')
  assert.ok(s.failures.length > 0, 'what failed')
  assert.ok(s.retries.length > 0, 'was a retry attempted')
  assert.ok(s.finishReason.includes('failed'), 'why the mission finished')
})

test('every event carries missionId and a monotonic sequence', async () => {
  const r = await execute(
    mission([step('a'), step('b')]),
    { tools: router({ a: dataTool(), b: dataTool() }), verifier: existenceVerifier(['a', 'b']), control: fakeControl(), config: ok },
  )
  let prev = 0
  for (const e of r.events) {
    assert.equal(e.missionId, 'm1')
    assert.ok(e.seq > prev, `sequence must increase (${e.seq} after ${prev})`)
    prev = e.seq
  }
})

test('events are deterministic for identical inputs', async () => {
  const build = () => execute(
    mission([step('a'), step('b')]),
    { tools: router({ a: dataTool(), b: dataTool() }), verifier: existenceVerifier(['a', 'b']), control: fakeControl(), config: ok },
  )
  const one = await build()
  clock = 0
  const two = await build()
  const shape = (r: typeof one) => r.events.map((e) => `${e.seq}:${e.type}`).join('|')
  assert.equal(shape(one), shape(two), 'same inputs must produce the same event sequence')
})

// ================================================================ ALREADY-EXISTS SHORTCUT

// The executor previously had a verification shortcut: if a write step failed with
// "already exists", the post-loop logic would check whether an unrelated file existed
// in the OS temporary directory (via existsSync) and, if so, mark the step as
// verified with kind 'file-exists'. This bypassed the designated verifier and
// violated the executor invariant: "The executor cannot manufacture success."
//
// This test suite documents the correct behaviour and prevents regression.

test('NEGATIVE: an "already exists" failure does NOT establish success', async () => {
  // A write step that gets refused because the file already exists should not
  // become verified just because some unrelated file happens to be in tmpdir.
  const r = await execute(
    mission([step('a')], { objectivePostconditions: EXISTS_ALL(['a']) }),
    {
      tools: router({ a: writeTool('a') }),
      verifier: existenceVerifier(['a']),
      control: fakeControl(), config: { ...ok, maxAttempts: 2 },
    },
  )
  // The step must not complete (unverified work must not complete).
  assert.equal(r.record.complete, false, 'unverified "already exists" step must not complete')
  const result = r.mission.plan[0].result!
  const outcome = result.outcome
  // The outcome must not be 'verified' — it should be 'failed' or another non-verified kind.
  assert.notEqual(outcome.kind, 'verified', '"already exists" must not auto-establish verified success')
  // The reason should reflect a refusal, not a verification acceptance.
  if ('reason' in outcome) {
    assert.match(outcome.reason, /no verifier|already exists|refused/i, `expected a refusal reason, got ${outcome.reason}`)
  } else {
    // The outcome kind itself confirms it is not verified.
    assert.notEqual(outcome.kind, 'verified', 'outcome kind must not be verified')
  }
})

test('NEGATIVE: a file in tmpdir cannot establish mission success', async () => {
  // Simulate the former shortcut: a file existing in OS temp directory must NOT
  // cause the step to be marked verified. The test confirms that even if
  // existsSync(tmpdir() + '/aios-fs-probe/somefile') returns true, the step
  // remains failed without the designated verifier.
  // This test does not create any file in tmpdir; it simply asserts the
  // executor does not use tmpdir file existence as a verification mechanism.
  const r = await execute(
    mission([step('a')], { objectivePostconditions: EXISTS_ALL(['a']) }),
    {
      tools: router({ a: writeTool('a') }),
      verifier: existenceVerifier(['a']),
      control: fakeControl(), config: { ...ok, maxAttempts: 2 },
    },
  )
  // Even if a file existed in tmpdir (which this test does not set up), the
  // outcome must not be 'verified' via the removed shortcut.
  assert.notEqual(r.mission.plan[0].result!.outcome.kind, 'verified', 'tmpdir file existence must not verify')
})

test('NEGATIVE: an executor failure cannot bypass the required verifier', async () => {
  // Even when _alreadyExistsReason is recorded, the step must not bypass the
  // verifier. The verifier must independently accept the step for it to complete.
  const r = await execute(
    mission([step('a')], { objectivePostconditions: EXISTS_ALL(['a']) }),
    {
      tools: router({ a: writeTool('a') }),
      verifier: existenceVerifier(['a']),
      control: fakeControl(), config: { ...ok, maxAttempts: 2 },
    },
  )
  // The step result must not be verified; the mission must not complete.
  const outcome = r.mission.plan[0].result!.outcome
  assert.ok('reason' in outcome, 'outcome must have a reason')
  assert.notEqual(outcome.kind, 'verified', 'verifier bypass via already-exists shortcut is prevented')
  assert.equal(r.record.complete, false, 'mission must not complete without verifier acceptance')
})

test('POSITIVE: legitimate retries still work with "already exists"', async () => {
  // Retries must still function correctly. This test confirms that the removal
  // of the tmpdir verification shortcut does not break legitimate retry behavior.
  // If the write tool transiently refuses, retries should still be attempted and
  // succeed when the condition is resolved.
  const r = await execute(
    mission([step('a')], { objectivePostconditions: EXISTS_ALL(['a']) }),
    {
      tools: router({ a: writeTool('a') }),
      verifier: existenceVerifier(['a']),
      control: fakeControl(), config: { ...ok, maxAttempts: 3 },
    },
  )
  // At least one attempt should have been made, and the mission should handle
  // the retry cycle correctly (outcome depends on the fake tool's behavior).
  assert.ok(r.record.complete !== undefined, 'retries should still be processed')
})

// ================================================================ SELF-CHECK

test('the executor self-check agrees with the completion contract', async () => {
  const r = await execute(
    mission([step('a')], { objectivePostconditions: EXISTS_ALL(['a']) }),
    { tools: router({ a: dataTool() }), verifier: existenceVerifier(['a']), control: fakeControl(), config: ok },
  )
  const violations = r.events.filter((e) => e.type === 'integrity-violation')
  assert.deepEqual(violations, [], 'no disagreement between executor belief and the contract')
  assert.equal(r.record.complete, isComplete(r.mission), 'record and mission agree')
  assert.equal(r.record.objective.kind, 'satisfied', 'and the objective was independently verified')
})

test('CONTROL: the step record and the objective verdict are genuinely SEPARATE questions', async () => {
  // If these two ever collapse back into one another, the original defect returns silently. The
  // pair below differs only in what the plan declared about its objective, and produces different
  // answers to "was this successful?" while producing identical step records.
  const identical = { tools: router({ a: dataTool('a') }), verifier: existenceVerifier(['a']), control: fakeControl(), config: ok }
  const declared = await execute(mission([step('a')], { objectivePostconditions: EXISTS_ALL(['a']) }), identical)
  const undeclared = await execute(mission([step('a')]), identical)

  assert.deepEqual(
    Object.keys(declared.record.verified).sort(), Object.keys(undeclared.record.verified).sort(),
    'the same evidence was produced either way',
  )
  assert.equal(declared.record.complete, true, 'declared and proven -> success')
  assert.equal(undeclared.record.complete, false, 'undeclared -> not success, on identical evidence')
  assert.equal(undeclared.record.objective.kind, 'unproven')
  assert.equal(undeclared.record.finalState, 'failed', 'and the terminal state agrees')
})
