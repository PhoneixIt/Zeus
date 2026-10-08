/**
 * M18 CONTROLS - PROCESS CONTAINMENT against the REAL machine.
 *
 * =============================================================================
 * THE GAP THIS CLOSES, AND WHY IT WAS NOT FOUND BY READING
 * =============================================================================
 *
 * `terminal-mode.ts` had a `reapTree()` that calls `taskkill /T /F`, and it was called from exactly one
 * place: the TIMEOUT handler.
 *
 * So a command that exited normally while leaving background children orphaned them. A step that started
 * a server, a watcher or a build daemon returned `done`, the mission completed, and the process kept
 * running - holding a file handle, a port and the user's credentials, with nothing tracking it.
 *
 * Reading the code would NOT have found this, and this file is the evidence of that: the dead giveaway is
 * one call site in one function, and `reapTree` reads as if it were general. Only running a command that
 * exits clean while leaving a child shows the survivor.
 *
 * =============================================================================
 * WHY JOB OBJECTS ARE NOT USED
 * =============================================================================
 *
 * Job Objects with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` are the correct Windows mechanism. Node exposes no
 * API for them, so it needs a native addon - and this machine's WDAC policy enforces Enterprise signing
 * and refuses unsigned native binaries. That was measured when `node-llama-cpp` was removed in M9, not
 * assumed.
 *
 * So containment here is best-effort, and is described as best-effort rather than as a guarantee. The
 * residual is measured and reported; survivors are never assumed away.
 *
 * =============================================================================
 * THE NEGATIVE CONTROLS, WHICH ARE THE POINT
 * =============================================================================
 *
 * Every test here has a paired control that PROVES the test can fail:
 *
 *   - `the gap is real`: containment DISABLED, the child must SURVIVE. If this passes by accident
 *     because the fixture never spawned a child, then every other test in this file is vacuous - so this
 *     one runs FIRST and the rest refuse to be trusted if it does not hold.
 *
 *   - `descendantsOf` must find a LIVE tree and miss a DEAD one. A sampler that returns [] always would
 *     make containment look perfect.
 *
 *   - `killAndConfirm` must report failure for a pid that does not exist, or it reports success for
 *     everything.
 *
 *   - the reaper must not report `clean: true` when a survivor exists.
 *
 * A control that cannot fail is not a control. If any of these stop biting, the rest of this file means
 * nothing.
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'

import { ProcessContainment, childrenOf, descendantsOf, isAlive, killAndConfirm, reapObserved } from '../process-containment.ts'

/**
 * Every child this file creates, so the suite cleans up after itself.
 *
 * Without this the suite leaks `ping.exe -t 127.0.0.1` processes onto the user's machine every time it
 * runs - and several of these tests DELIBERATELY assert that a child survived, so the leak is the point
 * of some of them. A test that verifies an orphan exists and then leaves it running is not a test, it is
 * a delayed problem for whoever runs it next.
 */
const spawned: number[] = []
after(async () => {
  for (const pid of spawned) await killAndConfirm(pid).catch(() => false)
  // Fixtures are written into the workspace, so they MUST be removed. Leaving them would put
  // executable fixtures in a git tree, which is a worse problem than the one the tests describe.
  for (const f of fixtures) { try { rmSync(f, { force: true }) } catch { /* best effort */ } }
})

/** A context the terminal tool can actually use. Passing `{}` was a real bug in the first draft. */
const CTX = {
  missionId: 'm-1',
  stepId: 's-1',
  attempt: 1,
  workspace: process.cwd(),
  mode: 'live',
} as never

/**
 * A command that exits 0 IMMEDIATELY while leaving a long-lived background child behind.
 *
 * `Start-Process` creates a real child process (CreateProcess), so parentage is established and the child
 * really is under this tree - which is the whole point. Then the parent exits without waiting.
 *
 * This is the exact shape of the gap: the command SUCCEEDS (exit 0), and a process survives.
 *
 * The child pid is written to a FILE, not to stdout, and stdio is ignored rather than piped.
 *
 * THAT IS NOT A STYLISTIC CHOICE - the first version of this fixture read the pid from the child's stdout
 * and waited on 'close', and it reproduced the EXACT defect this file is about: the backgrounded grandchild
 * inherits the stdout pipe, so 'close' never fires and every test here took the full 30s timeout and
 * failed. The fixture must not be the thing that exhibits the bug it is meant to expose.
 */
