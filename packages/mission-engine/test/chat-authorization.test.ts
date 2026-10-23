/**
 * STAGE A3 - AUTHORISATION ON THE CHAT PATH. The behavioural regression tests.
 *
 * THE DEFECT THIS FILE EXISTS TO PREVENT
 * ============================================================================================
 *
 * `git push` planned for the CHAT ran ungate while the identical command in the interactive
 * terminal stopped at a human. One executor, one approval gate, two different answers depending
 * on which route the step arrived by - a non-uniform authorization boundary, which is the
 * mandate's Stage A exit criterion this stage exists for. The cause was structural:
 *
 *   1. `routedTools()` (the chat path's tool surface) exposed ONLY `resolve`. The gate reads
 *      `deps.tools.effectOf?.(step)` / `isConsequential?.(step)` / `preflight?.(step)` - all
 *      undefined - so `effect` was always undefined, no request was ever recorded, no
 *      `approval-required` was ever emitted, and no wait ever happened. The gate compiled,
 *      tested green at the executor level (where the harness provides its own tools object),
 *      and short-circuited to "nothing consequential here" for every chat mission.
 *   2. `parsePlan` mapped only id/intent/tool/args, so even a plan that DECLARED an effect lost
 *      it before the executor's weakest source could read it.
 *   3. `runGoal` accepted no decision channel: there was no store to decide against and no wait
 *      hook to surface a request live, so the window could not be asked even if a request had
 *      been made.
 *   4. The `/approve` route's matching policy lived inline in `chat-server.ts`, a module that
 *      starts an HTTP server on import (`void main()`), so the one policy that MUST be
 *      unit-tested - how a click becomes a decision on the exact requested key - was
 *      structurally untestable.
 *
 * HOW EACH TEST FAILS AGAINST THE PRE-FIX CODE
 * ============================================================================================
 *
 *   T1  parsePlan dropped `effect`: `steps[0].effect` is undefined -> assertion fails.
 *   T2  no validation existed: `assert.throws` fails because nothing throws.
 *   T3  routedTools had no `effectOf`/`isConsequential`: undefined result / TypeError.
 *   T4  approval-route.ts does not exist: the import fails. (Its policy is also re-proved
 *       end-to-end in T5-T7, where the tests decide through THE SAME function /approve uses.)
 *   T5  no effectOf -> no classification -> no request -> no waiter -> the required
 *       `approval-required` event never arrives (or, without the cliPath seam, the planner
 *       spawn goes to the real default CLI instead of the fake - both are pre-fix states).
 *   T6  same as T5: with no gate firing, the step runs DIRECTLY (step-start without a prior
 *       request) - which is exactly the ungate this suite pins. The assertion also requires
 *       the artifact layer's refusal to appear, proving approval and execution are separate.
 *   T7  same as T5; additionally there is no refusal status because nothing consults a store.
 *   T8  same as T5; the wait/timeout status cannot be produced by code that never waits.
 *   T9  same as T5; and pre-fix `signal` inside the deps object never reached `execute` (it is
 *       the THIRD argument), so a cancel could not stop a waiting/running executor at all.
 *
 * WHAT THESE TESTS RUN - AND WHAT THEY DELIBERATELY DO NOT
 * ============================================================================================
 *
 * The e2e tests drive the REAL `runGoal` with the model replaced by a local fake CLI emitting
 * the real NDJSON event shape (the proven planner-prose-reply harness), through the REAL
 * executor, the REAL ApprovalStore, and the REAL chat-path router (`routedTools`). Zero network,
 * zero model cost. What they need from the machine: the operator host running (for the guard
 * consults every step performs - a latched emergency stop correctly halts the mission before any
 * gate, and these tests would then fail LOUDLY with the halt visible, which is the honest
 * outcome) and an un-latched guard.
 *
 * The `/approve` HTTP route itself (auth gate, status codes) is exercised in the live demo;
 * its decision policy - exact match, ambiguity refusal, nothing-found - is this file's T4 and
 * is reused verbatim by the e2e tests below.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// ONE scratch home for the whole file, installed before `agent.ts` is ever imported.
// `AGENT_ROOT` (and therefore `MISSIONS_DIR`) is computed at MODULE LOAD from the home
// directory, so the redirect must happen first or every mission record lands in the real
// `~/.aios/agent`. Same pattern as chat-cancellation.test.ts.
const HOME = mkdtempSync(join(tmpdir(), 'aios-authz-'))
process.env.USERPROFILE = HOME
process.env.HOMEDRIVE = HOME.slice(0, 2)
process.env.HOMEPATH = HOME.slice(2)
process.on('exit', () => {
  try { rmSync(HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) } catch { /* best effort */ }
})

