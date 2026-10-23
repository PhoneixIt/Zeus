/**
 * A QUESTION MUST BE ANSWERED, NOT TURNED INTO A MISSION.
 *
 * ============================================================================================
 * WHY THIS IS A TEST AND NOT A COMMENT
 * ============================================================================================
 *
 * `interpret()` is where a user's message becomes either an answer or a mission. It was wrong
 * for questions: a question was handed to the planner, which asks the model for executable
 * STEPS. So "Why is Python popular?" produced a research mission - a browser, a brief, a
 * read-back, a verification loop - and the person waited through all of it for one sentence.
 *
 * The observed failure, in the running window:
 *
 *   You: is claude or chatgpt better?
 *   Zeus: Nothing has arrived for 90 seconds. The mission may have stalled.
 *
 * A question does not need a mission. It needs an answer. This file locks that down through the
 * REAL entry point - `interpret()` - with only the language model replaced by a subprocess that
 * emits a canned reply. Everything else is production code, unmodified.
 *
 * THE RULE UNDER TEST, stated once:
 *
 *   1. A trailing question mark is required but not sufficient.
 *   2. A wh-word question is a question EVEN IF it contains an action verb ("How do I save a
 *      file?" asks for guidance; it does not request the save).
 *   3. A question that names an action verb and does not begin with a wh-word is a REQUEST
 *      ("Open Notepad?"), and it must go to the governed pipeline, never be answered in chat.
 *
 * WHAT IS AND IS NOT TESTED
 * ============================================================================================
 *
 * The routing decision and its consequences: which path the message takes, and whether the
 * model's answer is returned as the chat reply with zero executable steps. The language model's
 * own quality is not asserted - a canned reply stands in for it, which is the one thing a test
 * may not claim to measure.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))

// ONE home for the whole file, installed before agent.ts is ever imported. agent.ts computes
// its state directories at module load, and Node caches modules, so a per-test scratch home
// would send later tests' records somewhere the first test's cleanup has deleted.
const HOME = mkdtempSync(join(tmpdir(), 'aios-answer-route-'))
process.env.USERPROFILE = HOME
process.env.HOMEDRIVE = HOME.slice(0, 2)
process.env.HOMEPATH = HOME.slice(2)
process.on('exit', () => {
  try { rmSync(HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) } catch { /* best effort */ }
})

const ANSWER = 'Python is popular because it is readable, has a large ecosystem, and is easy to learn.'
// The NDJSON shape the real CLI emits: one envelope whose `part` carries the text.
const ANSWER_NDJSON = `${JSON.stringify({ part: { type: 'text', text: ANSWER } })}\n`

interface InterpretOutcome {
  readonly reply: string
  readonly steps: readonly unknown[]
  readonly model: string
}

/**
 * Run `body` with the model CLI replaced by a real subprocess that emits `modelOutput`.
 *
 * `shell: false` cannot run a `.cmd` shim on Windows (measured), so the shim is node.exe with
 * `NODE_OPTIONS=--require <shim.js>`: node loads the required module before it resolves the
 * bogus `run` argument, and the shim writes the NDJSON and exits. Everything downstream -
 * the spawn, the NDJSON loop, the envelope, the parser - is production code.
 *
 * The shim also CAPTURES its argv to `capture-*.txt` in the test home, returned as `captured`.
 * That file is the spawn proof for whatever `body` ran: EMPTY means no model process was ever
 * created - the honest way to show that a conversational message never reached the model at all,
 * and the only way to tell the two paths apart when the visible reply could be either.
 */
