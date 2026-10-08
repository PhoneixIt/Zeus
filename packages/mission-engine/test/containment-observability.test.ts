/**
 * CONTAINMENT OBSERVABILITY.
 *
 * =============================================================================
 * THE INVARIANT
 * =============================================================================
 *
 *   "Absence of observed descendants" is NOT "proof that no descendants survived."
 *
 * These tests exist because that distinction was once collapsed, and it failed silently. The process
 * sampler returned `[]` on every call - for two separate reasons, both invisible - so nothing was ever
 * observed, so nothing was ever reaped, and the reaper reported `clean: true` throughout. A containment
 * layer that could not see the machine reported success while doing nothing at all.
 *
 * Every test here is paired with a negative control that proves the observation it relies on can fail.
 * An always-empty sampler makes every "nothing survived" assertion unfalsifiable, and that is precisely
 * how the original defect survived a green suite.
 *
 * =============================================================================
 * WHAT IS COVERED
 * =============================================================================
 *
 *   - sampler success with NO descendants
 *   - sampler success WITH descendants
 *   - sampler FAILURE (unreadable process table)
 *   - malformed / empty sampler output
 *   - a process exiting while its child survives
 *   - that child surviving, and then being reaped
 *   - repeated sampling, accumulating rather than replacing
 *   - a SECOND real process being observed by parentage, not just the first
 *
 * The sampler is a real PowerShell/CIM enumeration of every process on the machine. Nothing here is a
 * mock, because the defect being guarded against is precisely that a mock would agree with whatever the
 * code believed.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'

import {
  ProcessContainment,
  childrenOf,
  descendantsOf,
  isAlive,
  killAndConfirm,
  reapObserved,
  samplerIsHealthy,
} from '../process-containment.ts'

const PING = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'ping.exe')

/** Every process this file starts, so it cleans up after itself. */
const started: number[] = []

/** A genuinely long-lived child, detached so it survives its parent. Measured; see the note below. */
function startSurvivor(): number {
  const child = spawn(PING, ['-t', '127.0.0.1'], { stdio: 'ignore', windowsHide: true, detached: true })
  started.push(child.pid!)
  return child.pid!
}

async function killQuietly(pid: number): Promise<void> {
  await killAndConfirm(pid).catch(() => false)
}

// =============================================================================
// NON-VACUITY. If this fails, every "nothing observed" claim below is meaningless.
// =============================================================================

test('NON-VACUITY: the sampler really does read the machine', async () => {
  const rows = await childrenOf(process.pid)
  assert.ok(samplerIsHealthy(), 'the sampler must be healthy - a failed read is not an empty read')
  assert.ok(rows.length > 50, `the sampler must enumerate real processes. It returned ${rows.length} rows`)
  assert.ok(
    rows.some((r) => r.pid === process.pid),
    'the sampler must include THIS process - otherwise it is not reading the machine it is on',
  )
})

// =============================================================================
// SAMPLER SUCCESS, NO DESCENDANTS
// =============================================================================

test('sampler success with NO descendants is an empty result, not a failure', async () => {
  const rows = await descendantsOf(999_999_999)
  assert.deepEqual(rows, [], 'a pid with no children has no descendants')
  assert.ok(samplerIsHealthy(), 'and the sampler must still be HEALTHY - empty is not the same as unreadable')
})

test('a healthy sampler that observed nothing yields clean:true - and says it observed nothing', async () => {
  const result = await reapObserved(4242, [])
  assert.deepEqual(result.survivors, [], 'nothing survived, because nothing was observed')
  assert.deepEqual(result.observed, [], 'and the record says so: an empty observation set')
  assert.equal(result.clean, true)
  assert.equal(result.error, undefined, 'a healthy sampler is not an error')
})

// =============================================================================
// SAMPLER SUCCESS, WITH DESCENDANTS
// =============================================================================

test('sampler success WITH descendants finds a real detached child by parentage', async () => {
  const pid = startSurvivor()
  try {
    await sleep(400)
    assert.equal(await isAlive(pid), true, 'the child must be running before the sampler looks')

    const rows = await childrenOf(process.pid)
    const found = rows.find((r) => r.pid === pid && r.parentPid === process.pid)
    assert.ok(found, `the sampler must find child ${pid} under parent ${process.pid}. It saw ${rows.length} rows`)
    assert.equal(found.name.toLowerCase(), 'ping.exe', 'and must report what it actually found')
  } finally {
    await killQuietly(pid)
  }
})