/** Routes to PLANNING: no question mark, not a greeting - so a model plan is required. */
const GOAL = 'push the current branch to the remote origin for the team'

/** The plan every fake CLI call returns: one terminal step whose verb the classifier sends. */
const PLAN_JSON = JSON.stringify({
  reply: 'Pushing the branch now.',
  steps: [
    { id: 's1', intent: 'push the current branch to origin', tool: 'terminal', args: { command: 'git push' } },
  ],
})

interface Ev {
  kind?: string
  text?: string
  ok?: boolean
  cancelled?: boolean
  stepId?: unknown
  effectKind?: unknown
  target?: unknown
  irreversible?: unknown
  reason?: unknown
  summary?: unknown
  verified?: unknown
  [k: string]: unknown
}

const byKind = (events: readonly Ev[], kind: string): Ev[] => events.filter((e) => e.kind === kind)
const kindsOf = (events: readonly Ev[]): string => events.map((e) => String(e.kind)).join(', ')

/**
 * Bound any runGoal so a broken wait loop FAILS instead of hanging the runner forever.
 * The failure message carries what the harness saw, because a silent hang is undiagnosable.
 */
async function withDeadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error(`${what} did not finish within ${ms}ms - the approval channel hung`)), ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Install the fake model planner for one run and ALWAYS restore NODE_OPTIONS.
 *
 * `runGoal` spawns the planner as `cliPath` with argv `run --format json ...`. The shim is node
 * itself with `NODE_OPTIONS=--require <shim>`: node loads the shim before resolving the bogus
 * `run` argument, the shim writes the NDJSON event stream and exits 0. This is the same measured
 * harness planner-prose-reply.test.ts pins (a .cmd shim is NOT spawnable with shell:false).
 */
async function withFakePlanner<T>(fn: (cliPath: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'aios-authz-cli-'))
  const shimJs = join(dir, 'emit-ndjson.js')
  const ndjson = [
    JSON.stringify({ type: 'step_start' }),
    JSON.stringify({ type: 'text', part: { type: 'text', text: PLAN_JSON } }),
    JSON.stringify({ type: 'step_finish' }),
  ].join('\n') + '\n'
  writeFileSync(shimJs, `process.stdout.write(${JSON.stringify(ndjson)});\nprocess.exit(0);\n`, 'utf8')
  const prev = process.env.NODE_OPTIONS
  process.env.NODE_OPTIONS = `--require ${JSON.stringify(shimJs)}`
  try {
    return await fn(process.execPath)
  } finally {
    if (prev === undefined) delete process.env.NODE_OPTIONS
    else process.env.NODE_OPTIONS = prev
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) } catch { /* best effort */ }
  }
}

/**
 * Drive the REAL runGoal end to end through the approval channel.
 *
 * `decision` (when set) is applied through `matchOutstanding` + `ApprovalStore.decide` on every
 * live `approval-required` - THE SAME two calls the /approve HTTP route makes. A match failure
 * is recorded in `wiringErrors` rather than thrown, because a throw inside `emit` is swallowed
 * by the executor's wait hook (`catch { /* stays needs-human *\/ }`) and would surface as an
 * unrelated later assertion instead of as what it is.
 */
async function runWithChannel(opts: {
  readonly decision?: 'approved' | 'rejected'
  readonly approvalWaitMs?: number
  readonly abortOnFirstRequest?: boolean
}): Promise<{
    res: { ok: boolean; cancelled?: boolean; error?: string }
    events: Ev[]
    store: import('../../governance/approval.ts').ApprovalStore
    wiringErrors: string[]
    elapsed: number
  }> {
  const { runGoal } = await import('../live/agent/agent.ts')
  const { ApprovalStore } = await import('../../governance/approval.ts')
  const { matchOutstanding } = await import('../live/agent/approval-route.ts')
  const store = new ApprovalStore()
  const events: Ev[] = []
  const wiringErrors: string[] = []
  const ac = new AbortController()
  const started = Date.now()

  const res = await withFakePlanner((cliPath) => withDeadline(runGoal(GOAL, (e) => {
    const ev = e as unknown as Ev
    events.push(ev)
    if (ev.kind !== 'approval-required') return
    if (opts.abortOnFirstRequest === true) {
      // Stop lands while the mission is paused on the gate. If the waiter's signal handling is
      // broken this abort is ignored and the run then hits the 45s deadline instead - a failure
      // that says so - rather than quietly succeeding.
      ac.abort()
      return
    }
    if (!opts.decision) return
    const target = {
      stepId: String(ev.stepId ?? ''),
      kind: String(ev.effectKind ?? ''),
      target: String(ev.target ?? ''),
    }
    const outcome = matchOutstanding(store.outstanding(), target)
    if (outcome.kind !== 'found') {
      wiringErrors.push(`/approve could not match its own request: ${JSON.stringify(target)} -> ${outcome.kind}`)
      return
    }
    try {
      store.decide(outcome.request.key, opts.decision, 'the test operator at the window', Date.now())
    } catch (err) {
      wiringErrors.push(String(err))
    }
  }, {
    cliPath,
    approvals: store,
    approvalWaitMs: opts.approvalWaitMs ?? 1000,
    signal: ac.signal,
  }), 45_000, 'runGoal'))

  return { res, events, store, wiringErrors, elapsed: Date.now() - started }
}