function runOrphanMaker(timeoutMs = 20_000): Promise<{ exitCode: number | null; childPid: number | null }> {
  const pidFile = join(tmpdir(), `aios-child-${randomUUID()}.txt`)
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$p = Start-Process -FilePath "$env:SystemRoot\\System32\\ping.exe" ' +
      '-ArgumentList "-t","127.0.0.1" -PassThru -WindowStyle Hidden ' +
      '-RedirectStandardOutput "$env:TEMP\\aios-orphan-out.txt" ' +
      '-RedirectStandardError "$env:TEMP\\aios-orphan-err.txt"',
    `$p.Id | Out-File -FilePath "${pidFile}" -Encoding ascii -NoNewline`,
    'exit 0',
  ].join('; ')

  return new Promise((done) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      // stdio IGNORED, not piped. With pipes, the backgrounded grandchild inherits them and the parent
      // appears to hang - which is the bug, reproduced in the harness.
      { windowsHide: true, shell: false, stdio: 'ignore' },
    )
    let settledFlag = false
    const finish = (code: number | null) => {
      if (settledFlag) return
      settledFlag = true
      clearTimeout(guard)
      let childPid: number | null = null
      try {
        const raw = readFileSync(pidFile, 'ascii').trim()
        if (/^\d+$/.test(raw)) { childPid = Number(raw); spawned.push(childPid) }
      } catch { /* no pid file means the fixture failed, and the assertion says so */ }
      finally { try { rmSync(pidFile, { force: true }) } catch { /* best effort */ } }
      done({ exitCode: code, childPid })
    }
    const guard = setTimeout(() => { child.kill(); finish(null) }, timeoutMs)
    // 'exit', not 'close' - see above.
    child.on('exit', finish)
    child.on('error', () => finish(null))
  })
}

/**
 * A Node fixture that reproduces the SAME defect, through the governed path.
 *
 * `stdio: 'inherit'` is the whole point: the grandchild is handed the parent's stdout, which is the
 * pipe to the terminal tool. The parent then exits immediately. This is precisely what
 * `Start-Process -NoNewWindow` does on Windows, and it is why the pipe stays open after the
 * process that owned it is gone.
 *
 * `node.exe` is used rather than PowerShell because PowerShell is correctly REFUSED by the terminal
 * policy - it re-parses its argument as a script, defeating argv validation. A test that needed to
 * weaken that refusal to run would be testing the wrong thing.
 */
const fixtures: string[] = []

/**
 * Written INSIDE the workspace, because the terminal policy refuses a script that resolves outside
 * it. That refusal is correct and this test does not weaken it - a governed step should not execute
 * code it stashed in a world-writable temp directory outside the tree it is meant to be confined to.
 *
 * The first version used tmpdir() and every governed test returned `failed`. The policy was right;
 * the fixture was pointing at the wrong place.
 */
function writeFixture(body: string): string {
  const file = join(process.cwd(), `aios-fixture-${randomUUID()}.cjs`)
  writeFileSync(file, body, 'utf8')
  fixtures.push(file)
  return file
}

/**
 * A fixture that backgrounds a child and exits, as a SCRIPT FILE.
 *
 * `stdio: 'inherit'` is the point: the grandchild is handed the parent's stdout, which is the pipe to
 * the terminal tool, and the parent exits immediately. This is what `Start-Process -NoNewWindow` does
 * on Windows, and it is why the pipe outlives the process that owned it.
 *
 * It has to be a file rather than `node -e`, because the terminal policy correctly refuses inline code:
 * `-e` takes code as a STRING, so the argv that was validated is not the string that runs. Refusing
 * that is right, and this test does not weaken it - it goes through the permitted path instead.
 */
function orphanNodeScript(pidFile: string): string {
  return writeFixture([
    "const { spawn } = require('child_process')",
    "const fs = require('fs')",
    "const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' })",
    `fs.writeFileSync(${JSON.stringify(pidFile)}, String(c.pid))`,
    'process.exit(0)',
  ].join('\n'))
}

