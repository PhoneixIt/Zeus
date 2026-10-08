/**
 * PROCESS RESULT SEMANTICS.
 *
 * =============================================================================
 * THE RULE
 * =============================================================================
 *
 *   A successful external action must never be classified as failed merely because inherited stdio
 *   remains open.
 *
 * That rule exists because the opposite was true. `terminal-mode.ts` settled on Node's `'close'`
 * event, which fires when the process has exited AND all its stdio streams have closed. A process that
 * backgrounds a child hands that child an inherited handle on the same stdout pipe, so the pipe
 * outlives the process that opened it.
 *
 * MEASURED, with a control that behaves correctly:
 *
 *     command backgrounds a child, parent exits 0   ->  exit at 1.4s, pipe STILL OPEN at 21.4s
 *     command with no background child, exits 0      ->  exit at 1.0s, pipe closed at 1.0s
 *
 * So the tool waited out the whole timeout, reported a SUCCEEDED command as `timed-out` / `failed`, and
 * the timeout handler then reaped the very background process the command legitimately started. A
 * correct action recorded as a failure, with failure triggering cleanup that destroys the user's work -
 * an inversion of the rule this whole project is built on.
 *
 * =============================================================================
 * WHAT IS PROVEN HERE
 * =============================================================================
 *
 *   1. normal foreground success
 *   2. normal failure (nonzero exit) - reported as failure, not swallowed
 *   3. background child with a successful parent - the case that was broken
 *   4. timeout - still a timeout, still reaped, and still reported as failure
 *   5. descendant cleanup is attempted on the timeout path
 *   6. stderr/stdout drainage - output is captured, and cut output says it was cut
 *   7. a process that has ALREADY exited before the listener attaches
 *
 * Every test drives the REAL governed tool. Nothing here is a mock of the process model: the defect
 * being guarded against is one a mock would agree with by construction.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'

import { makeTerminalTool, type ProcessRecord, type TerminalConfig } from '../live/terminal-mode.ts'
import { isAlive, killAndConfirm } from '../process-containment.ts'

const NODE_EXE = join(process.env.ProgramFiles ?? 'C:\\Program Files', 'nodejs', 'node.exe')
const PING = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'ping.exe')
const CTX = {
  missionId: 'm', stepId: 's', attempt: 1,
  observation: {}, prior: {}, signal: new AbortController().signal,
} as never

const written: string[] = []

/** A script inside the workspace, because the policy refuses anything outside it. */
function script(body: string): string {
  const file = join(process.cwd(), `aios-sem-${randomUUID()}.cjs`)
  writeFileSync(file, body, 'utf8')
  written.push(file)
  return file
}

function tool(timeoutMs: number, containment?: TerminalConfig['containment']) {
  return makeTerminalTool({
    workspace: process.cwd(),
    systemRoot: process.env.SystemRoot ?? 'C:\\Windows',
    programFiles: process.env.ProgramFiles ?? 'C:\\Program Files',
    timeoutMs,
    containment,
  })
}

type Res = {
  kind: string
  reason?: string
  summary?: string
  data?: ProcessRecord
}

async function run(argv: string[], timeoutMs = 20_000): Promise<{ r: Res; elapsed: number }> {
  const t0 = Date.now()
  const r = (await tool(timeoutMs).run(CTX, { executable: NODE_EXE, argv } as never)) as Res
  return { r, elapsed: Date.now() - t0 }
}

test.after(() => {
  for (const f of written) { try { rmSync(f, { force: true }) } catch { /* best effort */ } }
})

// =============================================================================
// 1. NORMAL FOREGROUND SUCCESS
// =============================================================================

