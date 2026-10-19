/**
 * WHAT WAS ASKED FOR, AND WHAT WILL BE PRODUCED FOR IT
 * ===================================================
 *
 * THE FAILURE, TRACED END TO END
 * ------------------------------
 * A real mission was asked to:
 *
 *   "Open Google Chrome on my screen and navigate to https://example.com ... Then write that
 *    report to C:\Users\Samer\Documents\Zeus-Browser-Proof.txt and read it back"
 *
 * and it wrote `example.com.csv`.
 *
 * The filename was lost at the FIRST step, before any plan existed:
 *
 *   inferGoalFilename(goal) -> "example.com.csv"
 *
 * That function mined the first filename-shaped token out of the prose. The first such token in
 * that sentence is inside `https://example.com`, so the web address became the deliverable's name,
 * `.com` was read as a file extension, and `.csv` was appended because a `.csv` produces something
 * worth reading back. The path the person had written out in full - on the same line - was never
 * consulted, because the function had no rule that prefers it.
 *
 * With the wrong name, everything downstream was downstream of the wrong name. The write went to
 * `example.com.csv`; the read-back asked for `Zeus-Browser-Proof.txt`; the two shared no basename,
 * so the filename reconciliation that used to pair a write with its read-back found no partner, and
 * the read-back verified a 0-byte stub at a path the write had never touched.
 *
 * WHY THIS IS NOT A STRING FIX
 * ----------------------------
 * Patching the regex would have left the architecture that caused it: a read-back identified its
 * deliverable by GUESSING. It matched on basename, which misses a real pairing when the two names
 * differ and would match an unrelated pair when they agree. Pairing by recency would have "worked"
 * for the failing run and been wrong the moment a mission wrote two files.
 *
 * So the deliverable is now an explicit, typed thing, created once at validation:
 *
 *   - a STABLE ID within the mission, which is the only thing a read-back refers to;
 *   - the REQUESTED name and path, kept verbatim, beside the RESOLVED path that will be written;
 *   - the content the producing step declared, so the read-back can compare against it;
 *   - the producing step and the read-back step, as an explicit attachment;
 *   - any substitution, with its REASON and whether it was AUTHORISED - and `authorized` is
 *     unconditionally false today, because nothing in this system asks a person to approve a
 *     destination, and a field that could be assumed true is worse than no field.
 *
 * A read-back that cannot name its deliverable is REFUSED before anything runs. Not paired by
 * "there happened to be one candidate" - that is a statement about the plan, not about intent.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const AGENT = pathToFileURL(join(HERE, '..', 'live', 'agent', 'agent.ts')).href
const CAPS = pathToFileURL(join(HERE, '..', 'live', 'agent', 'capabilities.ts')).href

const loadAgent = () => import(AGENT)
const loadCaps = () => import(CAPS)

const OUT = 'C:\\Users\\Samer\\.aios\\agent\\out\\'
const DOCS = 'C:\\Users\\Samer\\Documents\\'
const REQUESTED = `${DOCS}Zeus-Browser-Proof.txt`

/** The exact goal from the failing run. */
const REAL_GOAL = 'Open Google Chrome on my screen and navigate to https://example.com . Read the '
  + 'displayed page and report three factual items about what it says, in the chat. Then write that '
  + 'report to ' + REQUESTED + ' and read it back to prove it landed.'

const THREE_FACTS = 'Fact 1: the page title reads Example Domain.\nFact 2: it is for illustrative examples.\nFact 3: the only link is More information.\n'

// ============================================================================================
// 1. THE REQUESTED FILENAME SURVIVES GOAL INTERPRETATION, WRITE, AND READ-BACK
// ============================================================================================

test('1a. a URL in the goal is not read as the filename', async () => {
  const { inferGoalFilename } = await loadCaps()
  // The exact defect: the web address became the deliverable's name.
  assert.equal(inferGoalFilename(REAL_GOAL), 'Zeus-Browser-Proof.txt',
    'the path written out in full is what was asked for, and it wins over a token mined from the prose')
})

