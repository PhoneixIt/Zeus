import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'

/**
 * A MISSING PREREQUISITE IS NOT A FAILING CONTROL.
 *
 * Three harnesses - run-filesystem, run-two-step, run-fs-ops-mission - begin with a step that needs
 * the operator host. With the host absent, that step fails, everything downstream is skipped, and
 * the harnesses then dereference a step result that does not exist. The `TypeError` looked like a
 * defect in the filesystem and dependency paths, which is the wrong lesson: nothing of the sort had
 * gone wrong.
 *
 * The exit codes are the classification, and the load-bearing property is the boundary between them:
 *
 *   0  every check passed
 *   1  a check FAILED
 *   2  no check was evaluated (a prerequisite is missing)
 *
 * `blockOnHost` can move a *connection failure* into bucket 2. It must never move a *failed
 * assertion* into it, and that is what the second half of this file pins.
 */

const LIVE = join(process.cwd(), 'packages', 'mission-engine', 'live')
const RUN = (f: string) => ['--experimental-strip-types', '--no-warnings', join(LIVE, f)]

function run(file: string) {
  const r = spawnSync('node', RUN(file), { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 120000 })
  return { code: r.status, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}` }
}

// ============================================================ the exit-code boundary

test('the exit codes stay DISJOINT: blocked is never reported as failed, and vice versa', () => {
  // Run regardless of whether the host is up, because the property being asserted holds either way:
  // an exit of 2 must be explained by HOST-BLOCKED, and an exit of 1 must be explained by FAILURE.
  // A harness that exits 1 while printing HOST-BLOCKED would be laundering a failing control.
  for (const f of ['run-filesystem.ts', 'run-two-step.ts', 'run-fs-ops-mission.ts']) {
    const r = run(f)
    const aCheckRan = /\bFAIL\b|\bPASS\b/.test(r.out)
    assert.ok([0, 1, 2].includes(r.code ?? -1), `${f} exited ${r.code}; expected 0, 1 or 2`)

    if (r.code === 2) {
      // The laundering signature: a check printed a result AND the harness still claims nothing was
      // evaluated. Either alone is legitimate; both together is a failing control reported as a
      // missing prerequisite - the one thing this classification must never do.
      assert.equal(aCheckRan, false,
        `${f} exited blocked but printed a check result - a failing control laundered as host-blocked`)
      assert.match(r.out, /HOST-BLOCKED/, `${f} exited 2, so it must say it is host-blocked`)
      assert.match(r.out, /no check was evaluated/, `${f} must say that no check ran`)
      assert.doesNotMatch(r.out, /TypeError/, `${f} exited 2 for the stated reason, not a crash`)
    }
    if (r.code === 1) {
      assert.match(r.out, /FAIL/, `${f} exited 1, so a check must have failed`)
      assert.doesNotMatch(r.out, /HOST-BLOCKED/, `${f} exited 1; a blocked banner must not appear`)
    }
    if (r.code === 0) {
      assert.doesNotMatch(r.out, /\bFAIL\b/, `${f} exited 0, so nothing failed`)
      assert.doesNotMatch(r.out, /HOST-BLOCKED/, `${f} exited 0; the host was there`)
    }
  }
})

test('the preflight appears EXACTLY ONCE, before any check is computed', () => {
  // This is the mutation that matters most, and the one the behavioural tests above cannot catch.
  //
  // H4 relocates the guard so it sits just before the final `process.exit(failed ? 1 : 0)`. Every
  // check has then already run, so a FAILED assertion exits 2 under a HOST-BLOCKED banner - a
  // failing control laundered as a missing prerequisite. The runtime tests pass either way, because
  // with the host down nothing reaches the checks at all.
  //
  // So this is asserted on the source, where it is visible.
  const IN_SCOPE = ['run-filesystem.ts', 'run-two-step.ts', 'run-fs-ops-mission.ts']
  for (const f of IN_SCOPE) {
    const src = readFileSync(join(LIVE, f), 'utf8')

    const calls = [...src.matchAll(/blockOnHost\(/g)]
    assert.equal(calls.length, 1, `${f} must have exactly one blockOnHost call; ${calls.length} found`)

    const guardAt = src.indexOf('blockOnHost(await hostAvailability())')
    assert.ok(guardAt >= 0, `${f} must guard on the real host probe`)

    // And it must come before the first check. A guard placed among the checks cannot be relied on
    // to stop before them.
    const firstCheck = Math.min(
      ...[src.indexOf('const checks:'), src.indexOf('check('), src.indexOf('checks.push')]
        .filter((i) => i >= 0),
    )
    assert.ok(
      guardAt < firstCheck,
      `${f} must classify a missing host BEFORE computing any check (guard at ${guardAt}, first check at ${firstCheck})`,
    )
  }
})

test('a failing check exits 1; the laundering variant shows a detectable signature', () => {
// Deterministic regardless of whether the host is up, because what is under test is the ORDERING
// of the guard relative to the checks - not the host's actual availability. Each variant pins the
// probe to a fixed answer and asserts on the guard's position.
const variants: Array<{ label: string; body: string; exit: number; aCheckFailed: boolean; launders: boolean }> = [
    {
      // The shipped shape: the guard ran, had nothing to block, and the check still failed.
      label: 'guard first, nothing to block',
      aCheckFailed: true, exit: 1, launders: false,
      body: `
        let failed = 0
        const check = (w: string, ok: boolean) => { if (!ok) { console.log('   FAIL  ' + w); failed += 1 } }
        blockOnHost({ ok: true })
        check('a control that fails', false)
        process.exit(failed ? 1 : 0)
      `,
    },
    {
      // The guard stops BEFORE any check, so a blocked harness never reports a check result.
      label: 'guard first, something to block',
      aCheckFailed: false, exit: 2, launders: false,
      body: `
        let failed = 0
        const check = (w: string, ok: boolean) => { if (!ok) { console.log('   FAIL  ' + w); failed += 1 } }
        blockOnHost({ ok: false, reason: 'host absent' })
        check('a control that fails', false)
        process.exit(failed ? 1 : 0)
      `,
    },
    {
      // THE MUTATION. The guard runs after the checks, so a genuinely FAILED control exits 2 under a
      // blocked banner. Asserted rather than assumed, because the defense is that this is
      // DISTINGUISHABLE: a check printed a result while the harness claims nothing was evaluated.
      label: 'guard AFTER the checks (the laundering mutation)',
      aCheckFailed: true, exit: 2, launders: true,
      body: `
        let failed = 0
        const check = (w: string, ok: boolean) => { if (!ok) { console.log('   FAIL  ' + w); failed += 1 } }
        check('a control that fails', false)
        blockOnHost({ ok: false, reason: 'host absent' })
        process.exit(failed ? 1 : 0)
      `,
    },
  ]

  for (const v of variants) {
    const f = join(process.cwd(), '_mc_exitmap_probe.mts')
    writeFileSync(f, `import { blockOnHost } from './packages/mission-engine/live/live-control.ts'\n${v.body}\n`, 'utf8')
    try {
      const r = spawnSync('node', ['--experimental-strip-types', '--no-warnings', f], { encoding: 'utf8' })
      const aCheckFailed = /\bFAIL\b/.test(r.stdout ?? '')
      const claimsNothingRan = /no check was evaluated/.test(r.stdout ?? '')

      assert.equal(aCheckFailed, v.aCheckFailed, `${v.label}: check-result visibility mismatch`)
      assert.equal(r.status, v.exit, `${v.label}: exited ${r.status}, expected ${v.exit}`)

      // THE PROPERTY: a check that failed must never coincide with a claim that no check was
      // evaluated. The legitimate variants satisfy it; the laundering variant is asserted to
      // VIOLATE it, because a signature you have never seen fire is not a signature.
      if (v.launders) {
        assert.equal(aCheckFailed && claimsNothingRan, true,
          `${v.label}: this mutation was expected to be DETECTABLE, and it was not - the signature does not fire`)
      } else {
        assert.equal(aCheckFailed && claimsNothingRan, false,
          `${v.label}: a failed check coincides with a "nothing was evaluated" claim - that is laundering`)
      }
    } finally {
      rmSync(f, { force: true })
    }
  }
})

test('a host-blocked harness does not leave a crash trace where the assertion used to be', () => {
  // The specific symptom this task is about: `.result` dereferenced on a step that never ran.
  for (const f of ['run-filesystem.ts', 'run-two-step.ts', 'run-fs-ops-mission.ts']) {
    const r = run(f)
    if (r.code === 2) {
      assert.doesNotMatch(
        r.out,
        /Cannot read properties of undefined \(reading '(outcome|evidence)'\)/,
        `${f} still crashes on a step with no result; the preflight did not run first`,
      )
    }
  }
})

test('the harnesses in scope carry the preflight', () => {
  // STATIC, so it cannot silently regress the way a behavioural check can: a harness whose preflight
  // was deleted would still pass the behavioural tests whenever the host happens to be up.
  //
  // SCOPED TO THIS TASK. Thirteen further harnesses also speak to the operator host and do not yet
  // classify a missing one - `run-auto-recovery`, `run-browser-mission`, `run-cross-tool-mission`,
  // `run-dev-mission`, `run-dev-recovery`, `run-durable-mission`, `run-gui-accept`, `run-gui-audit`,
  // `run-interact-mission`, `run-live-mission`, `run-navigation-mission`, `run-repo-mission` and
  // `run-summary-mission`. They are deliberately NOT asserted here, because changing them is a
  // separate bounded task and asserting them now would either fail or broaden this one.
  //
  // Each of those thirteen also reports `FAILURE` rather than a crash when the host is absent, so
  // the mis-classification there is misleading rather than fatal - unlike the three below, which
  // threw a TypeError on a step result that did not exist.
  const IN_SCOPE = ['run-filesystem.ts', 'run-two-step.ts', 'run-fs-ops-mission.ts']
  for (const f of IN_SCOPE) {
    const src = readFileSync(join(LIVE, f), 'utf8')
    assert.match(
      src,
      /blockOnHost\(\s*await hostAvailability\(\)\s*\)/,
      `${f} needs the operator host, so it must classify a missing one before asserting`,
    )
  }
})

test('the remaining host-dependent harnesses are KNOWN to lack the preflight', () => {
  // Not a failure - a measurement, so the follow-up task has a checked number rather than a
  // remembered one. If this count drops without anyone changing the assertion, the assertion is
  // wrong, not the code.
  const hostDependent = readdirSync(LIVE)
    .filter((f) => f.endsWith('.ts') && f.startsWith('run-'))
    .filter((f) => /liveControl|livePermission|observeDesktopTool/.test(readFileSync(join(LIVE, f), 'utf8')))

  const withPreflight = hostDependent.filter((f) =>
    /blockOnHost\(\s*await hostAvailability\(\)\s*\)/.test(readFileSync(join(LIVE, f), 'utf8')))

  // 3 -> 6, and this time on evidence rather than on the assertion's own say-so.
//
// The history of this number: it said 3, but at the verified backup of 2026-10-11 the real
// count was already 5 (run-auto-recovery and run-dev-mission had since gained the preflight),
// and `run-gui-mission.ts` makes it 6. So it was stale before this work started, and the
// fix-it-from-3 stance would have been guessing which number was right.
//
// What settles it is the test below, which opens every file the count is derived from and
// checks the preflight is really in it. The count is not asserted against a remembered number
// any more - it is asserted against the discovery implementation, so it cannot drift silently
// again the way it did. A harness that loses its preflight now fails here by name.
  // 6 -> 8. `run-browser-mission.ts` and `run-dev-recovery.ts` were found WITHOUT this preflight
  // on 2026-10-23: with the host down, run-browser-mission failed late and left its temp dirs
  // behind, and run-dev-recovery crashed trying to grant an approval that had never been
  // requested. Both now classify the missing prerequisite before creating anything or asserting
  // any control. The count is still discovery-derived; the list below names each file.
assert.equal(withPreflight.length, 8, 'eight harnesses now carry the preflight, each verified below')
  // 18 -> 17, with the file that left the set named rather than remembered: this session's
  // browser-navigation work removed `run-navigation-mission.ts`'s dependency on the operator
  // host. It drives headless Chromium over CDP and supplies a mission-scoped control surface
  // whose input methods are never called by navigation steps; the approval gate (a navigation
  // without a grant is still held for a human), the mission-scoped navigation policy and every
  // independent verifier are unchanged, as the recorded mission run demonstrates. The count is
  // discovery-derived, so it fell the moment the file stopped reaching for liveControl/
  // livePermission/observeDesktopTool - the same 3-vs-5 and 17-vs-18 corrections above: the
  // measured number is corrected to what is there, and the failure it produced was the check
  // working rather than the code being wrong.
  assert.equal(hostDependent.length, 17, 'browser navigation no longer reaches for the operator host')
})

test('the preflight count is derived from the files themselves, not remembered', () => {
  // Enumerated explicitly. If someone adds or removes a preflight, this names the file instead of
  // failing as an anonymous count mismatch.
  const expected = [
    'run-auto-recovery.ts',
    'run-browser-mission.ts',
    'run-dev-mission.ts',
    'run-dev-recovery.ts',
    'run-filesystem.ts',
    'run-fs-ops-mission.ts',
    'run-gui-mission.ts',
    'run-two-step.ts',
  ]
  const hostDependent = readdirSync(LIVE)
    .filter((f) => f.endsWith('.ts') && f.startsWith('run-'))
    .filter((f) => /liveControl|livePermission|observeDesktopTool/.test(readFileSync(join(LIVE, f), 'utf8')))

  for (const f of expected) {
    assert.ok(hostDependent.includes(f), `${f} should be host-dependent`)
    assert.match(
      readFileSync(join(LIVE, f), 'utf8'),
      /blockOnHost\(\s*await hostAvailability\(\)\s*\)/,
      `${f} should carry the preflight`,
    )
  }
  const withPreflight = hostDependent.filter((f) =>
    /blockOnHost\(\s*await hostAvailability\(\)\s*\)/.test(readFileSync(join(LIVE, f), 'utf8')))
  assert.deepEqual([...withPreflight].sort(), [...expected].sort(),
    'the set of harnesses with the preflight changed; update this list deliberately')
})

test('the new GUI mission is classified as host-dependent WITH the preflight', () => {
  // A focused assertion rather than only a count, so that if this harness later stops reading
  // `liveControl`, the failure names the harness instead of showing up as an unrelated delta.
  const src = readFileSync(join(LIVE, 'run-gui-mission.ts'), 'utf8')
  assert.ok(
    /liveControl|livePermission|observeDesktopTool/.test(src),
    'run-gui-mission.ts should be discovered as host-dependent',
  )
  assert.ok(
    /blockOnHost\(\s*await hostAvailability\(\)\s*\)/.test(src),
    'run-gui-mission.ts should carry the same preflight the other host-dependent harnesses use',
  )
})

// ============================================================ the helper itself

test('blockOnHost exits 2 with a classified banner when the host is missing', () => {
  // A child process, because the real thing calls process.exit.
  const src = `
    import { blockOnHost } from './packages/mission-engine/live/live-control.ts'
    blockOnHost({ ok: false, reason: 'Operator host is not running: no state file' })
    console.log('UNREACHABLE: this line must never print')
  `
  const f = join(process.cwd(), '_mc_block_probe.mts')
  writeFileSync(f, src, 'utf8')
  try {
    const r = spawnSync('node', ['--experimental-strip-types', '--no-warnings', f], { encoding: 'utf8' })
    assert.equal(r.status, 2, 'the not-evaluated code')
    assert.match(r.stdout ?? '', /HOST-BLOCKED/)
    assert.match(r.stdout ?? '', /no check was evaluated/)
    assert.match(r.stdout ?? '', /scripts\/start-operator-host\.mjs/, 'and the remedy is named')
    assert.doesNotMatch(r.stdout ?? '', /UNREACHABLE/, 'it must actually stop')
  } finally {
    rmSync(f, { force: true })
  }
})

test('blockOnHost does NOTHING when the host is available - it cannot block a passing run', () => {
  const src = `
    import { blockOnHost } from './packages/mission-engine/live/live-control.ts'
    blockOnHost({ ok: true })
    console.log('REACHED')
  `
  const f = join(process.cwd(), '_mc_block_probe2.mts')
  writeFileSync(f, src, 'utf8')
  try {
    const r = spawnSync('node', ['--experimental-strip-types', '--no-warnings', f], { encoding: 'utf8' })
    assert.equal(r.status, 0, 'an available host must not block anything')
    assert.match(r.stdout ?? '', /REACHED/)
    assert.doesNotMatch(r.stdout ?? '', /HOST-BLOCKED/)
  } finally {
    rmSync(f, { force: true })
  }
})


