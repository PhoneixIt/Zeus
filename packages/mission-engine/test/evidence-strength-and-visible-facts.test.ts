/**
 * THE EVIDENCE MUST BE AS STRONG AS THE OBSERVATION IT CAME FROM
 * ============================================================
 *
 * TWO DEFECTS, BOTH FOUND BY A REAL MISSION FAILING WITH EVERY STEP VERIFIED
 *
 * 1. EVIDENCE TRUNCATED TO 120 CHARACTERS BEFORE GRADING
 *
 *    The objective `window-shows-text` is satisfied by evidence of kind `screen-text-present`,
 *    and the executor grades it with `screenText.includes(postconditionText)`. The launch verifier
 *    produced that evidence from a full-screen OCR read - 1,663 characters, containing
 *    "example.com" - and then recorded only `screen.slice(0, 120)` of it.
 *
 *    On a desktop with several windows open, the first 120 characters are whatever the OCR engine
 *    returned first, frequently another application's chrome. So the recorded claim was about text
 *    the person never saw, and a postcondition that was genuinely satisfied came back UNMET:
 *
 *      5 of 5 step(s) verified. Objective verdict: unmet - 1 of 5 objective postcondition(s)
 *      are not established by the evidence: window-shows-text.
 *
 *    The claim was true and the evidence said otherwise. That is this project's own failure mode
 *    turned on itself: the system was too strict about itself for the wrong reason.
 *
 * 2. A VISIBLE WINDOW IS NOT SEEING THE ANSWER
 *
 *    The same mission planned a real `launch-app` AND a `web-research`, took its three facts from
 *    the research brief, and reported success. The window did open. But the person asked what the
 *    page SAYS, and the facts came from a headless fetch of a page nobody was shown.
 *
 *    The rule as it stood asked only whether a visible capability appeared anywhere in the plan.
 *    That is a question about the plan, not about the goal. It is answered here as a question about
 *    where the FACTS came from.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const CAPS = pathToFileURL(join(HERE, '..', 'live', 'agent', 'capabilities.ts')).href
const AGENT = pathToFileURL(join(HERE, '..', 'live', 'agent', 'agent.ts')).href

const loadCaps = () => import(CAPS)
const loadAgent = () => import(AGENT)

const OUT = 'C:\\Users\\Samer\\.aios\\agent\\out\\'
const scratch = () => mkdtempSync(join(process.env.USERPROFILE ?? '', '.aios', 'agent', 'out', 'evidence-'))
const cleanup = (d: string) => rmSync(d, { recursive: true, force: true })

// The window title as the browser reports it, and the OCR text the host returns. The key property:
// the postcondition appears LATE in the observed text and NOT within any short prefix.
const LONG_PAGE = 'A. Unrelated window chrome that the OCR engine returned first, occupying the '
  + 'opening characters of the read. '.repeat(3)
const OBSERVED = `${LONG_PAGE}https://example.com Example Domain illustrative examples`

/** Grade a postcondition the way the executor does. */
function grades(evidenceText: string, claim: string): boolean {
  return evidenceText.toLowerCase().includes(claim.toLowerCase())
}

// ============================================================================================
// DEFECT 1: EVIDENCE IS NOT TRUNCATED
// ============================================================================================

test('1a. a claim appearing late in the observed screen text still satisfies the postcondition', async () => {
  // This is the live failure, reduced to arithmetic. The evidence text used to be a 120-character
  // prefix, and "example.com" sits past character 120 in a real desktop read.
  const claim = 'example.com'
  assert.ok(OBSERVED.indexOf(claim) > 120,
    'the fixture must actually be longer than the old truncation, or it proves nothing')
  assert.equal(grades(OBSERVED.slice(0, 120), claim), false,
    'the OLD behaviour could not see it')
  assert.equal(grades(OBSERVED, claim), true,
    'the full observation can, and that is what the evidence must carry')
})

