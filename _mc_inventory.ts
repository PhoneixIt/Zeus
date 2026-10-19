/**
 * INVENTORY RECONCILIATION.
 *
 * The previous report claimed 16 host-dependent harnesses, 3 covered, 13 uncovered. A remembered
 * number is not a checked number, so this derives it from the sources and prints what each harness
 * actually needs.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const LIVE = join(process.cwd(), 'packages', 'mission-engine', 'live')
const files = readdirSync(LIVE).filter((f) => f.endsWith('.ts')).sort()

/** What a harness depends on, read from its imports - not guessed from its name. */
function deps(src: string) {
  return {
    controlHost: /liveControl|livePermission/.test(src),
    desktopTool: /observeDesktopTool/.test(src),
    localModel: /8792|local-model|withLocalModel|localModel/i.test(src),
    browser: /playwright|chromium|browser-launch/gi.test(src),
    preflight: /blockOnHost\(\s*await hostAvailability\(\)\s*\)/.test(src),
  }
}

const rows = files.map((f) => ({ name: f, ...deps(readFileSync(join(LIVE, f), 'utf8')) }))

const hostDependent = rows.filter((r) => r.controlHost || r.desktopTool)
const covered = hostDependent.filter((r) => r.preflight)
const uncovered = hostDependent.filter((r) => !r.preflight)

console.log(`total .ts files in live/: ${files.length}`)
console.log(`host-dependent        : ${hostDependent.length}`)
console.log(`with preflight        : ${covered.length}`)
console.log(`WITHOUT preflight     : ${uncovered.length}`)
console.log('')
console.log('--- host-dependent, WITH the preflight ---')
for (const r of covered) console.log(`  ${r.name}   (controlHost=${r.controlHost} desktopTool=${r.desktopTool})`)
console.log('')
console.log('--- host-dependent, WITHOUT the preflight ---')
for (const r of uncovered) console.log(`  ${r.name}   (controlHost=${r.controlHost} desktopTool=${r.desktopTool})`)

console.log('')
console.log('--- the six named as "unresolved" in the last report ---')
for (const n of ['run-auto-recovery.ts', 'run-dev-mission.ts', 'run-dev-recovery.ts',
                 'run-durable-mission.ts', 'run-model-folder-mission.ts', 'run-summary-mission.ts']) {
  const r = rows.find((x) => x.name === n)!
  console.log(`  ${n.padEnd(30)} controlHost=${String(r.controlHost).padEnd(5)} desktopTool=${String(r.desktopTool).padEnd(5)} ` +
    `localModel=${String(r.localModel).padEnd(5)} browser=${String(r.browser).padEnd(5)} preflight=${r.preflight}`)
}
