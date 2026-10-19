/**
 * MUTATION TEST for the three corrections approved in this task.
 *
 *   A1 - run-approval no longer declares its objective
 *   B1 - the implausible-empty-root guard is removed
 *   C1 - the self-referential output refusal is removed
 *
 * Restores every file and verifies byte-identity.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const APPR = 'packages/mission-engine/live/run-approval.ts'
const EXPC = 'packages/planner/expected-content.ts'
const DET = 'packages/planner/deterministic.ts'

const MUTATIONS = [
  {
    file: APPR, name: 'A1  run-approval declares no objective again',
    find: "    objectivePostconditions: [{ kind: 'consequential-deleted', path: target }],",
    replace: "    objectivePostconditions: undefined,",
  },
  {
    file: EXPC, name: 'B1  implausible-empty-root guard removed',
    find: "  if (entries.length === 0 && isObservationRoot && world.scope.maxDepth >= 1) {",
    replace: "  if (false) {",
  },
  {
    file: DET, name: 'C1  self-referential output refusal removed',
    find: "    if (isInside(label, outPath)) {",
    replace: "    if (false) {",
  },
]

// A1 is only observable in the harness itself, so its command is the harness, not the unit suite.
function cmdFor(file: string) {
  if (file === APPR) {
    return ['--experimental-strip-types', '--no-warnings', APPR]
  }
  return ['--experimental-strip-types', '--no-warnings', '--test',
    'packages/planner/test/expected-content.test.ts',
    'packages/planner/test/self-referential-output.test.ts']
}

function run(file: string) {
  const r = spawnSync('node', cmdFor(file), { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const out = r.stdout || ''
  const t = /tests (\d+)/.exec(out); const f = /fail (\d+)/.exec(out)
  const failed = r.status !== 0
  return { code: r.status, tests: t ? t[1] : '-', fail: f ? f[1] : (failed ? '1' : '0') }
}

const originals = new Map(MUTATIONS.map((m) => [m.file, readFileSync(m.file, 'utf8')]))
const b = run(DET)
console.log(`BASELINE: exit=${b.code} tests=${b.tests} fail=${b.fail}\n`)

let allBit = true
for (const m of MUTATIONS) {
  const orig = originals.get(m.file)!
  if (!orig.includes(m.find)) { console.log(`${m.name.padEnd(50)}  ANCHOR NOT FOUND`); allBit = false; continue }
  writeFileSync(m.file, orig.replace(m.find, m.replace), 'utf8')
  const r = run(m.file)
  const bit = Number(r.fail) > 0 || r.code !== 0
  if (!bit) allBit = false
  console.log(`${m.name.padEnd(50)}  exit=${r.code} fail=${r.fail}  ${bit ? 'BIT' : 'DID NOT BIT'}`)
  writeFileSync(m.file, orig, 'utf8')
}

const back = run(DET)
console.log(`\nRESTORED: exit=${back.code} tests=${back.tests} fail=${back.fail}`)
for (const [f, o] of originals) console.log(`  ${f} byte-identical: ${readFileSync(f, 'utf8') === o}`)
console.log(allBit && back.code === 0 ? '\nRESULT: every new control BIT.' : '\nRESULT: A CONTROL DID NOT BIT.')