async function withFakeCli<T>(
  modelOutput: string, body: () => Promise<T>,
): Promise<{ value: T; captured: string }> {
  const shim = mkdtempSync(join(tmpdir(), 'aios-fake-answer-'))
  const shimJs = join(shim, 'emit-ndjson.js')
  const capturePath = join(HOME, `capture-${randomUUID()}.txt`)
  writeFileSync(
    shimJs,
    [
      `try { require('node:fs').writeFileSync(${JSON.stringify(capturePath)}, process.argv.slice(2).join(' ')) } catch {}`,
      `process.stdout.write(${JSON.stringify(modelOutput)});`,
      'process.exit(0);',
    ].join('\n'),
    'utf8',
  )
  const prevOptions = process.env.NODE_OPTIONS
  process.env.NODE_OPTIONS = `--require ${JSON.stringify(shimJs)}`
  try {
    const value = await body()
    let captured = ''
    try { captured = readFileSync(capturePath, 'utf8') } catch { captured = '' }
    return { value, captured }
  } finally {
    process.env.NODE_OPTIONS = prevOptions
    rmSync(shim, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

/** Drive the real `interpret()` through `withFakeCli`. */
async function interpretWith(
  modelOutput: string, goal: string,
): Promise<{ outcome: InterpretOutcome; captured: string }> {
  const { value: outcome, captured } = await withFakeCli(modelOutput, async () => {
    const mod = await import('../../mission-engine/live/agent/agent.ts')
    return (await mod.interpret(goal, () => {}, { cliPath: process.execPath })) as InterpretOutcome
  })
  return { outcome, captured }
}

interface EmittedEvent {
  readonly kind?: string
  readonly text?: string
  readonly ok?: boolean
  readonly [k: string]: unknown
}

interface RunGoalOutcome {
  readonly ok: boolean
  readonly reply: string
  readonly steps: readonly unknown[]
  readonly error?: string
}

/**
 * Drive the REAL `runGoal` - the function the chat server calls for every message - collecting
 * the events the window would receive. This is one level above `interpretWith`: it proves not
 * only how the message was routed, but what the MISSION became (ok/failed, what `done` said),
 * which is the half a person actually watches.
 */
async function runGoalWith(goal: string): Promise<{ result: RunGoalOutcome; events: EmittedEvent[]; captured: string }> {
  const { value, captured } = await withFakeCli(ANSWER_NDJSON, async () => {
    const mod = await import('../../mission-engine/live/agent/agent.ts')
    const events: EmittedEvent[] = []
    const result = (await mod.runGoal(
      goal,
      (e) => { events.push(e as unknown as EmittedEvent) },
      { cliPath: process.execPath },
    )) as unknown as RunGoalOutcome
    return { result, events }
  })
  return { result: value.result, events: value.events, captured }
}

test('a wh-word question is ANSWERED, not planned', async () => {
  // THE REGRESSION. Before the fix this produced executable steps - a research mission for a
  // fact - and reported `unproven`. Now it returns the model's prose with zero steps.
  const { outcome: r } = await interpretWith(ANSWER_NDJSON, 'Why is Python popular?')
  assert.equal(r.steps.length, 0, 'a question must not produce executable steps')
  assert.match(r.reply, /readable/, 'the model answer must be returned as the chat reply')
  assert.equal(r.model, 'none (conversational)', 'an answer is not a mission')
})

test('a question that does not begin with a wh-word is still answered', async () => {
  // "is claude or chatgpt better?" - the exact message that stalled the window. No wh-word at
  // the start, no action verb, trailing question mark: a question, and it must be answered.
  const { outcome: r } = await interpretWith(ANSWER_NDJSON, 'is claude or chatgpt better?')
  assert.equal(r.steps.length, 0)
  assert.match(r.reply, /ecosystem/)
})

test('a wh-word question that names an action verb is still a QUESTION', async () => {
  // "How do I save a file?" asks for guidance. It does not request that a file be saved, and
  // treating it as a task would make Zeus act on a question.
  const { outcome: r } = await interpretWith(ANSWER_NDJSON, 'How do I save a file?')
  assert.equal(r.steps.length, 0, 'asking how to do something is not requesting that it be done')
  assert.match(r.reply, /easy to learn/)
})

test('an action request phrased as a question is NOT answered in chat', async () => {
  // "Open Notepad?" names an action verb and does not begin with a wh-word. It is a request
  // phrased as a question, and it must enter the governed pipeline where it is approved and
  // verified. Answering it in chat would bypass the permission check.
  const { outcome: r } = await interpretWith(ANSWER_NDJSON, 'Open Notepad?')
  assert.notEqual(
    r.model,
    'none (conversational)',
    'a consequential request must not be routed to the answer path',
  )
})

test('a goal with no question mark is not a question', async () => {
  const { outcome: r } = await interpretWith(ANSWER_NDJSON, 'open Notepad')
  assert.notEqual(r.model, 'none (conversational)', 'a command is a task, not a question')
})

test('AND IT CAN FAIL: the rule is observable, not decorative', async () => {
  // The answer path is distinguished from the plan path by its model marker. If a future change
  // routes questions to the planner again, the first assertion in this file fails. That is the
  // point: the distinction is something a test can actually see.
  const answered = await interpretWith(ANSWER_NDJSON, 'What is the capital of France?')
  const planned = await interpretWith(ANSWER_NDJSON, 'list the windows open on this desktop')
  assert.equal(answered.outcome.model, 'none (conversational)')
  assert.notEqual(planned.outcome.model, 'none (conversational)')
})

test('a follow-up CARRIES the previous conversation to the model', async () => {
  // Context threading, proven on the PROMPT THE MODEL ACTUALLY RECEIVED - captured by the shim,
  // not inferred. "And what about JavaScript?" has no referent without the turn before it, and
  // until now the transcript never reached the model: every message arrived as if the
  // conversation had just started.
  const mod = await import('../../mission-engine/live/agent/agent.ts')
  mod.appendConversation({
    role: 'assistant',
    text: 'Python is popular because it is readable and has a huge ecosystem.',
    at: Date.now(), missionId: 'seed-context', ok: true,
  })
  const { outcome, captured } = await interpretWith(ANSWER_NDJSON, 'And what about JavaScript?')
  assert.equal(outcome.steps.length, 0, 'a follow-up question is still just a question')
  assert.match(captured, /JavaScript/, 'the new question must reach the model')
  assert.match(captured, /Python is popular/, 'the previous turn must reach the model as context')
  assert.match(
    captured,
    /NOT instructions/,
    'the context block must label the transcript as data, never as authority',
  )
})

test('the context is BOUNDED: one huge turn cannot fill the prompt', async () => {
  // Truncation, measured on the captured prompt. A 20 000-character answer is sliced per turn,
  // so the block cannot grow without limit as a session ages - and the turn is still PRESENT
  // (truncated), not silently dropped.
  const mod = await import('../../mission-engine/live/agent/agent.ts')
  mod.appendConversation({
    role: 'assistant',
    text: 'HUGE-TURN ' + 'x'.repeat(20000),
    at: Date.now(), missionId: 'seed-huge', ok: true,
  })
  const { captured } = await interpretWith(ANSWER_NDJSON, 'Is Go better than Rust?')
  assert.ok(captured.length > 0, 'the prompt must be captured at all for this to prove anything')
  assert.ok(captured.length < 4500, `the prompt must stay bounded, got ${captured.length} chars`)
  assert.match(captured, /HUGE-TURN/, 'the truncated turn must still be present as context')
})

// ============================================================================================
// ORDINARY SMALL TALK - the live "how are you" blocker of 2026-10-22
// ============================================================================================
//
// In the real window: "hi" was answered in 13ms, and "how are you" - typed WITHOUT the question
// mark - showed the pool status ("choosing a free model and spreading the load across its
// pool"), then 90 seconds of silence, then the watchdog, and never got a reply. The cause was
// routing, not the watchdog and not the provider: the well-being branch in `conversationalReply`
// demanded a trailing question mark, and `isKnowledgeQuestion` demands one too, so the most
// ordinary message in any conversation fell past BOTH guards and into the mission planner -
// a 300-second model call for a message that needs no model at all. The watchdog warning the
// person saw was a SYMPTOM of that wrong path: nothing could arrive before a planner returned.
//
// The spawn capture is the discriminator that makes these tests honest: a reply string alone
// cannot tell the conversational path from a model answer, but an EMPTY capture proves no model
// process was ever created.

test('"how are you" (no question mark) is ANSWERED as conversation, never planned', async () => {
  // THE LIVE BLOCKER, end to end through runGoal - the exact function the chat server calls.
  // Prompt means zero spawn (capture empty); "not a bogus failed mission" means ok:true and a
  // done event saying so, which is also what un-sticks the window (finish() runs from done).
  const started = Date.now()
  const { result: r, events, captured } = await runGoalWith('how are you')
  const elapsed = Date.now() - started

  assert.equal(captured, '',
    'no model process may be spawned for a phatic message - this is what sent the live message to a 300s planner')
  assert.equal(r.ok, true, 'ordinary conversation must not become a failed mission')
  assert.equal(r.steps.length, 0, 'small talk proposes no executable steps')
  const done = events.find((e) => e.kind === 'done')
  assert.ok(done, 'the window un-sticks only on a done event; the mission must end with one')
  assert.equal(done.ok, true, 'the done must report a completed turn, not a failure')
  assert.match(String(done.text), /doing well/,
    'the well-being reply must be what the person sees - not a planner verdict')
  assert.ok(elapsed < 30_000, `a conversational message answers in milliseconds, not mission time; took ${elapsed}ms`)
})

test('the whole well-being family answers in its common forms - mark or no mark', async () => {
  // The defect class, not just the one message: every idiomatic phatic form must take the
  // conversational path, and none of them may spawn the model. "how are you?" (with the mark)
  // worked before the fix and must keep working - the fix WIDENS the match, never narrows it.
  const variants = ['how are you?', 'How are you', 'how r u', "how's it going", 'how is it going']
  for (const goal of variants) {
    const { outcome: r, captured } = await interpretWith(ANSWER_NDJSON, goal)
    assert.equal(captured, '', `${goal}: the CLI must not be spawned`)
    assert.equal(r.steps.length, 0, `${goal}: no executable steps`)
    assert.equal(r.model, 'none (conversational)', `${goal}: marked as conversational, so runGoal reports ok:true`)
    assert.doesNotMatch(r.reply, /readable/, `${goal}: the canned MODEL answer must not appear - no model was asked`)
  }
})

test('CONTROL: a task sentence that opens like small talk still reaches the planner', async () => {
  // The safety half of the same fix. The widened well-being match must not swallow a task: the
  // action-verb gate runs BEFORE every phatic pattern, so a sentence naming "open" goes to the
  // planner whether or not it has a question mark. If this ever flips, ordinary requests would
  // be answered with small talk instead of being done - the failure mode the routing guards
  // were built to prevent.
  const { outcome: r, captured } = await interpretWith(ANSWER_NDJSON, 'how are you going to open Notepad')
  assert.ok(captured.length > 0, 'the planner must be asked: this is a task, not a greeting')
  assert.notEqual(r.model, 'none (conversational)',
    'a task must never be marked conversational - that would report ok:true with nothing done')
  assert.doesNotMatch(r.reply, /doing well/, 'the well-being reply must never answer a task request')
})
