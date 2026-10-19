/**
 * DIAGNOSE, do not assume.
 *
 * Runs each of the six named harnesses and captures the FIRST failure it reports, plus whether the
 * operator host was reachable at the time. The point is to distinguish:
 *
 *   host unavailable   - a prerequisite nobody started; HOST-BLOCKED
 *   local model absent - a different prerequisite, also HOST-BLOCKED but a DIFFERENT one
 *   assertion failed   - a control genuinely failed; FAIL
 *   setup refused      - the fixture itself could not be built; neither of the above
 *
 * Classifying by name would have put all six in the first bucket. The evidence says otherwise.
 */
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { hostAvailability } from './packages/mission-engine/live/live-control.ts'

const LIVE = 'packages/mission-engine/live'
const SIX = [
  'run-auto-recovery.ts',
  'run-dev-mission.ts',
  'run-dev-recovery.ts',
  'run-durable-mission.ts',
  'run-model-folder-mission.ts',
  'run-summary-mission.ts',
]

const avail = await hostAvailability()
console.log(`operator host reachable: ${avail.ok}${avail.ok ? '' : ` (${avail.reason.slice(0, 60)})`}`)
console.log('')

for (const h of SIX) {
  const r = spawnSync('node', ['--experimental-strip-types', '--no-warnings', join(LIVE, h)],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 120000 })
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`

  // The first line that carries the reason, in the order a reader would meet them.
  const firstError = out.split('\n').find((l) =>
    /Error:|ENOENT|ECONNREFUSED|fetch failed|refused|FAIL|MODEL|not listening|REFUSED|throw/i.test(l))
  const failCount = (out.match(/\bFAIL\b/g) ?? []).length
  const passCount = (out.match(/\bPASS\b/g) ?? []).length
  const refusedLine = out.split('\n').find((l) => /REFUSED|refusing/i.test(l))

  console.log(`=== ${h} ===`)
  console.log(`  exit         ${r.status}`)
  console.log(`  PASS/FAIL    ${passCount}/${failCount}`)
  console.log(`  first signal ${firstError ? firstError.trim().replace(/\s+/g, ' ').slice(0, 130) : '(none)'}`)
  if (refusedLine) console.log(`  refused      ${refusedLine.trim().replace(/\s+/g, ' ').slice(0, 130)}`)
  console.log('')
}
