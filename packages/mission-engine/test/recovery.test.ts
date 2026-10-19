/**
 * M29 CONTROLS - the executor's recovery decisions.
 * =============================================================================
 *
 * Recovery is the first time this executor can CHANGE THE WORLD in response to a failure, so the
 * tests are weighted toward what it must NOT do.
 *
 * The eligibility rules are pure functions, so every one of them is testable without an executor, a
 * browser, or a filesystem - and they are tested directly, because an eligibility rule that is only
 * exercised through a whole mission is a rule whose refusal reasons nobody has read.
 *
 * The recovery BUDGET is likewise a pure object, and its whole value is that it cannot be exceeded.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  isRecoverableFailure, RecoveryBudget, UNRECOVERABLE_OUTCOMES, type RecoveryPolicy,
} from '../recovery.ts'
import { rollbackRecoveryPolicy } from '../live/rollback-recovery.ts'
import { BACKUP_SUFFIX } from '../live/edit-tools.ts'
import type { Step, StepOutcome } from '../state.ts'

const ROOT = mkdtempSync(join(tmpdir(), 'aios-m29-'))
process.on('exit', () => { try { rmSync(ROOT, { recursive: true, force: true }) } catch { /* held */ } })

const failed = (reason: string): StepOutcome => ({ kind: 'failed', reason })
const step = (tool: string, args: Record<string, unknown> = {}): Step =>
  ({ id: 's', tool, args, mode: 'filesystem', capability: 'filesystem.edit' } as unknown as Step)

// ============================================================================================
// ELIGIBILITY
// ============================================================================================

test('an ordinary execution fault IS eligible for recovery', () => {
  const r = isRecoverableFailure(failed('tool reported data but verification rejected it: the file moved'), 'x')
  assert.ok(r.permitted, 'a fault in executing in-scope work is exactly what recovery is for')
})

test('CONTROL: an authorisation refusal is NOT recovered automatically', () => {
  // The machine's own gate said no. Retrying automatically is the machine arguing with itself.
  const outcome: StepOutcome = { kind: 'needs-human', reason: 'awaiting authorisation' }
  const r = isRecoverableFailure(outcome, 'awaiting human authorisation for delete on x')
  assert.equal(r.permitted, false)
  assert.match(r.reason, /needs a person/, r.reason)
})

test('CONTROL: a replan-required outcome is NOT recovered automatically', () => {
  // The plan is wrong, not the execution. Recovery would be treating a planning decision as a fault.
  const outcome: StepOutcome = {
    kind: 'replan-required',
    reason: 'the world moved',
    invalidation: { reason: 'environment-changed', detail: 'the file moved' },
  }
  const r = isRecoverableFailure(outcome, 'the plan assumed a path that is gone')
  assert.equal(r.permitted, false, 'a stale plan needs a replan, not a rollback')
})

test('CONTROL: outcome-unknown is NOT recovered automatically', () => {
  // The machine may be in a state nobody can describe. Restoring on top of that could destroy the
  // only record that exists.
  const outcome: StepOutcome = {
    kind: 'outcome-unknown',
    reason: 'the result could not be recorded',
    attempt: 1,
    attempted: { tool: 'edit-file', intent: 'x', args: {} },
    persistenceError: 'disk full',
  }
  const r = isRecoverableFailure(outcome, 'the result could not be recorded')
  assert.equal(r.permitted, false)
  assert.match(r.reason, /unknown/, r.reason)
})

test('CONTROL: a POLICY denial is NOT recovered from', () => {
  // Refusals that name policy in any of its shapes. Recovering would be looking for a way around it.
  for (const reason of [
    'edit refused by policy: outside the workspace root',
    'blocked: navigation refused by policy',
    'this scheme is not permitted here',
    'refusing to overwrite the target',
    'file: destinations are DISABLED',
  ]) {
    const r = isRecoverableFailure(failed(reason), reason)
    assert.equal(r.permitted, false, `"${reason}" must not be recovered from`)
    assert.match(r.reason, /POLICY refusal/, r.reason)
  }
})

test('CONTROL: a failure with NO stated cause is not eligible', () => {
  const r = isRecoverableFailure(failed('   '), '   ')
  assert.equal(r.permitted, false, 'a recovery decision with no cause is not auditable')
  assert.match(r.reason, /no stated cause/, r.reason)
})

test('every declared unrecoverable outcome is genuinely a StepOutcome kind', () => {
  // Guards against the set drifting when the union changes - a stale member would be a silent no-op.
  for (const k of UNRECOVERABLE_OUTCOMES) {
    assert.ok(['needs-human', 'replan-required', 'outcome-unknown'].includes(k), `${k} is not a real kind`)
  }
})

// ============================================================================================
// THE BUDGET
// ============================================================================================

test('CONTROL: the budget cannot be exceeded', () => {
  const b = new RecoveryBudget(2)
  assert.equal(b.remaining, 2)
  assert.ok(b.available())
  assert.equal(b.spend(), true)
  assert.equal(b.spend(), true)
  assert.equal(b.available(), false, 'a third recovery must not be available')
  assert.equal(b.spend(), false, 'and spending past the limit must REFUSE, not increment')
  assert.equal(b.spent, 2, 'a refused spend must not count')
})

