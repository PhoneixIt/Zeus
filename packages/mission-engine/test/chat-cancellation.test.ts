/**
 * CANCELLATION, end to end - the behavioural regression tests for Stage A.
 *
 * Every test here FAILS against the pre-fix code, and each one says how:
 *
 *   1. `interpret` ignored `signal` entirely, so a pre-aborted request still walked the model
 *      pool and failed with a spawn error instead of a cancellation.
 *   2. `runGoal` ignored `signal` entirely, so a mission cancelled before it started answered
 *      conversationally with `ok:true` - work happened after the person said stop.
 *   3. `openCodePlannerFetch` ignored `signal`, so a cancelled request still SPAWNED a model
 *      process (and failed with "could not start the OpenCode CLI" on a bogus path).
 *   4. `runCli` had no abort handling at all: an abort during a run left the child alive and
 *      the promise pending until the full timeout.
 *   5. The chat path's emergency stop was `async () => false` - a stub. There was no consult
 *      to test; the export did not exist.
 *
 * The mid-run test (4) drives a REAL child process: `node` running a file named `run` in the
 * test's own cwd, which is exactly how `runCli` invokes a CLI (first argument `run`). The fake
 * ticks a heartbeat file so the test can prove the process DIED after the abort rather than
 * the promise merely resolving - a cancellation that stops the report but not the process is
 * the exact defect this suite exists to prevent.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// ONE scratch home for the whole file, installed before `agent.ts` is ever imported.
// `AGENT_ROOT` (and therefore `MISSIONS_DIR`) is computed at MODULE LOAD from the home
// directory, so the redirect must happen first or every test writes mission records into the
// real `~/.aios/agent`. Same pattern as planner-prose-reply.test.ts.
const HOME = mkdtempSync(join(tmpdir(), 'aios-cancel-'))
process.env.USERPROFILE = HOME
process.env.HOMEDRIVE = HOME.slice(0, 2)
process.env.HOMEPATH = HOME.slice(2)
process.on('exit', () => {
  try { rmSync(HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) } catch { /* best effort */ }
})

/** A goal that routes to PLANNING (no question mark, not a greeting), so no model can answer it. */
const PLANNING_GOAL = 'write a short report about the windows currently open into a file'

test('interpret with a pre-aborted signal cancels before any model is asked', async () => {
  const { interpret, MissionCancelled } = await import('../live/agent/agent.ts')
  const events: unknown[] = []
  const ac = new AbortController()
  ac.abort()

  await assert.rejects(
    () => interpret(PLANNING_GOAL, (e) => events.push(e), {
      // A path that cannot spawn: if anything had tried to ask a model, this would surface as
      // a spawn failure rather than as a cancellation.
      cliPath: 'C:\\nonexistent-aios\\opencode-cli-does-not-exist.exe',
      signal: ac.signal,
    }),
    (e: unknown) => e instanceof MissionCancelled,
    'a cancelled request must surface as MissionCancelled, not as a model error',
  )
  assert.equal(
    events.some((e) => (e as { kind?: string }).kind === 'plan'),
    false,
    'no plan may be requested after the person cancelled',
  )
})

test('runGoal with a pre-aborted signal reports cancelled - work does not happen after Stop', async () => {
  const { runGoal } = await import('../live/agent/agent.ts')
  const events: Array<{ kind: string; ok?: boolean; text?: string; cancelled?: boolean }> = []
  const ac = new AbortController()
  ac.abort()

  // 'hi' is CONVERSATIONAL: pre-fix it was answered instantly by the fast path with ok:true -
  // which is exactly the bug. Cancelling before the mission starts must stop even that.
  const res = await runGoal('hi', (e) => events.push(e as never), { signal: ac.signal })

  assert.equal(res.ok, false, 'a cancelled mission is not ok')
  assert.equal(res.cancelled, true, 'the result must say cancelled, not merely failed')
  assert.equal(res.error, 'cancelled by the person')

  const done = events.find((e) => e.kind === 'done')
  assert.ok(done, 'a terminal done event must still be emitted')
  assert.equal(done?.cancelled, true, 'the done event must carry the cancelled flag')
  assert.match(String(done?.text), /cancel/i, 'the final text must name the cancellation')
})