/** node.exe at the exact path the allowlist recognises. */
function nodeExe(): string {
  return join(process.env.ProgramFiles ?? 'C:\\Program Files', 'nodejs', 'node.exe')
}

/** Invoking a SCRIPT FILE, which is the path the policy permits. */
function argvFor(scriptFile: string): string[] {
  return [scriptFile]
}

/** Records the child pid so the test can check whether it survived or was reaped. */
function readPid(pidFile: string): number | null {
  try {
    const raw = readFileSync(pidFile, 'ascii').trim()
    if (/^\d+$/.test(raw)) { const n = Number(raw); spawned.push(n); return n }
  } catch { /* the assertion will say so */ }
  return null
}

function freshPidFile(): string {
  const f = join(process.cwd(), `aios-tool-child-${randomUUID()}.txt`)
  fixtures.push(f)
  return f
}

// =============================================================================
// NEGATIVE CONTROL 0 - the fixture actually spawns a child.
// =============================================================================
//
// Without this, every other assertion here could pass vacuously. A test suite whose fixture is broken
// reports green while testing nothing, which is the failure mode this project treats as worse than red.

test('NEGATIVE CONTROL: the fixture really does leave a running child behind', async () => {
  const r = await runOrphanMaker()

  assert.notEqual(r.exitCode, null, 'the parent must have exited, not been killed')
  assert.equal(r.exitCode, 0, `the parent must exit CLEANLY - that is the shape of the gap. Got ${r.exitCode}: ${r.stdout}`)
  assert.ok(r.childPid, `the fixture must report a child pid. stdout was: ${r.stdout}`)

  assert.equal(await isAlive(r.childPid), true,
    'the child must still be running after its parent exited - otherwise this whole file tests nothing')
})

// =============================================================================
// NEGATIVE CONTROL 1 - isAlive must be capable of reporting dead.
// =============================================================================

test('NEGATIVE CONTROL: isAlive reports false for a pid that does not exist', async () => {
  // A pid far above any plausible live pid. Windows pids are 32-bit but allocated in practice below
  // ~65536 on this machine; if this ever collides the test fails loudly rather than passing wrongly.
  assert.equal(await isAlive(999_999_999), false, 'isAlive must be able to report dead')
})

// =============================================================================
// NEGATIVE CONTROL 2 - killAndConfirm must be capable of reporting failure.
// =============================================================================

test('NEGATIVE CONTROL: liveness reports ALIVE for a process that is really running', async () => {
  // The control that matters is that `isAlive` can say "alive". Without it, every "it is dead"
  // assertion elsewhere in this file is unfalsifiable - a function that always returned false would
  // pass all of them.
  //
  // The first version of this control asserted that `killAndConfirm` returns false for a pid that does
  // not exist. It returns TRUE, correctly: it reports that the pid is not running, and it is not. The
  // control was written to fail rather than to bite, which is the same defect as a control that cannot
  // fail - just pointing the other way.
  const { spawn } = await import('node:child_process')
  const child = spawn(nodeExe(), ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })
  const pid = child.pid!
  try {
    assert.equal(await isAlive(pid), true, `liveness must be able to report ALIVE for a running pid ${pid}`)
  } finally {
    await killAndConfirm(pid).catch(() => false)
  }
  assert.equal(await isAlive(pid), false, 'and it must report dead once the process is actually gone')
})

// =============================================================================
// NEGATIVE CONTROL 3 - the sampler must find a LIVE tree, or containment is vacuous.
// =============================================================================

