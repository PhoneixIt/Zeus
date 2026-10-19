/**
 * RUN THE MISSION HARNESSES, using each file's own documented invocation.
 *
 * Categorises every outcome so an expected refusal is never confused with a regression:
 *   OK          - the harness's own checks all passed
 *   OBJECTIVE   - failed on an objective that is DELIBERATELY unproven (browser/navigation)
 *   ENV         - failed for an environmental reason (no browser, no display, no node)
 *   REGRESSION  - failed on a filesystem/terminal objective that should be provable
 */
import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const LIVE = 'packages/mission-engine/live'
const harnesses = readdirSync(LIVE).filter((f) => f.startsWith('run-') && f.endsWith('.ts')).sort()

const rows: { name: string; code: number | null; kind: string; note: string }[] = []

for (const h of harnesses) {
  const r = spawnSync('node', ['--experimental-strip-types', '--no-warnings', `${LIVE}/${h}`], {
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 120000,
  })
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`
  let kind = r.status === 0 ? 'OK' : 'REGRESSION'
  let note = ''

  if (r.status !== 0) {
    if (/objective not verified|objective was not verified|unproven|artifact-content-matches/.test(out)) {
      kind = 'OBJECTIVE'
      note = 'refused: objective deliberately unproven'
    } else if (/ECONNREFUSED|ENOENT|not found|cannot find|spawn|browser|chrome|display|WSL|EPERM|EBUSY|EACCES/.test(out)) {
      kind = 'ENV'
      note = (out.match(/(ECONNREFUSED|ENOENT|EPERM|EACCES|EBUSY)/)?.[0] ?? 'environment')
    }
    const failLine = out.split('\n').filter((l) => /FAIL|✗|not ok|Error:/.test(l)).slice(-1)[0] ?? ''
    note = (note ? note + ' | ' : '') + failLine.trim().slice(0, 110)
  }
  rows.push({ name: h.replace(/\.ts$/, ''), code: r.status, kind, note })
}

const pad = (s: string, n: number) => (s + ' '.repeat(n)).slice(0, n)
console.log(pad('HARNESS', 30) + pad('EXIT', 6) + pad('KIND', 12) + 'NOTE')
console.log('-'.repeat(120))
for (const r of rows) console.log(pad(r.name, 30) + pad(String(r.code), 6) + pad(r.kind, 12) + r.note)

console.log('\n' + '-'.repeat(120))
const by = (k: string) => rows.filter((r) => r.kind === k).length
console.log(`OK ${by('OK')}   OBJECTIVE ${by('OBJECTIVE')}   ENV ${by('ENV')}   REGRESSION ${by('REGRESSION')}   total ${rows.length}`)
console.log('\nNON-ZERO, grouped:')
for (const k of ['OBJECTIVE', 'ENV', 'REGRESSION']) {
  const g = rows.filter((r) => r.kind === k)
  if (g.length) {
    console.log(`\n  ${k} (${g.length}):`)
    for (const r of g) console.log(`    ${r.name}  exit=${r.code}  ${r.note}`)
  }
}
