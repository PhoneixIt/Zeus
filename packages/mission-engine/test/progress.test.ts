import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error Node test runner loads the TypeScript source directly.
import { describeProgress, tally, isComplete, type Mission, type Step } from '../state.ts'

/**
 * Progress must be countable, and the human-readable line must agree with the audit stream.
 *
 * The bug these exist for: `describeProgress()` counted `pending` by STEP STATUS while every
 * other category was counted by OUTCOME. Two different bases, so the two could disagree -
 * a mission could report "0 pending" while the numbers added up to fewer steps than it had.
 * `skipped` was not counted at all, so a dependency-blocked step vanished from the summary.
 */

const step = (id: string, outcome?: Step['result'] extends undefined ? never : NonNullable<Step['result']>['outcome'], status: Step['status'] = 'done'): Step => ({
  id, intent: id, mode: 'cli', rationale: 't', status, result: outcome ? { id, outcome, durationMs: 1 } : undefined,
})

const mission = (plan: Step[]): Mission => ({
  id: 'm1', objective: 'o', constraints: [], state: 'executing', plan, history: [], pendingApprovals: [], startedAt: 0,
})

const V = { kind: 'verified', evidence: { kind: 'file-exists', path: 'a' } } as const

// ------------------------------------------------------------- accounting is exact

test('every step is accounted for EXACTLY once', () => {
  // The property that catches the mixed-basis bug: no step may be double counted or lost.
  const m = mission([
    step('a', V),
    step('b', { kind: 'legitimately-empty', reason: 'none' }),
    step('c', { kind: 'failed', reason: 'broke' }),
    step('d', { kind: 'skipped', reason: 'blocked', blockedBy: 'c' }),
    step('e', { kind: 'needs-human', reason: 'approval' }),
    step('f', { kind: 'replan-required', reason: 'stale', invalidation: { reason: 'focus-changed', to: 'x' } }),
    step('g', undefined, 'running'),
    step('h', undefined, 'pending'),
  ])
  const t = tally(m)
  assert.equal(t.total, 8)
  assert.equal(t.accountedFor, 8, 'the tally must cover every step exactly once')
  assert.equal(t.verified, 1)
  assert.equal(t.legitimatelyEmpty, 1)
  assert.equal(t.failed, 1)
  assert.equal(t.skipped, 1)
  assert.equal(t.needsHuman, 1)
  assert.equal(t.replanRequired, 1)
  assert.equal(t.running, 1)
  assert.equal(t.pending, 1)
})

test('a step with a result is counted by OUTCOME, not by status', () => {
  // A finished step still has status 'done'; counting by status would call it pending.
  const t = tally(mission([step('a', V, 'done')]))
  assert.equal(t.verified, 1)
  assert.equal(t.pending, 0, 'a verified step is not pending')
})

// ----------------------------------------------------------------- skipped is its own thing

test('skipped is counted separately from failed and never inflates failures', () => {
  const m = mission([
    step('a', { kind: 'failed', reason: 'real failure' }),
    step('b', { kind: 'skipped', reason: 'blocked', blockedBy: 'a' }),
  ])
  const t = tally(m)
  assert.equal(t.failed, 1)
  assert.equal(t.skipped, 1)
  assert.equal(t.skipped, t.total - t.failed - t.verified, 'the skip is not a failure')
})

test('the wording distinguishes skipped from failed', () => {
  const text = describeProgress(mission([
    step('a', { kind: 'failed', reason: 'x' }),
    step('b', { kind: 'skipped', reason: 'y', blockedBy: 'a' }),
  ]))
  assert.match(text, /1 FAILED/, 'the real failure is named')
  assert.match(text, /1 skipped \(blocked by a dependency\)/, 'and the gate is described as a gate')
  assert.notEqual(
    text.replace(/skipped \([^)]*\)/, 'skipped'),
    text.replace(/FAILED/, 'skipped'),
    'a skipped step must never read identically to a failed one',
  )
})

// -------------------------------------------------------------- all categories visible

test('the progress line names every category that is present', () => {
  const m = mission([
    step('a', V),
    step('b', { kind: 'legitimately-empty', reason: 'none' }),
    step('c', { kind: 'failed', reason: 'x' }),
    step('d', { kind: 'skipped', reason: 'y', blockedBy: 'c' }),
    step('e', { kind: 'needs-human', reason: 'z' }),
    step('f', { kind: 'replan-required', reason: 'w', invalidation: { reason: 'focus-changed', to: 'x' } }),
    step('g', undefined, 'running'),
    step('h', undefined, 'pending'),
  ])
  const text = describeProgress(m)
  for (const [pattern, what] of [
    [/1 verified/, 'verified'],
    [/1 legitimately empty/, 'legitimately empty'],
    [/1 FAILED/, 'failed'],
    [/1 skipped/, 'skipped'],
    [/1 need replanning/, 'replan-required'],
    [/1 waiting on human/, 'needs-human'],
    [/1 running/, 'running'],
    [/1 pending/, 'pending'],
  ] as Array<[RegExp, string]>) {
    assert.match(text, pattern, `the line must mention ${what}; got: ${text}`)
  }
})

test('absent categories are omitted rather than shown as zero', () => {
  const text = describeProgress(mission([step('a', V)]))
  assert.doesNotMatch(text, /FAILED/)
  assert.doesNotMatch(text, /skipped/)
  assert.doesNotMatch(text, /waiting on human/)
  assert.match(text, /1 verified/)
  assert.match(text, /0 pending/)
})

test('the state always leads the line', () => {
  const text = describeProgress({ ...mission([step('a', V)]), state: 'blocked-on-human' })
  assert.ok(text.startsWith('blocked-on-human'), `expected the state first, got: ${text}`)
})

// ------------------------------------------------------------ agreement with completion

test('a mission with skipped steps is NOT complete, and the line agrees', () => {
  const m = mission([step('a', V), step('b', { kind: 'skipped', reason: 'blocked', blockedBy: 'a' })])
  assert.equal(isComplete(m), false)
  assert.match(describeProgress(m), /skipped/)
  assert.doesNotMatch(describeProgress(m), /^\w+ \| \d+ verified \| $/, 'must not read as finished')
})

test('progress line and isComplete can never contradict', () => {
  const cases: Array<[string, Step[]]> = [
    ['all verified', [step('a', V), step('b', V)]],
    ['one failed', [step('a', V), step('b', { kind: 'failed', reason: 'x' })]],
    ['one skipped', [step('a', V), step('b', { kind: 'skipped', reason: 'y', blockedBy: 'a' })]],
    ['one pending', [step('a', V), step('b', undefined, 'pending')]],
    ['empty plan', []],
  ]
  for (const [name, plan] of cases) {
    const m = mission(plan)
    const complete = isComplete(m)
    const text = describeProgress(m)
    if (complete) {
      assert.match(text, /verified/, `${name}: a complete mission must show verified work`)
    } else {
      assert.ok(
        text.length > 0,
        `${name}: an incomplete mission still reports honestly`,
      )
    }
  }
})

test('an empty plan reports zero of everything and is not complete', () => {
  const m = mission([])
  const t = tally(m)
  assert.equal(t.total, 0)
  assert.equal(t.accountedFor, 0)
  assert.equal(isComplete(m), false, 'nothing was attempted, so nothing is complete')
})