test('a budget of zero permits nothing', () => {
  const b = new RecoveryBudget(0)
  assert.equal(b.available(), false)
  assert.equal(b.spend(), false)
})

test('CONTROL: a nonsense budget is refused at construction', () => {
  // A budget of NaN would compare false against everything and silently allow unlimited recovery.
  for (const bad of [-1, 1.5, NaN, Infinity]) {
    assert.throws(() => new RecoveryBudget(bad as number), /non-negative integer|recovery budget/,
      `${String(bad)} must be refused`)
  }
})

// ============================================================================================
// THE POLICY: WHAT IT WILL AND WILL NOT PLAN
// ============================================================================================

const withBackup = (): { p: string; policy: RecoveryPolicy; recovered: Set<string> } => {
  const p = join(ROOT, `f${Math.floor(Math.random() * 1e9)}.js`)
  writeFileSync(p, "'a'", 'utf8')
  writeFileSync(p + BACKUP_SUFFIX, "'a'", 'utf8')
  const recovered = new Set<string>()
  return { p, policy: rollbackRecoveryPolicy({ workspaceRoot: ROOT, maxRecoveries: 1, recovered }), recovered }
}

test('a failed EDIT with a backup is recoverable, and the step declares its own effect', () => {
  const { p, policy } = withBackup()
  const plan = policy.plan({ missionId: 'm', step: step('edit-file', { path: p }), reason: 'x', outcome: failed('verification rejected it') })
  assert.ok('steps' in plan, `an edit with a backup must be recoverable: ${('reason' in plan) ? plan.reason : ''}`)
  const s = plan.steps[0]!
  assert.equal(s.tool, 'rollback-file')
  assert.equal(s.capability, 'filesystem.rollback')
  assert.ok(s.effect, 'a rollback DECLARES its effect, so it needs its own approval')
  assert.equal(s.effect!.kind, 'delete')
})

test('the rollback step carries NO digest - a plan-time guess would defeat the stale guard', () => {
  const { p, policy } = withBackup()
  const plan = policy.plan({ missionId: 'm', step: step('edit-file', { path: p }), reason: 'x', outcome: failed('y') })
  assert.ok('steps' in plan)
  assert.equal(plan.steps[0]!.args?.expectCurrentDigest, undefined,
    'the executor cannot see the current content at plan time; the VERIFIER decides whether a restore is honest')
})

test('CONTROL: a failed edit with NO backup is NOT recoverable', () => {
  const p = join(ROOT, `nb${Math.floor(Math.random() * 1e9)}.js`)
  writeFileSync(p, 'x', 'utf8')
  const policy = rollbackRecoveryPolicy({ workspaceRoot: ROOT, maxRecoveries: 1 })
  const plan = policy.plan({ missionId: 'm', step: step('edit-file', { path: p }), reason: 'x', outcome: failed('y') })
  assert.equal('permitted' in plan && plan.permitted, false, 'nothing to roll back to is not recovery')
  assert.match(('reason' in plan ? plan.reason : ''), /no backup/, 'and the refusal must say so')
})

test('CONTROL: an OUT-OF-SCOPE edit is not recovered, and the policy refuses to plan it', () => {
  const outside = join(ROOT, '..', 'elsewhere.js')
  const policy = rollbackRecoveryPolicy({ workspaceRoot: ROOT, maxRecoveries: 1 })
  const plan = policy.plan({ missionId: 'm', step: step('edit-file', { path: outside }), reason: 'x', outcome: failed('y') })
  assert.equal('permitted' in plan && plan.permitted, false, 'recovery must not reach outside the workspace')
  assert.match(('reason' in plan ? plan.reason : ''), /out of scope|outside the workspace/, 'reason must be stated')
})

test('CONTROL: a non-edit step is NOT offered a rollback', () => {
  const { p, policy } = withBackup()
  for (const tool of ['run-process', 'navigate-browser', 'write-file-summary', undefined]) {
    const plan = policy.plan({ missionId: 'm', step: step(tool ?? '', { path: p }), reason: 'x', outcome: failed('y') })
    assert.equal('permitted' in plan && plan.permitted, false, `${tool ?? 'no tool'} must not be rolled back`)
  }
})

test('CONTROL: the same path is not recovered twice - that is what a loop looks like', () => {
  const { p, policy, recovered } = withBackup()
  const req = { missionId: 'm', step: step('edit-file', { path: p }), reason: 'x', outcome: failed('y') }
  assert.ok('steps' in policy.plan(req), 'the first recovery is permitted')
  const second = policy.plan(req)
  assert.equal('permitted' in second && second.permitted, false,
    'a repeated recovery for the same path must be refused, whatever the budget says')
  assert.match(('reason' in second ? second.reason : ''), /already been attempted/, 'reason must be stated')
  assert.ok(recovered.has(p))
})

test('the policy declares the bound it was given', () => {
  const policy = rollbackRecoveryPolicy({ workspaceRoot: ROOT, maxRecoveries: 3 })
  assert.equal(policy.maxRecoveries, 3, 'the executor reads this, so it must match the budget')
})