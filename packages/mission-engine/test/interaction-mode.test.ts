/**
 * THE REQUESTED INTERACTION MODE IS PART OF THE GOAL
 * ====================================================
 *
 * THE DEFECT THIS PINS
 * --------------------
 * A goal saying "open a browser on my screen and search X" can be completed entirely by
 * `web-research`, which runs headless Chrome against a throwaway profile. No window ever appears.
 * Every step verifies, the objective postcondition is satisfied by whatever artifact landed, and
 * the person is told it worked - having seen nothing happen.
 *
 * There is no `visible-browser` capability to fall back on, and pretending otherwise would hide
 * the most important fact about the system. What exists is:
 *
 *   - web-research    headless, no window ever appears
 *   - launch-app      opens a REAL window, including a browser at a URL
 *   - desktop-input   real keyboard and mouse into a named window
 *
 * Both routes are legitimate. What was missing was any way for the SYSTEM to know which one the
 * person meant, so it was free to answer with either. These tests pin both halves of that:
 * a visible goal answered headlessly is REFUSED, and the same goal answered with a real window
 * capability PROCEEDS.
 *
 * THE DELIBERATE OVER-APPROXIMATION
 * ---------------------------------
 * `interactionMode` is deliberately over-eager rather than clever. "show me the spreadsheet in
 * Documents" classifies as `visible` even though it names a file, because the rule matches the
 * bare phrase "show me". That is intentional and it is the safe direction to be wrong in: a
 * `visible` goal that gets answered with a real window is a slightly redundant mission, while an
 * `any` goal that was meant as visible gets answered by a browser nobody can see. The ordinary
 * research goals below are asserted as `any` precisely so this rule cannot widen into them.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const AGENT = pathToFileURL(join(HERE, '..', 'live', 'agent', 'agent.ts')).href
const GOAL_INTENT = pathToFileURL(join(HERE, '..', 'live', 'agent', 'goal-intent.ts')).href

const loadIntent = () => import(GOAL_INTENT)
const loadAgent = () => import(AGENT)

/** A well-formed headless step. `url` and `objective` are BOTH required, so a refusal that
 *  mentions headless research is the visible-interaction rule and not a missing argument. */
const headlessOnly = (goal: string) => ({
  reply: '',
  model: 'test',
  steps: [{
    id: 's1',
    intent: 'Research the topic on the web',
    tool: 'web-research',
    args: { url: 'https://duckduckgo.com/', objective: goal, pages: 2 },
  }],
})

// ============================================================================================
// CLASSIFICATION
// ============================================================================================

test('a goal that explicitly asks to SEE something is classified visible', async () => {
  const { interactionMode } = await loadIntent()
  for (const goal of [
    'open a browser on my screen and search nakivo backup',
    'let me see the market report on screen',
    'watch it happen',
    'open google and search nakivo backup',
  ]) {
    assert.equal(interactionMode(goal), 'visible', `"${goal}" asks to see something`)
  }
})

test('asking to see the MACHINE is visible, even without the words "on my screen"', async () => {
  // The phrasing people actually use. "list the windows open on this desktop" carries no explicit
  // visibility wording at all, which is exactly why it was previously invisible to the rule and a
  // headless plan could answer it.
  const { interactionMode } = await loadIntent()
  for (const goal of [
    'list the windows open on this desktop',
    'show me the taskbar',
    'what is on my screen right now',
    'show me the desktop icons',
  ]) {
    assert.equal(interactionMode(goal), 'visible', `"${goal}" is a request to see the screen`)
  }
})

test('ordinary knowledge goals stay `any`, so the guard does not fire on everything', async () => {
  // The counterpart, and it matters as much. A guard that fires on every goal is a guard that
  // gets switched off, and then the visible case stops being protected too.
  const { interactionMode } = await loadIntent()
  for (const goal of [
    'research data protection companies and give me a spreadsheet',
    'list the data protection companies',
    'display the sales figures as a table',
    'see the contents of notes.txt',
    'read the quarterly report and tell me what it says',
    'check the weather report',
    'save the summary to my Documents folder',
    'find all pst files and list them',
  ]) {
    assert.equal(interactionMode(goal), 'any', `"${goal}" wants the answer, not a window`)
  }
})

// ============================================================================================
// ENFORCEMENT, THROUGH THE REAL validatePlan
// ============================================================================================

