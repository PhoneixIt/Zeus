/**
 * MUTATION TEST for the review security boundary.
 *
 * Confirms the "tampering after approval is detected" claim by removing each protection in turn and
 * showing the security tests go red. Restores the file afterwards and verifies byte-identity.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const TARGETS = [
  {
    file: 'packages/review/digest.ts',
    name: 'S1  postconditions dropped from the digest allowlist',
    find: "    objectivePostconditions: [...(p.objectivePostconditions ?? [])],\n",
    replace: "",
  },
  {
    file: 'packages/review/diff.ts',
    name: 'S2  postcondition changes not reported in the diff',
    find: "  if (canonicalise(bPC) !== canonicalise(aPC)) {",
    replace: "  if (false && canonicalise(bPC) !== canonicalise(aPC)) {",
  },
  {
    file: 'packages/review/render.ts',
    name: 'S3  the approved checks are hidden from the reviewer',
    find: "    - ${describePostcondition(pc)}",
    replace: "    - (withheld)",
  },
]

const CMD = ['--experimental-strip-types', '--no-warnings', '--test', 'packages/review/test/objective-review.test.ts']

const originals = new Map(TARGETS.map((t) => [t.file, readFileSync(t.file, 'utf8')]))

function run() {
  const r = spawnSync('node', CMD, { encoding: 'utf8' })
  const out = r.stdout || ''
  const t = /tests (\d+)/.exec(out)
  const f = /fail (\d+)/.exec(out)
  return { code: r.status, tests: t ? t[1] : '?', fail: f ? f[1] : '?' }
}

const baseline = run()
console.log(`BASELINE (unmutated): tests=${baseline.tests} fail=${baseline.fail} exit=${baseline.code}\n`)

let allBit = true
for (const m of TARGETS) {
  const orig = originals.get(m.file)!
  if (!orig.includes(m.find)) {
    console.log(`${m.name.padEnd(62)}  ANCHOR NOT FOUND`)
    allBit = false
    continue
  }
  writeFileSync(m.file, orig.replace(m.find, m.replace), 'utf8')
  const r = run()
  const bit = Number(r.fail) > 0
  if (!bit) allBit = false
  console.log(`${m.name.padEnd(62)}  tests=${r.tests} fail=${r.fail} exit=${r.code}  ${bit ? 'BIT' : 'DID NOT BIT'}`)
  writeFileSync(m.file, orig, 'utf8')
}

const restored = run()
console.log(`\nRESTORED: tests=${restored.tests} fail=${restored.fail} exit=${restored.code}`)
for (const [f, o] of originals) {
  const now = readFileSync(f, 'utf8')
  console.log(`  ${f} byte-identical: ${now === o}`)
}
console.log(allBit && restored.code === 0 ? '\nRESULT: every security control BIT.' : '\nRESULT: A CONTROL DID NOT BIT.')
