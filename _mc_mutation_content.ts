/**
 * MUTATION TEST for the content-verification path.
 *
 * C1 - the composer's canonical ordering removed -> the prediction stops matching what is written.
 * C2 - the planner stops declaring the content condition -> the objective no longer checks content.
 * C3 - the content condition stops comparing hashes -> a wrong report is accepted.
 *
 * Restores every file and verifies byte-identity.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const SUM = 'packages/planner/summarizer.ts'
const DET = 'packages/planner/deterministic.ts'
const ST = 'packages/mission-engine/state.ts'

const MUTATIONS = [
  {
    file: SUM, name: 'C1  canonical ordering removed from the composer',
    find: "    const entries = [...input.entries].sort((a, b) =>\n      a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind))",
    replace: "    const entries = [...input.entries]",
  },
  {
    file: DET, name: 'C2  planner stops declaring the content postcondition',
    find: "  if (!expected.ok) return base\n  return [...base, { kind: 'artifact-content-matches', path: outPath, sha256: expected.sha256 }]",
    replace: "  if (!expected.ok) return base\n  return base",
  },
  {
    file: ST, name: 'C3  content condition stops comparing the hash',
    find: "        proved = all.some((e) => e.kind === 'file-read-back'\n          && samePath(e.path, pc.path) && typeof e.sha256 === 'string' && e.sha256 === pc.sha256)",
    replace: "        proved = all.some((e) => e.kind === 'file-read-back'\n          && samePath(e.path, pc.path) && typeof e.sha256 === 'string')",
  },
]

const CMD = ['--experimental-strip-types', '--no-warnings', '--test',
  'packages/planner/test/expected-content.test.ts',
  'packages/mission-engine/test/objective.test.ts']

const originals = new Map(MUTATIONS.map((m) => [m.file, readFileSync(m.file, 'utf8')]))

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
  const orig = originals.get(m.file)!
  if (!orig.includes(m.find)) { console.log(`${m.name.padEnd(58)}  ANCHOR NOT FOUND`); allBit = false; continue }
  writeFileSync(m.file, orig.replace(m.find, m.replace), 'utf8')
  const r = run(); const bit = Number(r.fail) > 0
  if (!bit) allBit = false
  console.log(`${m.name.padEnd(58)}  tests=${r.tests} fail=${r.fail}  ${bit ? 'BIT' : 'DID NOT BIT'}`)
  writeFileSync(m.file, orig, 'utf8')
}
const back = run()
console.log(`\nRESTORED: tests=${back.tests} fail=${back.fail} exit=${back.code}`)
for (const [f, o] of originals) console.log(`  ${f} byte-identical: ${readFileSync(f, 'utf8') === o}`)
console.log(allBit && back.code === 0 ? '\nRESULT: every content-path control BIT.' : '\nRESULT: A CONTROL DID NOT BIT.')