test('a visible goal answered ONLY by headless research is REFUSED', async () => {
  const { validatePlan } = await loadAgent()
  const goal = 'open a browser on my screen and search nakivo backup'
  const v = validatePlan(headlessOnly(goal), goal)

  // The refusal is a whole-plan judgement, so the step object itself is still returned; what stops
  // the plan is the refusal, and runGoal returns early on an empty-or-refused set. Asserted on the
  // refusal rather than on the step list, which is the thing that actually prevents execution.
  const aboutVisibility = v.refusals.find((r) => /headless research/i.test(r))
  assert.ok(aboutVisibility,
    `the refusal must be about visibility, not an unrelated argument problem: ${JSON.stringify(v.refusals)}`)
  // And it must say what the person should have got instead, because "I could not show you that"
  // is useful and a refusal with no alternative is just an obstruction.
  assert.match(aboutVisibility, /launch-app/i)
  assert.match(aboutVisibility, /desktop-input/i)
  assert.match(aboutVisibility, /shows the person nothing/i)
})

test('the SAME goal answered with a real window capability PROCEEDS', async () => {
  // The pair above and here is the whole point: the goal's WORDING decides, not the tool's name.
  const { validatePlan } = await loadAgent()
  const goal = 'open a browser on my screen and search nakivo backup'
  const v = validatePlan({
    reply: '', model: 'test',
    steps: [
      { id: 's1', intent: 'Open Edge at the search', tool: 'launch-app', args: { app: 'msedge', url: 'https://duckduckgo.com/?q=nakivo+backup' } },
      { id: 's2', intent: 'Type into the address bar', tool: 'desktop-input', args: { action: 'type', text: 'nakivo backup' } },
    ],
  }, goal)

  assert.equal(v.refusals.length, 0, `a visible plan must not be refused: ${JSON.stringify(v.refusals)}`)
  assert.equal(v.steps.length, 2, 'both steps survive validation')
})

test('headless PLUS one window-opening step is accepted, because a window does appear', async () => {
  // The rule is "no window appears", not "headless tools are forbidden". Research followed by
  // opening the result is the ordinary way to do this task and must not be refused.
  const { validatePlan } = await loadAgent()
  const goal = 'open a browser on my screen and search nakivo backup'
  const v = validatePlan({
    reply: '', model: 'test',
    steps: [
      { id: 's1', intent: 'Research', tool: 'web-research', args: { url: 'https://duckduckgo.com/', objective: goal, pages: 2 } },
      { id: 's2', intent: 'Open the page in a real window', tool: 'launch-app', args: { app: 'msedge', url: 'https://duckduckgo.com/?q=nakivo+backup' } },
    ],
  }, goal)

  assert.equal(v.refusals.length, 0, `research plus a window is legitimate: ${JSON.stringify(v.refusals)}`)
})

test('an ordinary research goal answered headlessly is NOT refused', async () => {
  // The other half of the pair. If this fails, the guard has become indiscriminate.
  const { validatePlan } = await loadAgent()
  const goal = 'research data protection companies and give me a spreadsheet'
  const v = validatePlan(headlessOnly(goal), goal)

  const aboutVisibility = v.refusals.filter((r) => /headless research/i.test(r))
  assert.equal(aboutVisibility.length, 0,
    'headless research is a legitimate answer when nobody asked to see anything')
})

test('EVERY visible capability is recognised as visible', async () => {
  // If a new window-opening capability is registered later and nobody adds it here, the rule
  // would refuse a plan that does open a window. Asserted against the registry so that is a
  // loud failure rather than a silent one.
  const { CAPABILITIES } = await import(pathToFileURL(join(HERE, '..', 'live', 'agent', 'capabilities.ts')).href)
  const { validatePlan } = await loadAgent()
  const goal = 'show me the taskbar'
  const windowing = CAPABILITIES.filter((c) => /launch-app|desktop-input|screen-diff|list-windows|survey-window|ocr/.test(c.id))
  assert.ok(windowing.length > 0, 'the registry must still expose window capabilities')

  for (const c of windowing) {
    const v = validatePlan({
      reply: '', model: 'test',
      steps: [{ id: 's1', intent: 'Do the visible thing', tool: c.id, args: { app: 'msedge', action: 'type', text: 'x', path: 'C:\\Users\\Samer\\Documents\\x.txt', url: 'https://example.com/' } }],
    }, goal)
    const refused = v.refusals.some((r) => /headless research/i.test(r))
    assert.equal(refused, false, `${c.id} opens or reads a real window and must not be refused as headless`)
  }
})