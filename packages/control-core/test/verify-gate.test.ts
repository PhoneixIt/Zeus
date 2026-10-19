/**
 * M23 CONTROLS - the verification gate can fail.
 * =============================================================================
 *
 * `verify-gate.mjs` now runs on `npm test`. Its entire value is that a failing check makes the whole
 * command fail. That is a property of CODE, and code that has only ever been seen passing has not
 * been shown to work.
 *
 * So this file does not test the unit tests, the audit, or the syntax check. Those have their own
 * tests. It tests the GATE: that a non-zero exit anywhere propagates, that a check which never starts
 * is a failure rather than a pass, and that the summary names what failed.
 *
 * Every control here drives the real gate as a child process with a TEMPORARY check list. Nothing is
 * stubbed inside the gate, and no real check is ever made to fail - the three real checks stay green
 * and untouched. What fails is a throwaway `node -e` that exits non-zero on demand.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const GATE = join(ROOT, 'verify-gate.mjs')

/** Drive the real gate against a temporary check list. Returns its exit code and output. */
function runGate(checks: { name: string; args: string[] }[]): { code: number; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'aios-gate-'))
  try {
    const listFile = join(dir, 'checks.json')
    writeFileSync(listFile, JSON.stringify(checks), 'utf8')
    const r = spawnSync(process.execPath, [GATE], {
      encoding: 'utf8',
      env: { ...process.env, AIOS_VERIFY_CHECKS: listFile },
      timeout: 120_000,
    })
    return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const ok = ['-e', 'console.log("ok")']
const bad = ['-e', 'console.error("deliberate failure"); process.exit(3)']

// ============================================================================================
// THE SUCCESS PATH
// ============================================================================================

test('the gate reports PASS when every check it was given exits zero', () => {
  const { code, out } = runGate([
    { name: 'first', args: ok },
    { name: 'second', args: ok },
  ])
  assert.equal(code, 0, `an all-green gate must exit 0. OUTPUT WAS:\n${out}`)
  assert.match(out, /ALL CHECKS PASS/)
})

// ============================================================================================
// THE GATE CAN FAIL - the only reason the green above means anything
// ============================================================================================

test('CONTROL: a non-zero check makes the gate exit non-zero', () => {
  const { code, out } = runGate([{ name: 'failing-check', args: bad }])
  assert.notEqual(code, 0, `the whole point of this gate is that a failure propagates. OUT:\n${out}`)
  assert.match(out, /1 CHECK\(S\) FAILED: failing-check/,
    `the failure must be NAMED - "npm test failed" is not actionable. OUT:\n${out}`)
})

test('CONTROL: the exit code is non-zero even when an EARLIER check passed', () => {
  // 0 -> failure is the transition `npm test` actually makes. If the gate short-circuited or only
  // remembered the last status, this is the case that would slip through.
  const { code } = runGate([{ name: 'green', args: ok }, { name: 'red', args: bad }])
  assert.notEqual(code, 0, 'a green check must not mask a later failure')
})

test('CONTROL: a failure in the FIRST check still fails the gate when the last one passes', () => {
  // The mirror image: a gate that only remembered the LAST status would pass this.
  const { code } = runGate([{ name: 'red', args: bad }, { name: 'green', args: ok }])
  assert.notEqual(code, 0, 'a later green check must not mask an earlier failure')
})

test('CONTROL: the gate runs EVERY check rather than stopping at the first failure', () => {
  // Short-circuiting would hide the second failure behind the first, so fixing one thing silently
  // changes what you are told about. Both must appear in the summary.
  const { code, out } = runGate([
    { name: 'red-one', args: bad },
    { name: 'red-two', args: bad },
  ])
  assert.notEqual(code, 0, `OUTPUT WAS:\n${out}`)
  assert.match(out, /red-one/)
  assert.match(out, /red-two/)
  assert.match(out, /2 CHECK\(S\) FAILED/,
    'both failures must be counted; a gate that reports one of two is hiding work')
})

test('CONTROL: a check that CANNOT START is a failure, never a pass', () => {
  // The subtle one. If the file named by a check does not exist, node exits non-zero and the gate
  // is fine - but a check that failed to SPAWN (bad interpreter, missing file in a wrapper) must
  // never be mistaken for success. Here the ARGS are valid, so this also pins that a check running
  // with arguments the interpreter rejects is reported, not skipped.
  const { code, out } = runGate([{ name: 'impossible', args: ['--this-flag-does-not-exist'] }])
  assert.notEqual(code, 0, `a check that could not run is not a passing check. OUT:\n${out}`)
  assert.match(out, /FAILED|EXIT/,
    `the failure must be visible in the output, not only in the status. OUT:\n${out}`)
})

test('CONTROL: a malformed check list fails the gate instead of running nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aios-gate-bad-'))
  try {
    const listFile = join(dir, 'checks.json')
    writeFileSync(listFile, JSON.stringify({ not: 'an array' }), 'utf8')
    const r = spawnSync(process.execPath, [GATE], {
      encoding: 'utf8',
      env: { ...process.env, AIOS_VERIFY_CHECKS: listFile },
      timeout: 60_000,
    })
    assert.notEqual(r.status ?? -1, 0, 'an unusable check list must fail rather than verify nothing')
    assert.match(`${r.stdout}${r.stderr}`, /must be a JSON array/,
      'and it must say what was wrong with it')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ============================================================================================
// WHAT THE GATE DELIBERATELY LEAVES OUT
// ============================================================================================

test('CONTROL: the gate does NOT run the live proof harness', () => {
  // `control:proofs` installs a low-level keyboard AND mouse hook on the live desktop and waits for
  // a human to press chords. A routine `npm test` must never be able to do that. The gate asserts
  // this by CONTENT, so the omission cannot be reintroduced by accident.
  const src = readFileSync(GATE, 'utf8')
  assert.doesNotMatch(src, /run-proof-gate\.mjs/,
    'the proof harness must not be invoked by the default verification command')
  assert.doesNotMatch(src, /control:proofs['"\s]*:/,
    'no live-proof check may be added to the default gate without a human decision')
})

test('the gate keeps the unit tests as its first check, with the previous invocation intact', () => {
  const src = readFileSync(GATE, 'utf8')
  assert.match(src, /--test['"]?,\s*'packages\/\*\/test\/\*\.test\.ts'/,
    'the original test glob must be preserved exactly - "preserve existing behaviour" is literal')
  assert.match(src, /audit-injection-routes\.mjs/, 'the route audit must be in the default gate')
  assert.match(src, /syntax-check\.mjs/, 'the C# compile check must be in the default gate')
})