/**
 * Controls for the collaboration loop's NON-NETWORK logic.
 *
 * Everything here runs without calling OpenCode: state persistence, lock ownership, verdict
 * reading, and the no-infinite-loop rule. The live loop is exercised separately by
 * `run-orchestrator.ts`, which really does invoke the CLI.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { Orchestrator, normalizedFindings, type Task } from '../orchestrator.ts'
import { buildReviewRequest, readVerdict, OpenCodeReviewer } from '../reviewer.ts'

const DIR = mkdtempSync(join(tmpdir(), 'aios-orch-'))
process.on('exit', () => { try { rmSync(DIR, { recursive: true, force: true }) } catch { /* held */ } })

const SEED = { objective: 'o', architecture: 'a', rationale: 'r' }
function fresh(p: string, l: string) {
  return new Orchestrator(p, l, Orchestrator.emptyState('o', 'a', 'r'))
}
const TASK: Task = {
  id: 't1', objective: 'do the thing', constraints: ['do not break X'],
  verifyCommand: 'node -e "console.log(\'3 tests passed\'); process.exit(0)"', maxReviewRounds: 2, timeoutMs: 60_000,
}

/** A reviewer that answers from a script, so the LOOP can be tested without a network. */
function scripted(text: string, verdict = 'approve') {
  return {
    name: 'scripted', model: 'scripted-model', isIndependent: true,
    review: async () => ({
      verdict: verdict as never, text, model: 'scripted-model',
      independent: true, elapsedMs: 1,
    }),
  } as never
}

test('state persists and reloads, and a corrupt file is refused rather than reset', () => {
  const p = join(DIR, 's1.json')
  const { orch } = Orchestrator.loadOrCreate(p, join(DIR, 'l1'), SEED)
  orch.enqueue(TASK)
  assert.ok(existsSync(p), 'state must be written to disk')

  const { orch: again, resumed } = Orchestrator.loadOrCreate(p, join(DIR, 'l1'), SEED)
  assert.equal(resumed, true, 'a second load must report it resumed')
  assert.equal(again.snapshot().tasks.length, 1, 'the queued task must survive')

  writeFileSync(p, '{ not json', 'utf8')
  assert.throws(() => Orchestrator.loadOrCreate(p, join(DIR, 'l1'), SEED), /corrupt/,
    'a corrupt state file must be REFUSED, never silently discarded')
})

test('the lock refuses a second orchestrator', () => {
  const lp = join(DIR, 'l2')
  const a = new Orchestrator(join(DIR, 's2.json'), lp, Orchestrator.emptyState('o', 'a', 'r'))
  const first = a.acquireLock()
  assert.equal(first.acquired, true, 'the first owner takes the lock')
  const b = new Orchestrator(join(DIR, 's3.json'), lp, Orchestrator.emptyState('o', 'a', 'r'))
  const second = b.acquireLock()
  assert.equal(second.acquired, false, 'a second orchestrator must be refused')
  assert.ok(second.holder, 'the refusal must say who holds it')
})

test('a task completes only when the real verify command exits zero AND the reviewer approves', async () => {
  const orch = new Orchestrator(join(DIR, 's4.json'), join(DIR, 'l4'), Orchestrator.emptyState('o', 'a', 'r'))
  orch.enqueue(TASK)
  const { record } = await orch.runCycle(TASK, {
    model: 'm', reviewer: scripted('looks good\nVERDICT: approve'), cwd: DIR,
  })
  assert.equal(record.verificationPassed, true, 'the verify command really ran')
  assert.equal(record.status, 'done')
  assert.ok(record.verificationOutput.length > 0, 'the verification output must be kept verbatim')
})

test('a FAILING verify command cannot be talked into done by an approving reviewer', async () => {
  const orch = new Orchestrator(join(DIR, 's5.json'), join(DIR, 'l5'), Orchestrator.emptyState('o', 'a', 'r'))
  const bad: Task = { ...TASK, id: 't2', verifyCommand: 'node -e "process.exit(3)"' }
  orch.enqueue(bad)
  const { record } = await orch.runCycle(bad, {
    model: 'm', reviewer: scripted('fine\nVERDICT: approve'), cwd: DIR,
  })
  assert.equal(record.verificationPassed, false, 'exit 3 is a failure')
  assert.notEqual(record.status, 'done', 'an approval must NOT override failing evidence')
})

