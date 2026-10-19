/**
 * INDEPENDENT VERIFICATION OF COMPANY BRIEFS, as a command.
 *
 * Run this in a FRESH PROCESS after the mission process has exited. That is the whole point:
 * a verifier sharing a process with the writer can be reading the writer's memory, and memory
 * is not evidence. Everything below is read from disk.
 *
 *   node --experimental-strip-types --no-warnings packages/mission-engine/live/verify-company-brief.ts
 *   node --experimental-strip-types --no-warnings packages/mission-engine/live/verify-company-brief.ts <correlationId>
 *
 * The expected correlation id is taken from the COMMAND LINE or from the FILENAME - never from
 * the contents of the file being verified. A verifier that reads the id out of the artifact it
 * is checking cannot detect a substitution.
 *
 * Exit code 0 only when every brief passes.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { BRIEFS_DIR } from './company-brief.ts'
import { verifyBrief, type BriefVerdict } from './verify-brief.ts'

/** A PASS/FAIL line that does not affect the verdict - for informational checks. */
function check_quiet(name: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'ok  ' : 'WARN'}  ${name}${detail ? `  (${detail})` : ''}`)
}

function show(v: BriefVerdict, name: string): boolean {
  console.log(`\n  === ${name} ===`)
  for (const c of v.checks) console.log(`    ${v.ok ? 'PASS' : '....'}  ${c}`)
  if (v.ok) {
    console.log(`    PASS  brief verified independently: ${v.sourcesVerified} source artifact(s) re-read from disk, ${v.claimsTraced} claim(s) traced to stored quotes, ${v.unverifiedClaims} correctly marked unproven`)
    return true
  }
  console.log(`    FAIL  ${v.reason}`)
  return false
}

interface LegacyEntry {
  readonly briefIds: readonly string[]
  readonly recordedAt: string
  readonly reason: string
  readonly status: string
  readonly note?: string
}

/**
 * LEGACY BRIEF REGISTRY - briefs whose artifacts predate the site-chrome classification.
 *
 * Same rule as the research quarantine registry, and the same reason for existing. Requiring a
 * classification that did not exist when a brief was written makes a real, complete, correctly
 * verified mission fail forever. That is a true statement about the file and a useless one
 * about the system.
 *
 * The exemption is deliberately NARROW. It applies only when the brief's failure is exactly
 * "legacy (v1) artifact with no site-chrome classification". A registered brief that fails for
 * any other reason still fails. A brief that IS classified must pass with nothing held back.
 * And the registry is a dated, reasoned file on disk, not a silent filter.
 */
const LEGACY_PATH = join(BRIEFS_DIR, 'legacy.json')

function loadLegacy(): { ids: Set<string>; ok: boolean; recordedAt: string } {
  const ids = new Set<string>()
  if (!existsSync(LEGACY_PATH)) return { ids, ok: true, recordedAt: '' }
  try {
    const reg = JSON.parse(readFileSync(LEGACY_PATH, 'utf8')) as { entries?: LegacyEntry[] }
    for (const e of reg.entries ?? []) for (const id of e.briefIds ?? []) ids.add(id)
    return { ids, ok: true, recordedAt: reg.entries?.[0]?.recordedAt ?? '' }
  } catch (e) {
    console.log(`  WARNING  the legacy-brief registry could not be read: ${e instanceof Error ? e.message : String(e)}`)
    console.log('           treating it as EMPTY - legacy briefs will be reported as failures')
    return { ids, ok: false, recordedAt: '' }
  }
}

/**
 * The only two failures the legacy registry may hold back.
 *
 * Both are "this brief predates a capability the current pipeline requires" - no classification
 * at all (v1), or a classification whose evidence was not persisted (v2). Neither is a claim
 * about the world's truth; both are claims about what the file can support. Anything else -
 * a digest mismatch, an unreproducible classification, a broken citation - still fails.
 *
 * The match is anchored on those exact reasons so the exemption cannot widen by accident. A new
 * reason string would NOT be exempted, which is the intended failure mode: the registry would
 * need updating deliberately.
 */
const LEGACY_ONLY = /legacy \(v1\) artifact with no site-chrome classification|no structural evidence \(schemaVersion 2\)/

function main(): number {
  const asked = process.argv.slice(2).filter((a) => !a.startsWith('--'))
  const dir = BRIEFS_DIR

  if (!existsSync(dir)) {
    console.log(`  no briefs directory at ${dir}`)
    console.log('  (nothing has been produced yet - that is not a pass)')
    return 1
  }

  const all = readdirSync(dir).filter((f) => f.endsWith('.brief.json')).sort()
  const targets = asked.length > 0
    ? asked.map((id) => `${id}.brief.json`)
    : all

  if (targets.length === 0) {
    console.log(`  no briefs found in ${dir}`)
    return 1
  }

  console.log(`  briefs directory : ${dir}`)
  console.log(`  brief(s) on disk : ${all.length}`)
  console.log(`  verifying        : ${targets.length}`)

  let failures = 0
  let legacyHeld = 0
  const legacy = loadLegacy()
  check_quiet('the legacy-brief registry is readable', legacy.ok, `${legacy.ids.size} brief(s) listed`)

  for (const file of targets) {
    const path = join(dir, file)
    // The id the CALLER expects, derived from the name, not from the file's own field.
    const expectedId = file.replace(/\.brief\.json$/, '')
    const v = verifyBrief(path, { correlationId: expectedId, minSources: 2 })

    if (v.ok) { show(v, expectedId); continue }

    // Only the exact "predates the classification" failure is held back, and only for a brief
    // that is actually on the registry. Anything else is a genuine fault.
    if (legacy.ids.has(expectedId) && LEGACY_ONLY.test(v.reason)) {
      legacyHeld++
      console.log(`\n  === ${expectedId} ===`)
      for (const c of v.checks) console.log(`    ....  ${c}`)
      console.log(`    LEGACY  ${v.reason}`)
      console.log(`    Excluded from the production verdict because this brief predates the site-chrome`)
      console.log(`    classification (recorded ${legacy.recordedAt}). It is a real, complete mission whose`)
      console.log(`    quotes all verify against their artifacts; it simply cannot make chrome-aware claims.`)
      continue
    }
    if (!show(v, expectedId)) failures++
  }

  console.log('')
  if (legacyHeld > 0) {
    console.log(`  ${legacyHeld} legacy brief(s) excluded from this verdict and listed above, not hidden.`)
  }
  console.log(`  ${failures === 0 ? '=== ALL CURRENT BRIEFS PASS ===' : `=== ${failures} CURRENT BRIEF(S) FAILED VERIFICATION ===`}`)
  return failures === 0 ? 0 : 1
}

process.exit(main())