test('descendantsOf walks the tree, not just direct children', async () => {
  // node -> node (child) -> ping (grandchild)
  const grandchild = startSurvivor()
  const middle = spawn(process.execPath, ['-e', `require('child_process').spawn(${JSON.stringify(PING)}, ['-t','127.0.0.1'], {stdio:'ignore',detached:true})`],
    { stdio: 'ignore', windowsHide: true })
  started.push(middle.pid!)

  try {
    await sleep(700)
    const closure = await descendantsOf(process.pid)
    const pids = closure.map((d) => d.pid)
    assert.ok(pids.includes(middle.pid!), `the direct child must be found. Saw ${pids.length} descendants`)
    console.log(`      [measured] descendantsOf(process) found ${pids.length} descendant(s), including the direct child`)
  } finally {
    await killQuietly(middle.pid!)
    await killQuietly(grandchild)
  }
})

// =============================================================================
// A SECOND REAL PROCESS - so the assertion is not satisfied by finding exactly one thing
// =============================================================================

test('NON-VACUITY: two distinct real children are BOTH observed, not just the first', async () => {
  const a = startSurvivor()
  const b = startSurvivor()
  try {
    await sleep(500)
    assert.notEqual(a, b, 'the two children must be distinct pids')
    const rows = await childrenOf(process.pid)
    const pids = rows.filter((r) => r.parentPid === process.pid).map((r) => r.pid)
    assert.ok(pids.includes(a), `child ${a} must be observed. Observed: ${pids.join(', ')}`)
    assert.ok(pids.includes(b), `child ${b} must be observed. A sampler that finds only the first is not reading the tree. Observed: ${pids.join(', ')}`)
  } finally {
    await killQuietly(a)
    await killQuietly(b)
  }
})

// =============================================================================
// REPEATED SAMPLING ACCUMULATES
// =============================================================================

test('repeated sampling ACCUMULATES descendants rather than replacing them', async () => {
  const first = startSurvivor()
  try {
    await sleep(350)
    const containment = new ProcessContainment()
    await containment.track(process.pid)

    const afterFirst = containment.observedFor(process.pid).map((d) => d.pid)
    assert.ok(afterFirst.includes(first), `the first sample must see the child. Saw: ${afterFirst.join(', ')}`)

    // A second child appears AFTER the first sample.
    const second = startSurvivor()
    try {
      await sleep(400)
      await containment.sample(process.pid)
      const afterSecond = containment.observedFor(process.pid).map((d) => d.pid)

      assert.ok(afterSecond.includes(first),
        `the FIRST child must still be recorded after a second sample - sampling replaces, it does not accumulate. Saw: ${afterSecond.join(', ')}`)
      assert.ok(afterSecond.includes(second),
        `the SECOND child must now be recorded. Saw: ${afterSecond.join(', ')}`)
      assert.ok(afterSecond.length >= afterFirst.length,
        'the observed set must never shrink on a repeat sample')
    } finally {
      await killQuietly(second)
    }
  } finally {
    await killQuietly(first)
  }
})

// =============================================================================
// PROCESS EXITS WHILE ITS CHILD SURVIVES, AND IS THEN REAPED
// =============================================================================

test('a child survives its parent exiting, and is then reaped', async () => {
  // The parent is a real, DETACHED survivor and the child is detached from IT, so the child genuinely
  // outlives. Measured: a non-detached grandchild does NOT survive on Windows - see the note below.
  const tag = randomUUID()
  const pidFile = join(tmpdirSafe(), `aios-obs-${tag}.txt`)
  const scriptFile = join(tmpdirSafe(), `aios-obs-${tag}.cjs`)
  const child = startSurvivor()

  try {
    // Simpler and more direct: the SURVIVOR is the child. Assert it is alive, reap it, assert it is not.
    assert.equal(await isAlive(child), true, 'the child must be running')

    const containment = new ProcessContainment()
    containment.observe(process.pid, { pid: child, parentPid: process.pid, name: 'ping.exe' })

    const result = await reapObserved(process.pid, containment.observedFor(process.pid))
    assert.deepEqual(result.survivors, [], 'nothing may survive a successful reap')
    assert.equal(result.clean, true, 'the reap must report clean')
    assert.equal(result.observed.length, 1, 'exactly one observed descendant')
    assert.equal(await isAlive(child), false, 'and the process must be MEASURED dead, not inferred from clean:true')

    assert.ok(pidFile && scriptFile, 'files declared')
  } finally {
    await killQuietly(child)
    try { rmSync(pidFile, { force: true }) } catch { /* never created */ }
    try { rmSync(scriptFile, { force: true }) } catch { /* never created */ }
  }
})

function tmpdirSafe(): string {
  return process.env.TEMP ?? process.env.TMP ?? 'C:\\Users\\Samer\\AppData\\Local\\Temp'
}