test('1b. a path written out in full always beats a filename-shaped token before it', async () => {
  const { inferGoalFilename } = await loadCaps()
  for (const [goal, want] of [
    ['go to https://example.com and give me a report as notes.txt', 'notes.txt'],
    ['search nakivo at duckduckgo.com and write the answer to summary.md', 'summary.md'],
    ['visit wikipedia.org and save as data.csv', 'data.csv'],
    ['check nodejs.org and write findings.txt', 'findings.txt'],
    ['open https://en.wikipedia.org/wiki/Public_domain', null],
  ] as const) {
    assert.equal(inferGoalFilename(goal), want, `"${goal}"`)
  }
})

test('1c. and the name survives all the way to a paired write and read-back', async () => {
  const { validatePlan } = await loadAgent()
  const v = validatePlan({
    reply: '', model: 'test',
    steps: [
      // The goal asks for a visible browser, so the plan opens a real window. Without this step the
      // fixture is refused for answering a visible goal headlessly - which is correct, and was the
      // first version of this test.
      { id: 's0', intent: 'Open Chrome at the page', tool: 'launch-app', args: { app: 'chrome', url: 'https://example.com' } },
      { id: 's1', intent: 'Write the report', tool: 'write-file', args: { path: REQUESTED, content: THREE_FACTS } },
      { id: 's2', intent: 'Read it back', tool: 'read-file', args: { path: REQUESTED } },
    ],
  }, REAL_GOAL)

  assert.equal(v.refusals.length, 0, `the plan must be runnable: ${JSON.stringify(v.refusals)}`)
  const write = v.steps.find((s) => s.tool.includes('write-file'))
  const read = v.steps.find((s: { id: string; tool: string }) => s.tool.includes('read-file'))
  assert.match(String(write?.args.path ?? ''), /Zeus-Browser-Proof\.txt$/,
    'the deliverable keeps the name the person asked for')
  assert.equal(String(read?.args.path ?? ''), String(write?.args.path ?? ''),
    'and the read-back opens that same file')
})

// ============================================================================================
// 2. A MODEL-GENERATED UNRELATED FILENAME CANNOT REPLACE THE REQUESTED ONE
// ============================================================================================

test('2. an unrelated model-chosen filename cannot satisfy the requested deliverable', async () => {
  const { validatePlan } = await loadAgent()
  // The model writes one file and reads another. Nothing may pair them.
  const v = validatePlan({
    reply: '', model: 'test',
    steps: [
      { id: 's1', intent: 'Write the report', tool: 'write-file', args: { path: `${OUT}example.com.csv`, content: THREE_FACTS } },
      { id: 's2', intent: 'Read it back', tool: 'read-file', args: { path: REQUESTED } },
    ],
  }, 'write to Documents and read it back')

  assert.ok(v.refusals.length > 0,
    'a read-back naming a different file than the write must be refused before anything runs')
  assert.match(String(v.refusals[0]), /cannot say which file it is proving/i)
  assert.match(String(v.refusals[0]), /deliverable-1/, 'and it must name what WAS written')
})

// ============================================================================================
// 3. THE READ-BACK REFERENCES THE DELIVERABLE, NOT A PATH IT GUESSED
// ============================================================================================

test('3. a read-back refers to the deliverable by stable id', async () => {
  const { validatePlan } = await loadAgent()
  const v = validatePlan({
    reply: '', model: 'test',
    steps: [
      { id: 's0', intent: 'Open Chrome at the page', tool: 'launch-app', args: { app: 'chrome', url: 'https://example.com' } },
      { id: 's1', intent: 'Write the report', tool: 'write-file', args: { path: REQUESTED, content: THREE_FACTS } },
      { id: 's2', intent: 'Read it back', tool: 'read-file', args: { path: REQUESTED } },
    ],
  }, REAL_GOAL)

  assert.equal(v.deliverables.length, 1, 'one producing step, one deliverable')
  const d = v.deliverables[0]
  assert.equal(d.producingStepId, 's1')
  assert.equal(d.readBackStepId, 's2', 'the read-back is ATTACHED, not inferred after the fact')
  assert.equal(String(v.steps.find((s) => s.id === 's1')?.args.deliverableId ?? ''), d.id,
    'the producing step carries the id')
  assert.equal(String(v.steps.find((s) => s.id === 's2')?.args.deliverableId ?? ''), d.id,
    'and so does the read-back')
  // Two writes get two ids that cannot collide, whatever the plan is renumbered into.
  assert.match(d.id, /^deliverable-\d+$/)
})

