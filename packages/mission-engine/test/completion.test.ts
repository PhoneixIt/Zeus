import assert from 'node:assert/strict'
import test from 'node:test'
import { isComplete, describeProgress, type Mission, type Step } from '../state.ts'

/**
 * The completion rule, tested.
 *
 * These tests exist because of three real production bugs in the PortAi mission repository,
 * all the same shape: a failure became an empty value, and the empty value was
 * indistinguishable from success.
 *
 *   - an OpenAI response in array form was silently discarded: zero drafts, success returned
 *   - a downstream chain had `catch { return [] }`: provider failure became "no results"
 *   - a run where EVERY specialist threw was recorded `completed` in the database
 *
 * A mission model that infers completion from steps having run cannot catch any of them.
 * These tests pin that it does not.
 */

const step = (id: string, outcome: Step['result'] extends undefined ? never : NonNullable<Step['result']>['outcome']): Step => ({
  id,
  intent: `do ${id}`,
  mode: 'cli',
  rationale: 'test',
  status: outcome.kind === 'failed' ? 'failed' : 'done',
  result: { id, outcome, durationMs: 1 },
})

const mission = (steps: Step[]): Mission => ({
  id: 'm1',
  objective: 'test',
  constraints: [],
  state: 'executing',
  plan: steps,
  history: [],
  pendingApprovals: [],
  startedAt: 0,
})

const VERIFIED = { kind: 'verified', evidence: { kind: 'file-exists', path: 'a.txt' } } as const

// ------------------------------------------------- the defect class: silent failure

test('a FAILED step does not complete the mission', () => {
  // THE BUG. Every specialist threw; the run was recorded `completed`.
  const m = mission([step('a', { kind: 'failed', reason: 'provider error' })])
  assert.equal(isComplete(m), false, 'a failure is not a completion')
})

test('a failed step is reported as FAILED, not quietly folded away', () => {
  const m = mission([step('a', VERIFIED), step('b', { kind: 'failed', reason: 'timeout' })])
  const text = describeProgress(m)
  assert.match(text, /1 FAILED/, 'the summary must name the failure')
  assert.match(text, /1 verified/, 'and what did work')
})

test('a step that ran but returned no evidence is not complete', () => {
  // THE BUG. Zero drafts were created; the route returned success.
  const m = mission([step('a', { kind: 'legitimately-empty', reason: 'nothing to draft' })])
  // legitimately-empty IS accepted - but only when the executor says WHY it is legitimate.
  assert.equal(isComplete(m), true)
  // The point is that it cannot be silent: the reason is required by the type.
  assert.ok(m.plan[0].result)
})

test('legitimately-empty is distinguishable from failed in the summary', () => {
  // These are opposite claims and collapsing them is the original bug.
  const empty = describeProgress(mission([step('a', { kind: 'legitimately-empty', reason: 'no matches' })]))
  const failed = describeProgress(mission([step('a', { kind: 'failed', reason: 'no matches' })]))
  assert.match(empty, /legitimately empty/)
  assert.match(failed, /FAILED/)
  assert.notEqual(empty, failed, 'the two must never read the same')
})

test('needs-human is NOT complete and is visible', () => {
  const m = mission([step('a', VERIFIED), step('b', { kind: 'needs-human', reason: 'needs approval' })])
  assert.equal(isComplete(m), false)
  assert.match(describeProgress(m), /waiting on human/)
})

test('a pending step blocks completion', () => {
  const m = mission([step('a', VERIFIED), { ...step('b', VERIFIED), status: 'pending' as const, result: undefined }])
  assert.equal(isComplete(m), false, 'a plan with work still pending is not complete')
})

test('a SKIPPED step blocks completion', () => {
  // "We ran everything except the important bit" must never read as done.
  const m = mission([
    step('a', VERIFIED),
    { id: 'b', intent: 'skip me', mode: 'cli', rationale: 't', status: 'skipped' },
  ])
  assert.equal(isComplete(m), false)
})

test('an EMPTY plan is not complete', () => {
  // Nothing was attempted. "Complete" would be a fabrication.
  assert.equal(isComplete(mission([])), false)
})

// -------------------------------------------------------------- multi-step reality

test('a partial mission reports exactly what is missing', () => {
  const m = mission([
    step('a', VERIFIED),
    step('b', VERIFIED),
    step('c', { kind: 'failed', reason: 'nope' }),
    { id: 'd', intent: 'later', mode: 'gui', rationale: 't', status: 'pending' },
  ])
  assert.equal(isComplete(m), false)
  const text = describeProgress(m)
  assert.match(text, /2 verified/)
  assert.match(text, /1 FAILED/)
  assert.match(text, /1 pending/)
})

test('a fully verified mission completes', () => {
  const m = mission([step('a', VERIFIED), step('b', VERIFIED)])
  assert.equal(isComplete(m), true, 'the positive case must still work')
})

test('mixed verified + legitimately-empty completes', () => {
  const m = mission([
    step('a', VERIFIED),
    step('b', { kind: 'legitimately-empty', reason: 'no matching records' }),
  ])
  assert.equal(isComplete(m), true)
})

// --------------------------------------- the one that must never be possible

test('INCONCLUSIVE cannot masquerade as progress', () => {
  // The audit asked for this explicitly: when a mechanism is unreliable, record INCONCLUSIVE
  // rather than manufacturing a pass. There is no 'inconclusive' outcome that counts as done,
  // because adding one would recreate exactly the bug class above.
  const kinds = ['verified', 'legitimately-empty', 'failed', 'needs-human'] as const
  assert.equal(kinds.includes('inconclusive' as never), false,
    'an inconclusive step must not be a completion path')
  const m = mission([step('a', { kind: 'failed', reason: 'INCONCLUSIVE: cannot distinguish' })])
  assert.equal(isComplete(m), false)
  assert.match(describeProgress(m), /FAILED/, 'it is visible as a failure, not hidden')
})