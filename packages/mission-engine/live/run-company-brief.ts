/**
 * THE COMPANY-BRIEF MISSION, as a standalone command and as a module the window can call.
 *
 * =============================================================================
 * WHY THE UI CALLS THIS FILE AND NOT `company-brief.ts` DIRECTLY
 * =============================================================================
 *
 * The mission launches and kills a browser and writes files. None of that should be able to
 * take the interface down with it, so the window shells out to this exactly as it already
 * shells out to `research-engine.ts`. One place decides where the browser profile lives, which
 * port is used, and which limits apply - so the window and the command line cannot drift into
 * behaving differently.
 *
 * With `--json` it prints one JSON object, which is how the window renders a verdict it did
 * not compute itself.
 *
 * USAGE
 *   run-company-brief.ts --url https://example.com --objective "What does this company sell?"
 *
 * $0: no model is called. `mode` is `deterministic-extraction` and `modelUsed` is null. There is
 * no provider, no key, and no fallback that could become billable.
 */

import { mkdtempSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

import { runCompanyBrief, ensureBriefDirs, renderBriefReport, BRIEFS_DIR, type BriefRunResult } from './company-brief.ts'
import { RUNS_DIR } from './research-app.ts'
import { findChrome } from './run-research-desk.ts'

const PORT = Number(process.env.AIOS_CDP_PORT ?? '9333')

export async function runBrief(objective: string, url: string): Promise<BriefRunResult> {
  const chrome = findChrome()
  if (!chrome) throw new Error('no browser found; set AIOS_CHROME')
  ensureBriefDirs()
  return runCompanyBrief({
    chromePath: chrome,
    cdpPort: PORT,
    // A throwaway profile per mission. The user's ordinary browser profile is never opened,
    // so their sessions, cookies and tabs are not reachable from here.
    profileDir: mkdtempSync(join(tmpdir(), 'aios-brief-profile-')),
    runDir: RUNS_DIR,
  }, objective, url)
}

/** The window consumes this shape. */
export function toJsonLine(r: BriefRunResult): string {
  return JSON.stringify({
    stage: r.terminalState,
    correlationId: r.correlationId,
    objective: r.objective,
    startingUrl: r.startingUrl,
    mode: r.mode,
    modelUsed: r.modelUsed,
    elapsedMs: r.elapsedMs,
    briefPath: r.briefPath,
    sources: r.sources.map((s) => ({
      id: s.id, url: s.url, title: s.title, elements: s.elementCount,
      findings: s.findingCount, selectedBy: s.selectedBy, selectedReason: s.selectedReason,
    })),
    claimCount: r.claims.length,
    traceableClaims: r.claims.filter((c) => c.kind === 'quoted-fact').length,
    derivedClaims: r.claims.filter((c) => c.kind === 'rule-derived').length,
    // The rendered report travels with the verdict, so a UI shows the same text the command
    // line does instead of re-deriving a summary of its own.
    report: renderBriefReport(r, { maxPerSection: 6 }),
    unresolved: r.unresolved,
    warnings: r.warnings,
    terminalReason: r.terminalReason,
  })
}

function arg(name: string): string | null {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null
}

async function main(): Promise<void> {
  const asJson = process.argv.includes('--json')
  const objective = arg('--objective') ?? 'What does this company sell, and who is it for?'
  const url = arg('--url') ?? process.argv.slice(2).find((a) => a.startsWith('https://'))

  if (!url) {
    console.error('  usage: run-company-brief.ts --url https://example.com --objective "..."')
    process.exit(2)
  }

  let r: BriefRunResult
  try {
    r = await runBrief(objective, url)
  } catch (e) {
    // A mission that could not start is still a reportable outcome, not a stack trace.
    const msg = e instanceof Error ? e.message : String(e)
    if (asJson) console.log(JSON.stringify({ stage: 'failed', terminalReason: msg, sources: [], claims: 0 }))
    else console.error(`  FAILED  ${msg}`)
    process.exit(1)
    return
  }

  if (asJson) {
    console.log(toJsonLine(r))
    process.exit(r.terminalState === 'failed' ? 1 : 0)
    return
  }

  console.log(`\n  ${r.objective}`)
  console.log(`  ${r.startingUrl}`)
  console.log(`  ${r.terminalState.toUpperCase()}  ${r.terminalReason}`)
  console.log(`  mode: ${r.mode}   model used: ${r.modelUsed ?? 'none'}`)
  console.log('')
  for (const line of renderBriefReport(r, { maxPerSection: 6 })) console.log(`  ${line}`)
  // Sources, claims and unresolved questions are printed by renderBriefReport above, so they are
  // not repeated here. A summary that restates the report in a second shape is a second place to
  // drift out of agreement with the first.
  if (r.warnings.length > 0) {
    console.log(`\n  WARNINGS (${r.warnings.length})`)
    for (const w of r.warnings) console.log(`    ! ${w}`)
  }
  console.log(`\n  brief:  ${r.briefPath}`)
  console.log(`  briefs: ${BRIEFS_DIR}`)
  process.exit(r.terminalState === 'failed' ? 1 : 0)
}

function isEntryPoint(): boolean {
  const invoked = process.argv[1]
  if (!invoked) return false
  return resolve(invoked) === fileURLToPath(import.meta.url)
}

if (isEntryPoint()) await main()

// dirname is imported for parity with research-engine.ts; keep the reference explicit so a
// future relative-path change is a one-line edit rather than a hunt.
void dirname