/**
 * THE ENGINE, as a standalone command.
 *
 * The window does not contain the engine; it runs this. That split is deliberate: the engine
 * launches and kills a browser and writes files, and none of that should be able to take the
 * interface down with it.
 *
 * Called with `--json`, it prints one JSON object per run - which is how the window shows a
 * verdict it did not compute itself, and how a test asserts on a real run.
 */

import { mkdtempSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

import { research, ensureDurableDirs, RUNS_DIR, RESEARCH_ROOT, readHistory, type AppRun } from './research-app.ts'
import { findChrome } from './run-research-desk.ts'

const PORT = Number(process.env.AIOS_CDP_PORT ?? '9333')

export async function runOne(url: string): Promise<AppRun> {
  const chrome = findChrome()
  if (!chrome) throw new Error('no browser found; set AIOS_CHROME')
  ensureDurableDirs()
  return research({
    chromePath: chrome,
    cdpPort: PORT,
    profileDir: mkdtempSync(join(tmpdir(), 'aios-desk-profile-')),
    runDir: RUNS_DIR,
    timeoutMs: 25_000,
    maxBytes: 4 * 1024 * 1024,
  }, url)
}

async function main(): Promise<void> {
  const asJson = process.argv.includes('--json')
  const urls = process.argv.slice(2).filter((a) => !a.startsWith('--'))
  const targets = urls.length > 0
    ? urls
    : ['https://www.iana.org/help/example-domains']

  ensureDurableDirs()
  let failures = 0
  for (const u of targets) {
    const r = await runOne(u)
    if (asJson) {
      // One line of JSON per run: machine-readable, and nothing in it is prose.
      console.log(JSON.stringify({
        stage: r.stage, runId: r.runId, correlationId: r.correlationId,
        url: r.requestedUrl, finalUrl: r.finalUrl, title: r.title,
        elements: r.elements, findings: r.findings, elapsedMs: r.elapsedMs,
        artifactPath: r.artifactPath, verified: r.verified, verifyReason: r.verifyReason,
        interaction: r.interaction, ...(r.failure ? { failure: r.failure } : {}),
      }))
    } else {
      console.log(`\n  ${u}`)
      if (r.stage === 'failed') { console.log(`    FAILED  ${r.failure}`); failures++; continue }
      const i = r.interaction
      console.log(`    ${r.verified ? 'VERIFIED' : 'UNVERIFIED'}  "${r.title.slice(0, 48)}"`)
      console.log(`      ${r.elements} elements, ${r.findings} finding(s), ${r.elapsedMs}ms`)
      if (i) {
        console.log(`      scroll   ${i.scrollBefore} -> ${i.scrollAfter}  ${i.scrolled ? '(moved)' : '(NOT moved)'}`)
        console.log(`      click    hit <${i.clickedTag ?? 'nothing'}> link="${i.clickedHref ?? 'none'}" url ${String(i.urlAfterClick ?? '').slice(0, 60)}`)
        console.log(`      back     ${i.wentBack ? 'returned to the first page' : 'DID NOT go back'}`)
      }
      console.log(`      ${r.verifyReason}`)
      console.log(`      ${r.artifactPath}`)
      if (!r.verified) failures++
    }
  }
  if (!asJson) {
    console.log(`\n  history: ${join(RESEARCH_ROOT, 'history.jsonl')} (${readHistory().length} run(s))`)
  }
  process.exit(failures === 0 ? 0 : 1)
}

/** Am I the process the person actually ran? See the note on the same guard in the desk. */
function isEntryPoint(): boolean {
  const invoked = process.argv[1]
  if (!invoked) return false
  return resolve(invoked) === fileURLToPath(import.meta.url)
}

if (isEntryPoint()) await main()