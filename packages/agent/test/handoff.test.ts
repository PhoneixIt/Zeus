/**
 * THE HANDOFF CONTRACT, tested without running a model.
 *
 * The round trip proves the CLI works. This file proves the RULES hold - and several of them
 * can only be checked cheaply here, by feeding the validator deliberately bad input and
 * confirming it refuses rather than waves things through. A validator that accepts a forged
 * result is worse than no validator, because it manufactures the appearance of verification.
 *
 * Nothing here spawns a process, touches the network, or costs anything.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  claimTask, verifyResult, writeTask, initMailbox, parseTask,
  type HandoffTask, type HandoffResult,
} from '../handoff.ts'

const TASK: HandoffTask = {
  id: 't1',
  correlationId: 'corr-1',
  request: 'do a bounded thing',
  cwd: 'C:/work',
  acceptance: 'the thing is verifiably done',
}

const okResult = (over: Partial<HandoffResult> = {}): HandoffResult => ({
  taskId: 't1',
  correlationId: 'corr-1',
  cwd: 'C:/work',
  text: 'done',
  sessionId: 'ses_1',
  exitCode: 0,
  elapsedMs: 10,
  claimedAt: 1,
  finishedAt: 2,
  selfReport: { met: true, evidence: 'the file exists on disk' },
  ...over,
})

test('a well-formed result is accepted', () => {
  const v = verifyResult(TASK, JSON.stringify(okResult()))
  assert.equal(v.verdict, 'accepted')
})

// --- the acceptances that must NOT be granted -------------------------------------

test('acceptance claimed with no evidence is rejected', () => {
  const v = verifyResult(TASK, JSON.stringify(okResult({ selfReport: { met: true, evidence: '' } })))
  assert.equal(v.verdict, 'rejected')
})

test('acceptance NOT met is rejected', () => {
  const v = verifyResult(TASK, JSON.stringify(okResult({ selfReport: { met: false, evidence: 'it failed' } })))
  assert.equal(v.verdict, 'rejected')
})

test('a result carrying no self-report at all is rejected', () => {
  const { selfReport, ...rest } = okResult()
  void selfReport
  const v = verifyResult(TASK, JSON.stringify(rest))
  assert.equal(v.verdict, 'rejected')
})

test('a result for a different task is rejected', () => {
  const v = verifyResult(TASK, JSON.stringify(okResult({ taskId: 'other' })))
  assert.equal(v.verdict, 'rejected')
})

test('a non-zero exit is rejected even if acceptance is claimed', () => {
  // The ordering matters: a generous prose report must not rescue a failed run.
  const v = verifyResult(TASK, JSON.stringify(okResult({ exitCode: 2 })))
  assert.equal(v.verdict, 'rejected')
})

test('a transport failure is rejected', () => {
  const v = verifyResult(TASK, JSON.stringify(okResult({ failure: 'could not start the CLI' })))
  assert.equal(v.verdict, 'rejected')
})

test('work claimed in the wrong directory is rejected', () => {
  const v = verifyResult(TASK, JSON.stringify(okResult({ cwd: 'C:/somewhere/else' })))
  assert.equal(v.verdict, 'rejected')
})

test('malformed JSON is rejected rather than thrown', () => {
  const v = verifyResult(TASK, 'not json')
  assert.equal(v.verdict, 'rejected')
})

// --- the task contract ------------------------------------------------------------

test('a task must carry an acceptance criterion', () => {
  // Without one, "done" is unfalsifiable and the whole handoff degrades to vibes.
  const r = parseTask(JSON.stringify({ ...TASK, acceptance: '' }))
  assert.ok(r.error)
})

test('a task id must be filename-safe', () => {
  // The id becomes a filename, so a path traversal in it would write outside the mailbox.
  assert.ok(parseTask(JSON.stringify({ ...TASK, id: '../escape' })).error)
  assert.ok(parseTask(JSON.stringify({ ...TASK, id: 'a/b' })).error)
  assert.ok(!parseTask(JSON.stringify({ ...TASK, id: 'ok-1_2.3' })).error)
})

test('a task cwd must be absolute', () => {
  // A relative cwd resolves against whatever process happened to start the worker, which
  // would silently aim the work somewhere nobody chose.
  assert.ok(parseTask(JSON.stringify({ ...TASK, cwd: 'work' })).error)
  assert.ok(!parseTask(JSON.stringify({ ...TASK, cwd: 'C:/work' })).error)
})

test('malformed task JSON produces an error, not an exception', () => {
  assert.ok(parseTask('{').error)
  assert.ok(parseTask('[]').error)
})

// --- the single-writer rule --------------------------------------------------------

test('a task can be claimed exactly once, even by two claimers in a row', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aios-handoff-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeTask(root, TASK)

  const first = claimTask(root)
  assert.ok(!('error' in first), 'the first claim must succeed')
  assert.equal((first as { task: HandoffTask }).task.id, 't1')

  const second = claimTask(root)
  assert.ok('error' in second, 'the second claim must find nothing')
})

test('a malformed task is parked, and does not block the queue', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aios-handoff-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  initMailbox(root)
  // Named so it sorts FIRST, ahead of the good task.
  writeFileSync(join(root, 'inbox', '0000-broken.json'), '{ not json', 'utf8')
  writeTask(root, TASK)

  const c = claimTask(root)
  assert.ok(!('error' in c), 'a good task behind a bad one must still be claimable')
  assert.equal((c as { task: HandoffTask }).task.id, 't1')
  assert.ok(existsSync(join(root, 'claimed', 'INVALID-0000-broken.json')),
    'the bad task must be parked where a human will find it')
})

test('older tasks are claimed before newer ones', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aios-handoff-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeTask(root, { ...TASK, id: 'newer', createdAt: 2000 })
  writeTask(root, { ...TASK, id: 'older', createdAt: 1000 })

  const c = claimTask(root)
  assert.ok(!('error' in c))
  assert.equal((c as { task: HandoffTask }).task.id, 'older')
})

test('auto-approval cannot be set from a task file', (t) => {
  // The whole bounded-task guarantee rests on this. If a task could request it, anything
  // that could write JSON could run unbounded work.
  const root = mkdtempSync(join(tmpdir(), 'aios-handoff-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const r = parseTask(JSON.stringify({ ...TASK, autoApprove: true }))
  assert.ok(!r.error, 'it should parse...')
  const task = r.task as HandoffTask & { autoApprove?: boolean }
  assert.equal(task.autoApprove, undefined,
    'but autoApprove must not survive onto the parsed task')
})