// ===========================================================================================
// parse-time: a declared effect is KEPT and a malformed one REFUSES the plan
// ===========================================================================================

test('T1 parsePlan keeps a declared effect instead of dropping it before the gate can read it', async () => {
  const { parsePlan } = await import('../live/agent/agent.ts')
  const plan = parsePlan(JSON.stringify({
    reply: 'r',
    steps: [{
      id: 's1',
      intent: 'push the branch',
      tool: 'terminal',
      args: { command: 'git push' },
      effect: { kind: 'external-send', target: 'the origin remote', reason: 'pushing sends commits off this machine', irreversible: true },
    }],
  }))
  assert.equal(plan.steps.length, 1)
  const effect = plan.steps[0]?.effect
  assert.ok(effect, 'the declaration must survive parsing - the executor compares the tool against it')
  assert.equal(effect?.kind, 'external-send')
  assert.equal(effect?.target, 'the origin remote')
  assert.equal(effect?.reason, 'pushing sends commits off this machine')
  assert.equal(effect?.irreversible, true)
})

test('T2 a malformed effect refuses the plan rather than being quietly discarded', async () => {
  const { parsePlan } = await import('../live/agent/agent.ts')
  // An unknown kind: the plan asked for a consequence this system has no class for.
  assert.throws(
    () => parsePlan(JSON.stringify({
      reply: 'r',
      steps: [{ id: 's1', intent: 'x', tool: 'terminal', args: { command: 'git push' }, effect: { kind: 'explode', target: 'x' } }],
    })),
    /cannot honour/,
    'a step whose declared consequence is unclassifiable must refuse the whole plan',
  )
  // A missing target: an effect with no identity is not an effect, it is a decoration - and
  // dropping it would run the step with no approval where one was admitted to.
  assert.throws(
    () => parsePlan(JSON.stringify({
      reply: 'r',
      steps: [{ id: 's1', intent: 'x', tool: 'terminal', args: { command: 'git push' }, effect: { kind: 'delete' } }],
    })),
    /cannot honour|must name a target/,
    'an effect with no target must refuse the plan, not vanish into a run without authorisation',
  )
})

// ===========================================================================================
// the chat router mirrors the tool-router's governance surface
// ===========================================================================================

test('T3 the chat router classifies its own step arguments, exactly as the executor gate reads them', async () => {
  const { routedTools } = await import('../live/agent/capabilities.ts')
  const tools = routedTools()
  const step = (tool: string, args: Record<string, unknown>) => ({ id: 's1', intent: 'x', tool, args }) as never

  // Resolution still works - the mirror must not have broken the only method that existed.
  const r = tools.resolve(step('terminal', { command: 'git status' }))
  assert.equal('tool' in r && r.tool?.name, 'terminal', 'resolve must keep working alongside the new methods')

  // `git push` SENDS: classified, therefore gated. This is the exact case that ran ungate.
  const push = tools.effectOf(step('terminal', { command: 'git push' }))
  assert.ok(push, 'git push is an external send and must be classified by the chat router')
  assert.equal(push?.kind, 'external-send')
  assert.equal(push?.target, 'git push')
  assert.equal(push?.irreversible, true)

  // `git status` READS: looked and found nothing - `undefined`, never `true`. A static
  // "terminal is consequential" flag would demand a human for every read command.
  assert.equal(tools.effectOf(step('terminal', { command: 'git status' })), undefined,
    'a read-only git verb must classify as no effect')
  assert.equal(tools.isConsequential(step('terminal', { command: 'git status' })), undefined,
    'isConsequential must mean "looked and found nothing", not "is consequential"')

  // npm install unpacks third-party code onto this machine.
  const npm = tools.effectOf(step('terminal', { command: 'npm i lodash' }))
  assert.equal(npm?.kind, 'install')
  assert.equal(npm?.target, 'lodash')

  // A non-terminal tool without its own classifier stays undefined rather than guessed.
  assert.equal(tools.effectOf(step('write-file', { path: 'out.txt', content: 'x' })), undefined)
})