test('the loop STOPS when the same outcome repeats with no new information', async () => {
  const orch = new Orchestrator(join(DIR, 's6.json'), join(DIR, 'l6'), Orchestrator.emptyState('o', 'a', 'r'))
  orch.enqueue(TASK)
  await orch.runCycle(TASK, { model: 'm', reviewer: scripted('no\nVERDICT: request-changes', 'request-changes'), cwd: DIR })
  const second = await orch.runCycle(TASK, { model: 'm', reviewer: scripted('no\nVERDICT: request-changes', 'request-changes'), cwd: DIR })
  assert.equal(second.record.status, 'exhausted', 'repeating must exhaust, not loop forever')
  assert.match(second.record.note, /no new information/)
})

// ============================================================================================
// THE LOOP-WASTE FIX
// ============================================================================================

test('a reviewer repeating ITS OWN findings stops the loop, whatever the outcome label is', async () => {
  // THE CASE THE OLD GUARD MISSED.
  //
  // The guard used to count OUTCOMES, and `changes-requested` is not in the set that stops a loop, so
  // a reviewer could restate itself indefinitely - each round costing implement (246.6s) + review
  // (240.0s). That is where the ~1,015s went.
  //
  // The fingerprints here are textually identical; what differs between the two rounds is only
  // punctuation and spacing, which `normalizedFindings` deliberately collapses. A verdict the
  // reviewer cannot keep repeating stops buying cycles; `maxReviewRounds` is still the hard ceiling
  // underneath this.
  const findings = 'The function under test has no assertion covering the empty-input case.'
  const orch = new Orchestrator(join(DIR, 's-repeat.json'), join(DIR, 'l-repeat'),
    Orchestrator.emptyState('o', 'a', 'r'))
  const task: Task = { ...TASK, verifyCommand: 'node -e "process.exit(0)"', maxReviewRounds: 6 }
  orch.enqueue(task)

  await orch.runCycle(task, {
    model: 'm', reviewer: scripted(findings + '\nVERDICT: request-changes', 'request-changes'), cwd: DIR,
  })
  const second = await orch.runCycle(task, {
    model: 'm',
    // Same content, different punctuation and capitalisation - the cheap reword a reviewer does
    // when it is repeating itself. Under the old guard this cost another full cycle.
    reviewer: scripted('the function under test has NO assertion covering the empty input case.\nVERDICT: request-changes', 'request-changes'),
    cwd: DIR,
  })
  assert.equal(second.record.status, 'exhausted',
    'a reviewer restating its findings must not buy another cycle')
  assert.match(second.record.note, /no new information/)
})

test('GENUINELY NEW findings DO buy another round', async () => {
  // The control for the test above. Without this, "stop early" would be indistinguishable from
  // "stopped working" - a guard that ends every task after one review is not a fix, it is a cap.
  const orch = new Orchestrator(join(DIR, 's-new.json'), join(DIR, 'l-new'),
    Orchestrator.emptyState('o', 'a', 'r'))
  const task: Task = { ...TASK, verifyCommand: 'node -e "process.exit(0)"', maxReviewRounds: 4 }
  orch.enqueue(task)

  await orch.runCycle(task, {
    model: 'm', reviewer: scripted('Missing an assertion for null.\nVERDICT: request-changes', 'request-changes'), cwd: DIR,
  })
  const second = await orch.runCycle(task, {
    model: 'm', reviewer: scripted('Missing an assertion for negative numbers.\nVERDICT: request-changes', 'request-changes'), cwd: DIR,
  })
  assert.equal(second.record.status, 'pending',
    'a genuinely different finding must be allowed to drive another round')
})

test('normalizedFindings treats a reworded finding as the same finding', () => {
  const a = normalizedFindings('The Function has No Assertion covering the empty input case.')
  const b = normalizedFindings('the function has no assertion covering the empty-input case')
  assert.equal(a, b, 'case, punctuation and spacing must not make a finding look new')
  assert.notEqual(a, normalizedFindings('the timeout is far too long for the verify command'))
})

test('a state file written before findingsSeen existed is UPGRADED, not discarded', () => {
  // Restart recovery must not require deleting history to pick up a new field.
  const p = join(DIR, 's-legacy.json')
  const legacy = {
    ...Orchestrator.emptyState('o', 'a', 'r'),
    tasks: [{
      id: 't1', objective: 'o', status: 'pending', rounds: [],
      verificationOutput: '', verificationPassed: null,
      repeatedOutcome: 0, lastOutcome: '', startedAt: '2020-01-01T00:00:00.000Z',
      finishedAt: null, note: '',
    }],
  }
  writeFileSync(p, JSON.stringify(legacy), 'utf8')
  const { orch, resumed } = Orchestrator.loadOrCreate(p, join(DIR, 'l-legacy'), SEED)
  assert.equal(resumed, true)
  assert.deepEqual(orch.snapshot().tasks[0].findingsSeen, [],
    'the missing field must be added as empty, keeping the task')
})

