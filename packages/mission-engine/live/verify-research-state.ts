/**
 * FRESH-PROCESS VERIFICATION of the research desk's durable state.
 *
 * =============================================================================
 * WHY THIS IS A SEPARATE PROGRAM
 * =============================================================================
 *
 * The engine verifies its own artifact inside the process that wrote it. That proves the
 * writer can read its own file. It does not prove the file survived the process, and it cannot
 * catch a defect where the writer and the verifier share a mistaken assumption - because they
 * run in the same place at the same time with the same imports.
 *
 * So this reads ONLY what is on disk, in a process that never launched a browser and never
 * imported the engine's runtime state. It re-derives every verdict from the bytes.
 *
 * It also checks the history file, because history is what makes a run auditable: every line
 * must carry the same correlation id as the artifact it claims to describe, so a result cannot
 * be filed against the wrong run.
 *
 * Usage: node --experimental-strip-types --no-warnings packages/mission-engine/live/verify-research-state.ts
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { verifyRun } from './web-verify.ts'
import { RESEARCH_ROOT, RUNS_DIR, HISTORY_PATH, readHistory } from './research-app.ts'

/**
 * The quarantine registry: artifacts that are KNOWN-BAD historical bytes, deliberately retained.
 *
 * Why this exists, and what it deliberately does NOT do:
 *
 * Two artifacts failed verification because of a defect that was found, root-caused and fixed.
 * The options were to delete them (destroying the evidence that the verifier works), to leave
 * them mixed in with production state (making every future run report two failures that no
 * longer describe anything real), or to record them explicitly. This is the third option.
 *
 * The rule this file enforces:
 *   - a quarantined artifact is REPORTED, BY NAME, WITH ITS ORIGINAL REJECTION REASON
 *   - it does NOT count as a production failure
 *   - it does NOT count as a pass either
 *   - anything not on the list is production state, and a failure there FAILS the verifier
 *
 * So the registry can never be used to make a green result by hiding a real current failure -
 * adding an artifact to it is an explicit, dated, reasoned act, and the entry is itself on disk
 * where anyone can read what was excused and why.
 */
interface QuarantineEntry {
  readonly artifactIds: readonly string[]
  readonly quarantinedAt: string
  readonly defect: string
  readonly status: string
  readonly rejectedBecause: string
  readonly note?: string
}
interface QuarantineRegistry {
  readonly entries: readonly QuarantineEntry[]
}

const QUARANTINE_PATH = join(RESEARCH_ROOT, 'quarantine.json')

function loadQuarantine(): { ids: Map<string, QuarantineEntry>; entries: QuarantineEntry[]; ok: boolean } {
  const ids = new Map<string, QuarantineEntry>()
  const entries: QuarantineEntry[] = []
  if (!existsSync(QUARANTINE_PATH)) return { ids, entries, ok: true }
  try {
    const reg = JSON.parse(readFileSync(QUARANTINE_PATH, 'utf8')) as QuarantineRegistry
    for (const e of reg.entries ?? []) {
      entries.push(e)
      for (const id of e.artifactIds ?? []) ids.set(id, e)
    }
    return { ids, entries, ok: true }
  } catch (e) {
    // A corrupt registry must NOT be treated as "nothing is quarantined", because that would
    // silently promote quarantined bytes to production and fail the run for the wrong reason.
    // It must also not be treated as "everything is quarantined". Report and carry on empty.
    console.log(`  WARNING  the quarantine registry at ${QUARANTINE_PATH} could not be read: ${e instanceof Error ? e.message : String(e)}`)
    console.log('           treating it as EMPTY - quarantined artifacts will be reported as production failures')
    return { ids, entries, ok: false }
  }
}

let failed = 0
let quarantinedRejected = 0
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
  if (!ok) failed++
}

console.log('=== durable state, read from disk by a fresh process ===')
console.log(`  root    ${RESEARCH_ROOT}`)
check('the state directory exists', existsSync(RESEARCH_ROOT))
check('the runs directory exists', existsSync(RUNS_DIR))
check('the history file exists', existsSync(HISTORY_PATH), HISTORY_PATH)

const artifacts = existsSync(RUNS_DIR) ? readdirSync(RUNS_DIR).filter((f) => f.endsWith('.record.json')) : []
check('at least one artifact survived the engine process', artifacts.length > 0, `${artifacts.length} artifact(s)`)

