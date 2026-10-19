/**
 * MUTATION CONTROL for the host-blocked classification.
 *
 * Removing the preflight must make the tests go RED. That is the whole claim: a guard nobody has
 * watched fail is not a guard.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const TARGETS = ['packages/mission-engine/live/run-filesystem.ts',
                 'packages/mission-engine/live/run-two-step.ts',
                 'packages/mission-engine/live/run-fs-ops-mission.ts']

const CMD = ['--experimental-strip-types', '--no-warnings', '--test', 'packages/mission-engine/test/host-blocked.test.ts']
const ORIGINALS = new Map(TARGETS.map((f) => [f, readFileSync(f, 'utf8')]))

const MUTATIONS = [
  {
    name: 'H1  run-filesystem preflight removed',
    file: 'packages/mission-engine/live/run-filesystem.ts',
    find: /\n\s*blockOnHost\(await hostAvailability\(\)\)\n/,
    replace: '\n',
  },
  {
    name: 'H2  run-two-step preflight removed',
    file: 'packages/mission-engine/live/run-two-step.ts',
    find: /\n\s*blockOnHost\(await hostAvailability\(\)\)\n/,
    replace: '\n',
  },
  {
    name: 'H3  run-fs-ops-mission preflight removed',
    file: 'packages/mission-engine/live/run-fs-ops-mission.ts',
    find: /\n\s*blockOnHost\(await hostAvailability\(\)\)\n/,
    replace: '\n',
  },
  {
    // The dangerous one: turning a failed assertion into a blocked result by exiting 2 AFTER the
    // checks have run.
    name: 'H4  preflight relocated to AFTER the assertions',
    file: 'packages/mission-engine/live/run-filesystem.ts',
    re: /(blockOnHost\(await hostAvailability\(\)\)\n)/,
    replace: '$1// (moved below - a failed check would now be laundered as blocked)\n',
    then: (src: string) => src.replace(
      'process.exit(failed ? 1 : 0)',
      'blockOnHost({ ok: false, reason: "forged" })\nprocess.exit(failed ? 1 : 0)'),
  },
  {
    // The same laundering, on run-two-step - proves the structural assertion generalises rather than
    // pinning one file's line numbers.
    name: 'H5  run-two-step guard duplicated below the checks',
    file: 'packages/mission-engine/live/run-two-step.ts',
    re: /\n(\s*process\.exit\(failed \? 1 : 0\))/,
    replace: '\nblockOnHost({ ok: false, reason: "forged" })\n$1',
  },
]

function run() {
  const r = spawnSync('node', CMD, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const out = r.stdout || ''
  const t = /tests (\d+)/.exec(out); const f = /fail (\d+)/.exec(out)
  return { code: r.status, tests: t ? t[1] : '?', fail: f ? f[1] : '?' }
}

const base = run()
console.log(`BASELINE: tests=${base.tests} fail=${base.fail} exit=${base.code}\n`)

let allBit = true
for (const m of MUTATIONS) {
  const orig = ORIGINALS.get(m.file)!
  const pat = m.re ?? new RegExp(m.find!.source)
  if (!pat.test(orig)) { console.log(`${m.name.padEnd(50)}  ANCHOR NOT FOUND`); allBit = false; continue }
  let mutated = orig.replace(pat, m.replace ?? '')
  if (m.then) mutated = m.then(mutated)
  writeFileSync(m.file, mutated, 'utf8')
  const r = run(); const bit = Number(r.fail) > 0
  if (!bit) allBit = false
  console.log(`${m.name.padEnd(50)}  tests=${r.tests} fail=${r.fail}  ${bit ? 'BIT' : 'DID NOT BIT'}`)
  writeFileSync(m.file, orig, 'utf8')
}

const back = run()
console.log(`\nRESTORED: tests=${back.tests} fail=${back.fail} exit=${back.code}`)
for (const f of TARGETS) console.log(`  ${f} byte-identical: ${readFileSync(f, 'utf8') === ORIGINALS.get(f)}`)
console.log(allBit && back.code === 0 ? '\nRESULT: every control BIT.' : '\nRESULT: A CONTROL DID NOT BIT.')
