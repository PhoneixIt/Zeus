/**
 * THE CLOSED LOOP MUST BE ABLE TO TELL A DELIVERABLE FROM A PROMISE
 * ================================================================
 *
 * The failure these tests exist to prevent is not hypothetical. It was observed end to end on this
 * machine: "data protection companies" produced three verified steps, `ok=true`, the message
 *
 *     Completed 3 step(s); every step and the objective were independently verified.
 *
 * and a file containing
 *
 *     Company,Founded,Description
 *     To be populated from the research results,,
 *
 * Every existing check passed. All of them were checking that a file existed, was rectangular, and
 * read back identically. None of them asked whether it contained anything - so a green report
 * shipped an empty deliverable, which is strictly worse than a red one because it is believed.
 *
 * These tests cover the two halves of the fix: the deterministic substance check, and the feedback
 * that carries the earlier steps' REAL CONTENT forward, because without the content a replan is the
 * same plan asked twice.
 *
 * The negative cases matter as much as the positive ones. A placeholder detector that fires on real
 * data is worse than none at all: it throws away a good answer and sends the user looking for
 * another one without ever saying why. So "unknown headquarters", "N/A", "none", "0" and "-" are
 * all asserted to PASS, deliberately.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL, fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const REPLAN = pathToFileURL(join(HERE, '..', 'live', 'agent', 'replan.ts')).href

const load = () => import(REPLAN)

// ============================================================ the substance check

test('an empty table of promises is recognised as a promise', async () => {
  const { findPlaceholderContent, placeholderRatio } = await load()
  const marker = findPlaceholderContent('To be populated from the research results,,')
  assert.ok(marker.length > 0, 'a promise written in words must be reported as one')

  // A row of nothing but separators is a DIFFERENT fault and is caught by a different function.
  // `findPlaceholderContent` asks "does this text announce that it is unfinished?" and `,,` does
  // not announce anything - it is simply empty. Answering "it is a placeholder" for it would be
  // conflating absence with a stated intention, and would make the marker's evidence unusable.
  // `placeholderRatio` is the function that sees absence, so it is the one that must catch it.
  assert.deepEqual(findPlaceholderContent(',,'), [], 'absence is not a marker')
  assert.equal(placeholderRatio([',,', ',,']), 1, 'a table of nothing IS wholly a promise')
})

test('the exact row this defect produced is caught', async () => {
  // Taken verbatim from the real file. If this regresses, the bug that motivated the whole module
  // is back and no test that merely paraphrases the case would notice.
  const { findPlaceholderContent } = await load()
  const real = 'To be populated from the research results,,'
  assert.match(findPlaceholderContent(real).join(' '), /to be populated/i)
})

test('a sheet of real companies is NOT a placeholder', async () => {
  const { findPlaceholderContent } = await load()
  const rows = [
    'Veeam,2006,"Kirkland, Washington, USA"',
    'Commvault,1996,"Tinton Falls, New Jersey, USA"',
    'Rubrik,2014,"Fremont, California, USA"',
  ]
  for (const r of rows) {
    assert.deepEqual(findPlaceholderContent(r), [], `real data flagged: ${r}`)
  }
})

test('a cell that merely LOOKS unfinished is real data and must survive', async () => {
  // The most dangerous class of false positive: a genuine blank in a genuine table. These are the
  // words an analyst actually types, and flagging them would mean discarding a correct answer.
  const { findPlaceholderContent } = await load()
  const legitimate = [
    'Acme,-',
    'Acme,0',
    'Acme,n/a',
    'Acme,None',
    'Acme,unknown',
    'Acme,Unknown headquarters',
    'Acme,not disclosed',
    'Acme,private',
    'Acme,employee count unknown',
  ]
  for (const r of legitimate) {
    assert.deepEqual(
      findPlaceholderContent(r), [],
      `this is real data and must not be treated as a promise: ${JSON.stringify(r)}`,
    )
  }
})

test('rows as an array of arrays and as a string are both inspected, by one detector', async () => {
  const { placeholderInArgs } = await load()
  const asArray = placeholderInArgs({
    path: 'x.csv',
    headers: 'Company,Founded,Description',
    rows: [['To be populated from the research results', '', '']],
  })
  assert.ok(asArray.length > 0, 'the array form must be inspected')
  const asString = placeholderInArgs({
    path: 'x.csv',
    headers: 'Company,Founded,Description',
    rows: 'To be populated from the research results,,',
  })
  assert.ok(asString.length > 0, 'the string form must be inspected too')
})

test('a real sheet in array form is not flagged', async () => {
  const { placeholderInArgs } = await load()
  const hits = placeholderInArgs({
    path: 'x.csv',
    headers: 'Company,Founded,Description',
    rows: [['Veeam', '2006', 'backup and disaster recovery'], ['Rubrik', '2014', 'cloud data security']],
  })
  assert.deepEqual(hits, [], `a real sheet was flagged: ${hits.join(', ')}`)
})

test('one stray mention among real rows does not condemn the sheet', async () => {
  // Ratio, not presence. A single "TBD" in a footnote of an otherwise finished table is a note;
  // a table where every row is a promise is not a table.
  const { placeholderRatio } = await load()
  const mostly = placeholderRatio(['Veeam,2006', 'Rubrik,2014', 'Cohesity,2013', 'to be populated'])
  assert.ok(mostly > 0 && mostly < 0.5, `expected a small minority, got ${mostly}`)
  const entirely = placeholderRatio(['to be populated', 'to be populated', 'to be populated'])
  assert.equal(entirely, 1, 'a sheet that is nothing but promises is wholly a promise')
})

test('a sheet with no content at all is wholly a promise', async () => {
  const { placeholderRatio } = await load()
  assert.equal(placeholderRatio(['', '   ']), 1, 'empty content cannot be presented as a deliverable')
})

// ============================================================ the feedback

test('the feedback carries the CONTENT the earlier steps produced, not just their success', async () => {
  // This is the load-bearing assertion of the whole module. Feedback that says only "step s1
  // succeeded" leaves the model in exactly the context that produced the placeholder, so it
  // writes the same placeholder. The evidence has to be IN the prompt.
  const { buildReplanFeedback } = await load()
  const dir = mkdtempSync(join(tmpdir(), 'aios-replan-'))
  const brief = join(dir, 'brief.md')
  writeFileSync(
    brief,
    '# Research brief\n\nQUOTED FACTS\n- "Veeam was founded in 2006 and is headquartered in Kirkland, Washington."\n'
    + '- "Commvault was founded in 1996 and is headquartered in Tinton Falls, New Jersey."\n'
    + '- "Rubrik was founded in 2014 and is headquartered in Fremont, California."\n',
    'utf8',
  )

  const fb = buildReplanFeedback({
    goal: 'data protection companies',
    attempt: 1,
    reason: 'the spreadsheet contained a promise instead of data',
    objectiveKind: 'satisfied',
    objectiveReason: 'the file existed and was rectangular',
    steps: [
      { id: 's1', tool: 'web-research', intent: 'Research the companies', verified: true, summary: '3 page(s), 3 quoted fact(s)' },
      { id: 's2', tool: 'spreadsheet', intent: 'Write the sheet', verified: false, summary: 'To be populated from the research results' },
    ],
    evidencePaths: [brief],
  })

  assert.match(fb, /data protection companies/, 'the goal survives')
  assert.match(fb, /attempt 2/, 'the model is told this is a retry')
  assert.match(fb, /Veeam was founded in 2006/, 'THE ACTUAL RESEARCH MUST BE IN THE PROMPT')
  assert.match(fb, /Commvault was founded in 1996/)
  assert.match(fb, /Rubrik was founded in 2014/)
  assert.match(fb, /VERIFIED/, 'verified steps are marked as such')
  assert.match(fb, /NOT VERIFIED/, 'failed steps are marked as such, so they are not repeated as successes')
  assert.match(fb, /ARRAY OF ARRAYS/i, 'the form that makes plans parseable is restated')
  assert.match(fb, /Do not invent a URL/i, 'the fabrication rule the verifier already enforces is restated')
})

test('a long evidence file is bounded, and keeps its findings', async () => {
  const { buildReplanFeedback } = await load()
  const dir = mkdtempSync(join(tmpdir(), 'aios-replan-long-'))
  const brief = join(dir, 'big.md')
  // 40k of process notes, then the answer at the very end - which is where a real brief puts it.
  const filler = 'EVIDENCE COMPOSITION  process note line that says nothing useful\n'.repeat(700)
  writeFileSync(brief, `${filler}FINAL FINDING: Acme was founded in 1999.\n`, 'utf8')

  const fb = buildReplanFeedback({
    goal: 'companies',
    attempt: 1,
    reason: 'placeholder',
    objectiveKind: 'satisfied',
    objectiveReason: '',
    steps: [{ id: 's1', tool: 'web-research', intent: 'research', verified: true, summary: 'ok' }],
    evidencePaths: [brief],
  })

  assert.ok(fb.length < 20_000, `the prompt must stay bounded, got ${fb.length} characters`)
  assert.match(fb, /FINAL FINDING: Acme was founded in 1999/, 'the finding at the end must survive')
  assert.match(fb, /earlier content omitted/, 'and the omission must be stated, not silent')
})

test('an unreadable evidence file is skipped, not reported as empty', async () => {
  // "I could not read it" and "it was empty" are different facts. Reporting the second when the
  // first is true would tell the model its research produced nothing, which is a fabrication in
  // the other direction - and would send it looking for data that already exists.
  const { buildReplanFeedback } = await load()
  const fb = buildReplanFeedback({
    goal: 'companies',
    attempt: 1,
    reason: 'placeholder',
    objectiveKind: 'satisfied',
    objectiveReason: '',
    steps: [{ id: 's1', tool: 'web-research', intent: 'research', verified: true, summary: 'ok' }],
    evidencePaths: [join(tmpdir(), 'aios-definitely-not-here-9f2a.md')],
  })
  assert.match(fb, /Research FIRST and use what comes back/i)
  assert.doesNotMatch(fb, /BEGIN /, 'an unreadable file must not be presented as evidence')
})

test('with no evidence the model is told to research rather than to fill in', async () => {
  const { buildReplanFeedback } = await load()
  const fb = buildReplanFeedback({
    goal: 'companies',
    attempt: 1,
    reason: 'the plan had no usable content',
    objectiveKind: 'unproven',
    objectiveReason: 'no postcondition',
    steps: [{ id: 's1', tool: 'spreadsheet', intent: 'write it', verified: true, summary: 'wrote a file' }],
  })
  assert.match(fb, /Nothing to fill a table from/i)
})

test('the verifier\'s own words reach the model', async () => {
  // A refusal like `1 row(s) do not have 2 columns; the file is not rectangular` is the single most
  // useful sentence available for the next attempt, and it already exists - it was simply never
  // handed over.
  const { buildReplanFeedback } = await load()
  const refusal = '1 row(s) do not have 2 columns; the file is not rectangular'
  const fb = buildReplanFeedback({
    goal: 'companies',
    attempt: 1,
    reason: 'a step did not verify',
    objectiveKind: 'unproven',
    objectiveReason: 'the postcondition was not matched',
    steps: [{ id: 's2', tool: 'spreadsheet', intent: 'write', verified: false, summary: refusal }],
  })
  assert.ok(fb.includes(refusal), 'the refusal text must survive into the prompt')
})

// ============================================================ the bound

test('the last allowed attempt is not retried, whatever went wrong', async () => {
  const { shouldReplan } = await load()
  assert.equal(shouldReplan({
    attempt: 1, maxAttempts: 2, stepsExecuted: 3, allStepsVerified: true, objectiveSatisfied: false, placeholderFound: true,
  }), false, 'the final attempt must stand, or the loop never ends')
})

test('a placeholder with no other failure still earns a retry', async () => {
  // The real case: every step verified, the objective was satisfied, and the deliverable was empty.
  // Nothing else about that run says "retry", which is exactly why this condition is explicit.
  const { shouldReplan } = await load()
  assert.equal(shouldReplan({
    attempt: 0, maxAttempts: 2, stepsExecuted: 3, allStepsVerified: true, objectiveSatisfied: true, placeholderFound: true,
  }), true)
})

test('a wholly clean run is not retried', async () => {
  // Regression for an inverted condition. The first version of `shouldReplan` asked whether
  // anything looked GOOD and returned true on "a step verified", so the tidiest possible mission -
  // the one with nothing wrong at all - was the one that got retried.
  const { shouldReplan } = await load()
  assert.equal(shouldReplan({
    attempt: 0, maxAttempts: 2, stepsExecuted: 3, allStepsVerified: true, objectiveSatisfied: true, placeholderFound: false,
  }), false)
})

test('a run in which nothing executed is not retried', async () => {
  // Re-asking an identical model about an identical goal returns an identical plan. Without this
  // veto, a plan the system could not even build would be rebuilt the same unbuildable way.
  const { shouldReplan } = await load()
  assert.equal(shouldReplan({
    attempt: 0, maxAttempts: 3, stepsExecuted: 0, allStepsVerified: false, objectiveSatisfied: false, placeholderFound: false,
  }), false)
})

test('a run where every step failed IS retried, because the refusals are the input', async () => {
  const { shouldReplan } = await load()
  assert.equal(shouldReplan({
    attempt: 0, maxAttempts: 2, stepsExecuted: 2, allStepsVerified: false, objectiveSatisfied: false, placeholderFound: false,
  }), true, 'the verifier\'s refusal is the most useful input the next attempt can have')
})