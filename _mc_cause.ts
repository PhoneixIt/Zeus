/**
 * ESTABLISH CAUSE, not just symptom.
 *
 * For each harness: does the mission fail because the OPERATOR HOST was unreachable, or for some
 * other reason? The distinction decides whether a host preflight is the right fix.
 *
 * The test is direct: run the same mission code path with the host probe and see what the permission
 * call does. If `livePermission()` throws, every mission needing permission fails before step 1 -
 * which makes the host a genuine prerequisite, not a coincidence.
 */
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'

const LIVE = 'packages/mission-engine/live'

// The question each harness must answer: is the operator host REQUIRED for this mission to run?
const CHECKS: Array<{ file: string; question: string }> = [
  { file: 'run-auto-recovery.ts', question: 'permission: livePermission in config' },
  { file: 'run-dev-mission.ts', question: 'permission: livePermission in config' },
  { file: 'run-dev-recovery.ts', question: 'permission: livePermission in config' },
  { file: 'run-durable-mission.ts', question: 'permission: livePermission in config' },
  { file: 'run-summary-mission.ts', question: 'permission: livePermission in config' },
  { file: 'run-model-folder-mission.ts', question: 'does not use livePermission at all' },
]

for (const c of CHECKS) {
  const src = readFileSync(join(LIVE, c.file), 'utf8')
  const usesPerm = /permission:\s*livePermission/.test(src)
  const usesControl = /control:\s*liveControl/.test(src)
  console.log(`${c.file.padEnd(30)} permission=livePermission:${String(usesPerm).padEnd(5)} control=liveControl:${String(usesControl).padEnd(5)}`)
}

console.log('')
console.log('--- and the harnesses that fail for a reason of their OWN ---')

// run-model-folder-mission: needs CLI arguments.
const r = spawnSync('node', ['--experimental-strip-types', '--no-warnings', join(LIVE, 'run-model-folder-mission.ts')],
  { encoding: 'utf8' })
console.log(`run-model-folder-mission no-arg exit=${r.status}: ${(r.stdout ?? '').trim().split('\n').pop()}`)

// run-dev-mission: what is the baseline section asserting?
const dev = readFileSync(join(LIVE, 'run-dev-mission.ts'), 'utf8')
const baselineLines = dev.split('\n').filter((l) => /BASELINE|before the change/.test(l))
console.log(`run-dev-mission baseline lines: ${baselineLines.length}`)
for (const l of baselineLines.slice(0, 3)) console.log(`    ${l.trim().slice(0, 110)}`)
