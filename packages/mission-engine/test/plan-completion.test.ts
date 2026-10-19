/**
 * AUTONOMOUS MULTI-STEP COMPLETION: DOES THE POLICY FIRE, AND ONLY WHEN IT SHOULD?
 *
 * ============================================================================================
 * WHY THIS EXISTS
 * ============================================================================================
 *
 * The system prompt says "do not stop at the first action". Measured on this machine, the model
 * did not obey it: given an information goal it emitted exactly one step - open a browser - and
 * stopped, and the mission was graded "not achieved" while a working results page sat on screen.
 * The prompt was rewritten and the behaviour did not change, which is the expected result for a
 * small local model and is why the guarantee had to move into code.
 *
 * So this file tests the code. The dangerous failure modes are all in the "too eager" direction
 * and they are the ones that cost the user real work:
 *
 *   - firing on a plan that already delivers, and replacing it with something worse
 *   - firing on a show-goal or a produce-goal, which already have verifiers and must be left alone
 *   - a correction that is not actually more complete than the original
 *
 * And one failure mode in the "too quiet" direction: never firing at all, which is the bug it was
 * written to fix.
 *
 * ============================================================================================
 * WHAT IS AND IS NOT TESTED
 * ============================================================================================
 *
 * The policy - `assessCompletion` and `correctionMessage` - is pure and tested exhaustively.
 * What it cannot prove here is that a particular free local model actually produces a better plan
 * when corrected; that depends on the model and on rate limits, and asserting it in a unit test
 * would make the suite flaky rather than honest. That half is verified end to end against the
 * running system, separately.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { join } from 'node:path'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const PC = pathToFileURL(join(HERE, '..', 'live', 'agent', 'plan-completion.ts')).href
const GI = pathToFileURL(join(HERE, '..', 'live', 'agent', 'goal-intent.ts')).href

const step = (tool: string, intent = 'do something') => ({ id: 's1', intent, tool, args: {} })

// ---------------------------------------------------------------- the bug

test('IT FIRES: an information goal answered by a browser alone is a gesture, not a goal', async () => {
  const { assessCompletion } = await import(PC)
  const { classifyGoal } = await import(GI)
  const goal = 'data protection companies'
  assert.equal(classifyGoal(goal), 'information')

  const v = assessCompletion(goal, 'information', [step('launch-app', 'open google and search')])
  assert.equal(v.incomplete, true,
    'this is the exact plan the system produced: one step, a browser, no deliverable')
  assert.match(v.why, /window is not information/i)
  assert.match(v.requiredOutcome, /web-research/i)
  assert.match(v.requiredOutcome, /spreadsheet/i,
    'the correction must name the tools that can actually deliver, or it is only a complaint')
})

test('it fires when the goal says "open ... search ..." but is really a request to know', async () => {
  const { assessCompletion } = await import(PC)
  // The phrasing that produced the reported bug. It CONTAINS "open" and "search", and the plan
  // it invited really did open a search page - and that is still not the answer to anything.
  const v = assessCompletion(
    'open google and search for data protection companies',
    'information',
    [step('launch-app', 'Open Google browser with a search for data protection companies')],
  )
  assert.equal(v.incomplete, true)
})

// ---------------------------------------------------------------- what it must NOT touch

test('IT DOES NOT FIRE on a plan that already delivers', async () => {
  const { assessCompletion } = await import(PC)
  // The single most important negative case. A false positive here replaces working plans.
  // `write-file`, `spreadsheet` and `read-file` always count as delivering, regardless of goal
  // wording: they produce an artifact the person can keep.
  for (const tool of ['write-file', 'spreadsheet', 'read-file']) {
    // A non-list goal: the deliverable is an artifact, which any of these provides.
    const v = assessCompletion('save a summary of the meeting', 'information', [step(tool)])
    assert.equal(v.incomplete, false, `a plan containing ${tool} delivers something`)
  }
  // web-research alone delivers a brief - UNLESS the goal plainly asks for a list, in which
  // case a brief is not enough and the completion pass fires. Both outcomes are asserted.
  const vBrief = assessCompletion('research nakivo', 'information', [step('web-research')])
  assert.equal(vBrief.incomplete, false, 'a brief is the right deliverable for a research goal')
  const vList = assessCompletion('data protection companies', 'information', [step('web-research')])
  assert.equal(vList.incomplete, true, 'a list goal answered by a brief alone is incomplete')
  // And a mixed plan, where the browser is the first step and the research is the second.
  const mixed = assessCompletion('data protection companies', 'information', [
    step('launch-app', 'open the site'),
    step('web-research', 'read the pages'),
    step('spreadsheet', 'write the list'),
  ])
  assert.equal(mixed.incomplete, false, 'a browser + research + spreadsheet is complete')
})

test('IT DOES NOT FIRE on show, produce or act goals', async () => {
  const { assessCompletion } = await import(PC)
  // These have their own verifiers. Second guessing them would be second guessing work that
  // already has a proof - and the browser case is exactly a show-goal that was reported working.
  for (const intent of ['show', 'produce', 'act', 'conversational'] as const) {
    const v = assessCompletion('open notepad', intent, [step('launch-app')])
    assert.equal(v.incomplete, false, `must not second-guess a ${intent} goal`)
  }
})

test('IT DOES NOT FIRE on a zero-step plan', async () => {
  const { assessCompletion } = await import(PC)
  // A conversational reply has no steps and is not a failed plan. The early return exists so the
  // `.every()` below cannot report an empty array as "display only".
  const v = assessCompletion('hi', 'information', [])
  assert.equal(v.incomplete, false)
})

test('IT DOES NOT FIRE on a plan that does something other than displaying', async () => {
  const { assessCompletion } = await import(PC)
  // Not a deliverable and not a display: this function has no opinion about it.
  const v = assessCompletion('find something', 'information', [step('terminal')])
  assert.equal(v.incomplete, false)
})

// ---------------------------------------------------------------- the correction message

test('the correction names the defect, names the fix, and keeps the steps that were right', async () => {
  const { assessCompletion, correctionMessage } = await import(PC)
  const goal = 'data protection companies'
  const v = assessCompletion(goal, 'information', [step('launch-app')])
  const msg = correctionMessage(goal, v)

  assert.match(msg, /previous plan/i)
  assert.match(msg, new RegExp(goal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
    'the goal must be quoted back, or the model cannot tell which question it is answering')
  assert.match(msg, /what was wrong/i)
  assert.match(msg, /what is needed/i)
  // The sentence that stops the model replacing everything and losing the parts that were right.
  assert.match(msg, /keep any steps/i)
  assert.match(msg, /only "reply" and "steps" are allowed/i,
    'the schema constraint must be restated, or a corrected reply arrives unparseable')
})

test('the correction never instructs the model to fabricate a result', async () => {
  const { assessCompletion, correctionMessage } = await import(PC)
  const v = assessCompletion('data protection companies', 'information', [step('launch-app')])
  const msg = correctionMessage('data protection companies', v).toLowerCase()
  // A model told to "just produce something" will invent findings. The correction must route it
  // to tools that go and READ, never to composing an answer from nothing.
  assert.doesNotMatch(msg, /make up|fabricat|invent|guess the answer|from memory|without (using )?the tools/i)
  assert.match(msg, /web-research/, 'it must point at the instrument that actually reads pages')
})