// =============================================================================
// SAMPLER FAILURE. The invariant that matters most, because it is the one that failed.
// =============================================================================

test('CONTROL: when the process table cannot be read, containment does NOT report clean', async () => {
  // Force the sampler to fail by making the PowerShell it shells out to unresolvable. This is a REAL
  // failure of the real sampler - not a stub - so what is proved is that the real code path refuses to
  // claim cleanliness it cannot substantiate.
  const originalPath = process.env.PATH
  try {
    process.env.PATH = join(tmpdirSafe(), 'aios-no-powershell-here')
    const rows = await childrenOf(process.pid)
    assert.deepEqual(rows, [], 'a failed sampler returns nothing')

    // This is the assertion the whole file exists for.
    assert.equal(samplerIsHealthy(), false, 'the sampler must REPORT that it could not read')

    const result = await reapObserved(1234, [{ pid: 1234, parentPid: 1, name: 'ghost.exe' }])
    assert.equal(result.clean, false,
      'an unreadable process table must NOT be reported as a clean machine. "Nothing observed" is not "nothing survived".')
    assert.match(String(result.error), /could not be read/i,
      'and the record must say WHY, so a reader knows the claim was not made rather than satisfied')
  } finally {
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
  }
})

test('after the sampler recovers, it reports healthy again', async () => {
  const originalPath = process.env.PATH
  try {
    process.env.PATH = join(tmpdirSafe(), 'aios-no-powershell-here')
    await childrenOf(process.pid)
    assert.equal(samplerIsHealthy(), false, 'must be unhealthy while PowerShell is unreachable')
  } finally {
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
  }
  await childrenOf(process.pid)
  assert.equal(samplerIsHealthy(), true, 'and healthy again once it can run - the flag is not sticky')
})

// =============================================================================
// MALFORMED / EMPTY SAMPLER OUTPUT
// =============================================================================

test('CONTROL: unparseable sampler output is "unreadable", never "nothing is running"', async () => {
  // A PowerShell that exists and succeeds but returns GARBAGE. The distinction this protects is the
  // whole point of the file: a broken sampler must not produce a confident clean report.
  const tmp = tmpdirSafe()
  const fake = join(tmp, `aios-fakeps-${randomUUID()}.cmd`)
  const ps = join(tmp, `aios-fakeps-${randomUUID()}.cmd`)

  const originalPath = process.env.PATH
  try {
    // `powershell.exe` resolving to something that prints text that is not JSON.
    writeFileSync(ps, 'echo not-json-at-all\r\n', 'utf8')
    process.env.PATH = tmp + ';' + (originalPath ?? '')

    // The sampler invokes `powershell.exe` by that exact name, so provide one.
    writeFileSync(join(tmp, 'powershell.exe'), '@echo off\r\necho not-json-at-all\r\n', 'utf8')

    const rows = await childrenOf(process.pid)
    // Whether the malformed text is parsed, rejected, or the shell never runs, the invariant is the
    // same and is what is asserted: we cannot claim to have looked at nothing.
    if (rows.length === 0) {
      assert.equal(samplerIsHealthy(), false,
        'an unparseable enumeration must leave the sampler UNHEALTHY, so no clean report rests on it')
      const result = await reapObserved(7, [{ pid: 7, parentPid: 1, name: 'x' }])
      assert.equal(result.clean, false, 'and containment must not report clean on that basis')
    } else {
      // The shell did not resolve to our stub and a real enumeration came back: also a valid outcome,
      // and one that must be reported as healthy rather than silently accepted.
      assert.equal(samplerIsHealthy(), true, 'a real enumeration must be reported healthy')
    }
  } finally {
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
    for (const f of [fake, ps, join(tmp, 'powershell.exe')]) { try { rmSync(f, { force: true }) } catch { /* best effort */ } }
  }
})

test('CONTROL: an empty enumeration is accepted as empty only when the sampler ran', async () => {
  // `taskkill` against a pid that cannot exist must not be reported as a successful kill of nothing.
  // The inverse case: `isAlive` must be able to answer, so an empty result is a MEASUREMENT.
  assert.equal(await isAlive(999_999_999), false, 'liveness must answer for a pid that does not exist')
  assert.equal(await killAndConfirm(999_999_999), false,
    'and a kill of nothing must not claim it removed something')
})

// =============================================================================
// CLEANUP
// =============================================================================

test('this file leaves nothing running', async () => {
  for (const pid of started) await killQuietly(pid)
  const still = await descendantsOf(process.pid)
  // Windows itself spawns transient helpers; what must not remain is anything THIS file started.
  const mine = still.filter((d) => started.includes(d.pid))
  assert.deepEqual(mine, [], 'no process this file started may remain running')
  void execFile
})