test('normal foreground success is `completed`, with exit code and output', async () => {
  const { r } = await run([script("console.log('OUT-1'); console.error('ERR-1'); process.exit(0)")])
  assert.equal(r.kind, 'data', `expected data. Got ${r.kind}: ${r.reason ?? ''}`)
  assert.equal(r.data!.state, 'completed', `expected completed. Got ${r.data!.state}`)
  assert.equal(r.data!.exitCode, 0)
  assert.equal(r.data!.timedOut, false)
  assert.match(r.data!.stdout, /OUT-1/, 'stdout must be captured')
  assert.match(r.data!.stderr, /ERR-1/, 'stderr must be captured')
  assert.equal(r.data!.stdoutTruncated, false)
})

// =============================================================================
// 2. NORMAL FAILURE - reported as failure, with the reason preserved
// =============================================================================

test('a nonzero exit is `failed`, and the exit code and stderr survive into the record', async () => {
  const { r } = await run([script("console.error('deliberate failure'); process.exit(3)")])
  assert.equal(r.kind, 'failed', `expected failed. Got ${r.kind}`)
  assert.equal(r.data!.exitCode, 3, 'the real exit code must be recorded')
  assert.equal(r.data!.state, 'nonzero')
  assert.match(String(r.reason), /exited with code 3/, 'the reason must name the code')
  assert.match(String(r.reason), /deliberate failure/, 'and preserve stderr')
})

// =============================================================================
// 3. BACKGROUND CHILD WITH A SUCCESSFUL PARENT - the case that was inverted
// =============================================================================

test('a backgrounded child holding stdout does NOT make a successful parent `failed`', async () => {
  const pidFile = join(process.cwd(), `aios-sem-${randomUUID()}.txt`)
  written.push(pidFile)
  const body = [
    "const { spawn } = require('child_process')",
    "const fs = require('fs')",
    `const ping = ${JSON.stringify(PING)}`,
    // DETACHED, so it genuinely outlives - measured; a non-detached child dies with its parent on
    // Windows, which would make this test prove nothing.
    "const c = spawn(ping, ['-t', '127.0.0.1'], { stdio: 'inherit', detached: true })",
    `fs.writeFileSync(${JSON.stringify(pidFile)}, String(c.pid))`,
    "console.log('PARENT-DONE')",
    'setTimeout(() => process.exit(0), 1200)',
  ].join('\n')

  const { r, elapsed } = await run([script(body)])

  try {
    // The action succeeded. It must be recorded as having succeeded.
    assert.equal(r.kind, 'data', `a successful command must not be failed. Got ${r.kind}: ${r.reason ?? ''}`)
    assert.equal(r.data!.state, 'completed', `expected completed. Got ${r.data!.state}`)
    assert.equal(r.data!.exitCode, 0)
    assert.equal(r.data!.timedOut, false, 'must NOT be marked as timed out')
    assert.match(r.data!.stdout, /PARENT-DONE/, "the parent's own output must still be captured")

    // The bound. Without a bounded drain this would sit until the 20s timeout.
    assert.ok(elapsed < 15_000, `must settle on process EXIT, not on pipe close. Took ${elapsed}ms of 20000ms`)
    console.log(`      [measured] parent exited 0, settled in ${elapsed}ms with the pipe still held`)
  } finally {
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, 'utf8'))
      await killAndConfirm(pid).catch(() => false)
    }
  }
})

// =============================================================================
// 4. TIMEOUT - still a timeout, still a failure
// =============================================================================

test('a command that never exits is `timed-out` and reported as failed', async () => {
  const { r, elapsed } = await run([script('setInterval(() => {}, 1000)')], 3_000)
  assert.equal(r.kind, 'failed', `a hang must be a failure. Got ${r.kind}`)
  assert.equal(r.data!.state, 'timed-out')
  assert.equal(r.data!.timedOut, true, 'must be marked as timed out')
  assert.match(String(r.reason), /timeout/i, 'the reason must name the timeout')
  assert.ok(elapsed >= 2_500, `must actually have waited out the timeout. Took ${elapsed}ms`)
})

// =============================================================================
// 5. DESCENDANT CLEANUP on the timeout path
// =============================================================================