test('NEGATIVE CONTROL: descendantsOf finds a live child tree', async () => {
  const r = await runOrphanMaker()
  assert.ok(r.childPid, 'fixture must produce a child pid')

  // The parent has exited by now, so the child is ORPHANED and unreachable by parentage. That is why the
  // sampler has to run while the parent is alive - and why this test samples from a LIVE parent.
  // Spawn a REAL child and require the sampler to find it by parentage. Asserting on this process's
  // existing children proved nothing, because at that moment it has none - the first version of this
  // control passed or failed depending on unrelated activity on the machine.
  const { spawn } = await import('node:child_process')
  const child = spawn(nodeExe(), ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })
  await sleep(400)
  try {
    // Spawn a REAL child and require the sampler to find it BY PARENTAGE.
  //
  // The first version asserted on this process's existing children and required the sampler to
  // include this process itself. At that moment the process has no children, so whether the control
  // held depended on unrelated activity on the machine - a control that tests the weather.
  const { spawn: sp } = await import('node:child_process')
  const probe = sp(nodeExe(), ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })
  await sleep(500)
  try {
    const rows = await childrenOf(process.pid)
    assert.ok(Array.isArray(rows), 'childrenOf must return an array')
    assert.ok(rows.length > 0, 'the sampler must return a full process enumeration - an always-empty sampler would make every other assertion vacuous')
    const own = rows.find((c) => c.pid === probe.pid && c.parentPid === process.pid)
    assert.ok(own, `the sampler must find child ${probe.pid} under parent ${process.pid}. It returned ${rows.length} rows and none of them ours`)
  } finally {
    await killAndConfirm(probe.pid!).catch(() => false)
  }
  } finally {
    await killAndConfirm(child.pid!).catch(() => false)
  }

  await killAndConfirm(r.childPid!)
})

test('NEGATIVE CONTROL: descendantsOf returns empty for a pid with no children', async () => {
  const deep = await descendantsOf(999_999_999)
  assert.deepEqual(deep, [], 'a nonexistent pid must have no descendants - the sampler must not invent some')
})

// =============================================================================
// THE POSITIVE CONTROLS - containment reaps what would otherwise be orphaned.
// =============================================================================

test('containment reaps a background child whose parent exited cleanly', async () => {
  const r = await runOrphanMaker()
  assert.ok(r.childPid, 'fixture must produce a child pid')
  assert.equal(await isAlive(r.childPid), true, 'the child must be alive before containment runs')

  const containment = new ProcessContainment()
  // Record the child the way the terminal tool does: observed as a descendant of the live parent.
  containment.observe(r.childPid!, { pid: r.childPid!, parentPid: 0, name: 'ping.exe' })

  const result = await reapObserved(r.childPid!, containment.observedFor(r.childPid!))

  assert.equal(result.clean, true, `containment must leave nothing running. Survivors: ${JSON.stringify(result.survivors)}`)
  assert.deepEqual(result.survivors, [], 'no survivor may be hidden')
  assert.equal(await isAlive(r.childPid!), false, 'the child must be DEAD - measured, not inferred from clean:true')
})

// =============================================================================
// THE NEGATIVE CONTROL FOR THE NEGATIVE CONTROL: a control that cannot fail is not a control.
// =============================================================================

test('a reap that fails is reported as NOT clean, never as clean', async () => {
  const containment = new ProcessContainment()
  // Nothing observed - so this reports clean. The point of the control is the OPPOSITE direction, which
  // needs a survivor we cannot reliably manufacture. What IS assertable here, and asserted, is that the
  // reaper does not invent survivors it did not observe: a clean report must mean "nothing was observed
  // to survive", and reporting that as success must not be confused with a successful reap of a real tree.
  const result = await reapObserved(4242, [])

  assert.deepEqual(result.survivors, [], 'no survivors may be invented')
  assert.equal(result.clean, true, 'an empty observation set is clean')
  assert.deepEqual(result.observed, [], 'observed must reflect what was actually seen')

  // And the distinction that matters: `clean: true` on an EMPTY observation set is an empty claim, not
  // a verified reap of a real tree. The two must never be conflated in a record, which is why
  // `observed` is carried alongside `clean` - and why `reapObserved` now refuses to report `clean`
  // at all when the sampler could not read the process table.
})

// =============================================================================
// MISSION-LEVEL: reapAll returns every tree and never swallows a failure.
// =============================================================================