test('1b. the launch verifier records the whole text it read', async () => {
  // Asserted on the source, because the value depends on the host and cannot be produced here
  // without a real window. What is checked is that the truncation is gone, so it cannot return.
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(fileURLToPath(new URL('../live/agent/capabilities.ts', import.meta.url)), 'utf8')
  assert.doesNotMatch(src, /text: probe \|\| screen\.slice\(/,
    'the 120-character truncation must not come back')
  assert.match(src, /text: probe \|\| screen,/,
    'the evidence must carry the text that was actually observed')
})

test('1c. and the search-term path still records the query, not the whole screen', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(fileURLToPath(new URL('../live/agent/capabilities.ts', import.meta.url)), 'utf8')
  // `probe` is the query text, which is the STRONGER claim: it says the search terms are on screen.
  // It must keep winning over the raw text, or "found the query" and "found some other word" would
  // become indistinguishable.
  assert.match(src, /text: probe \|\| screen,/)
  assert.match(src, /including the searched term/,
    'and the detail must still say whether the match came from the query')
})

// ============================================================================================
// DEFECT 2: FACTS MUST COME FROM WHAT WAS DISPLAYED
// ============================================================================================

const VISIBLE_FACTS_GOAL = 'Open Google Chrome on my screen and navigate to https://example.com , '
  + 'read the text actually displayed on that page, and report three factual items about what the '
  + 'page says.'

const launch = { id: 's1', intent: 'Open Chrome at the page', tool: 'launch-app', args: { app: 'chrome', url: 'https://example.com' } }
const listwins = { id: 's2', intent: 'Confirm the window', tool: 'list-windows', args: {} }
const ocr = { id: 's3', intent: 'Read the displayed text', tool: 'ocr', args: {} }
const survey = { id: 's3b', intent: 'Read the window accessibility tree', tool: 'survey-window', args: {} }
const research = { id: 's4', intent: 'Research the page', tool: 'web-research', args: { url: 'https://example.com', objective: 'x', pages: 1 } }

test('2a. a real window plus headless facts is REFUSED', async () => {
  const { validatePlan } = await loadAgent()
  const v = validatePlan({ reply: '', model: 'test', steps: [launch, listwins, research] }, VISIBLE_FACTS_GOAL)
  const r = v.refusals.find((x) => /takes its facts from headless research/i.test(x))
  assert.ok(r,
    `a visible goal whose facts come from a headless fetch must be refused: ${JSON.stringify(v.refusals)}`)
  // The refusal must name the capabilities that WOULD work. The plan already opens a window, so
  // suggesting launch-app again would be useless advice; what it is missing is a way to READ what
  // that window shows. This assertion originally demanded `launch-app` and was wrong - the message
  // naming the reading tools is the correct advice.
  assert.match(String(r), /ocr|survey-window/, 'it must name the capability that reads the visible window')
  assert.match(String(r), /nobody was shown/i,
    'and it must say plainly why fetching the answer elsewhere is not the same as seeing it')
})

test('2b. the same goal answered with OCR is allowed', async () => {
  const { validatePlan } = await loadAgent()
  const v = validatePlan({ reply: '', model: 'test', steps: [launch, ocr] }, VISIBLE_FACTS_GOAL)
  assert.equal(v.refusals.length, 0,
    `reading the visible window is exactly what was asked: ${JSON.stringify(v.refusals)}`)
})

test('2c. and with survey-window instead', async () => {
  const { validatePlan } = await loadAgent()
  const v = validatePlan({ reply: '', model: 'test', steps: [launch, survey] }, VISIBLE_FACTS_GOAL)
  assert.equal(v.refusals.length, 0, `the accessibility tree is the same observation: ${JSON.stringify(v.refusals)}`)
})

test('2d. research plus opening the result is still fine when no on-screen fact is claimed', async () => {
  // The rule is about where the ANSWER comes from, not about forbidding research. A mission that
  // researches and then shows the result in a window is doing what was asked, and this guard must
  // not make that impossible.
  const { validatePlan } = await loadAgent()
  const goal = 'open a browser on my screen and navigate to example.com'
  const v = validatePlan({ reply: '', model: 'test', steps: [research, launch] }, goal)
  assert.equal(v.refusals.length, 0,
    `research + a visible window is legitimate: ${JSON.stringify(v.refusals)}`)
})