test('the planner never spawns a model process for an already-cancelled request', async () => {
  const { openCodePlannerFetch } = await import('../../model/opencode-planner.ts')
  const ac = new AbortController()
  ac.abort()

  const { fetchImpl } = openCodePlannerFetch({
    model: 'opencode/fake-free',
    timeoutMs: 5_000,
    cliPath: 'C:\\nonexistent-aios\\opencode-cli-does-not-exist.exe',
    sandbox: false,
    signal: ac.signal,
  }, () => {})

  await assert.rejects(
    () => fetchImpl('http://127.0.0.1/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: 'opencode/fake-free',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    } as RequestInit),
    (e: unknown) => /cancelled by the user/.test(e instanceof Error ? e.message : String(e)),
    'the refusal must say cancelled - a spawn error here would mean the process was started anyway',
  )
})

test('aborting a running model call kills the child process immediately', async () => {
  const { runCli } = await import('../../model/opencode-planner.ts')
  const dir = mkdtempSync(join(tmpdir(), 'aios-cancel-run-'))
  const beat = join(dir, 'beat.txt')
  // The fake CLI: node itself, running a file named `run` in cwd - which is exactly the argv
  // runCli produces (`run --format json --model <m> <message>`; the message carries the
  // heartbeat path). Only globals are used, so the extensionless file runs as CommonJS under
  // module detection. It never exits; only the abort can end it.
  writeFileSync(join(dir, 'run'), [
    "const beat = process.argv[process.argv.length - 1]",
    'let write = null',
    "import('node:fs').then((m) => { write = m.writeFileSync })",
    'const tick = () => { if (write) { try { write(beat, String(Date.now())) } catch (e) {} } }',
    'tick()',
    'setInterval(tick, 200)',
    '',
  ].join('\n'), 'utf8')

  const ac = new AbortController()
  const started = Date.now()
  try {
    const pending = runCli(process.execPath, 'fake-model', beat, dir, 300_000, ac.signal)

    // Wait for the first tick rather than assuming one: a COLD node child can take more than
    // a second to start, and asserting on a fixed 900ms sleep made this test fail for the
    // wrong reason - the child was still starting, not misbehaving.
    const deadline = Date.now() + 15_000
    while (!existsSync(beat) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100))
    }
    assert.ok(existsSync(beat), 'the fake CLI must start within 15s')
    await new Promise((r) => setTimeout(r, 400))
    assert.ok(
      Number(readFileSync(beat, 'utf8')) > 0,
      'the fake CLI must be alive and ticking before the abort',
    )

    ac.abort()
    const res = await pending

    assert.equal(res.failure, 'cancelled by the user')
    assert.ok(Date.now() - started < 30_000, 'abort must not wait out the 300s timeout')

    // The heartbeat stops moving: the child is DEAD, not merely detached. A promise that
    // resolves while the process lives on is the orphan this whole change exists to prevent.
    const lastBeat = Number(readFileSync(beat, 'utf8'))
    await new Promise((r) => setTimeout(r, 900))
    const afterAbort = Number(readFileSync(beat, 'utf8'))
    assert.equal(afterAbort, lastBeat, 'the heartbeat must stop: the aborted child must be dead')
  } finally {
    // ALWAYS abort, even when an assertion above throws: an un-aborted fake child keeps the
    // test process's handles alive and hangs the whole runner instead of failing cleanly.
    ac.abort()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})

test('the chat path emergency stop consults the guard latch and rejects on an unreadable guard', async () => {
  const { emergencyStopConsult } = await import('../live/agent/agent.ts')

  const latched = await emergencyStopConsult(async () => ({
    control: 'STOPPED', input: 'BLOCKED', blockedBy: 'EMERGENCY STOP LATCHED',
    infrastructureHealthy: true, emergencyLatched: true,
  } as never))
  assert.equal(latched, true, 'a latched emergency stop must halt the chat path')

  const blockedOnly = await emergencyStopConsult(async () => ({
    control: 'STOPPED', input: 'BLOCKED', blockedBy: 'EMERGENCY_STOP',
    infrastructureHealthy: true,
  } as never))
  assert.equal(blockedOnly, true, 'a guard reporting EMERGENCY_STOP in blockedBy must halt too')

  const healthy = await emergencyStopConsult(async () => ({
    control: 'ARMED', input: 'PERMITTED', blockedBy: null, infrastructureHealthy: true,
  } as never))
  assert.equal(healthy, false, 'a healthy guard must not halt')

  // Uncertainty is not reassurance. An unreadable guard REJECTS; the executor's permission
  // consult immediately behind it throws for the same guard and stops the mission with the
  // true reason. Answering `true` here would report a latch that does not exist.
  await assert.rejects(
    () => emergencyStopConsult(async () => { throw new Error('fetch failed') }),
    /fetch failed/,
  )
})