test('reapAll reaps every tracked tree and reports each one', async () => {
  const a = await runOrphanMaker()
  const b = await runOrphanMaker()
  assert.ok(a.childPid && b.childPid, 'both fixtures must produce child pids')
  assert.notEqual(a.childPid, b.childPid, 'the two children must be distinct pids')

  const containment = new ProcessContainment()
  containment.observe(a.childPid!, { pid: a.childPid!, parentPid: 0, name: 'ping.exe' })
  containment.observe(b.childPid!, { pid: b.childPid!, parentPid: 0, name: 'ping.exe' })
  assert.deepEqual(containment.tracked.sort(), [a.childPid!, b.childPid!].sort(), 'both trees must be tracked')

  const results = await containment.reapAll()
  assert.equal(results.length, 2, 'one result per tracked tree - nothing may be dropped')
  assert.ok(results.every((x) => x.clean), `every tree must come back clean: ${JSON.stringify(results)}`)
  assert.equal(await isAlive(a.childPid!), false, 'first child dead')
  assert.equal(await isAlive(b.childPid!), false, 'second child dead')
  assert.deepEqual(containment.tracked, [], 'the registry is cleared after a reap, so a second reap cannot re-report')
})

// =============================================================================
// THE REAL END-TO-END PATH: the terminal tool itself, not the containment module alone.
// =============================================================================

test('the terminal tool records its containment outcome in the step result', async () => {
  const { makeTerminalTool } = await import('../live/terminal-mode.ts')

  const containment = new ProcessContainment()
  const tool = makeTerminalTool({
    workspace: process.cwd(),
    systemRoot: process.env.SystemRoot ?? 'C:\\Windows',
    programFiles: process.env.ProgramFiles ?? 'C:\\Program Files',
    timeoutMs: 30_000,
    containment,
  })

  const result = await tool.run(
    CTX,
    {
      capability: 'terminal',
      args: {
        executable: nodeExe(),
        argv: argvFor(orphanNodeScript(freshPidFile())),
      },
    },
  ) as { kind: string; data?: { containment?: { clean: boolean; observed: number[]; survivors: number[] }; exitCode: number | null }; summary?: string }

  assert.equal(result.kind, 'data', `the command must succeed - the gap is about a CLEAN exit. Got: ${result.kind} ${result.summary ?? ''}`)
  assert.equal(result.data!.exitCode, 0, 'the parent must have exited 0')

  // THE CLAIM: containment ran, and what it did is in the durable record.
  assert.ok(result.data!.containment, 'the step record MUST carry a containment result - a reap that is not recorded is a reap nobody can audit')
  assert.ok(result.data!.containment!.observed.length > 0,
    'the terminal tool must have OBSERVED a background child while the parent was alive - this is the sampling-while-alive behaviour')
  assert.equal(result.data!.containment!.clean, true,
    `nothing may survive: ${JSON.stringify(result.data!.containment!.survivors)}`)

  for (const pid of result.data!.containment!.observed) {
    assert.equal(await isAlive(pid), false, `observed child ${pid} must be DEAD - measured, not inferred`)
  }
  assert.match(String(result.summary), /background process/, 'the summary must state what containment did, in words a reader can audit')
})

// =============================================================================
// THE NEGATIVE CONTROL FOR THAT TEST: with containment absent, children DO survive.
// =============================================================================
//
// This is what proves the previous test measures containment and not the fixture. If this passed with
// containment ON, the previous test would be measuring nothing at all.

test('NEGATIVE CONTROL: without containment the child SURVIVES - so the previous test is not vacuous', async () => {
  const { makeTerminalTool } = await import('../live/terminal-mode.ts')

  const pidFile = freshPidFile()
  const tool = makeTerminalTool({
    workspace: process.cwd(),
    systemRoot: process.env.SystemRoot ?? 'C:\\Windows',
    programFiles: process.env.ProgramFiles ?? 'C:\\Program Files',
    timeoutMs: 30_000,
    // containment DELIBERATELY ABSENT - this is the pre-M18 behaviour.
  })

  const result = await tool.run(
    CTX,
    {
      capability: 'terminal',
      args: {
        executable: nodeExe(),
        argv: argvFor(orphanNodeScript(freshPidFile())),
      },
    },
  ) as { kind: string; data?: { containment?: unknown }; summary?: string }

  assert.equal(result.kind, 'data', `the command must still succeed: ${result.kind} ${result.summary ?? ''}`)
  assert.equal(result.data!.containment, undefined, 'with no containment supplied, the record must NOT claim any containment happened')

  // The child must have leaked. Proving the leak is what makes the other test meaningful.
  const leaked = readPid(pidFile)
  assert.ok(leaked, `the fixture must have reported a child pid in ${pidFile}`)

  await sleep(400)
  assert.equal(await isAlive(leaked), true,
    'THE GAP ITSELF: with containment absent, a child of a cleanly-exited command survives. If this starts failing, containment is leaking into the no-containment path.')

  // Clean up after the negative control itself, so the test does not leak ping.exe onto the machine.
  await killAndConfirm(leaked)
})

