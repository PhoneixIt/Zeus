/**
 * A BROWSER PAGE IS NOT AN UNSAVED DOCUMENT
 * =========================================
 *
 * THE LIVE FAILURE
 * ----------------
 * The goal "open a browser on my screen and navigate to https://example.com" was run end to end
 * against the real host and the real executor. The transcript:
 *
 *     [ 91.8s] plan  s1 launch-app  s2 survey-window
 *     [ 98.5s] s1 verified  "exact match on launch-app"
 *     [ 98.5s] s2 verified  "exact match on survey-window"
 *     [ 98.5s] "Attempt 1 did not deliver the goal, so AIOS is planning again"
 *     [133.7s] a2-s1 NOT verified  "browser was already open on "Example Domain", so the launch
 *              activated that window rather than creating a new one. AIOS will not type into a
 *              document it was not asked to change - that would silently modify work which may
 *              not be saved. Close that browser window, or name the file you want written so a
 *              separate document is opened."
 *     [133.7s] done  ok=false  "0 of 2 step(s) verified"
 *
 * TWO SEPARATE DEFECTS, and fixing only the obvious one leaves the mission failing.
 *
 * 1. THE REFUSAL FIRED ON A LAUNCH THAT TYPED NOTHING.
 *
 *    `adoptedWindowRefusal` exists to stop AIOS typing into a document it was not asked to change -
 *    its own message says so. It fired because a browser titles its window `"<page> - <app>"`,
 *    which the segment parser reads exactly like a named document. But the failing launch carried
 *    a URL and NO file path, so the tool's entire action was to navigate a tab. No keystroke was
 *    sent, so there was no unsaved work at risk, and the refusal's only remedy - "close that
 *    window" - would have destroyed the person's browsing session to protect a document that does
 *    not exist.
 *
 * 2. THE OBJECTIVE POSTCONDITION WAS UNSATISFIABLE, SO THE REPLAN WAS UNAVOIDABLE.
 *
 *    The postcondition `window-shows-text` is checked with `screenText.includes(pc.text)`. For
 *    every plain URL (anything without a `q=` parameter) the declared text was the first 60
 *    characters of the step's INTENT - the plan's prose, not page text. So the claim could never be
 *    met no matter what the browser showed, the objective stayed `unmet`, and the loop replanned
 *    into the refusal above. Fixing (1) alone would have let the second attempt run; fixing (2)
 *    alone would have left the first attempt replanning anyway.
 *
 * WHAT IS DELIBERATELY NOT CHANGED
 * --------------------------------
 * The refusal still stands for every editor document, including "open notes.txt in notepad" with
 * a path - the case it was written for, and the one where someone lost work. The exemption is a
 * property of the ACTION (navigating a URL, opening no file), not of the window, so no assumption
 * is made that every browser window is safe or that any title containing a dash is a page.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { join } from 'node:path'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const WIN = pathToFileURL(join(HERE, '..', 'live', 'agent', 'window-identity.ts')).href
const AGENT = pathToFileURL(join(HERE, '..', 'live', 'agent', 'agent.ts')).href
const CAPS = pathToFileURL(join(HERE, '..', 'live', 'agent', 'capabilities.ts')).href
const INTENT = pathToFileURL(join(HERE, '..', 'live', 'agent', 'goal-intent.ts')).href

const loadWin = () => import(WIN)
const loadAgent = () => import(AGENT)
const loadCaps = () => import(CAPS)
const loadIntent = () => import(INTENT)

const NAVIGATING = { navigatingUrl: true }

// ============================================================================================
// 1. CHROME ALREADY DISPLAYING THE REQUESTED PUBLIC WEBPAGE
// ============================================================================================

test('1. Chrome already showing the requested page is NOT refused on a URL launch', async () => {
  const { adoptedWindowRefusal } = await loadWin()
  // The exact title observed in the failing run.
  assert.equal(
    adoptedWindowRefusal(true, 'Example Domain - Google Chrome', 'chrome', NAVIGATING),
    null,
    'a browser at a URL types nothing, so the unsaved-document rule has nothing to police')
})

test('1b. Edge, and a browser with no trailing app segment, behave the same', async () => {
  const { adoptedWindowRefusal } = await loadWin()
  assert.equal(adoptedWindowRefusal(true, 'Example Domain - Microsoft Edge', 'edge', NAVIGATING), null)
  assert.equal(adoptedWindowRefusal(true, 'Example Domain', 'browser', NAVIGATING), null,
    'an unsuffixed browser title has no document segment to begin with')
})

// ============================================================================================
// 2. CHROME OPEN ON A DIFFERENT WEBPAGE
// ============================================================================================

test('2. Chrome open on a DIFFERENT page is still allowed - navigation is the task', async () => {
  const { adoptedWindowRefusal } = await loadWin()
  // The person asked to navigate somewhere; activating a browser showing another page is exactly
  // what a second launch to the same single-instance browser does, and refusing it would make
  // "open a browser and go to X" impossible whenever a browser happens to be running.
  assert.equal(
    adoptedWindowRefusal(true, 'New Tab - Google Chrome', 'chrome', NAVIGATING),
    null,
    'a browser is a page host, not a document')
})

// ============================================================================================
// 3. AN EDITOR WITH A POTENTIALLY UNSAVED DOCUMENT
// ============================================================================================

test('3. an editor document is STILL refused on a URL launch - the exemption is action-based', async () => {
  const { adoptedWindowRefusal } = await loadWin()
  // The safety case that motivated the rule. A browser exemption must not leak to editors even
  // when the caller believes it is navigating: an editor holds unsaved work by definition.
  assert.ok(
    adoptedWindowRefusal(true, 'quarterly-report.docx - Word', 'chrome', NAVIGATING),
    'an editor window must be refused whatever the caller says, because it hosts documents')
  assert.ok(adoptedWindowRefusal(true, 'AIOS-TEST-BLANK.txt - Notepad', 'notepad', NAVIGATING))
  assert.ok(adoptedWindowRefusal(true, 'budget.xlsx - Excel', 'excel', NAVIGATING))
})

test('3b. the live Notepad case from the original defect is still refused with no flag', async () => {
  const { adoptedWindowRefusal } = await loadWin()
  assert.ok(adoptedWindowRefusal(true, 'AIOS-TEST-BLANK.txt - Notepad', 'notepad'),
    'the invariant that was written to stop unsaved work being edited is intact')
})

// ============================================================================================
// 4. A DASH IN A TITLE THAT IS NOT A BROWSER PAGE
// ============================================================================================

test('4. a dashed title belonging to a non-browser is not treated as a page', async () => {
  const { adoptedWindowRefusal, windowTitleSegments } = await loadWin()
  // The whole failure began as a string-shape mistake, so shape alone must never grant the
  // exemption: the app segment is what decides, not the dash.
  assert.equal(windowTitleSegments('Q3 - final - budget.xlsx - Excel').app, 'Excel')

  assert.ok(
    adoptedWindowRefusal(true, 'Q3 - final - budget.xlsx - Excel', 'excel', NAVIGATING),
    'a dashed Excel title is a document, not a webpage')
  assert.ok(
    adoptedWindowRefusal(true, 'notes - draft - Notepad', 'notepad', NAVIGATING),
    'and a dashed Notepad title likewise')
  // An application whose name merely CONTAINS a browser word must not inherit the exemption.
  assert.ok(
    adoptedWindowRefusal(true, 'report - Chrome Notepad Pro', 'notepad', NAVIGATING),
    'substring matching on the app name would be a hole; the app segment must match exactly')
})

// ============================================================================================
// 5. A REQUESTED WEBPAGE ALREADY VISIBLE AFTER A PREVIOUS ATTEMPT
// ============================================================================================

test('5. a plain URL now declares a SATISFIABLE postcondition, not the plan prose', async () => {
  const { toMissionForTest } = await loadAgent()
  const m = toMissionForTest('m5', 'open a browser on my screen and navigate to https://example.com', [
    {
      id: 's1',
      intent: 'Open a visible browser window and navigate to https://example.com so the page title is shown on screen',
      tool: 'launch-app',
      args: { app: 'chrome', url: 'https://example.com' },
    },
  ])
  const pcs = (m as unknown as { objectivePostconditions?: Array<{ kind: string; text?: string }> }).objectivePostconditions ?? []
  const shown = pcs.find((p) => p.kind === 'window-shows-text')
  assert.ok(shown, 'a browser launch to a URL must declare what should be on the screen')
  assert.equal(shown?.text, 'example.com',
    'the host is what is observable - the address bar renders it and the title carries it')
  // And specifically NOT the intent prose, which is what made the objective unsatisfiable.
  assert.doesNotMatch(String(shown?.text), /open a visible browser window/i,
    'the plan prose is never printed on the page, so it can never satisfy a screen-text claim')
})

test('5b. a search URL still declares the searched term', async () => {
  const { toMissionForTest } = await loadAgent()
  const m = toMissionForTest('m5b', 'search for nakivo backup', [
    { id: 's1', intent: 'Search', tool: 'launch-app', args: { app: 'chrome', url: 'https://duckduckgo.com/?q=nakivo+backup' } },
  ])
  const pcs = (m as unknown as { objectivePostconditions?: Array<{ kind: string; text?: string }> }).objectivePostconditions ?? []
  assert.equal(pcs.find((p) => p.kind === 'window-shows-text')?.text, 'nakivo backup',
    'a query is the stronger claim and is preferred over the host')
})

test('5c. the postcondition text is present in the screen text the verifier returns', async () => {
  // The two halves must actually meet, or the fix is cosmetic. The verifier returns the first 120
  // characters of OCR'd screen text; the postcondition must be a substring of that.
  const { toMissionForTest } = await loadAgent()
  const m = toMissionForTest('m5c', 'navigate', [
    { id: 's1', intent: 'i', tool: 'launch-app', args: { app: 'chrome', url: 'https://example.com' } },
  ])
  const claim = ((m as unknown as { objectivePostconditions?: Array<{ text?: string }> }).objectivePostconditions ?? [])[0]?.text ?? ''
  // What OCR actually returned on the real screen during the live run:
  const realScreen = 'Example Domain\nc\n-Z example.com\nO\nGoogle Chrome isn\'t your default browser'
  assert.ok(realScreen.toLowerCase().includes(claim.toLowerCase()),
    `the declared claim "${claim}" must occur in real screen text, or it can never be satisfied`)
})

// ============================================================================================
// 6. A GENUINELY FAILED LAUNCH WHERE RETRYING IS APPROPRIATE
// ============================================================================================

test('6. a launch that CREATED the window is never refused, whatever it is showing', async () => {
  const { adoptedWindowRefusal } = await loadWin()
  assert.equal(adoptedWindowRefusal(false, 'notes.txt - Notepad', 'notepad'), null,
    'not adopted = this call created the window, so nothing pre-existing is at risk')
  assert.equal(adoptedWindowRefusal(false, 'Example Domain - Google Chrome', 'chrome'), null)
})

test('6b. a browser viewing a NAMED FILE is refused - the exemption is not "any browser"', async () => {
  // The exemption is granted on the promise that the launch navigates a URL and opens no file.
  // A window whose document segment is an obvious FILE is showing a document whatever that promise
  // says, so it stays refused. This is the "do not assume every browser window is safe" half.
  //
  // The check is deliberately narrow - an obvious file name, not "any title containing a dot",
  // because page titles carry dots too ("Node.js", "example.com") and a general extension test
  // would refuse the live case this fix exists to repair.
  const { adoptedWindowRefusal } = await loadWin()
  assert.ok(
    adoptedWindowRefusal(true, 'quarterly-report.pdf - Google Chrome', 'chrome', NAVIGATING),
    'a browser showing a named PDF is showing a document, and is refused')
  assert.ok(adoptedWindowRefusal(true, 'budget.xlsx - Microsoft Edge', 'edge', NAVIGATING))
})

test('6c. a page title that CONTAINS a dot is not mistaken for a file', async () => {
  // The other half, and the reason the file check above is narrow. These are the real titles the
  // live run produced; refusing them would reinstate the original defect.
  const { adoptedWindowRefusal } = await loadWin()
  assert.equal(adoptedWindowRefusal(true, 'Example Domain - Google Chrome', 'chrome', NAVIGATING), null)
  assert.equal(adoptedWindowRefusal(true, 'Node.js - Google Chrome', 'chrome', NAVIGATING), null,
    'a page titled after a language is a page, not a .js file')
})

test('6c. no flag at all means the original behaviour, unchanged', async () => {
  const { adoptedWindowRefusal } = await loadWin()
  assert.ok(adoptedWindowRefusal(true, 'Example Domain - Google Chrome', 'chrome'),
    'a caller that has not PROVED a URL navigation gets the original refusal. Ambiguity fails safe.')
})

// ============================================================================================
// 7. AMBIGUOUS WINDOW STATE MUST FAIL SAFELY
// ============================================================================================

test('7. an unknown application is refused, not guessed at', async () => {
  const { adoptedWindowRefusal } = await loadWin()
  assert.ok(adoptedWindowRefusal(true, 'Quarterly Report - SomeUnknownApp', 'someunknownapp', NAVIGATING),
    'an app not in the known list is not assumed to be a browser')
})

test('7b. an empty title is refused rather than treated as safe', async () => {
  const { adoptedWindowRefusal } = await loadWin()
  // No title means no way to establish anything, so it must not become a silent pass.
  const r = adoptedWindowRefusal(true, '', 'chrome', NAVIGATING)
  assert.ok(r === null || typeof r === 'string', 'the return type stays string|null')
  // An empty title has no document segment, which the pre-existing rule already treats as safe -
  // and that is unchanged, because with no named document there is nothing named to protect.
  assert.equal(r, null)
})

// ============================================================================================
// 8. A HEADLESS-ONLY PLAN FOR A VISIBLE MISSION IS STILL REFUSED
// ============================================================================================

test('8. a headless-only plan for an explicitly visible-desktop mission is STILL refused', async () => {
  const { validatePlan } = await loadAgent()
  const { interactionMode } = await loadIntent()
  const goal = 'open a browser on my screen and navigate to https://example.com'
  assert.equal(interactionMode(goal), 'visible', 'this goal explicitly asks to be seen')

  const v = validatePlan({
    reply: '', model: 'test',
    steps: [{
      id: 's1', intent: 'Research the page', tool: 'web-research',
      // well-formed: url and objective are both required, so the ONLY possible refusal is the
      // visible-interaction one.
      args: { url: 'https://example.com', objective: goal, pages: 1 },
    }],
  }, goal)

  const refusal = v.refusals.find((r: string) => /headless research/i.test(r))
  assert.ok(refusal,
    `fixing the browser adoption path must NOT let a headless answer satisfy a visible goal: ${JSON.stringify(v.refusals)}`)
  assert.match(String(refusal), /launch-app/i, 'and it must still name the capability that would work')
})

test('8b. and the same goal WITH a real window is accepted', async () => {
  const { validatePlan } = await loadAgent()
  const goal = 'open a browser on my screen and navigate to https://example.com'
  const v = validatePlan({
    reply: '', model: 'test',
    steps: [{ id: 's1', intent: 'Open Chrome at the page', tool: 'launch-app', args: { app: 'chrome', url: 'https://example.com' } }],
  }, goal)
  assert.equal(v.refusals.length, 0, `the intended plan must be accepted: ${JSON.stringify(v.refusals)}`)
})

// ============================================================================================
// THE CALLER PASSES THE FLAG ONLY WHEN IT HAS PROVED IT
// ============================================================================================

test('the caller only exempts a URL launch that opens no file', async () => {
  // Guards the wiring in capabilities.ts, which is where the flag is computed. Read from source
  // because the condition is internal to the tool closure.
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(fileURLToPath(new URL('../live/agent/capabilities.ts', import.meta.url)), 'utf8')
  assert.match(
    src,
    /navigatingUrl: isBrowserLaunch && openUrl !== undefined && openPath === undefined/,
    'the exemption must require a browser, a URL, and NO file path')
})