#!/usr/bin/env node
/**
 * THE VERIFICATION GATE.
 *
 * =============================================================================
 * WHY THIS EXISTS
 * =============================================================================
 *
 * `npm test` ran the unit tests and nothing else. Two checks that guard safety-critical behaviour
 * lived outside it and were run by hand, if at all:
 *
 *   - `control:audit-routes` - fails if any route can change real machine state without passing the
 *     declared injection gate. It is the check that exists BECAUSE `/show`, `/restore` and `/focus`
 *     once arrived ungated.
 *   - `control:syntax` - compiles the C# control core. A broken host is not a unit-test failure;
 *     nothing in the TypeScript test suite compiles C#, so `npm test` could stay green while the
 *     operator host no longer built.
 *
 * A check nobody runs is documentation with a passing exit code. Both were green at the moment they
 * were added and nobody would have known if they stopped being green.
 *
 * =============================================================================
 * WHAT THIS DELIBERATELY DOES NOT RUN
 * =============================================================================
 *
 * `control:proofs` is NOT in this gate. It needs the operator host running, which installs a
 * low-level keyboard AND mouse hook on the live desktop and requires a human to press chords. Running
 * it unattended from a verification command would make a routine `npm test` take over the machine.
 * It stays a separate, explicit, human-initiated command.
 *
 * =============================================================================
 * THE RULE: A CHECK THAT CANNOT RUN IS A FAILURE, NEVER A PASS
 * =============================================================================
 *
 * Three ways this could have quietly reported success, and what each would have cost:
 *
 *   1. spawn failure treated as pass - a missing or unrunnable script would report green.
 *   2. non-zero status swallowed - the entire reason this file exists.
 *   3. `&&` chaining in package.json - a short-circuit that hides every LATER check behind the first
 *      failure, so fixing one thing changes what you are told about. All checks run here, always,
 *      and the summary names each one.
 *
 * `verify-gate.test.ts` proves each of these by driving this gate against a temporary check list and
 * asserting a NON-ZERO exit. The seam that makes that possible is `AIOS_VERIFY_CHECKS` below, which
 * exists only so the gate can be shown to fail - it names no real behaviour.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

const NODE_ARGS = ['--experimental-strip-types', '--no-warnings']

/**
 * The checks, in the order they run.
 *
 * Unit tests stay FIRST and keep their exact previous invocation, including the quoted glob, so
 * "preserve the existing test behaviour" is literal rather than aspirational. Node expands the glob
 * itself; nothing here depends on a shell.
 */
const DEFAULT_CHECKS = [
  { name: 'unit tests', args: [...NODE_ARGS, '--test', 'packages/*/test/*.test.ts'] },
  { name: 'control:audit-routes', args: ['packages/control-core/audit-injection-routes.mjs'] },
  { name: 'control:syntax', args: ['packages/control-core/syntax-check.mjs'] },
]

/**
 * Load the check list, honouring the test seam.
 *
 * `AIOS_VERIFY_CHECKS` points at a JSON file of `{name, args}`. It is not a configuration feature:
 * nothing in normal use sets it, and it cannot add or remove a real check from a real run without
 * the caller deliberately going looking for this variable. It exists so the gate's own failure path
 * can be exercised, because a gate that has never been seen to fail has not been shown to fail.
 */
function loadChecks() {
  const override = process.env.AIOS_VERIFY_CHECKS
  if (!override) return DEFAULT_CHECKS
  if (!existsSync(override)) {
    console.error(`  FAILED - AIOS_VERIFY_CHECKS points at ${override}, which does not exist.`)
    process.exit(1)
  }
  const parsed = JSON.parse(readFileSync(override, 'utf8'))
  if (!Array.isArray(parsed) || parsed.some((c) => !c?.name || !Array.isArray(c.args))) {
    console.error('  FAILED - AIOS_VERIFY_CHECKS must be a JSON array of {name, args}.')
    process.exit(1)
  }
  return parsed
}

const checks = loadChecks()

console.log('=== VERIFICATION GATE ===')
console.log(`  node ${process.version}`)
console.log('')

const results = []
for (const check of checks) {
  console.log(`--- ${check.name} ---`)
  const started = Date.now()
  const run = spawnSync(process.execPath, check.args, { stdio: 'inherit' })

  // THE THREE FAILURE MODES. Any of these is a FAILURE, and none of them is a pass.
  if (run.error) {
    // 1. The check never ran.
    console.error(`  FAILED - ${check.name} could not be started: ${run.error.message}`)
    results.push({ name: check.name, ok: false, ms: Date.now() - started })
    continue
  }
  if (run.signal) {
    // A killed check proved nothing either way.
    console.error(`  FAILED - ${check.name} was terminated by signal ${run.signal}.`)
    results.push({ name: check.name, ok: false, ms: Date.now() - started })
    continue
  }
  results.push({ name: check.name, ok: run.status === 0, status: run.status, ms: Date.now() - started })
  console.log(`--- ${check.name}: ${run.status === 0 ? 'ok' : `EXIT ${run.status}`} ---`)
  console.log('')
}

const failed = results.filter((r) => !r.ok)
console.log('=== SUMMARY ===')
for (const r of results) {
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `  (exit ${r.status ?? 'n/a'})`}`)
}
console.log('')

if (failed.length) {
  // Name the failures. "npm test failed" is not an actionable report.
  console.log(`=== ${failed.length} CHECK(S) FAILED: ${failed.map((f) => f.name).join(', ')} ===`)
  console.log('  `control:proofs` is NOT part of this gate on purpose - it needs the operator host and a human.')
  process.exit(1)
}

console.log('=== ALL CHECKS PASS ===')
process.exit(0)