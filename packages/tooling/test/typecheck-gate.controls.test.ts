/**
 * CONTROLS FOR THE TYPE-CHECK GATE.
 *
 * =============================================================================
 * WHY A GATE NEEDS CONTROLS
 * =============================================================================
 *
 * The first version of `typecheck-gate.mjs` could not fail and reported success anyway.
 *
 * It lived at the repository root and computed its working directory as `join(dirname(here), '..')` -
 * one level too high. There is no `tsconfig.json` there and no source files, so `tsc` found nothing to
 * check, reported zero errors, and the gate printed PASS while verifying nothing whatsoever.
 *
 * It looked correct. It exited 0. It had a summary table. And it was, in substance, a script that
 * prints "PASS".
 *
 * A gate that checks the wrong directory and reports success is WORSE than no gate, because it is
 * believed - and the belief it creates is exactly what stops anyone looking for the errors it is
 * supposed to be finding. So these controls exist to establish that the gate CAN fail, before anyone
 * relies on it not failing.
 *
 * =============================================================================
 * WHAT IS PROVEN HERE, AND HOW
 * =============================================================================
 *
 * Three failure modes, each induced for real and each asserted to FAIL:
 *
 *   1. A DELIBERATE TYPE ERROR must fail the gate.
 *      Injected into a real product file (`mission-engine/state.ts`), then reverted.
 *
 *   2. A MISSING tsconfig must fail the gate rather than report zero errors.
 *      The tsconfig is MOVED, not edited - the gate must notice it is gone, not that it is empty.
 *
 *   3. AN UNREADABLE / EMPTY PROJECT must fail the gate.
 *      A tsconfig that includes nothing must not be able to produce a green result, because "zero
 *      errors from zero files" and "zero errors" are different claims.
 *
 * The first control also re-checks that the error is REVERTED, so a failure partway through cannot
 * leave a deliberate type error sitting in the repository. That matters more than it sounds: a control
 * that damages the thing it tests to prove it can fail is not a control, it is a hazard.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// This file lives at packages/tooling/test/, so the repository root is THREE levels up
// (test -> tooling -> packages -> root).
//
// The first two versions climbed one and then two, resolving `packages/tooling` and `packages`, and
// every control reported that a tsconfig was missing when it was sitting in the root the whole time.
// The control was measuring its own path arithmetic - and had it not asserted on the message, it
// could have "passed" by failing for entirely the wrong reason, which is worse than not existing.
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const gate = join(root, 'typecheck-gate.mjs')
const tsconfig = join(root, 'tsconfig.json')
const stateFile = join(root, 'packages', 'mission-engine', 'state.ts')

function runGate() {
  const r = spawnSync(process.execPath, [gate], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

/**
 * Restores a file even if the assertion throws.
 *
 * `try/finally` rather than cleanup at the end of the test body: a failing assertion would otherwise
 * skip the restore and leave the repository modified, so the NEXT run of the suite would fail for a
 * reason that has nothing to do with what it is testing.
 */
function withPatchedFile(path: string, patch: (s: string) => string, body: () => void): void {
  const original = readFileSync(path, 'utf8')
  try {
    writeFileSync(path, patch(original), 'utf8')
    body()
  } finally {
    writeFileSync(path, original, 'utf8')
  }
}

// =============================================================================
// CONTROL 0 (the baseline): the gate is green RIGHT NOW, and says how much it checked.
// =============================================================================
//
// Without this, "the gate fails when it should" proves nothing - it could be failing always. The
// control that matters is the pairing: green here, red under injection, green again after.

test('the gate is GREEN on the repository as it stands, and reports a non-zero file count', () => {
  const r = runGate()
  assert.equal(r.code, 0, `the gate must pass on a clean tree. Got exit ${r.code}:\n${r.out}`)
  assert.match(r.out, /PASS/, `expected PASS:\n${r.out}`)

  // A PASS that examined nothing is not a pass. The count is the evidence.
  const m = /project files checked\s+(\d+)/.exec(r.out)
  assert.ok(m, `the gate must report how many files it checked:\n${r.out}`)
  assert.ok(Number(m[1]) > 50, `the gate must have loaded real source. It reported ${m[1]} files`)
})

