#!/usr/bin/env node
/**
 * THE TYPE-CHECK GATE.
 *
 * =============================================================================
 * WHY THIS EXISTS
 * =============================================================================
 *
 * This repository had NO `tsconfig.json`, TypeScript was not installed, and every script ran with
 * `node --experimental-strip-types` - which STRIPS types rather than checking them. Eighteen
 * milestones were never typechecked, and nothing that depended on types being right could fail.
 *
 * Turning a real check on found 444 errors (228 in product code). Every one of these had survived a
 * green test suite:
 *
 *   - `executor.ts` imported '../../governance/contract.ts', one level too high
 *   - `live/consequential-tools.ts` imported './state.ts', which does not exist in live/
 *   - `WorldState` imported from two modules that merely USE it and never export it
 *   - `PlanProvider` imported from `planner/plan.ts`, which does not export it
 *   - `ModelRequest` still described a v2 protocol the code had already rewritten to v3
 *   - `PlanStep` had no `effect` field, while the compiler copied it and the reviewer rendered it -
 *     the exact governance hole `compile.ts` documents in its own comments
 *   - and in `terminal-mode.ts`: `resolve(ctx.workspace, ...)` where `ctx` is never declared, so the
 *     governed terminal tool threw ReferenceError on EVERY invocation
 *
 * None of that broke at runtime because type-only imports are ERASED by strip-types. The type layer
 * and the runtime layer disagreed, and no check existed to notice.
 *
 * =============================================================================
 * THE RULE: ZERO. NO BASELINE.
 * =============================================================================
 *
 * An earlier version of this gate compared against a committed baseline and failed only on a REGRESSION.
 * That was wrong, and wrong in a specific way worth recording.
 *
 * A baseline says "these errors are accepted". After this pass there are none to accept - but the
 * mechanism itself was the problem: it would have let the 79 that remained at the time sit there
 * indefinitely, each one looking deliberate because a file said so. A number someone agreed to is not
 * the same as a number someone decided about. This gate has no way to express "this error is fine".
 *
 * The errors were fixed rather than recorded. Several were real defects, and three of them were
 * behavioural rather than cosmetic:
 *
 *   - durable evidence was written for REJECTED verifications (`rec.verified` sat above the
 *     accepted/rejected test, so the store was told a step was verified on the strength of a
 *     verification that had just refused to verify it, with `undefined` as the evidence)
 *   - `reviewedProposalDigest` was passed inside `deps` instead of `opts` in two harnesses, so the
 *     "is this the plan a human reviewed?" check never ran there
 *   - the supervisor's non-convergence refusal omitted `stepOutcomes`, which its own caller reads
 *
 * =============================================================================
 * NO `noUncheckedIndexedAccess`
 * =============================================================================
 *
 * It is a good setting for this project and eventually the right one. It is deliberately OFF here, and
 * that is a decision rather than an oversight: turning it on across eighteen never-checked milestones
 * produced ~126 further errors overnight, and folding a retroactively-applied strictness increase into
 * the same count as real defects produces a number that cannot tell whether the code is getting safer.
 * It is a separate, deliberate change - recorded in docs/safety/known-defects.md - not something to
 * smuggle into a stabilisation pass.
 *
 * =============================================================================
 * A GATE THAT CANNOT FAIL IS NOT A GATE
 * =============================================================================
 *
 * The first version of this gate could not fail and reported success anyway. It lived at the repo root
 * and computed its working directory as `join(dirname(here), '..')` - one level too high. There is no
 * tsconfig there and no source, so tsc reported nothing, the gate counted zero errors, and it printed
 * PASS while verifying nothing at all.
 *
 * A gate that checks the wrong directory and reports success is worse than no gate, because it is
 * believed. So the two checks below are load-bearing:
 *
 *   1. `tsconfig.json` must exist at the root. Absence of a check must never be reportable as a
 *      passing check.
 *   2. `tsc` must actually have run. A spawn failure is a failure, never a pass.
 *
 * Both are exercised by `typecheck-gate.controls.mjs`, which drives this script and asserts it fails
 * for a deliberate type error, and fails when the tsconfig is missing.
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// The gate lives AT the repository root, so the root IS this file's directory. The first version used
// `join(dirname(...), '..')` and checked a directory with no tsconfig and no sources - see above.
const root = dirname(fileURLToPath(import.meta.url))
const tsconfigPath = join(root, 'tsconfig.json')

if (!existsSync(tsconfigPath)) {
  console.error('')
  console.error('  FAILED - there is no tsconfig.json at the repository root.')
  console.error('  Without it tsc has nothing to check, and reporting zero errors would be a LIE:')
  console.error('  "nothing was examined" and "nothing is wrong" are different claims.')
  console.error('')
  process.exit(1)
}

const tscBin = join(root, 'node_modules', 'typescript', 'bin', 'tsc')
if (!existsSync(tscBin)) {
  console.error('')
  console.error('  FAILED - TypeScript is not installed (expected node_modules/typescript).')
  console.error('  Run `npm install` first. A check that cannot run must fail, never pass.')
  console.error('')
  process.exit(1)
}

const tsc = spawnSync(
  process.execPath,
  [tscBin, '--noEmit', '--pretty', 'false', '--noErrorTruncation', '-p', tsconfigPath],
  { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
)

if (tsc.error || tsc.status === null) {
  console.error('')
  console.error(`  FAILED - tsc could not be run: ${tsc.error?.message ?? 'unknown error'}`)
  console.error('  A check that could not run is not a passing check.')
  console.error('')
  process.exit(1)
}

const output = `${tsc.stdout ?? ''}${tsc.stderr ?? ''}`
const lines = output.split(/\r?\n/).filter((l) => /error TS\d+:/.test(l))

// A third failure mode, and the subtlest of the three: tsc can succeed while having loaded no project
// source at all. A zero error count from zero files is indistinguishable from a zero from a clean
// project unless the file count is checked, so it is.
const listRun = spawnSync(
  process.execPath,
  [tscBin, '--noEmit', '--listFiles', '-p', tsconfigPath],
  { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
)
const projectFiles = `${listRun.stdout ?? ''}`
  .split(/\r?\n/)
  .filter((l) => l.includes('/packages/') && !l.includes('node_modules')).length

console.log('')
console.log('  TYPE-CHECK GATE')
console.log('  ' + '-'.repeat(58))
console.log(`  project files checked   ${String(projectFiles).padStart(4)}`)
console.log(`  type errors             ${String(lines.length).padStart(4)}`)
console.log('')

if (projectFiles === 0) {
  console.log('  FAILED - tsc reported no errors because it loaded no project source.')
  console.log('  A clean result from zero files is not a clean result.')
  console.log('')
  process.exit(1)
}

if (lines.length) {
  console.log(`  FAILED - ${lines.length} type error(s):`)
  console.log('')
  for (const l of lines) console.log(`    ${l.replace(`${root}/`, '').replace(/\\/g, '/')}`)
  console.log('')
  process.exit(1)
}

console.log(`  PASS - ${projectFiles} project files, zero type errors.`)
console.log('')
process.exit(0)