console.log('')
console.log('=== every PRODUCTION artifact re-verified from bytes ===')
const quarantine = loadQuarantine()
check('the quarantine registry is readable', quarantine.ok,
  `${quarantine.entries.length} entr(ies), ${quarantine.ids.size} artifact(s) listed`)

const seenIds = new Set<string>()
for (const f of artifacts) {
  const p = join(RUNS_DIR, f)
  // The expected run id is DERIVED FROM THE FILENAME, not read out of the file. A record that
  // disagreed with its own name would otherwise verify itself.
  const runId = f.replace(/\.record\.json$/, '')
  seenIds.add(runId)
  let finalUrl = ''
  try { finalUrl = String((JSON.parse(readFileSync(p, 'utf8')) as { finalUrl?: string }).finalUrl ?? '') } catch { /* handled by the verifier */ }
  const v = verifyRun(p, { runId, url: finalUrl, minElements: 3 })

  // The artifact is verified FIRST, and on its own merits. Only then is the registry consulted,
  // so a quarantined artifact that has since been fixed would be reported as verified, and a
  // quarantined artifact that fails for a DIFFERENT reason would still be shown that reason.
  if (v.ok) {
    const q = quarantine.ids.get(runId)
    const tag = q ? 'VERIFIED  (was quarantined - the defect no longer reproduces)' : 'VERIFIED  '
    console.log(`  ${tag}${runId}  ${v.record.elements.length} elements, ${v.rechecked} finding(s)`)
    if (q) console.log(`            classified ${v.record.schemaVersion === 3 ? 'schemaVersion 3 (classification reproduced from persisted evidence)' : v.record.schemaVersion === 2 ? 'schemaVersion 2 (classified, but NOT reproducible - no persisted evidence)' : 'legacy, pre-classification'}`)
    continue
  }

  const q = quarantine.ids.get(runId)
  if (q) {
    quarantinedRejected++
    console.log(`  QUARANTINED ${runId}`)
    console.log(`            reason on record: ${q.rejectedBecause}`)
    console.log(`            reason now      : ${v.reason}`)
    console.log(`            quarantined ${q.quarantinedAt}; status: ${q.status}`)
    console.log(`            excluded from the production verdict, retained as evidence`)
    continue
  }
  console.log(`  REJECTED  ${runId}  ${v.reason}`)
  failed++
}

console.log('')
console.log('=== quarantined historical artifacts (reported, not counted as production) ===')
if (quarantine.entries.length === 0) {
  console.log('  none')
} else {
  for (const e of quarantine.entries) {
    console.log(`  ${e.quarantinedAt}  ${e.artifactIds.length} artifact(s)  status=${e.status}`)
    console.log(`    defect: ${e.defect}`)
  }
  console.log(`  ${quarantinedRejected} quarantined artifact(s) still fail verification, as expected and retained.`)
  console.log('  They are listed so the rejection stays visible; they do not represent a current fault.')
}

console.log('')
console.log('=== the history matches the artifacts, by correlation id ===')
const history = readHistory()
check('history has entries', history.length > 0, `${history.length} line(s)`)
// History is append-only, so a line per run is expected; each must name a real artifact.
const orphans = history.filter((h) => !seenIds.has(h.correlationId))
check('every history line names an artifact that exists', orphans.length === 0,
  orphans.length ? `${orphans.length} orphan(s): ${orphans.slice(0, 2).map((o) => o.correlationId).join(', ')}` : '')
const dupes = history.length - new Set(history.map((h) => h.correlationId)).size
check('no duplicate correlation ids in history', dupes === 0, `${dupes} duplicate(s)`)

// And the interaction evidence must have been recorded, not just claimed in the summary.
const withInteraction = history.filter((h) => h.interaction && h.interaction.scrolled)
check('runs recorded real scroll evidence', withInteraction.length > 0, `${withInteraction.length} run(s) scrolled`)
const clicked = history.filter((h) => h.interaction && h.interaction.clickedHref)
check('runs recorded a real link click', clicked.length > 0, `${clicked.length} run(s) clicked a link`)
const back = history.filter((h) => h.interaction && h.interaction.wentBack)
check('runs recorded real back navigation', back.length > 0, `${back.length} run(s) went back`)

console.log('')
console.log(`=== ${failed === 0 ? 'PASS' : failed + ' FAILURE(S)'} (production state) ===`)
if (quarantinedRejected > 0) {
  console.log(`  ${quarantinedRejected} quarantined historical artifact(s) excluded from this verdict and listed above.`)
}
process.exit(failed ? 1 : 0)