// =============================================================================
// CONTROL 1: a deliberate type error must FAIL the gate.
// =============================================================================

test('CONTROL: one deliberate type error in a real product file makes the gate FAIL', () => {
  withPatchedFile(
    stateFile,
    (s) => `${s}\nconst _deliberateTypeError: number = 'this is not a number'\n`,
    () => {
      const r = runGate()
      assert.notEqual(r.code, 0, `a real type error must fail the gate. It exited 0:\n${r.out}`)
      assert.match(r.out, /FAILED/, `expected FAILED:\n${r.out}`)
      assert.match(r.out, /state\.ts/, `the gate must NAME the offending file:\n${r.out}`)
    },
  )

  // And the tree is clean again. Asserted explicitly rather than trusted.
  const after = runGate()
  assert.equal(after.code, 0, `the gate must be green again after the injection:\n${after.out}`)
})

// =============================================================================
// CONTROL 2: a MISSING tsconfig must fail, not report zero errors.
// =============================================================================
//
// This is the exact failure the original gate had, in the shape it took. Moving the file is the
// honest reproduction: the gate must notice the project is gone, not observe an empty one.

test('CONTROL: a MISSING tsconfig makes the gate FAIL rather than report zero errors', (t) => {
  const hidden = join(root, 'tsconfig.json.hidden-by-this-test')
  assert.ok(existsSync(tsconfig), 'the tsconfig must exist before this control can move it')

  t.after(() => {
    // Restored unconditionally: a failure here must not leave the repository without a tsconfig,
    // which would make every later run fail for the wrong reason.
    if (existsSync(hidden) && !existsSync(tsconfig)) renameSync(hidden, tsconfig)
  })

  renameSync(tsconfig, hidden)
  const r = runGate()

  assert.notEqual(r.code, 0, 'a missing tsconfig must fail the gate')
  assert.match(r.out, /no tsconfig/i, `expected the gate to name the missing tsconfig:\n${r.out}`)
  assert.doesNotMatch(r.out, /\bPASS\b/, `the gate must not report PASS with nothing to check:\n${r.out}`)
  assert.match(r.out, /LIE|nothing was examined/i,
    `the gate must say why zero is not an answer here:\n${r.out}`)
})

// =============================================================================
// CONTROL 3: an EMPTY project must fail, not report a clean zero.
// =============================================================================
//
// "Zero errors from zero files" and "zero errors" are different claims, and only one of them means the
// code is sound. This is the failure a reviewer is most likely to miss in the output.

test('CONTROL: a tsconfig that includes NO project source makes the gate FAIL', (t) => {
  const original = readFileSync(tsconfig, 'utf8')

  t.after(() => {
    writeFileSync(tsconfig, original, 'utf8')
  })

  // A real, valid tsconfig that simply includes nothing of ours.
  writeFileSync(tsconfig, JSON.stringify({
    compilerOptions: { noEmit: true, skipLibCheck: true, types: [] },
    include: [],
    files: [],
  }, null, 2), 'utf8')

  const r = runGate()
  assert.notEqual(r.code, 0, 'a gate that loads no project source must fail')
  assert.match(r.out, /no project source|loaded no project/i,
    `the gate must explain that a clean result from zero files is not a clean result:\n${r.out}`)
  assert.doesNotMatch(r.out, /^\s*PASS/m, `the gate must not report PASS for an empty project:\n${r.out}`)
})

// =============================================================================
// AND THE TREE IS LEFT EXACTLY AS IT WAS FOUND.
// =============================================================================

test('CONTROL: this file leaves the repository exactly as it found it', () => {
  assert.ok(existsSync(tsconfig), 'tsconfig.json must be present')
  const r = runGate()
  assert.equal(r.code, 0, `the gate must be green after every control has run and restored:\n${r.out}`)
})