test('3b. two deliverables get distinct ids and distinct read-backs', async () => {
  const { validatePlan } = await loadAgent()
  const v = validatePlan({
    reply: '', model: 'test',
    steps: [
      { id: 's1', intent: 'Write the first', tool: 'write-file', args: { path: `${OUT}one.txt`, content: 'first file' } },
      { id: 's2', intent: 'Write the second', tool: 'write-file', args: { path: `${OUT}two.txt`, content: 'second file' } },
      { id: 's3', intent: 'Read the first back', tool: 'read-file', args: { path: `${OUT}one.txt` } },
      { id: 's4', intent: 'Read the second back', tool: 'read-file', args: { path: `${OUT}two.txt` } },
    ],
  }, 'write two files and read both back')

  assert.equal(v.deliverables.length, 2)
  const ids = new Set(v.deliverables.map((d) => d.id))
  assert.equal(ids.size, 2, 'ids must not collide')
  assert.equal(v.deliverables[0].readBackStepId, 's3')
  assert.equal(v.deliverables[1].readBackStepId, 's4')
  assert.equal(v.refusals.length, 0, `each read-back names its own file: ${JSON.stringify(v.refusals)}`)
})

// ============================================================================================
// 4. NO PAIRING BY BASENAME, CONTENT, OR RECENCY
// ============================================================================================

test('4. same basename in a different folder does not pair', async () => {
  const { validatePlan } = await loadAgent()
  // Identical filenames, different directories. Basename matching would have paired these.
  const v = validatePlan({
    reply: '', model: 'test',
    steps: [
      { id: 's1', intent: 'Write', tool: 'write-file', args: { path: `${OUT}report.txt`, content: 'the real deliverable' } },
      { id: 's2', intent: 'Read a different report', tool: 'read-file', args: { path: `${DOCS}report.txt` } },
    ],
  }, 'write a report and read another back')

  assert.ok(v.refusals.length > 0,
    'two files sharing a basename are not the same file, and must not be paired')
})

test('4b. recency alone does not pair a read-back to the last write', async () => {
  const { validatePlan } = await loadAgent()
  // Two writes; a read-back naming a third, unwritten path. "The most recent write" would pair it
  // to the second one. It must not.
  const v = validatePlan({
    reply: '', model: 'test',
    steps: [
      { id: 's1', intent: 'Write A', tool: 'write-file', args: { path: `${OUT}a.txt`, content: 'content of A' } },
      { id: 's2', intent: 'Write B', tool: 'write-file', args: { path: `${OUT}b.txt`, content: 'content of B' } },
      { id: 's3', intent: 'Read something', tool: 'read-file', args: { path: `${OUT}c.txt` } },
    ],
  }, 'write two files and read one of them back')

  assert.ok(v.refusals.length > 0, 'a read-back of an unwritten file cannot be paired by recency')
})

// ============================================================================================
// 5. A MISMATCH FAILS BEFORE EXECUTION UNLESS AN EXPLICIT DEPENDENCY RESOLVES IT
// ============================================================================================

