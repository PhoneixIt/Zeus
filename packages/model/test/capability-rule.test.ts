/**
 * M26 CONTROLS - the prompt and the parser must agree about what a capability IS.
 * =============================================================================
 *
 * `CAPABILITY_RULE` was a hand-written string listing the capabilities a model may use, and the
 * system prompt tells the model that an unknown capability "is rejected and the whole plan is
 * discarded".
 *
 * So the two halves of the system had to agree, and they did not: the vocabulary in
 * `planner/plan.ts` gained `browser.read` and `browser.navigate`, and the literal did not. The model
 * was told those two capabilities did not exist, and any plan using one was correctly rejected by
 * the compiler for naming a capability the prompt had declared invalid.
 *
 * Nothing caught it, because nothing compared the two. The rule is now DERIVED from the vocabulary,
 * and these tests exist so that a future capability cannot be added without the prompt following -
 * which is the only thing that makes "derived" a property rather than a one-off repair.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { CAPABILITY_RULE, capabilityRule, SYSTEM_INSTRUCTIONS } from '../protocol.ts'
import { CAPABILITIES } from '../../planner/plan.ts'

/** The capabilities the rule names, parsed back out of the rendered sentence. */
function ruleCapabilities(rule: string): string[] {
  const m = /^Valid capabilities: (.+)\. Nothing else exists\.$/.exec(rule)
  assert.ok(m, `the rule must keep its parseable shape, got: ${rule}`)
  return m![1]!.split(', ').map((s) => s.trim())
}

test('CONTROL: the prompt names EXACTLY the capabilities the vocabulary has', () => {
  // THE control. A capability in the vocabulary but not in the prompt is invisible to the model;
  // one in the prompt but not in the vocabulary is rejected by the compiler. Both are the same bug.
  const listed = ruleCapabilities(CAPABILITY_RULE)
  assert.deepEqual(
    listed,
    [...CAPABILITIES],
    'the prompt\'s capability list has drifted from the vocabulary - every entry must be identical',
  )
})

test('CONTROL: nothing in the prompt names a capability that does not exist', () => {
  const known = new Set<string>(CAPABILITIES)
  for (const c of ruleCapabilities(CAPABILITY_RULE)) {
    assert.ok(known.has(c), `the prompt offers "${c}", which the planner would reject`)
  }
})

test('CONTROL: nothing in the vocabulary is missing from the prompt', () => {
  const listed = new Set(ruleCapabilities(CAPABILITY_RULE))
  for (const c of CAPABILITIES) {
    assert.ok(listed.has(c), `the vocabulary has "${c}" but the prompt never mentions it`)
  }
})

test('the browser capabilities are actually offered to the model', () => {
  // The specific pair that was missing when this was found.
  assert.ok(ruleCapabilities(CAPABILITY_RULE).includes('browser.read'))
  assert.ok(ruleCapabilities(CAPABILITY_RULE).includes('browser.navigate'))
})

test('capabilityRule() renders a narrower set when asked to', () => {
  const narrow = capabilityRule(['filesystem.read'])
  assert.match(narrow, /^Valid capabilities: filesystem\.read\. Nothing else exists\.$/)
  assert.ok(!narrow.includes('terminal.run'))
})

test('the rule still forbids invention, in the exact words the model is shown', () => {
  // Rule 1 of SYSTEM_INSTRUCTIONS rejects an unknown capability, so the rule must CLOSE the list.
  // A prompt that says "these are valid" without "nothing else exists" invites the model to
  // improvise, and improvisation here means a rejected plan.
  assert.match(CAPABILITY_RULE, /Nothing else exists\./)
  assert.match(SYSTEM_INSTRUCTIONS, /unknown capability/i)
})

test('every capability the prompt offers is a capability the SYSTEM can actually serve', () => {
  // A prompt may only offer what a router can route. This cannot know the live registry, so it
  // pins the weaker, always-true half: the prompt offers nothing that is not in the vocabulary.
  // The live half is covered by the mission harnesses, which fail loudly on an unroutable step.
  const known = new Set<string>(CAPABILITIES)
  const offered = ruleCapabilities(CAPABILITY_RULE)
  assert.ok(offered.length > 0)
  assert.ok(offered.every((c) => known.has(c)))
})