// ===========================================================================================
// the /approve matching policy (shared verbatim by the HTTP route and the e2e tests below)
// ===========================================================================================

test('T4 /approve matching is exact-or-nothing, refuses ambiguity, and cannot re-decide', async () => {
  const { ApprovalStore, keyFor } = await import('../../governance/approval.ts')
  const { matchOutstanding, isCompleteTarget } = await import('../live/agent/approval-route.ts')

  const store = new ApprovalStore()
  const effect = { kind: 'external-send' as const, target: 'git push', reason: 'sends commits', irreversible: true }
  const key = keyFor('mission-1', 's1', effect, 0)
  store.request(key, 'external-send on git push: sends commits')

  // Exact match on all three fields finds THE request, carrying its own key - never one built
  // here. decide() would refuse a key the store never requested, so this is the whole safety.
  const found = matchOutstanding(store.outstanding(), { stepId: 's1', kind: 'external-send', target: 'git push' })
  assert.equal(found.kind, 'found')
  assert.deepEqual(found.kind === 'found' ? found.request.key : null, key)

  // A near-miss is nothing: a different target is a different action, not a similar one.
  assert.equal(matchOutstanding(store.outstanding(), { stepId: 's1', kind: 'external-send', target: 'git push --force' }).kind, 'not-found')
  assert.equal(matchOutstanding(store.outstanding(), { stepId: 's2', kind: 'external-send', target: 'git push' }).kind, 'not-found')
  assert.equal(matchOutstanding(store.outstanding(), { stepId: 's1', kind: 'delete', target: 'git push' }).kind, 'not-found')

  // Two indistinguishable requests: refuse to guess. Picking the first would decide one of two
  // actions at random.
  const dupKey = keyFor('mission-1', 's1', effect, 1) // same triple, different epoch
  store.request(dupKey, 'external-send on git push: sends commits')
  const ambiguous = matchOutstanding(store.outstanding(), { stepId: 's1', kind: 'external-send', target: 'git push' })
  assert.equal(ambiguous.kind, 'ambiguous')
  assert.equal(ambiguous.kind === 'ambiguous' ? ambiguous.count : 0, 2)

  // Deciding the second one resolves the ambiguity; the decided request LEAVES outstanding, so a
  // double-click afterwards is `not-found` - the route answers 404 instead of deciding twice.
  store.decide(dupKey, 'approved', 'the operator', Date.now())
  assert.equal(matchOutstanding(store.outstanding(), { stepId: 's1', kind: 'external-send', target: 'git push' }).kind, 'found')
  store.decide(key, 'rejected', 'the operator', Date.now())
  assert.equal(matchOutstanding(store.outstanding(), { stepId: 's1', kind: 'external-send', target: 'git push' }).kind, 'not-found')

  // A partial identity is not a decision target.
  assert.equal(isCompleteTarget({ stepId: 's1', kind: 'external-send', target: '  ' }), false)
  assert.equal(isCompleteTarget({ stepId: 's1', kind: 'external-send', target: 'git push' }), true)
})

// ===========================================================================================
// end to end through the REAL runGoal: pause, decide, refuse, time out, cancel
// ===========================================================================================

test('T5 a consequential chat step PAUSES for a human and runs nothing until the store approves', async () => {
  const out = await runWithChannel({})
  const requests = byKind(out.events, 'approval-required')
  assert.ok(requests.length >= 1,
    `the gate must pause the mission and ask; no approval-required arrived. events: ${kindsOf(out.events)}`)

  const first = requests[0]!
  assert.equal(String(first.stepId), 's1', 'the request must name the exact step that is paused')
  assert.equal(String(first.effectKind), 'external-send')
  assert.equal(String(first.target), 'git push')
  assert.equal(first.irreversible, true, 'the window must be told this cannot be undone')
  assert.ok(String(first.reason ?? '').length > 0, 'the request must carry the reason a human decides on')

  assert.equal(byKind(out.events, 'step-start').length, 0,
    'nothing may start before a human decides - this is the ungate this suite exists to pin')
  assert.equal(out.store.decisions().length, 0, 'nobody decided; nothing may have been approved')
  assert.ok(out.store.outstanding().length >= 1, 'the request must be outstanding for someone to answer')
  assert.equal(out.res.ok, false, 'an unanswered gate is not a success')
  const done = byKind(out.events, 'done')
  assert.ok(done.length >= 1, `the mission must end with a terminal done event; events: ${kindsOf(out.events)}`)
  assert.equal(done[0]?.ok, false, 'the mission must end honestly as not achieved')
  assert.equal(byKind(out.events, 'status').some((s) => /Authorisation granted/.test(String(s.text))), false,
    'no grant may be reported when nobody granted anything')
  assert.deepEqual(out.wiringErrors, [])
})