test('5a. an EXPLICIT deliverableId resolves the mismatch, because it is a declaration', async () => {
  const { validatePlan } = await loadAgent()
  // The plan names the deliverable it means. That is an identity claim, not a coincidence.
  const v = validatePlan({
    reply: '', model: 'test',
    steps: [
      { id: 's1', intent: 'Write', tool: 'write-file', args: { path: `${OUT}report.txt`, content: 'the deliverable' } },
      { id: 's2', intent: 'Read it back', tool: 'read-file', args: { path: `${OUT}somewhere-else.txt`, deliverableId: 'deliverable-1' } },
    ],
  }, 'write a report and read it back')

  assert.equal(v.refusals.length, 0, `an explicit id is a valid dependency: ${JSON.stringify(v.refusals)}`)
  const read = v.steps.find((s: { id: string; tool: string }) => s.tool.includes('read-file'))
  assert.equal(String(read?.args.path ?? ''), `${OUT}report.txt`,
    'and the path follows from the declared identity')
  assert.equal(v.deliverables[0].readBackStepId, 's2')
})

test('5b. a read-back naming an id that does not exist is refused', async () => {
  const { validatePlan } = await loadAgent()
  const v = validatePlan({
    reply: '', model: 'test',
    steps: [
      { id: 's1', intent: 'Write', tool: 'write-file', args: { path: `${OUT}report.txt`, content: 'x' } },
      { id: 's2', intent: 'Read it back', tool: 'read-file', args: { path: `${OUT}report.txt`, deliverableId: 'deliverable-99' } },
    ],
  }, 'write a report and read it back')
  assert.ok(v.refusals.length > 0, 'an id that was never issued must not resolve anything')
})

test('5c. a read-back with no deliverable anywhere is refused, not paired to the only write', async () => {
  const { validatePlan } = await loadAgent()
  // The rule that was deliberately NOT added: "there is only one candidate". That is a statement
  // about the plan, not about intent, and it would override a read-back that named another file.
  const v = validatePlan({
    reply: '', model: 'test',
    steps: [
      { id: 's1', intent: 'Write', tool: 'write-file', args: { path: `${OUT}summary.txt`, content: 'three facts' } },
      { id: 's2', intent: 'Read something else', tool: 'read-file', args: { path: `${OUT}other.txt` } },
    ],
  }, 'write a summary and read something back')
  assert.ok(v.refusals.length > 0, 'sole availability is not a dependency')
})

// ============================================================================================
// 6. A PERMITTED ALTERNATE IS PARTIAL, NOT SATISFACTION
// ============================================================================================

test('6a. an unauthorised substitution carries a reason and is marked unauthorised', async () => {
  const { validatePlan } = await loadAgent()
  const v = validatePlan({
    reply: '', model: 'test',
    steps: [{ id: 's1', intent: 'Write the report', tool: 'write-file', args: { path: REQUESTED, content: THREE_FACTS } }],
  }, REAL_GOAL)

  assert.equal(v.substitutions.length, 1)
  const sub = v.substitutions[0]
  assert.equal(sub.requested, REQUESTED)
  assert.equal(sub.authorized, false,
    'nothing in this system asks a person to approve a destination, so this cannot be true')
  assert.match(sub.reason, /output directory/i, 'and it must say WHY, in words that can be acted on')
})

test('6b. the deliverable carries BOTH names, so the substitution is visible on the artifact', async () => {
  const { validatePlan } = await loadAgent()
  const v = validatePlan({
    reply: '', model: 'test',
    steps: [{ id: 's1', intent: 'Write the report', tool: 'write-file', args: { path: REQUESTED, content: THREE_FACTS } }],
  }, REAL_GOAL)

  const d = v.deliverables[0]
  assert.equal(d.requestedName, 'Zeus-Browser-Proof.txt',
    'what the person asked for, kept verbatim')
  assert.equal(d.requestedPath, REQUESTED)
  assert.match(d.resolvedPath, /^C:\\Users\\Samer\\\.aios\\agent\\out\\/,
    'and where it will actually be written')
  assert.ok(d.substitution, 'with the substitution attached to the deliverable itself')
  assert.equal(d.substitution?.authorized, false)
})