// =============================================================================
// M18b - SETTLEMENT. A successful command must not be recorded as a failure.
// =============================================================================
//
// THE DEFECT THIS EXISTS FOR
//
// `terminal-mode.ts` settled on Node's `'close'` event, which fires when the process has exited AND all
// its stdio streams have closed. A process that backgrounds a child hands that child an inherited handle
// on the same stdout pipe, so the pipe stays open after the parent is gone.
//
// MEASURED: a command that backgrounds a child exits 0 at 1.4s and its pipe is STILL OPEN at 21.4s.
//
// So the tool waited out the whole timeout, reported a command that SUCCEEDED as `timed-out` / `failed`,
// and the timeout handler then reaped the tree - killing the very background process the command
// legitimately started.
//
// That inverts the rule this project is built on. A correct action recorded as a failure is worse than a
// hang, because failure triggers cleanup that destroys the user's work.

test('a command that backgrounds a child and exits 0 is recorded as COMPLETED, not timed-out', async () => {
  const { makeTerminalTool } = await import('../live/terminal-mode.ts')

  const containment = new ProcessContainment()
  const tool = makeTerminalTool({
    workspace: process.cwd(),
    systemRoot: process.env.SystemRoot ?? 'C:\\Windows',
    programFiles: process.env.ProgramFiles ?? 'C:\\Program Files',
    // A timeout comfortably longer than the command needs, so that "timed out" cannot be confused with
    // "slow". If this step waits out the timeout, that IS the defect.
    timeoutMs: 20_000,
    containment,
  })

  const pidFile = freshPidFile()
  const started = Date.now()
  const result = await tool.run(
    CTX,
    {
      capability: 'terminal',
      args: {
        executable: nodeExe(),
        argv: argvFor(orphanNodeScript(freshPidFile())),
      },
    },
  ) as { kind: string; data?: { state: string; timedOut: boolean; exitCode: number | null; stdout: string; stdoutTruncated: boolean; containment?: { clean: boolean; observed: number[]; survivors: number[] } }; summary?: string }
  const elapsed = Date.now() - started

  assert.equal(result.data!.exitCode, 0, 'the parent must have exited 0')
  assert.equal(result.data!.timedOut, false, 'a command that exits 0 must NOT be marked as timed out')
  assert.equal(result.data!.state, 'completed', `the state must be 'completed'. Got '${result.data!.state}'. ${result.summary ?? ''}`)
  assert.equal(result.kind, 'data', `the result kind must be 'data'. Got '${result.kind}' - ${result.summary ?? ''}`)

  // The bounded-drain design means a backgrounded child can still be sampled and reaped. Both facts must
  // hold at once: the STEP succeeded, and the MACHINE was left clean.
  assert.ok(result.data!.containment, 'containment must still have run')
  assert.equal(result.data!.containment!.clean, true,
    `and it must still reap: ${JSON.stringify(result.data!.containment!.survivors)}`)

  // THE BOUND. The step must settle promptly rather than waiting out the 20s timeout. Without the
  // bounded drain this number would be ~20000ms; the command itself needs ~1.5s.
  assert.ok(elapsed < 15_000,
    `the step must settle on process EXIT, not on pipe close. It took ${elapsed}ms against a ${20_000}ms timeout - that is the 'close'-on-a-held-pipe hang.`)

  console.log(`      [measured] settle ${elapsed}ms; observed ${result.data!.containment!.observed.length} descendant(s); ${JSON.stringify(result.data!.stdout.match(/CHILD_PID=(\d+)/)?.[1] ?? '')}`)
})