test('2e. an ordinary non-visible research goal is untouched', async () => {
  const { validatePlan } = await loadAgent()
  const v = validatePlan({ reply: '', model: 'test', steps: [research] },
    'research data protection companies and give me a spreadsheet')
  assert.equal(v.refusals.length, 0, `headless research is the right tool when nobody asked to see: ${JSON.stringify(v.refusals)}`)
})

test('2f. a headless-only plan for a visible goal is still refused (the original rule)', async () => {
  const { validatePlan } = await loadAgent()
  const v = validatePlan({ reply: '', model: 'test', steps: [research] }, VISIBLE_FACTS_GOAL)
  assert.ok(v.refusals.length > 0, 'the original refusal must survive')
})

// ============================================================================================
// THE PRIOR PROTECTIONS ARE ALL STILL HERE
// ============================================================================================

test('3. the zero-byte read-back fix is intact', async () => {
  const { resolveCapability } = await loadCaps()
  const dir = scratch()
  const p = join(dir, 'proof.txt')
  writeFileSync(p, '', 'utf8')
  try {
    const cap = resolveCapability('read-file')
    const r = await cap.verifier.verify(
      { id: 's1', tool: 'read-file', args: { path: p, expectChars: 50 } } as never,
      {} as never,
      { path: p, chars: 0, text: '' },
    )
    assert.ok('rejected' in r, 'a 0-byte file must not pass a read-back that expected content')
  } finally { cleanup(dir) }
})

test('4. deliverable identity and destination honesty are intact', async () => {
  const { validatePlan } = await loadAgent()
  const target = `${OUT}evidence-deliverable-check.txt`
  const v = validatePlan({
    reply: '', model: 'test',
    steps: [
      { id: 's1', intent: 'Write', tool: 'write-file', args: { path: target, content: 'three facts' } },
      { id: 's2', intent: 'Read back', tool: 'read-file', args: { path: target } },
    ],
  }, 'write the report and read it back')
  assert.equal(v.deliverables.length, 1)
  assert.equal(v.deliverables[0].readBackStepId, 's2')
  assert.equal(v.substitutions.length, 0, 'the output directory is authorised, so nothing is substituted')
  assert.equal(v.steps.find((s) => s.id === 's2')?.args.deliverableId, v.deliverables[0].id)
})

test('5. an adopted editor document is still refused on a browser launch', async () => {
  const { adoptedWindowRefusal } = await import(pathToFileURL(join(HERE, '..', 'live', 'agent', 'window-identity.ts')).href)
  assert.ok(adoptedWindowRefusal(true, 'AIOS-TEST-BLANK.txt - Notepad', 'notepad', { navigatingUrl: true }))
  assert.equal(adoptedWindowRefusal(true, 'Example Domain - Google Chrome', 'chrome', { navigatingUrl: true }), null)
})

test('6. a person-named destination is still recorded as an unauthorised substitution', async () => {
  const { validatePlan } = await loadAgent()
  const v = validatePlan({
    reply: '', model: 'test',
    steps: [{ id: 's1', intent: 'Write', tool: 'write-file', args: { path: 'C:\\Users\\Samer\\Documents\\proof.txt', content: 'x' } }],
  }, 'write the report to my Documents folder')
  assert.equal(v.substitutions.length, 1)
  assert.equal(v.substitutions[0].authorized, false)
  assert.match(v.substitutions[0].reason, /output directory/i)
})

test('7. an unrelated file cannot satisfy a read-back', async () => {
  const { validatePlan } = await loadAgent()
  const dir = scratch()
  mkdirSync(join(dir, 'Documents'), { recursive: true })
  mkdirSync(join(dir, 'Downloads'), { recursive: true })
  try {
    const v = validatePlan({
      reply: '', model: 'test',
      steps: [
        { id: 's1', intent: 'Write', tool: 'write-file', args: { path: `${OUT}report.txt`, content: 'the real deliverable' } },
        { id: 's2', intent: 'Read a same-named file elsewhere', tool: 'read-file', args: { path: 'C:\\Users\\Samer\\Downloads\\report.txt' } },
      ],
    }, 'write a report and read one back')
    assert.ok(v.refusals.length > 0, 'a shared basename is not an identity')
  } finally { cleanup(dir) }
})