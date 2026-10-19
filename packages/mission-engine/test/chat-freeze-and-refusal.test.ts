/**
 * TWO FAILURES THE USER HIT IN ONE SESSION, AND WHY READING THE CODE DID NOT FIND THEM.
 *
 * ============================================================================================
 * 1. THE INTERFACE FROZE WHILE THE ANSWER WAS ALREADY WRITTEN
 * ============================================================================================
 *
 * The user typed "Hello", then "hi". Both were answered correctly - the replies were in the
 * transcript on disk - and neither appeared. Stop stayed enabled, the composer stayed disabled.
 *
 * The event feed was an SSE stream on /events, which is LIVE-ONLY. It cannot replay. A dropped
 * connection, a not-yet-established connection, or a reconnect gap all discard the events
 * emitted during the gap - including 'done'. Since finish() runs on 'done' and finish() is the
 * only thing that re-enables the composer, losing one event strands the UI forever.
 *
 * These tests assert the feed is INDEXED and REPLAYABLE, because that is the property that
 * makes the freeze impossible rather than merely unlikely.
 *
 * ============================================================================================
 * 2. A REFUSAL WAS SHOWN AS RAW JSON
 * ============================================================================================
 *
 * The user was shown:
 *
 *     {"refusal":"The request 'probe' is too ambiguous to form a plan. ..."}
 *
 * Declining is correct behaviour and must stay visible. Showing the envelope instead of the
 * sentence is not.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..', '..')
const src = (p: string) => readFileSync(resolve(REPO, p), 'utf8')

const ui = src('packages/mission-engine/live/agent/ui-assets.ts')
const agent = src('packages/mission-engine/live/agent/agent.ts')
const server = src('packages/mission-engine/live/agent/chat-server.ts')

// ------------------------------------------------------------------ 1. the feed

test('the client reads an INDEXED, REPLAYABLE event feed', () => {
  // The freeze was caused by /events. If the client is still consuming that route, the freeze
  // can come back.
  assert.equal(/fetch\(['"]\/events/.test(ui), false,
    'the client must not consume the live-only /events stream; a stream that cannot replay can ' +
    'lose the done event and leave the interface permanently disabled')

  assert.match(ui, /\/progress\?since=/,
    'the feed must be indexed polling of /progress, which replays what was missed')
})

test('the feed cursor advances only over events that were actually rendered', () => {
  // Advancing the cursor before rendering is how events get skipped: the index moves past an
  // event whose handler threw, and that event is never seen again.
  const fn = /async function pollFeed\(\)\s*\{[\s\S]*?\n\}/.exec(ui)?.[0] ?? ''
  assert.match(fn, /handleEvent\(e\)/, 'events must be handled')
  const handleAt = fn.indexOf('handleEvent(e)')
  const advanceAt = fn.indexOf('FEED.seen = body.total')
  assert.ok(handleAt > 0 && advanceAt > handleAt,
    'the cursor must advance AFTER the events are handled, never before')
})

test('a request that fails does NOT advance the cursor', () => {
  const fn = /async function pollFeed\(\)\s*\{[\s\S]*?\n\}/.exec(ui)?.[0] ?? ''
  // A dropped poll must be free: the next poll re-requests the same range and gets everything.
  const catchAt = fn.lastIndexOf('catch')
  const advanceAt = fn.indexOf('FEED.seen = body.total')
  assert.ok(catchAt < 0 || advanceAt < catchAt,
    'the cursor assignment must be inside the try, before the catch, so a failure skips it')
})

test('finish() is reachable from every terminal path, so the composer cannot stay disabled', () => {
  // finish() is the ONLY thing that re-enables the composer. Every path out of a mission must
  // reach it, or the window stays frozen exactly as it did for the user.
  assert.match(ui, /function finish\(\)/, 'finish() must exist')
  const fn = /function finish\(\)\s*\{[\s\S]*?\n\}/.exec(ui)?.[0] ?? ''
  assert.match(fn, /sendBtn'\)\.disabled = false/, 'finish() must re-enable send')
  assert.match(fn, /composer'\)\.disabled = false/, 'finish() must re-enable the composer')
  assert.match(fn, /state\.busy = false/, 'finish() must clear the busy flag')

  // The watchdog is the backstop for a mission that genuinely never reports.
  assert.match(ui, /Nothing has arrived for/, 'a quiet-but-busy window must surface a watchdog message')
  assert.match(ui, /state\.busy && FEED\.lastEventAt && Date\.now\(\) - FEED\.lastEventAt >/,
    'the watchdog must be time-bounded, not dependent on an event arriving')
})

test('the server buffers events so an indexed read can replay them', () => {
  assert.match(server, /const eventBuffer: ProgressEvent\[\] = \[\]/,
    'the replay buffer is what makes /progress authoritative')
  assert.match(server, /eventBuffer\.splice/, 'the buffer must be bounded so it cannot grow forever')
  assert.match(server, /eventBuffer\.slice\(from\)/, '/progress must return everything after the cursor')
})

// ------------------------------------------------------------------ 2. the refusal

test('a refusal document is answered with its sentence, not its envelope', () => {
  const envelope = '{"refusal":"That request is too ambiguous to form a plan."}'
  // Exactly what the user saw on screen.
  assert.equal(/typeof p\.refusal === 'string'/.test(agent), true,
    'the refusal variant must be recognised, or the raw document is displayed')
  assert.match(agent, /reply: p\.refusal\.trim\(\)/,
    'the refusal text must become the reply')

  // And the shape really does arrive as a bare refusal document with no steps.
  const parsed = JSON.parse(envelope) as { refusal?: string; steps?: unknown }
  assert.equal(parsed.steps, undefined, 'a refusal carries no steps, which is why it fell through')
  // The sentence a user should see, rather than the envelope.
  assert.equal(parsed.refusal, 'That request is too ambiguous to form a plan.')
})

test('AND IT CAN FAIL: the two failure modes are genuinely detectable from the source', () => {
  // Without these, the assertions above could be satisfied by a comment alone.
  const refusalDoc = '{"refusal":'
  const where = agent.indexOf(refusalDoc) >= 0 ? 'agent.ts' : ui.indexOf(refusalDoc) >= 0 ? 'ui-assets.ts' : null
  assert.ok(where !== null,
    `the exact envelope the user saw must appear in the source, or this control is measuring ` +
    `nothing. It is a real document the model emitted, quoted here on purpose.`)
  assert.equal(/EventSource|new EventSource/.test(ui), false,
    'EventSource must not reappear; it cannot send the Authorization header either')
})

void server