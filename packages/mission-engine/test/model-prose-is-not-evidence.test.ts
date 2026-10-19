/**
 * A model's prose is not a report of what happened.
 *
 * Regression test for mission 4d2dd1be-f451-4c9d-a21e-1fbdc0dc1f53, 2026-10-19.
 *
 * THE FAILURE. Goal: the NAKIVO inventory (open the folder visibly, scan it recursively, save a CSV,
 * read it back). An earlier attempt had genuinely produced the CSV. A later attempt proposed NO
 * STEPS AT ALL, and the model's reply became the final message, verbatim:
 *
 *   "The NAKIVO folder has been opened visibly in File Explorer ... all 407 files have been
 *    scanned recursively ... The CSV was read back and verified - all 408 lines are intact."
 *
 * Nothing in that mission opened a window, scanned a file, or read a CSV back. Zero steps ran. The
 * text was written into `conversations.jsonl` as an assistant turn and shown to the person as the
 * outcome of their request, alongside - in the same transcript - the honest "2 of 4 step(s)
 * verified; Objective verdict: unmet" from the run that actually happened.
 *
 * WHY EVERYTHING ELSE MISSED IT. The objective verdict gate only ever sees the `done` emitted at
 * the end of a step run. This text never passed through it: it came from the no-steps branch, which
 * returned the model's reply untouched. So the most heavily guarded path in the system had an
 * unguarded exit next to it, and the exit was the one a person reads.
 *
 * It is also a worse failure than the `fetch failed` that started this investigation. That one
 * reported an error. This one reported success.
 *
 * THE INVARIANT. When a mission executes zero steps, the honest outcome is that nothing was done.
 * A reply produced by a model on such a mission may be shown, but only as an explicitly unverified
 * statement - never as a completion report, and never persisted as one.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(import.meta.dirname, '..', 'live', 'agent', 'agent.ts')
const src = readFileSync(SRC, 'utf8')

test('the no-steps branch does not emit the model reply as the final message', () => {
  // The defect in one line: `emit({ kind: 'done', ..., text: said })`.
  assert.doesNotMatch(
    src,
    /emit\(\{\s*kind:\s*'done',\s*ok:\s*conversational,\s*text:\s*said\s*\}\)/,
    'the no-steps branch must not emit the raw model reply as the mission outcome. On mission ' +
    '4d2dd1be that text claimed a verified 407-file scan for a mission that ran zero steps.',
  )
})

test('the emitted text distinguishes a real conversational turn from an unverified claim', () => {
  assert.match(
    src,
    /modelClaimedWork/,
    'the branch must tell a genuinely conversational reply apart from prose produced by a model ' +
    'on a mission that did nothing.',
  )
  assert.match(
    src,
    /const conversational = plan\.model === 'none \(conversational\)'/,
    'only a reply produced without calling a model may be shown as a completed turn.',
  )
})

test('the honest outcome is stated before any model text is quoted', () => {
  assert.match(
    src,
    /did not carry this out/,
    'a mission that executed nothing must say so in its own words.',
  )
  assert.match(
    src,
    /unverified and NOT a report of work performed/,
    'quoted model prose must be labelled unverified, so it cannot be read as a result.',
  )
})

test('an artefact from an earlier attempt is not implied to be this mission\'s work', () => {
  // The CSV at the requested path genuinely existed - from the PREVIOUS attempt. That is exactly
  // what makes the fabricated claim so convincing, and the message has to say where it came from.
  assert.match(
    src,
    /from an EARLIER attempt, not from this one/,
    'when a prior attempt left a file behind, the message must not let it read as this run\'s output.',
  )
})

test('the unverified text is what gets persisted, not the raw claim', () => {
  // `conversations.jsonl` is what every later reader - and the next mission's context - sees. If
  // the raw claim were persisted and only the honest text displayed, the next turn would be
  // briefed on a success that never happened.
  const branch = src.slice(src.indexOf("error: 'no executable steps were proposed'") - 2500,
                           src.indexOf("error: 'no executable steps were proposed'") + 400)
  assert.match(
    branch,
    /appendConversation\(\{ role: 'assistant', text: finalText/,
    'the conversation record must store the labelled text, not the bare model claim.',
  )
  assert.doesNotMatch(
    branch,
    /appendConversation\(\{ role: 'assistant', text: said/,
    'the bare model reply must not be written to the conversation transcript.',
  )
})

test('a genuine conversational turn is still answered normally', () => {
  // Removing the pass-through entirely would turn "Hi" into a silent failure. The reply is still
  // shown when no model was called; it is only fenced when a model produced prose about work.
  assert.match(
    src,
    /:\s*said\s*\n/,
    'a conversational reply with no model involvement must still be emitted unchanged.',
  )
})