test('a reviewer with no verdict is NOT an approval', () => {
  assert.equal(readVerdict('I looked at it and it seems fine.'), 'request-changes',
    'the absence of an explicit line must not read as consent')
  assert.equal(readVerdict('VERDICT: approve'), 'approve')
  assert.equal(readVerdict('VERDICT: request-changes'), 'request-changes')
})

test('the review request carries evidence, constraints and the verdict line', () => {
  const s = buildReviewRequest({
    objective: 'do the thing', implementationNotes: 'I changed it',
    evidence: 'EXIT CODE: 0\nOUTPUT: tests 3 pass 3', constraints: ['do not break X'],
  })
  assert.match(s, /EXIT CODE: 0/)
  assert.match(s, /do not break X/)
  assert.match(s, /claims, not facts/i, 'the implementer\'s notes must be labelled as claims')
  assert.match(s, /VERDICT: approve/)
})

test('an unconfigured hosted reviewer reports unavailable and does NOT invent a verdict', async () => {
  const { OpenAICompatibleReviewer } = await import('../reviewer.ts')
  const r = new OpenAICompatibleReviewer({ baseUrl: 'http://127.0.0.1:1', apiKey: undefined, model: 'x' })
  const res = await r.review({ objective: 'o', implementationNotes: '', evidence: '', constraints: [] }, DIR, 5000)
  assert.equal(res.verdict, 'unavailable')
  assert.match(res.failure ?? '', /NOT exercised/)
})

test('the reviewer declares whether it is independent', () => {
  const same = new OpenCodeReviewer({ model: 'a', isIndependent: false })
  assert.equal(same.isIndependent, false, 'a same-model review must declare it is not independent')
})

test('independence is DERIVED from the two model names, not asserted by the caller', () => {
  // The claim under test: `isIndependent` must be a fact about model identity, not something a caller
  // can declare by passing `true`.
  const different = OpenCodeReviewer.build({
    reviewerModel: 'opencode/nemotron-3.5-lightning-free',
    implementerModel: 'opencode/space-bunny-free',
  })
  assert.equal(different.isIndependent, true, 'two different models really are independent')

  const sameModel = OpenCodeReviewer.build({
    reviewerModel: 'opencode/space-bunny-free',
    implementerModel: 'opencode/space-bunny-free',
  })
  assert.equal(sameModel.isIndependent, false, 'the same model cannot review itself independently')
})

test('re-spelling a model id does not MANUFACTURE independence', () => {
  // `opencode/x` and `x` are one model. Without prefix-insensitive comparison a caller could claim an
  // independent review by writing the same model differently.
  const a = OpenCodeReviewer.build({ reviewerModel: 'space-bunny-free', implementerModel: 'opencode/space-bunny-free' })
  assert.equal(a.isIndependent, false, 'the provider prefix must not change model identity')
})

test('a reviewer constructed WITHOUT a claim records independent=false, not true', () => {
  // Unknown is not independent. Defaulting it to true would let a caller who said nothing at all be
  // recorded as an independent review.
  const unspecified = new OpenCodeReviewer({ model: 'some-model' })
  assert.equal(unspecified.isIndependent, false)
})

test('reconcile downgrades a task recorded done without passing evidence', async () => {
  const p = join(DIR, 's7.json')
  const seed = Orchestrator.emptyState('o', 'a', 'r')
  const rec = {
    id: 't1', objective: 'do the thing', status: 'done', rounds: [],
    verificationOutput: '', verificationPassed: false,
    repeatedOutcome: 0, lastOutcome: '', startedAt: '2020-01-01T00:00:00.000Z',
    finishedAt: '2020-01-01T00:01:00.000Z', note: '',
  }
  // Written DIRECTLY, because that is the situation being tested: a record on disk claiming success
  // that the evidence does not support. Mutating the live object would only prove the setter works.
  writeFileSync(p, JSON.stringify({ ...seed, tasks: [rec], cursor: 0 }), 'utf8')

  const { orch } = Orchestrator.loadOrCreate(p, join(DIR, 'l7'), SEED)
  const notes = await orch.reconcile(DIR)
  assert.equal(orch.snapshot().tasks[0]!.status, 'blocked', 'a stale success record must be downgraded')
  assert.ok(notes.some((n) => n.includes('DOWNGRADED')))
})