test('on timeout the process TREE is reaped, not just the parent', async () => {
  const pidFile = join(process.cwd(), `aios-sem-${randomUUID()}.txt`)
  written.push(pidFile)
  const body = [
    "const { spawn } = require('child_process')",
    "const fs = require('fs')",
    `const ping = ${JSON.stringify(PING)}`,
    "const c = spawn(ping, ['-t', '127.0.0.1'], { stdio: 'ignore', detached: true })",
    `fs.writeFileSync(${JSON.stringify(pidFile)}, String(c.pid))`,
    'setInterval(() => {}, 1000)',
  ].join('\n')

  const r = (await tool(3_000).run(CTX, { executable: NODE_EXE, argv: [script(body)] } as never)) as Res

  assert.equal(r.kind, 'failed', 'the parent hangs, so the step fails')
  assert.equal(r.data!.state, 'timed-out')

  // The child must not outlive the timeout. `taskkill /T` walks the tree while the parent still exists,
  // which is the only moment it can.
  await sleep(600)
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, 'utf8'))
    assert.equal(await isAlive(pid), false, `the descendant ${pid} must be reaped with its parent, not orphaned`)
  }
})

// =============================================================================
// 6. STDERR / STDOUT DRAINAGE
// =============================================================================

test('a large burst written immediately before exit is captured, not truncated', async () => {
  // If settlement happened on 'exit' with no drain at all, the tail would be lost. This is the
  // cheapest possible test that the bounded grace exists.
  const { r } = await run([script("const s='X'.repeat(4000); for (let i=1;i<=20;i++) console.log(s+'-'+i)")])
  assert.equal(r.kind, 'data')
  assert.equal(r.data!.stdoutTruncated, false, 'a burst written just before exit must not be truncated')
  const lines = r.data!.stdout.split(/\r?\n/).filter((l) => l.startsWith('XXXX'))
  assert.equal(lines.length, 20, `all 20 lines must survive. Got ${lines.length}`)
  assert.ok(lines[19]!.endsWith('-20'), `the LAST line must be complete, got ${JSON.stringify(lines[19]?.slice(-6))}`)
})

test('output BEYOND the capture cap is marked truncated rather than silently dropped', async () => {
  const big = tool(20_000)
  const r = (await big.run(CTX, {
    executable: NODE_EXE,
    argv: [script("for (let i=0;i<200000;i++) console.log('PADDING-LINE-'+i)")],
  } as never)) as Res
  assert.equal(r.kind, 'data')
  assert.equal(r.data!.stdoutTruncated, true, 'a capped stream must say it was capped')
})

test('interleaved stderr does not contaminate stdout', async () => {
  const { r } = await run([script("console.log('OUT'); console.error('ERR')")])
  assert.match(r.data!.stdout, /OUT/)
  assert.doesNotMatch(r.data!.stdout, /ERR/, 'stderr must not appear in stdout')
  assert.match(r.data!.stderr, /ERR/)
})

// =============================================================================
// 7. A PROCESS THAT HAS ALREADY EXITED
// =============================================================================

test('a process that exits immediately is still settled and recorded, not lost', async () => {
  // The fastest possible exit. If the listener were attached after the process died, the 'exit' event
  // would never arrive and the step would hang until its timeout - which is the same class of bug as
  // waiting on a pipe, one level earlier.
  const { r, elapsed } = await run([script("process.exit(0)")])
  assert.equal(r.kind, 'data', `must settle. Got ${r.kind}: ${r.reason ?? ''}`)
  assert.equal(r.data!.exitCode, 0)
  assert.ok(elapsed < 10_000, `must not wait out the timeout. Took ${elapsed}ms`)
})

test('an immediate exit 0 and an immediate exit 1 are told apart', async () => {
  const ok = await run([script('process.exit(0)')])
  const bad = await run([script('process.exit(1)')])
  assert.equal(ok.r.kind, 'data', 'exit 0 must be data')
  assert.equal(bad.r.kind, 'failed', 'exit 1 must be failed')
  assert.equal(bad.r.data!.exitCode, 1)
})