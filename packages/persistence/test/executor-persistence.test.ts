/**
 * M16 CONTROLS - the executor against the REAL durable store.
 *
 * =============================================================================
 * WHAT IS ACTUALLY EXERCISED
 * =============================================================================
 *
 * The real `execute()` from `mission-engine`, the real `DurableStore` on a real file, and a real
 * `StoreRecorder`. The only things injected are the tool (a fake world), the verifier, and - for the
 * failure controls - the transition at which the store is made to refuse.
 *
 * That last one matters. A test that proves "persistence failures are handled" using a mock store is
 * proving that the mock was handled. Here the store is told to throw at a named transition, and the
 * question asked is what the MACHINE is thought to have done.
 *
 * =============================================================================
 * THE CENTRAL CLAIM BEING TESTED
 * =============================================================================
 *
 *   A TOOL FAILURE AND A PERSISTENCE FAILURE ARE DIFFERENT THINGS.
 *
 * Specifically: when the real action has happened and the record of it cannot be written, the step must
 * NOT become `failed`. It must become `outcome-unknown` - not complete, not retryable - because
 * `failed` means "this did not take effect" and that reading is what turns a lost record into a
 * duplicated action.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { execute } from '../../mission-engine/executor.ts'
import type { Tool, ToolContext, Verifier, ToolRouter, ExecuteResult } from '../../mission-engine/executor.ts'
import type { Mission, Step, Evidence, StepOutcome } from '../../mission-engine/state.ts'
import { isComplete, isRetryable, uncertainSteps } from '../../mission-engine/state.ts'
import { DurableStore } from '../store.ts'
import { StoreRecorder } from '../recorder.ts'
import { resumeMission } from '../recover.ts'
import { fakeControl } from '../../mission-engine/test/fakes.ts'

// ---------------------------------------------------------------- the fake world

/** Every side effect the fake world performs, so a control can ask what really happened. */
interface World {
  acted: string[]
  attempted: string[]
  reset(): void
}

function makeWorld(): World {
  const w: World = {
    acted: [],
    attempted: [],
    reset() { w.acted.length = 0; w.attempted.length = 0 },
  }
  return w
}

/** A tool that performs a REAL side effect on the fake world, and can be told to fail before/after. */
function actingTool(world: World, name: string, opts: { failBefore?: boolean } = {}): Tool {
  return {
    name,
    async run(_ctx: ToolContext, args: Record<string, unknown>) {
      const label = `${name}:${String(args.path ?? args.target ?? 'x')}`
      world.attempted.push(label)
      if (opts.failBefore) return { kind: 'failed' as const, reason: 'tool refused before acting' }
      world.acted.push(label)          // <-- THE MACHINE CHANGES HERE, irreversibly
      return { kind: 'data' as const, summary: `wrote ${label}`, data: { label, bytes: 10 } }
    },
  }
}

/** A verifier that looks at the world independently. It is not the tool and never asks the tool. */
const lookingVerifier: Verifier = {
  verifies: () => true,
  async verify(step: Step, _ctx: ToolContext, _toolData: unknown) {
    const path = String((step.args ?? {}).path ?? '')
    return { evidence: { kind: 'file-exists', path, bytes: 10 } satisfies Evidence }
  },
}

function routerFor(tool: Tool): ToolRouter {
  return { resolve: () => ({ tool, fellBack: false, reason: 'the only registered tool for this step' }) }
}

function missionOf(id = 'm1'): Mission {
  return {
    id,
    objective: 'write a summary file',
    constraints: ['read-only on the source'],
    state: 'executing',
    plan: [{
      id: 'write',
      intent: 'write the summary',
      mode: 'filesystem',
      tool: 'write-summary',
      rationale: 'the objective asks for a file',
      args: { path: 'C:\\out\\summary.txt' },
      dependsOn: [],
      status: 'pending',
      attempts: 0,
    }],
    history: [],
    pendingApprovals: [],
    startedAt: 1_700_000_000_000,
    proposalDigest: 'digest-1',
  }
}

function tmpDb(): string {
  return join(mkdtempSync(join(tmpdir(), 'aios-m16-')), 'history.sqlite')
}