test('T6 an APPROVED step reaches the tool, and the artifact layer still refuses honestly (approval is authorisation, not success)', async () => {
  const out = await runWithChannel({ decision: 'approved', approvalWaitMs: 1500 })
  assert.deepEqual(out.wiringErrors, [], 'the exact-match decision path must find every request the executor makes')
  assert.ok(byKind(out.events, 'status').some((s) => /Authorisation granted/.test(String(s.text))),
    'a granted decision must be reported before the step continues')

  assert.ok(byKind(out.events, 'step-start').length >= 1,
    `an approved step must reach tool selection. events: ${kindsOf(out.events)}`)

  const results = byKind(out.events, 'step-result')
  assert.ok(results.length >= 1, 'the step must report an outcome')
  const summaries = results.map((r) => String(r.summary ?? ''))
  assert.ok(summaries.some((s) => /refusing to run/i.test(s)),
    `the artifact layer must refuse a contractless git push with its own words; got: ${summaries.join(' || ')}`)
  assert.equal(summaries.some((s) => /awaiting human authorisation|needs-human/i.test(s)), false,
    'after approval the outcome must be the TOOL\'s refusal, not another wait for a human')

  const decisions = out.store.decisions()
  assert.ok(decisions.length >= 1 && decisions.some((d) => d.state === 'approved'),
    'the store must hold the approval that unblocked the step')
  assert.equal(byKind(out.events, 'done')[0]?.ok, false, 'an approved step that was refused by the tool is not a success')
})

test('T7 a REFUSED decision stops the step and says so - refusal is final, not a retry signal', async () => {
  const out = await runWithChannel({ decision: 'rejected', approvalWaitMs: 1500 })
  assert.deepEqual(out.wiringErrors, [])
  assert.ok(byKind(out.events, 'status').some((s) => /Authorisation REFUSED/.test(String(s.text))),
    'the refusal must be reported to the window')
  assert.equal(byKind(out.events, 'step-start').length, 0, 'a refused step must never reach its tool')
  const decisions = out.store.decisions()
  assert.ok(decisions.length >= 1, 'the refusal must be recorded')
  assert.equal(decisions.every((d) => d.state === 'rejected'), true, 'no rejected key may exist in any other state')
  assert.equal(byKind(out.events, 'done')[0]?.ok, false)
})

test('T8 an unanswered request times out honestly: bounded wait, nothing ran, no hang', async () => {
  const out = await runWithChannel({ approvalWaitMs: 700 })
  assert.ok(out.elapsed < 60_000, `the wait must be bounded by approvalWaitMs, took ${out.elapsed}ms`)
  assert.ok(byKind(out.events, 'status').some((s) => /No decision arrived within \d+s/.test(String(s.text))),
    'the timeout must be stated to the window, with what ran (nothing) attached')
  assert.equal(byKind(out.events, 'step-start').length, 0, 'a timeout must not release the step')
  assert.equal(out.store.decisions().length, 0)
  assert.equal(byKind(out.events, 'done')[0]?.ok, false)
  assert.deepEqual(out.wiringErrors, [])
})

test('T9 Stop during the wait cancels the mission - nothing runs, nothing is replayed', async () => {
  // 60s approvalWaitMs is the TRAP: if the waiter ignores the signal it would sit for 60s and
  // the 45s deadline inside runWithChannel would fail this test with "the approval channel
  // hung". A correct signal handling returns in milliseconds after the abort.
  const out = await runWithChannel({ abortOnFirstRequest: true, approvalWaitMs: 60_000 })
  assert.equal(out.res.cancelled, true, `a stop during the wait must cancel the mission, got: ${out.res.error ?? ''}`)
  assert.ok(out.elapsed < 15_000, `the abort must not wait out approvalWaitMs, took ${out.elapsed}ms`)
  const done = byKind(out.events, 'done')
  assert.equal(done.length >= 1 && done[0]?.cancelled, true, 'the done event must carry the cancelled flag')
  assert.match(String(done[0]?.text ?? ''), /cancel/i, 'the final text must name the cancellation')
  assert.equal(byKind(out.events, 'step-start').length, 0,
    'a cancelled wait must never become a granted one: nothing may run after Stop')
  assert.deepEqual(out.wiringErrors, [])
})