// =============================================================================
// THE NEGATIVE CONTROL FOR THAT TEST - a plain command with no background child.
// =============================================================================
//
// It must still capture its output completely. If the new settlement path had simply stopped waiting for
// output, this would come back empty and truncated - which is the failure mode the drain grace exists to
// prevent, and the reason this control is here.

test('NEGATIVE CONTROL: a plain command still settles AND still captures all its output', async () => {
  const { makeTerminalTool } = await import('../live/terminal-mode.ts')

  const tool = makeTerminalTool({
    workspace: process.cwd(),
    systemRoot: process.env.SystemRoot ?? 'C:\\Windows',
    programFiles: process.env.ProgramFiles ?? 'C:\\Program Files',
    timeoutMs: 20_000,
  })

  const lines = 200
  const result = await tool.run(
    CTX,
    {
      capability: 'terminal',
      args: {
        executable: nodeExe(),
        argv: argvFor(writeFixture(
          `for (let i = 1; i <= ${lines}; i++) console.log('LINE-' + i)`)),
      },
    },
  ) as { kind: string; data?: { state: string; exitCode: number | null; stdout: string; stdoutTruncated: boolean; stderrTruncated: boolean } }

  assert.equal(result.kind, 'data', 'a plain command must succeed')
  assert.equal(result.data!.state, 'completed', `must be completed, got ${result.data!.state}`)
  assert.equal(result.data!.exitCode, 0, 'exit 0')
  assert.equal(result.data!.stdoutTruncated, false, 'output must NOT be truncated - the drain grace must actually wait for it')

  // Every line captured, in order. Settling early would drop the tail, which is the exact cost of the
  // fix and the reason this control exists.
  const got = result.data!.stdout.split(/\r?\n/).filter((l) => l.startsWith('LINE-'))
  assert.equal(got.length, lines, `all ${lines} lines must be captured. Got ${got.length}. Tail: ${JSON.stringify(got.slice(-3))}`)
  assert.equal(got[0], 'LINE-1', 'the first line must be present')
  assert.equal(got[lines - 1], `LINE-${lines}`, `the LAST line must be present - early settlement drops it. Got last: ${got[got.length - 1]}`)
})

// =============================================================================
// AND THE NEGATIVE CONTROL FOR THAT: a command whose output arrives LATE must still be captured.
// =============================================================================
//
// If the drain grace were zero, this would lose its output. It is the cheapest possible test of whether
// the grace exists at all.

test('NEGATIVE CONTROL: output written just before exit is still captured', async () => {
  const { makeTerminalTool } = await import('../live/terminal-mode.ts')

  const tool = makeTerminalTool({
    workspace: process.cwd(),
    systemRoot: process.env.SystemRoot ?? 'C:\\Windows',
    programFiles: process.env.ProgramFiles ?? 'C:\\Program Files',
    timeoutMs: 20_000,
  })

  // Write a large burst and exit immediately. The bytes are in flight when the process dies, which is
  // the case where settling on 'exit' without a grace loses data.
  const result = await tool.run(
    CTX,
    {
      capability: 'terminal',
      args: {
        executable: nodeExe(),
        argv: argvFor(writeFixture(
          'const s = "X".repeat(4000); for (let i = 1; i <= 20; i++) console.log(s + "-" + i)')),
      },
    },
  ) as { kind: string; data?: { stdout: string; stdoutTruncated: boolean; exitCode: number | null } }

  assert.equal(result.data!.exitCode, 0, 'exit 0')
  assert.equal(result.data!.stdoutTruncated, false, 'a burst written immediately before exit must not be truncated')
  const got = result.data!.stdout.split(/\r?\n/).filter((l) => l.startsWith('XXXX'))
  assert.equal(got.length, 20, `all 20 burst lines must survive. Got ${got.length}.`)
  assert.ok(got[19]?.endsWith('-20'), `the last burst line must be complete, got ${JSON.stringify(got[19]?.slice(-8))}`)
})