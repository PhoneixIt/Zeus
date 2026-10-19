/**
 * PROOF KIT - the shared harness runner for the control-core proofs.
 *
 * =============================================================================
 * WHY THIS EXISTS
 * =============================================================================
 *
 * Until M17 the five proofs in this directory had never executed: they imported a module path that
 * did not resolve, and that module imported an uninstalled package at the top level. They "passed" in
 * the only sense that mattered - nobody ran them - and the repository cited them as evidence that
 * takeover, the latched stop and no-self-release hold.
 *
 * A proof nobody runs is documentation with a passing exit code. This file exists so that cannot
 * happen again, and so that a failure is legible rather than a stack trace.
 *
 * =============================================================================
 * THE DISTINCTION THAT MATTERS MOST
 * =============================================================================
 *
 * There are two things a proof can fail on, and conflating them is how "PASS" gets written next to
 * a system nobody has checked:
 *
 *   A CLAIM FAILED           - the thing the proof exists to establish is false. This is a finding.
 *   CORROBORATION UNAVAILABLE - the claim was not tested, because something unrelated was broken.
 *                               This is NOT a pass. It is an INCONCLUSIVE, and it must never be
 *                               counted as one.
 *
 * `/screen.png` currently fails on this machine - the host closes the connection without a response.
 * That is a real defect, recorded in known-defects.md. But a screenshot is CORROBORATING evidence:
 * the security claims (a refused release, a refused injection) do not depend on it. So a broken
 * screenshot must not crash the proof, and must not let it report a clean PASS either.
 *
 * The exit codes say which happened:
 *   0  every claim held, nothing was skipped
 *   1  a CLAIM FAILED
 *   3  INCONCLUSIVE - a claim could not be tested because a dependency was unavailable
 */

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))

export const EXIT_CLAIM_FAILED = 1
export const EXIT_INCONCLUSIVE = 3

/**
 * Start a fresh operator host so each proof begins from a clean precondition.
 *
 * =============================================================================
 * WHY THIS EXISTS - AND WHY IT IS NOT A CONVENIENCE
 * =============================================================================
 *
 * `Guard.emergencyLatched` is an in-memory `static bool` (`Guard.cs:112`). It is cleared ONLY by a
 * human pressing Ctrl+Alt+R, which is exactly right for the product and exactly wrong for a test
 * harness: once any proof exercises the latched stop, every LATER proof in the same gate runs
 * against a host that is permanently fail-closed.
 *
 * The consequence was measured, not guessed. `prove-chord-swallow` failed 4 claims with
 * `swallowed +0` and `release +0` - which read exactly like a broken hook. On a freshly started
 * host the same proof passes. Those 4 failures were cross-proof contamination, not a defect. A
 * red signal that means "the previous proof left the machine stopped" is worse than no signal,
 * because the next step is to go and debug a hook that is fine.
 *
 * So the gate restarts the host before each proof. That is the ONLY way to give each proof the
 * precondition it needs, because no automation on this machine can clear the latch.
 *
 * The restart is not free: it costs a compile and a launch per proof. That is the price of an
 * honest verdict. `AIOS_PROOF_NO_RESTART=1` restores the old shared-host behaviour for
 * COMPARISON ONLY - it must never be how the gate is run for a verdict, because that is the
 * configuration that produced four false failures.
 */
function restartHost() {
  if (process.env.AIOS_PROOF_NO_RESTART === '1') return true
  const script = join(HERE, '..', 'start-operator-host.mjs')
  const r = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 240_000, env: { ...process.env } })
  if (r.status !== 0) {
    console.log(`  !! could not start a fresh host (exit ${r.status}); the proof may report a precondition failure`)
    console.log(`     ${(r.stdout ?? '').trim().split('\n').slice(-3).join('\n     ')}`)
    return false
  }
  // Each proof is its own process, so it re-reads host.json on connect. The delay is only to let
  // the hook finish installing before the first query.
  spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},900)'], { encoding: 'utf8', timeout: 10_000 })
  return true
}

/**
 * Run one proof harness and classify the outcome.
 *
 * `name` is used in the summary so a failure names itself without the reader cross-referencing.
 */
export function runProof(name, { requiresHost = true } = {}) {
  if (requiresHost) restartHost()
  const file = join(HERE, `${name}.mjs`)
  const r = spawnSync(process.execPath, [file], {
    encoding: 'utf8',
    timeout: 180_000,
    env: { ...process.env },
  })

  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  const claimedPass = /=== SUMMARY: PASS ===/.test(out)
  const inconclusive = /=== INCONCLUSIVE:/.test(out)
  const failedClaims = [...out.matchAll(/^\s*FAIL\s+(.+)$/gm)].map((m) => m[1].trim())

  process.stdout.write(out)

  console.log('')
  console.log(`--- ${name} ---`)
  console.log(`  claims failed       ${failedClaims.length}`)
  for (const f of failedClaims) console.log(`      FAIL ${f}`)
  console.log(`  corroboration gaps  ${inconclusive ? 'YES - see INCONCLUSIVE above' : 'none'}`)

  if (failedClaims.length) {
    console.log(`  VERDICT: FAILED (exit ${EXIT_CLAIM_FAILED})`)
    return EXIT_CLAIM_FAILED
  }
  if (inconclusive) {
    console.log(`  VERDICT: INCONCLUSIVE - not a pass (exit ${EXIT_INCONCLUSIVE})`)
    return EXIT_INCONCLUSIVE
  }
  if (claimedPass) {
    console.log('  VERDICT: PASS')
    return 0
  }
  // No summary marker at all: the harness did not finish. Reporting that as anything else would be
  // inventing a verdict.
  console.log(`  VERDICT: NO VERDICT REACHED (exit ${EXIT_INCONCLUSIVE})`)
  return EXIT_INCONCLUSIVE
}

/**
 * Run every proof and return a single verdict for the gate.
 *
 * A gate that passes when some proofs crashed is not a gate, so INCONCLUSIVE is treated as a failure
 * here. That is deliberate and strict: it means "the control core's safety properties are not currently
 * demonstrated", which is the true statement and the one a reviewer needs.
 */
export function runAllProofs({ names }) {
  const results = []
  for (const n of names) results.push([n, runProof(n)])
  const failed = results.filter(([, c]) => c === EXIT_CLAIM_FAILED)
  const inconclusive = results.filter(([, c]) => c === EXIT_INCONCLUSIVE)

  console.log('')
  console.log('='.repeat(70))
  console.log('CONTROL-CORE PROOF GATE')
  for (const [n, c] of results) {
    const v = c === 0 ? 'PASS' : c === EXIT_CLAIM_FAILED ? 'FAILED' : 'INCONCLUSIVE'
    console.log(`  ${v.padEnd(14)} ${n}`)
  }
  console.log('')
  if (failed.length || inconclusive.length) {
    console.log(`  ${failed.length} proof(s) FAILED, ${inconclusive.length} INCONCLUSIVE.`)
    console.log('  The control core safety properties are NOT fully demonstrated right now.')
    console.log('  Treat this as a finding, not as a pass with caveats.')
  } else {
    console.log('  Every proof held and nothing was skipped.')
  }
  console.log('='.repeat(70))

  return failed.length || inconclusive.length ? EXIT_CLAIM_FAILED : 0
}

/** The proof names, in the order they should run. Cheap first. */
export const PROOFS = [
  'prove-chord-swallow',
  'prove-status-truth',
  'prove-panel-release',
  'prove-panel-colour',
  'prove-no-self-release',
]