/**
 * MUTATION CONTROL for the repo-wide evidence-path invariant.
 *
 * Re-introduces the exact defect that was fixed - prose interpolated into the typed `path` field -
 * and confirms the invariant test goes RED, then restores the file.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const TARGET = 'packages/mission-engine/live/filesystem-mode.ts'
const MUTATIONS = [
  {
    file: 'packages/mission-engine/live/filesystem-mode.ts',
    name: 'E1  prose interpolated back into file-exists path',
    find: '          path: claimed.path,',
    replace: '          path: `${claimed.path} (123 bytes on disk, content "xx")`,',
  },
  {
    // CRLF-aware: these files are checked out with Windows line endings, so an anchor written with
    // a bare `\n` silently fails to match and one mutation goes untested.
    file: 'packages/mission-engine/live/summary-tools.ts',
    name: 'E2  prose interpolated back into file-read-back path',
    re: /          path: claimed\.path,\r?\n          bytes: Buffer\.byteLength\(body, 'utf8'\),/,
    replace: "          path: `${claimed.path} (${body.length} bytes, re-read)`,",
  },
]

const CMD = ['--experimental-strip-types', '--no-warnings', '--test',
  'packages/mission-engine/test/evidence-contract.test.ts']

function run() {
  const r = spawnSync('node', CMD, { encoding: 'utf8' })
  const out = r.stdout || ''
  const t = /tests (\d+)/.exec(out); const f = /fail (\d+)/.exec(out)
  return { code: r.status, tests: t ? t[1] : '?', fail: f ? f[1] : '?' }
}

const base = run()
console.log(`BASELINE: tests=${base.tests} fail=${base.fail} exit=${base.code}\n`)

const HASHES = new Map([...new Set(MUTATIONS.map((m) => m.file))].map((f) => [f, readFileSync(f, 'utf8')]));
let allBit = true
for (const m of MUTATIONS) {
  const orig = readFileSync(m.file, 'utf8')
  const matched = m.re ? m.re.test(orig) : orig.includes(m.find!)
  if (!matched) { console.log(`${m.name.padEnd(52)}  ANCHOR NOT FOUND`); allBit = false; continue }
  writeFileSync(m.file, orig.replace(m.re ?? new RegExp(escapeRe(m.find!)), m.replace), 'utf8')
  const r = run(); const bit = Number(r.fail) > 0
  if (!bit) allBit = false
  console.log(`${m.name.padEnd(52)}  tests=${r.tests} fail=${r.fail} exit=${r.code}  ${bit ? 'BIT' : 'DID NOT BIT'}`)
  writeFileSync(m.file, orig, 'utf8')
}

function escapeRe(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

const back = run()
console.log(`\nRESTORED: tests=${back.tests} fail=${back.fail} exit=${back.code}`)
for (const f of [...new Set(MUTATIONS.map((m) => m.file))]) {
  console.log(`  ${f} byte-identical: ${HASHES.get(f) === hash(f)}`)
}
console.log(allBit && back.code === 0 ? '\nRESULT: the invariant BIT.' : '\nRESULT: IT DID NOT BIT.')

function hash(p: string) { return readFileSync(p, 'utf8') }


