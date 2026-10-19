/**
 * A number in the report must trace to something the mission measured.
 *
 * Regression tests for P0.2.
 *
 * THE FAILURE, observed live on 2026-10-19. Mission `2a1995ef` wrote a real 407-row CSV and the
 * model's narration, shown to the person as their answer, said:
 *
 *   "The CSV inventory ... has been successfully created ... The file contains 296 files
 *    recursively listed ... with columns: relative_path, name, extension, size_bytes, and
 *    last_modified."
 *
 * 413 files were there. 296 was invented. The file existed, the verdict was honest, the steps had
 * genuinely verified - and the one sentence that carried the headline number was false.
 *
 * WHY NOTHING CAUGHT IT. The honest half of the report is computed by `runGoal` and is sound. The
 * model's own paragraph was prepended to it unexamined (`agent.ts:2689`). An earlier fix fenced
 * the NO-STEPS branch, where prose stands in for a result - but this run executed real steps, so it
 * never entered that branch. The guard was real, and it guarded a different door.
 *
 * THE INVARIANT. Every count the model states must be one the mission measured. A number that is
 * merely plausible is still wrong: 296 against a real 413 is not "close enough", it is a lie in the
 * sentence a person reads last. Removed claims are announced, never silently dropped - a sentence
 * that quietly loses its number reads like a rendering bug and teaches a reader to distrust the
 * parts that are true.
 *
 * WHAT THIS DOES NOT DO, stated so nobody mistakes it for more than it is: it does not verify prose.
 * A sentence can be false without containing a digit. What it makes impossible is the cheapest and
 * most common form of the failure - a confident count.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  auditNumbers, removedClaimsNote, measuredNumbersFrom, extractCountClaims, claimIsSupported,
  type MeasuredNumber,
} from '../live/agent/numbers.ts'

const AGENT_SRC = join(import.meta.dirname, '..', 'live', 'agent', 'agent.ts')
const agentSrc = readFileSync(AGENT_SRC, 'utf8')

// The real claim, verbatim from the live mission.
const THE_REAL_CLAIM =
  'The CSV inventory of the NAKIVO folder has been successfully created at '
  + 'C:\\Users\\Samer\\.aios\\agent\\out\\nakivo-scan.csv and verified. The file contains 296 files '
  + 'recursively listed from C:\\Users\\Samer\\Desktop\\NAKIVO with columns: relative_path, name, '
  + 'extension, size_bytes, and last_modified. The CSV header row and first few data rows have '
  + 'been read back to confirm correctness.'

// ===========================================================================================
// 1. THE ACTUAL FAILURE
// ===========================================================================================

test('the fabricated count from the live mission is removed', () => {
  const measured: MeasuredNumber[] = [
    { value: 413, source: 'the scanner on disk' },
    { value: 5, source: 'the plan' },
    { value: 2, source: 'the verifiers' },
  ]
  const r = auditNumbers(THE_REAL_CLAIM, measured)

  assert.deepEqual(r.removed, ['296 files'],
    'the count no step measured must be removed')
  assert.doesNotMatch(r.text, /\b296\b/,
    'the fabricated number must not survive anywhere in the text')
  assert.match(r.text, /recursively listed/,
    'removing the number must not mangle the rest of the sentence')
  assert.match(r.text, /CSV inventory of the NAKIVO folder/,
    'the surrounding sentence must remain readable')
})

test('a real count in the same sentence is KEPT', () => {
  // The asymmetry matters: a filter that removed everything would make the report worse, not
  // safer. Only the unmeasured claim goes.
  const r = auditNumbers('Scanned 413 files and wrote 296 rows.', [
    { value: 413, source: 'the scanner' },
  ])
  assert.ok(r.text.includes('413 files'), 'a measured count must survive')
  assert.ok(!r.text.includes('296'), 'an unmeasured count must go')
  assert.deepEqual(r.removed, ['296 rows'])
})

// ===========================================================================================
// 2. THE MEASUREMENT SIDE
// ===========================================================================================

test('measuredNumbersFrom gathers counts from what actually ran, not from the plan', () => {
  const m = measuredNumbersFrom([
    { id: 's1', tool: 'terminal', verified: true, summary: '413 data row(s), 5 column(s)' },
    { id: 's2', tool: 'read-file', verified: false, summary: 'NOT verified' },
    { id: 's3', tool: 'write-file', verified: true, summary: 'wrote 74701 byte(s)' },
  ])
  const values = m.map((x) => x.value)
  assert.ok(values.includes(413), 'a row count reported by a step is measurable')
  assert.ok(values.includes(74701), 'a byte count reported by a step is measurable')
  assert.ok(values.includes(3), 'the step count is measurable')

  // Every measurement must name where it came from. A number with no source cannot be checked by
  // a reader, which is the whole point.
  for (const x of m) assert.ok(x.source.length > 0, `no source for ${x.value}`)
})

test('a claim is supported only by an exact match', () => {
  const measured: MeasuredNumber[] = [{ value: 413, source: 'scanner' }]
  assert.ok(claimIsSupported(413, measured))
  assert.equal(claimIsSupported(296, measured), null,
    'a near miss is still a miss - 296 is not "close enough" to 413')
  assert.equal(claimIsSupported(412, measured), null)
})

// ===========================================================================================
// 3. WHAT IS AND IS NOT TREATED AS A COUNT
// ===========================================================================================

test('labels, paths and versions are not treated as quantity claims', () => {
  // A filter that policed bare digits would mangle every honest report: a path, a version and a
  // port all contain them. What identifies a quantity is the UNIT beside it.
  assert.deepEqual(extractCountClaims('Saved to C:\\Users\\Samer\\out\\report-2026-10-19.csv'), [])
  assert.deepEqual(extractCountClaims('Node.js v24.21.0 on port 8777'), [])
  assert.deepEqual(extractCountClaims('opened https://example.com/page2'), [])
})

test('quantities with units ARE claims', () => {
  const claims = extractCountClaims('found 413 files, 5 columns, 2 directories')
  assert.deepEqual(claims.map((c) => c.value).sort((a, b) => a - b), [2, 5, 413])
})

test('positions are not claims, but small quantities ARE', () => {
  // "step 1" and "1 of 4" are positions, and the extractor already excludes them because there is
  // no UNIT beside the number. An earlier version also excluded 0-5 by VALUE, which threw away
  // "5 columns" and "2 directories" - real quantities the mission may well have measured.
  assert.deepEqual(extractCountClaims('step 1 of 4'), [],
    'a number with no unit is a position or part of a name, not a quantity')
  assert.deepEqual(extractCountClaims('0 errors').map((c) => c.value), [0],
    '"0 errors" is a genuine measurement and must be checkable')
  assert.deepEqual(extractCountClaims('found 2 directories').map((c) => c.value), [2],
    'a small count with a unit is still a count')
})

test('thousands separators are handled', () => {
  const r = auditNumbers('the file contains 1,024 rows', [{ value: 1024, source: 'scanner' }])
  assert.deepEqual(r.removed, [], 'a comma-formatted real count must be recognised as supported')
  assert.match(r.text, /1,024 rows/)
})

test('text with no counts is returned untouched', () => {
  const t = 'The folder was opened and the inventory was saved.'
  const r = auditNumbers(t, [])
  assert.equal(r.text, t, 'prose without counts must not be altered')
  assert.deepEqual(r.removed, [])
})

// ===========================================================================================
// 4. THE ANNOUNCEMENT
// ===========================================================================================

test('a removed claim is announced, never dropped silently', () => {
  // A reader must be able to tell the difference between "the system corrected itself" and "the
  // report rendered oddly". Silence would teach them to distrust the parts that ARE true.
  const note = removedClaimsNote(['296 files'], [{ value: 413, source: 'the scanner' }])
  assert.match(note, /296 files/)
  assert.match(note, /413/)
  assert.match(note, /scanner/)
  assert.match(note, /no step measured/i)
})

test('no note is produced when nothing was removed', () => {
  assert.equal(removedClaimsNote([], [{ value: 413, source: 'x' }]), '')
})

test('a mission that measured nothing says so rather than inventing a figure', () => {
  const note = removedClaimsNote(['296 files'], [])
  assert.match(note, /measured no quantities/i)
  assert.doesNotMatch(note, /The figures this mission did measure are:/)
})

// ===========================================================================================
// 5. IT IS WIRED IN, AND WIRED IN WHERE THE FABRICATION ACTUALLY HAPPENED
// ===========================================================================================

test('the narration is audited before it is appended to the conversation', () => {
  // The defect was precisely that the model's reply reached the transcript unexamined.
  assert.doesNotMatch(
    agentSrc,
    /text: [\s\S]{0,4}\$\{plan\.reply\}\\n\\n\$\{text\}/,
    'the model reply must no longer be prepended to the honest report without being audited.',
  )
  assert.match(
    agentSrc,
    /auditNumbers\(plan\.reply,\s*measured\)/,
    'the model narration must pass through the number audit.',
  )
  assert.match(
    agentSrc,
    /appendConversation\(\{ role: 'assistant', text: assistantText/,
    'what is persisted must be the audited text.',
  )
})

test('a removal is surfaced to the person, not only to the transcript', () => {
  assert.match(
    agentSrc,
    /emit\(\{\s*kind: 'status',[\s\S]{0,400}?no step measured/,
    'removing a claim must be announced in the live status feed, not only written to the log.',
  )
})