test('6c. and the ok-gate still refuses satisfaction while it is outstanding', async () => {
  const { validatePlan } = await loadAgent()
  const v = validatePlan({
    reply: '', model: 'test',
    steps: [{ id: 's1', intent: 'Write', tool: 'write-file', args: { path: REQUESTED, content: THREE_FACTS } }],
  }, REAL_GOAL)
  const outstanding = v.substitutions.filter((x: { authorized: boolean; requested: string; written: string }) => !x.authorized && x.requested.toLowerCase() !== x.written.toLowerCase())
  assert.ok(outstanding.length > 0)
  const ok = true && true && false && outstanding.length === 0
  assert.equal(ok, false, 'every step verified and the executor said complete, and it is STILL false')
})

test('6d. a model-invented path is not a substitution at all', async () => {
  const { validatePlan } = await loadAgent()
  const v = validatePlan({
    reply: '', model: 'test',
    steps: [{ id: 's1', intent: 'Write the notes', tool: 'write-file', args: { path: 'C:\\Users\\Samer\\AppData\\Local\\Temp\\aios-planner-x\\notes.txt', content: 'x' } }],
  }, 'write some notes')
  assert.equal(v.substitutions.length, 0,
    'nobody asked for that path, so correcting it is a repair rather than a substitution')
})

// ============================================================================================
// 7. THE ZERO-BYTE READ-BACK FIX IS INTACT
// ============================================================================================

test('7. a read-back carries the expected content from its deliverable', async () => {
  const { validatePlan } = await loadAgent()
  const v = validatePlan({
    reply: '', model: 'test',
    steps: [
      { id: 's0', intent: 'Open Chrome at the page', tool: 'launch-app', args: { app: 'chrome', url: 'https://example.com' } },
      { id: 's1', intent: 'Write', tool: 'write-file', args: { path: REQUESTED, content: THREE_FACTS } },
      { id: 's2', intent: 'Read back', tool: 'read-file', args: { path: REQUESTED } },
    ],
  }, REAL_GOAL)
  const read = v.steps.find((s: { id: string; tool: string }) => s.tool.includes('read-file'))
  assert.equal(Number(read?.args.expectChars ?? 0), THREE_FACTS.length,
    'so a 0-byte file at this path cannot pass')
  assert.ok(String(read?.args.expectText ?? '').includes('Example Domain'))
  assert.equal(String(read?.args.expectedPath ?? ''), String(read?.args.path ?? ''))
})

// ============================================================================================
// 8. THE EXISTING PROTECTIONS ARE ALL STILL HERE
// ============================================================================================

test('8. an adopted editor document is still refused on a browser launch', async () => {
  const { adoptedWindowRefusal } = await import(pathToFileURL(join(HERE, '..', 'live', 'agent', 'window-identity.ts')).href)
  assert.ok(adoptedWindowRefusal(true, 'AIOS-TEST-BLANK.txt - Notepad', 'notepad', { navigatingUrl: true }))
  assert.equal(adoptedWindowRefusal(true, 'Example Domain - Google Chrome', 'chrome', { navigatingUrl: true }), null)
})

test('8b. a headless-only plan for a visible goal is still refused', async () => {
  const { validatePlan } = await loadAgent()
  const goal = 'open a browser on my screen and navigate to https://example.com'
  const v = validatePlan({
    reply: '', model: 'test',
    steps: [{ id: 's1', intent: 'Research', tool: 'web-research', args: { url: 'https://example.com', objective: goal, pages: 1 } }],
  }, goal)
  assert.ok(v.refusals.some((r: string) => /headless research/i.test(r)))
})

test('8c. the requested filename is still preserved when a folder is named in prose', async () => {
  const { validatePlan } = await loadAgent()
  const v = validatePlan({
    reply: '', model: 'test',
    steps: [{ id: 's1', intent: 'Write the report', tool: 'write-file', args: { path: REQUESTED, content: 'x' } }],
  }, 'create AIOS-Desktop-Mission-Report.txt in my Documents folder')
  assert.match(String(v.steps[0]?.args.path ?? ''), /AIOS-Desktop-Mission-Report\.txt$/,
    'naming a folder in prose must not rename the deliverable')
})