function bestEffortRemove(p: string): void {
  try { rmSync(p.replace(/[\\/][^\\/]+$/, ''), { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) } catch { /* the OS still holds it */ }
}

/**
 * Run the real executor against the fake world and the real store.
 *
 * The dependency shape is `{ tools, verifier, control, config }` - `tools` is the Router and the rest
 * of the executor's knobs live under `config`. An earlier version of this file passed a flat
 * `{ router, permission, emergencyStop, recorder }`, and every test failed with
 * "Cannot read properties of undefined (reading 'preflight')" - a shape mistake reported as an
 * internal error, which is the least helpful possible message.
 *
 * The project's own `fakeControl()` is used rather than a fourth hand-rolled control surface.
 */
async function run(opts: {
  world: World
  store: DurableStore
  recorder?: StoreRecorder
  tool?: Tool
  mission?: Mission
  maxAttempts?: number
}): Promise<ExecuteResult> {
  const tool = opts.tool ?? actingTool(opts.world, 'write-summary')
  const mission = opts.mission ?? missionOf()
  return execute(
    mission,
    {
      tools: routerFor(tool),
      verifier: lookingVerifier,
      control: fakeControl(),
      config: {
        maxAttempts: opts.maxAttempts ?? 3,
        recorder: opts.recorder,
        now: (() => { let t = 1_700_000_000_000; return () => (t += 10) })(),
      },
    },
    // The reviewed digest, which MUST match the one the mission was compiled from.
    //
    // The first version of this file omitted it, so the executor took its earliest exit - the digest
    // check - and refused with "the proposal that was reviewed is undefined". Every test then failed
    // with an empty store and a world nothing had touched. The refusal was entirely correct; the test
    // was claiming to review a plan it had not reviewed.
    { reviewedProposalDigest: mission.proposalDigest },
  )
}

// ============================================================================================
// THE HAPPY PATH: durable recording actually happens
// ============================================================================================

test('a real mission is durably recorded: write-ahead, outcome, evidence, result, ending', async () => {
  const path = tmpDb()
  try {
    const store = new DurableStore({ path, sessionId: 'S1' })
    const world = makeWorld()
    const recorder = new StoreRecorder(store)

    const res = await run({ world, store, recorder })
    assert.equal(res.record.complete, true, 'the mission should complete')
    assert.deepEqual(world.acted, ['write-summary:C:\\out\\summary.txt'])

    const r = store.readMission('m1')!
    const h = store.readHistory('m1').map((e) => e.summary)

    // Write-ahead must be present BEFORE the outcome, in order.
    const begin = h.findIndex((s) => /BEGINNING \(write-ahead\)/.test(s))
    const outcome = h.findIndex((s) => /returned data/.test(s))
    assert.ok(begin >= 0, 'the write-ahead intent must be recorded')
    assert.ok(outcome > begin, 'the write-ahead must be recorded BEFORE the outcome')
    assert.equal(r.evidence.length, 1, 'the verified evidence must be durable')
    assert.match(r.evidence[0].provenance, /^verifier:/, 'with its provenance')
    assert.equal(r.evidence[0].observedInSession, 'S1')
    assert.ok(h.some((s) => /recorded as verified/.test(s)), 'the derived result must be durable')
    assert.ok(h.some((s) => /mission ended: complete/.test(s)), 'the ending must be durable')
    store.close()
  } finally { bestEffortRemove(path) }
})

test('the durable record, not the in-memory mission, is what survives - and they agree', async () => {
  const path = tmpDb()
  try {
    const store = new DurableStore({ path, sessionId: 'S1' })
    const world = makeWorld()
    await run({ world, store, recorder: new StoreRecorder(store) })

    // A genuinely separate process would be ideal; a second store on the same file is the same
    // mechanism M15 already proved with spawnSync, and this control is about AGREEMENT.
    const reopened = new DurableStore({ path, sessionId: 'S2' })
    const persisted = reopened.readMission('m1')!
    assert.equal(persisted.mission.plan[0].status, 'done')
    assert.equal(persisted.mission.plan[0].result?.outcome.kind, 'verified')
    assert.equal(persisted.mission.state, 'complete')
    assert.equal(isComplete(persisted.mission), true, 'completion is re-derived and agrees')
    assert.deepEqual(world.acted, ['write-summary:C:\\out\\summary.txt'], 'exactly one action - no duplicate')
    reopened.close(); store.close()
  } finally { bestEffortRemove(path) }
})

// ============================================================================================
// THE CENTRAL CONTROL: persistence failure after a real action
// ============================================================================================

test('CONTROL: the action happened and the record failed -> outcome-unknown, NEVER failed', async () => {
  const path = tmpDb()
  try {
    const store = new DurableStore({ path, sessionId: 'S1' })
    const world = makeWorld()
    // The write-ahead SUCCEEDS; recording what came back FAILS.
    const recorder = new StoreRecorder(store, (t) => (t === 'attemptOutcome' ? 'disk went away' : undefined))

    const res = await run({ world, store, recorder })

    assert.deepEqual(world.acted, ['write-summary:C:\\out\\summary.txt'], 'the machine really was changed')
    const step = res.mission.plan[0]
    assert.equal(step.status, 'uncertain', 'the step must be UNCERTAIN, not failed')
    assert.equal(step.result?.outcome.kind, 'outcome-unknown')

    const o = step.result!.outcome as Extract<StepOutcome, { kind: 'outcome-unknown' }>
    assert.match(o.reason, /may have changed/, 'the reason must say the machine may have changed')
    assert.match(o.persistenceError, /disk went away/, 'the persistence error must be retained')
    assert.equal(o.attempted.tool, 'write-summary', 'what was attempted must be recoverable')
    assert.deepEqual(o.attempted.args, { path: 'C:\\out\\summary.txt' })
    store.close()
  } finally { bestEffortRemove(path) }
})

test('CONTROL: outcome-unknown is NOT retryable, and the action is not repeated', async () => {
  const path = tmpDb()
  try {
    const store = new DurableStore({ path, sessionId: 'S1' })
    const world = makeWorld()
    const recorder = new StoreRecorder(store, (t) => (t === 'attemptOutcome' ? 'disk went away' : undefined))

    await run({ world, store, recorder, maxAttempts: 5 })

    assert.equal(world.acted.length, 1,
      'with five attempts allowed, the action must still happen ONCE. "Failed, therefore safe to retry" is exactly the bug.')
    assert.equal(world.attempted.length, 1, 'and it must not even be re-attempted')
    store.close()
  } finally { bestEffortRemove(path) }
})

test('CONTROL: isRetryable separates "complete?" from "may I try again?"', () => {
  const failed: StepOutcome = { kind: 'failed', reason: 'x' }
  const unknown: StepOutcome = {
    kind: 'outcome-unknown', reason: 'x', attempt: 1,
    attempted: { intent: 'i' }, persistenceError: 'e',
  }
  assert.equal(isRetryable(failed), true, 'a tool that returned failed did not change the machine')
  assert.equal(isRetryable(unknown), false, 'an unknown outcome MAY have changed it')
  assert.equal(isRetryable(undefined), true, 'an un-attempted step is retryable')

  const m = missionOf()
  m.plan[0].status = 'uncertain'
  m.plan[0].result = { id: 'write', outcome: unknown, durationMs: 1 }
  assert.equal(isComplete(m), false, 'an uncertain step is never complete')
  assert.equal(uncertainSteps(m).length, 1, 'and it must be findable for reconciliation')
})

test('CONTROL: a real tool FAILURE is still retryable - the two are not conflated', async () => {
  const path = tmpDb()
  try {
    const store = new DurableStore({ path, sessionId: 'S1' })
    const world = makeWorld()
    const recorder = new StoreRecorder(store)
    // The tool refuses BEFORE acting, every time.
    const tool = actingTool(world, 'write-summary', { failBefore: true })

    const res = await run({ world, store, recorder, tool, maxAttempts: 3 })

    assert.deepEqual(world.acted, [], 'the machine was never changed')
    assert.equal(world.attempted.length, 3, 'a clean, recorded failure may be retried')
    assert.equal(res.mission.plan[0].result?.outcome.kind, 'failed', 'and it is reported as failed')
    store.close()
  } finally { bestEffortRemove(path) }
})

// ============================================================================================
// FAILURE AT EVERY OTHER TRANSITION
// ============================================================================================

test('CONTROL: a failed WRITE-AHEAD means the action is never taken', async () => {
  const path = tmpDb()
  try {
    const store = new DurableStore({ path, sessionId: 'S1' })
    const world = makeWorld()
    const recorder = new StoreRecorder(store, (t) => (t === 'attemptBegin' ? 'cannot write' : undefined))

    const res = await run({ world, store, recorder })

    assert.deepEqual(world.acted, [], 'nothing may happen if the intent to act was not recorded first')
    assert.equal(res.mission.plan[0].result?.outcome.kind, 'failed')
    assert.match((res.mission.plan[0].result!.outcome as { reason: string }).reason, /No action was taken/,
      'and the reason must say so, so nobody reads it as an ordinary tool failure')
    store.close()
  } finally { bestEffortRemove(path) }
})

test('CONTROL: evidence that cannot be recorded is NOT a verified step', async () => {
  const path = tmpDb()
  try {
    const store = new DurableStore({ path, sessionId: 'S1' })
    const world = makeWorld()
    const recorder = new StoreRecorder(store, (t) => (t === 'verified' ? 'evidence store full' : undefined))

    const res = await run({ world, store, recorder })

    assert.deepEqual(world.acted.length, 1, 'the action did happen')
    const o = res.mission.plan[0].result!.outcome as Extract<StepOutcome, { kind: 'outcome-unknown' }>
    assert.equal(o.kind, 'outcome-unknown',
      'a step nobody can show was verified is not a verified step')
    assert.match(o.reason, /cannot be claimed complete/)
    assert.equal(store.readEvidence('m1').length, 0, 'and no evidence was invented to fill the gap')
    store.close()
  } finally { bestEffortRemove(path) }
})

test('CONTROL: a result that cannot be recorded becomes uncertain rather than silently absent', async () => {
  const path = tmpDb()
  try {
    const store = new DurableStore({ path, sessionId: 'S1' })
    const world = makeWorld()
    const recorder = new StoreRecorder(store, (t) => (t === 'stepResult' ? 'db locked' : undefined))

    const res = await run({ world, store, recorder })

    assert.equal(res.mission.plan[0].status, 'uncertain',
      'a step the store cannot account for must be uncertain, not quietly reported as done')
    assert.equal(world.acted.length, 1, 'and the action happened once')
    store.close()
  } finally { bestEffortRemove(path) }
})

test('CONTROL: a mission that cannot record ITSELF does not start', async () => {
  const path = tmpDb()
  try {
    const store = new DurableStore({ path, sessionId: 'S1' })
    const world = makeWorld()
    const recorder = new StoreRecorder(store, (t) => (t === 'missionStarted' ? 'no space' : undefined))

    const res = await run({ world, store, recorder })

    assert.deepEqual(world.acted, [], 'no work may begin without a durable record of what it is')
    assert.equal(res.record.complete, false)
    assert.equal(store.listMissionIds().length, 0, 'and nothing was written')
    store.close()
  } finally { bestEffortRemove(path) }
})

// ============================================================================================
// RESTART, AT EACH POINT
// ============================================================================================

test('restart DURING a step: the record says attempted, and the step comes back pending', async () => {
  const path = tmpDb()
  try {
    const store = new DurableStore({ path, sessionId: 'S1' })
    const world = makeWorld()
    const recorder = new StoreRecorder(store, (t) => (t === 'attemptOutcome' ? 'process died mid-write' : undefined))
    await run({ world, store, recorder })
    store.close()   // the process ends without ever recording the outcome

    const s2 = new DurableStore({ path, sessionId: 'S2' })
    const r = s2.readMission('m1')!
    // Read the history from the OPEN store. The first version read it from `store`, which had been
    // closed one line above as the entire point of the control - so the control died with "database is
    // not open" instead of testing anything.
    const h = s2.readHistory('m1').map((e) => e.summary)

    assert.equal(r.mission.plan[0].status, 'uncertain',
      'the write-ahead landed, so the record knows an action was attempted and its outcome was lost. ' +
      'That is UNCERTAIN, not pending - pending would claim nothing had been tried.')
    assert.equal(r.mission.plan[0].result?.outcome.kind, 'outcome-unknown')
    assert.ok(h.some((s) => /BEGINNING \(write-ahead\)/.test(s)),
      'and the durable record says an action was ATTEMPTED - which is what makes it recoverable')
    s2.close()
  } finally { bestEffortRemove(path) }
})

test('restart AFTER execution but BEFORE the result: obligations demand reconciliation, not a retry permit', async () => {
  const path = tmpDb()
  try {
    const store = new DurableStore({ path, sessionId: 'S1' })
    const world = makeWorld()
    const recorder = new StoreRecorder(store, (t) => (t === 'stepResult' ? 'died before result' : undefined))
    await run({ world, store, recorder })
    store.close()

    const s2 = new DurableStore({ path, sessionId: 'S2' })
    const permit = resumeMission(s2, 'm1')!
    assert.ok(permit.obligations.some((o) => o.kind === 're-observe'),
      'a resumed mission must require fresh observation')
    assert.equal(permit.requiresFreshObservation, true)
    assert.ok(!('executable' in permit), 'and must not carry permission of any kind')
    s2.close()
  } finally { bestEffortRemove(path) }
})

test('restart AFTER the result but BEFORE verification: verified work is not re-done', async () => {
  const path = tmpDb()
  try {
    const store = new DurableStore({ path, sessionId: 'S1' })
    const world = makeWorld()
    const recorder = new StoreRecorder(store, (t) => (t === 'verified' ? 'died before evidence' : undefined))
    await run({ world, store, recorder })
    store.close()

    const s2 = new DurableStore({ path, sessionId: 'S2' })
    const r = s2.readMission('m1')!
    assert.equal(r.evidence.length, 0, 'no evidence was recorded, so nothing claims verification')
    assert.equal(r.mission.plan[0].status, 'uncertain',
      'but the step is uncertain rather than failed, because the action may have succeeded')
    s2.close()
  } finally { bestEffortRemove(path) }
})

test('repeated recovery reads do NOT consume or erase obligations', async () => {
  const path = tmpDb()
  try {
    const store = new DurableStore({ path, sessionId: 'S1' })
    const world = makeWorld()
    await run({ world, store, recorder: new StoreRecorder(store) })
    store.recordApproval({
      id: 'ap-1', missionId: 'm1', stepId: 'write', effectKey: 'k', planEpoch: 1,
      sessionId: 'S1', state: 'approved', grantedAt: 1,
    })
    store.close()

    const s2 = new DurableStore({ path, sessionId: 'S2' })
    const first = resumeMission(s2, 'm1')!
    const second = resumeMission(s2, 'm1')!
    const third = resumeMission(s2, 'm1')!

    // The obligation must persist across reads. A permit that "used up" its obligations would let a
    // caller loop until it received an empty one, and an empty permit is a permission.
    for (const [n, p] of [['2nd', second], ['3rd', third]] as const) {
      assert.ok(p.obligations.some((o) => o.kind === 're-observe'), `${n} read must still require re-observation`)
      assert.ok(
        p.obligations.some((o) => o.kind === 're-obtain-approval'),
        `${n} read must still require approval to be obtained again`,
      )
    }
    assert.deepEqual(
      second.obligations.map((o) => o.kind).sort(),
      first.obligations.map((o) => o.kind).sort(),
      'the obligations must be identical, not progressively consumed',
    )
    s2.close()
  } finally { bestEffortRemove(path) }
})

// ============================================================================================
// THE EXECUTOR STILL WORKS WITHOUT A RECORDER
// ============================================================================================

test('no recorder supplied: behaviour is unchanged, because it is optional', async () => {
  const path = tmpDb()
  try {
    const store = new DurableStore({ path, sessionId: 'S1' })
    const world = makeWorld()
    const res = await run({ world, store })          // no recorder
    assert.equal(res.record.complete, true)
    assert.equal(world.acted.length, 1)
    store.close()
  } finally { bestEffortRemove(path) }
})

test('no recorder, a tool that fails: retried, and the machine is never touched', async () => {
  const path = tmpDb()
  try {
    const store = new DurableStore({ path, sessionId: 'S1' })
    const world = makeWorld()
    const res = await run({ world, store, tool: actingTool(world, 'write-summary', { failBefore: true }), maxAttempts: 3 })
    assert.deepEqual(world.acted, [])
    assert.equal(res.mission.plan[0].result?.outcome.kind, 'failed')
    store.close()
  } finally { bestEffortRemove(path) }
})