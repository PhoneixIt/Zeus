#!/usr/bin/env node
/**
 * THE TYPE-CHECK GATE.
 *
 * =============================================================================
 * WHY THIS EXISTS AT ALL
 * =============================================================================
 *
 * This repository had NO `tsconfig.json`, TypeScript was not installed, and every script ran with
 * `node --experimental-strip-types`. That flag STRIPS types - it erases them without checking them.
 *
 * So for eighteen milestones the project was never typechecked, and nothing that depended on types
 * being right could fail. Everything below is what was found the moment a real check was turned on:
 *
 *   - 444 errors total, 228 of them in product code
 *   - `executor.ts` imported `'../../governance/contract.ts'`, one level too high - a path that does
 *     not resolve
 *   - `live/consequential-tools.ts` and `live/run-approval.ts` imported `'./state.ts'`, which does not
 *     exist in `live/`
 *   - `WorldState` was imported by two files from modules that merely USE it and never export it
 *   - `PlanProvider` was imported from `planner/plan.ts`, which does not export it
 *   - `DeclaredEffect` and `Tool` were used as types without ever being imported
 *   - and, in `terminal-mode.ts`, the line `const cwd = resolve(ctx.workspace, cwdRaw)` referenced a
 *     name that does not exist in the module - so `resolve` was never called and the tool threw a
 *     ReferenceError on every invocation
 *
 * NONE of that broke at runtime, because `--experimental-strip-types` erases type-only imports
 * entirely. The type layer and the runtime layer disagreed, and no check had ever existed to notice.
 *
 * That is why this is a GATE and not a report. A count is only worth keeping if it can be made to
 * move in one direction.
 *
 * =============================================================================
 * THE RULE
 * =============================================================================
 *
 * `npm run typecheck` fails if the error count EXCEEDS the committed baseline, or if the set of
 * failing files grows. It does NOT fail because errors exist - fixing 186 of them is real progress
 * and must not be blocked by the remaining ones.
 *
 * Raising the baseline requires editing `typecheck-baseline.json` BY HAND, which makes it a decision
 * with a diff attached, not something a tool does silently on your behalf.
 */

import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// The gate lives AT the repository root, so the root IS this file's directory.
//
// The first version used `join(dirname(...), '..')`. That pointed one level too high, at a directory
// with no tsconfig.json and no sources - so tsc found nothing to check, reported zero errors, and the
// gate answered PASS while verifying nothing at all.
//
// That is the single worst failure mode a safety gate can have, and it happened here first. Hence the
// assertion below: the absence of a check must never be reportable as a passing check.
const root = dirname(fileURLToPath(import.meta.url))
const tsconfigPath = join(root, 'tsconfig.json')
const baselinePath = join(root, 'typecheck-baseline.json')

/** Writes the current counts as the baseline. Only ever run deliberately, never by the gate. */
const WRITE = process.argv.includes('--write-baseline')

if (!existsSync(tsconfigPath)) {
  // Deliberately NOT an exit code that looks like success, and deliberately NOT "0 errors".
  console.error('')
  console.error('  FAILED - there is no tsconfig.json at the repository root.')
  console.error('  Without it tsc has nothing to check, and reporting zero errors would be a LIE:')
  console.error('  "nothing was examined" and "nothing is wrong" are different claims.')
  console.error('')
  process.exit(1)
}

// tsc is invoked directly rather than through `npx`, so the gate cannot be defeated by an npx shim
// failing to resolve or by npx deciding to print its own output instead of tsc's.
const tscBin = join(root, 'node_modules', 'typescript', 'bin', 'tsc')
if (!existsSync(tscBin)) {
  console.error('')
  console.error('  FAILED - TypeScript is not installed (expected node_modules/typescript).')
  console.error('  Run `npm install` first. A gate that cannot run must fail, never pass.')
  console.error('')
  process.exit(1)
}

const tsc = spawnSync(process.execPath, [tscBin, '--noEmit', '--pretty', 'false', '-p', tsconfigPath], {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
})

if (tsc.error || tsc.status === null) {
  console.error('')
  console.error(`  FAILED - tsc could not be run: ${tsc.error?.message ?? 'unknown error'}`)
  console.error('  A check that could not run is not a passing check.')
  console.error('')
  process.exit(1)
}

const output = `${tsc.stdout ?? ''}${tsc.stderr ?? ''}`
const lines = output.split(/\r?\n/)

const product = new Set()
const test = new Set()
let productCount = 0
let testCount = 0

for (const line of lines) {
  const m = /^(packages\/[^\s(]+)\(\d+,\d+\): error TS\d+:/.exec(line)
  if (!m) continue
  const file = m[1]
  if (file.includes('/test/')) { test.add(file); testCount++ } else { product.add(file); productCount++ }
}

const current = {
  _comment: 'Committed by hand. Lowering it is progress; raising it is a decision with a diff.',
  productErrors: productCount,
  testErrors: testCount,
  productFiles: product.size,
  testFiles: test.size,
}

if (WRITE) {
  writeFileSync(baselinePath, `${JSON.stringify(current, null, 2)}\n`, 'utf8')
  console.log(`  baseline written: ${productCount} product, ${testCount} test`)
  process.exit(0)
}

let baseline
try {
  baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))
} catch {
  console.error('  typecheck-baseline.json is missing or unreadable.')
  console.error('  Run `npm run typecheck -- --write-baseline` to record the current counts.')
  process.exit(1)
}

const fmt = (n) => String(n).padStart(4)

console.log('')
console.log('  TYPE-CHECK GATE')
console.log('  ' + '-'.repeat(58))
console.log(`  ${'product errors'.padEnd(26)} ${fmt(current.productErrors)}   (baseline ${baseline.productErrors})`)
console.log(`  ${'test errors'.padEnd(26)} ${fmt(current.testErrors)}   (baseline ${baseline.testErrors})`)
console.log(`  ${'product files affected'.padEnd(26)} ${fmt(current.productFiles)}   (baseline ${baseline.productFiles})`)
console.log(`  ${'test files affected'.padEnd(26)} ${fmt(current.testFiles)}   (baseline ${baseline.testFiles})`)
console.log('')

const regressions = []
if (current.productErrors > baseline.productErrors) regressions.push(`product errors rose by ${current.productErrors - baseline.productErrors}`)
if (current.testErrors > baseline.testErrors) regressions.push(`test errors rose by ${current.testErrors - baseline.testErrors}`)
if (current.productFiles > baseline.productFiles) regressions.push(`product files affected grew by ${current.productFiles - baseline.productFiles}`)
if (current.testFiles > baseline.testFiles) regressions.push(`test files affected grew by ${current.testFiles - baseline.testFiles}`)

if (regressions.length) {
  console.log('  FAILED - the type layer got worse:')
  for (const r of regressions) console.log(`    - ${r}`)
  console.log('')
  console.log('  Fix them. If a new error is genuinely unavoidable, it is a DECISION: raise the')
  console.log('  baseline in typecheck-baseline.json by hand so the change has a diff attached.')
  console.log('')
  process.exit(1)
}

console.log(`  PASS - no type regression. ${current.productErrors} product and ${current.testErrors} test`)
console.log('  errors remain, all within the committed baseline.')
console.log('')
process.exit(0)