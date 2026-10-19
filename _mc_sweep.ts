/**
 * HARNESS SWEEP, with each harness's documented arguments supplied.
 *
 * Categories, and the point of having them:
 *   OK         - every one of the harness's own checks passed
 *   UNPROVEN   - refused because the objective is DELIBERATELY unproven (browser/navigation: no
 *                evidence producer exists, and declaring one is out of scope)
 *   HOST       - needs a host that is not running on this machine (AIOS host port, local model)
 *   BREAK      - failed on something that should have worked
 */
import { readdirSync, mkdirSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const LIVE = 'packages/mission-engine/live'
const all = readdirSync(LIVE).filter((f) => f.startsWith('run-') && f.endsWith('.ts')).sort()

// Documented invocations that take arguments.
function fixture(): { src: string; outDir: string; outFile: string } {
  const src = join(tmpdir(), `mc-sw-${Math.random().toString(36).slice(2, 10)}`)
  const outDir = join(tmpdir(), `mc-so-${Math.random().toString(36).slice(2, 10)}`)
  mkdirSync(src, { recursive: true }); mkdirSync(outDir, { recursive: true })
  writeFileSync(join(src, 'a.ts'), 'a'.repeat(120))
  writeFileSync(join(src, 'b.ts'), 'b'.repeat(80))
  writeFileSync(join(src, 'c.md'), 'c'.repeat(200))
  return { src, outDir, outFile: join(outDir, 'summary.txt') }
}
function argsFor(h: string): string[] {
  const f = fixture()
  if (h === 'run-folder-summary.ts') return ['--source', f.src, '--output', f.outFile]
  if (h === 'run-model-folder-mission.ts') return ['--source', f.src, '--output', f.outFile]
  return []
}

const rows: { h: string; code: number | null; kind: string; note: string }[] = []
for (const h of all) {
  const r = spawnSync('node', ['--experimental-strip-types', '--no-warnings', `${LIVE}/${h}`, ...argsFor(h)],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 120000 })
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`
  let kind = r.status === 0 ? 'OK' : 'BREAK'
  let note = ''
  if (r.status !== 0) {
    if (/ECONNREFUSED[\s\S]{0,80}(60997|8792|8791)|Failed to fetch|fetch failed/i.test(out)) {
      kind = 'HOST'; note = 'host/model port not listening on this machine'
    } else if (/REFUSED: --|was not given|must be an absolute path|unexpected argument/i.test(out)) {
      kind = 'ARGS'; note = 'needs arguments this sweep did not supply'
    } else if (/objective (was )?not verified|UNPROVEN|unproven|artifact-content-matches|not declared/i.test(out)) {
      kind = 'UNPROVEN'; note = 'objective deliberately unproven (no evidence producer)'
    } else if (/browser|chrome|playwright|chromium|display|screenshot|DISPLAY/i.test(out)) {
      kind = 'HOST'; note = 'browser/GUI host unavailable'
    }
    const fail = out.split('\n').filter((l) => /FAIL|Error:|✗/.test(l)).slice(-1)[0] ?? ''
    note = (note ? note + ' | ' : '') + fail.trim().replace(/\s+/g, ' ').slice(0, 96)
  }
  rows.push({ h: h.replace(/\.ts$/, ''), code: r.status, kind, note })
}

const pad = (s: string, n: number) => (s + ' '.repeat(n)).slice(0, n)
console.log(pad('HARNESS', 30) + pad('EXIT', 6) + pad('KIND', 10) + 'NOTE')
console.log('-'.repeat(126))
for (const r of rows) if (r.kind !== 'OK') console.log(pad(r.h, 30) + pad(String(r.code), 6) + pad(r.kind, 10) + r.note)
console.log('')
for (const r of rows) if (r.kind === 'OK') console.log(pad(r.h, 30) + pad(String(r.code), 6) + pad(r.kind, 10) + '(all checks passed)')
console.log('\n' + '-'.repeat(126))
const n = (k: string) => rows.filter((r) => r.kind === k).length
console.log(`OK ${n('OK')}   UNPROVEN ${n('UNPROVEN')}   HOST ${n('HOST')}   ARGS ${n('ARGS')}   BREAK ${n('BREAK')}   total ${rows.length}`)
console.log('\nBREAK (need triage):')
for (const r of rows.filter((x) => x.kind === 'BREAK')) console.log(`  ${r.h}  exit=${r.code}  ${r.note}`)
