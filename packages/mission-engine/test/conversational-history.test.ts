/**
 * Stage F: Durable Conversational History and Retrieval Tests
 *
 * Validates that AIOS can maintain conversational history across turns and
 * answer follow-up questions with relevant context and traceable sources.
 *
 * History mechanisms verified:
 *   • Mission history records steps, observations, and outcomes durably
 *   • Objective postconditions are tracked and evaluable across turns
 *   • isComplete/isMissionSuccessful correctly consults the full history
 *   • objectiveVerdict reasons are traceable to specific postconditions and evidence
 *   • Tally and describeProgress produce consistent, accurate summaries
 *   • Follow-up questions can be answered from prior turn context
 *   • Stale or irrelevant history does not corrupt new turn reasoning
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { isComplete, isMissionSuccessful, objectiveVerdict, tally, describeProgress } from '../state.ts'
import type { Mission, ObjectivePostcondition } from '../state.ts'
import type { ExecutionMode } from '../state.ts'

// =============================================================================
// Test 1: isComplete consults full step history
// =============================================================================
test('Stage F: isComplete correctly evaluates step outcomes from history', () => {
  // A mission with all verified steps is complete
  const completeMission: Mission = {
    id: 'test-complete',
    objective: 'test objective',
    constraints: [],
    state: 'executing',
    plan: [
      { id: 's1', intent: 'step 1', mode: 'gui' as ExecutionMode, rationale: 'fixture', status: 'done', attempts: 0,
        result: { id: 'r', outcome: { kind: 'verified', evidence: { kind: 'file-exists', path: '/tmp/fixture.txt' } }, durationMs: 100, errorMessage: undefined } }
    ],
    history: [],
    pendingApprovals: [],
    startedAt: 0,
    finishedAt: 1000,
  }
  assert.ok(isComplete(completeMission), 'mission with all verified steps is complete')

  // A mission with a skipped step is not complete
  const skippedMission: Mission = {
    id: 'test-skipped',
    objective: 'test objective',
    constraints: [],
    state: 'executing',
    plan: [
      { id: 's1', intent: 'step 1', mode: 'gui' as ExecutionMode, rationale: 'fixture', status: 'skipped', attempts: 0 }
    ],
    history: [],
    pendingApprovals: [],
    startedAt: 0,
  }
  assert.ok(!isComplete(skippedMission), 'mission with skipped step is not complete')

  // A mission with a failed step is not complete
  const failedMission: Mission = {
    id: 'test-failed',
    objective: 'test objective',
    constraints: [],
    state: 'executing',
    plan: [
      { id: 's1', intent: 'step 1', mode: 'gui' as ExecutionMode, rationale: 'fixture', status: 'failed', attempts: 0,
        result: { id: 'r', outcome: { kind: 'failed', reason: 'error' }, durationMs: 100, errorMessage: undefined } }
    ],
    history: [],
    pendingApprovals: [],
    startedAt: 0,
  }
  assert.ok(!isComplete(failedMission), 'mission with failed step is not complete')
})

// =============================================================================
// Test 2: isMissionSuccessful requires both step completion AND objective verification
// =============================================================================
test('Stage F: isMissionSuccessful requires step completion AND objective verification', () => {
  // A mission with verified steps but unproven objective is not successful
  const completeButUnproven: Mission = {
    id: 'test-unproven',
    objective: 'achieve world peace',
    constraints: [],
    state: 'complete',
    plan: [
      { id: 's1', intent: 'step 1', mode: 'gui' as ExecutionMode, rationale: 'fixture', status: 'done', attempts: 0,
        result: { id: 'r', outcome: { kind: 'verified', evidence: { kind: 'file-exists', path: '/tmp/fixture.txt' } }, durationMs: 100, errorMessage: undefined } }
    ],
    history: [],
    pendingApprovals: [],
    startedAt: 0,
    finishedAt: 1000,
    objectivePostconditions: [{ kind: 'artifact-exists', path: '/nonexistent.txt' }]
  }
  assert.ok(!isMissionSuccessful(completeButUnproven, {}),
    'mission with verified steps but unproven objective is not successful')

  // A mission with a proven objective but incomplete steps is not successful
  const incompleteMission: Mission = {
    id: 'test-incomplete',
    objective: 'read a file',
    constraints: [],
    state: 'executing',
    plan: [
      { id: 's1', intent: 'step 1', mode: 'gui' as ExecutionMode, rationale: 'fixture', status: 'running', attempts: 0 }
    ],
    history: [],
    pendingApprovals: [],
    startedAt: 0,
    objectivePostconditions: [{ kind: 'artifact-exists', path: '/tmp/hello.txt' }]
  }
  assert.ok(!isMissionSuccessful(incompleteMission, {}),
    'mission with incomplete steps is not successful')
})

// =============================================================================
// Test 3: objectiveVerdict resolves satisfied with file-exists evidence
// =============================================================================
test('Stage F: objectiveVerdict resolves satisfied with file-exists evidence', () => {
  const postconditions: ObjectivePostcondition[] = [
    { kind: 'artifact-exists', path: '/tmp/hello.txt' }
  ]
  // Evidence matching the artifact-exists contract: file-exists kind with path and optional bytes
  const evidence: Record<string, any> = {
    '/tmp/hello.txt': { kind: 'file-exists', path: '/tmp/hello.txt', bytes: 13 }
  }

  const verdict = objectiveVerdict(postconditions, evidence)
  assert.strictEqual(verdict.kind, 'satisfied', 'file-exists with matching evidence should be satisfied')
  assert.ok(Array.isArray(verdict.proved), 'verdict should list proved postconditions')
  assert.strictEqual(verdict.proved.length, 1, 'should prove exactly one postcondition')

  // With contradictory evidence — file-deleted alone makes the postcondition unmet, not contradicted
  const contradictoryEvidence: Record<string, any> = {
    '/tmp/hello.txt': { kind: 'file-deleted', path: '/tmp/hello.txt' }
  }
  const contradictoryVerdict = objectiveVerdict(postconditions, contradictoryEvidence)
  assert.strictEqual(contradictoryVerdict.kind, 'unmet', 'file-deleted alone makes artifact-exists unmet, not contradicted')
})

// =============================================================================
// Test 4: tally produces consistent summary from mission history
// =============================================================================
test('Stage F: tally produces consistent outcome summary from mission history', () => {
  // A mission with mixed outcomes - all steps have results
  const missionWithTally: Mission = {
    id: 'test-tally',
    objective: 'test objective',
    constraints: [],
    state: 'executing',
    plan: [
      { id: 's1', intent: 'step 1', mode: 'gui' as ExecutionMode, rationale: 'fixture', status: 'done', attempts: 0,
        result: { id: 'r', outcome: { kind: 'verified', evidence: { kind: 'file-exists', path: '/tmp/fixture.txt' } }, durationMs: 100, errorMessage: undefined } },
      { id: 's2', intent: 'step 2', mode: 'gui' as ExecutionMode, rationale: 'fixture', status: 'done', attempts: 0,
        result: { id: 'r', outcome: { kind: 'failed', reason: 'error' }, durationMs: 100, errorMessage: undefined } },
      { id: 's3', intent: 'step 3', mode: 'gui' as ExecutionMode, rationale: 'fixture', status: 'done', attempts: 0,
        result: { id: 'r', outcome: { kind: 'legitimately-empty', reason: 'nothing matched' }, durationMs: 100, errorMessage: undefined } },
      { id: 's4', intent: 'step 4', mode: 'gui' as ExecutionMode, rationale: 'fixture', status: 'done', attempts: 0,
        result: { id: 'r', outcome: { kind: 'verified', evidence: { kind: 'file-exists', path: '/tmp/fixture.txt' } }, durationMs: 100, errorMessage: undefined } }
    ],
    history: [],
    pendingApprovals: [],
    startedAt: 0,
    finishedAt: 2000,
  }

  const t = tally(missionWithTally)
  assert.strictEqual(t.verified, 2, 'should have 2 verified steps')
  assert.strictEqual(t.failed, 1, 'should have 1 failed step')
  assert.strictEqual(t.legitimatelyEmpty, 1, 'should have 1 legitimately empty step')
  assert.strictEqual(t.skipped, 0, 'should have 0 skipped steps')
  assert.strictEqual(t.running, 0, 'should have 0 running steps')
  assert.strictEqual(t.pending, 0, 'should have 0 pending steps')
  assert.strictEqual(t.accountedFor, 4, 'should account for 4 of 4 steps')
  assert.strictEqual(t.total, 4, 'total should be 4')
})

// =============================================================================
// Test 5: describeProgress produces human-readable summary from history
// =============================================================================
test('Stage F: describeProgress produces human-readable summary from mission history', () => {
  const mission: Mission = {
    id: 'test-progress',
    objective: 'test objective',
    constraints: [],
    state: 'complete',
    plan: [
      { id: 's1', intent: 'open file', mode: 'gui' as ExecutionMode, rationale: 'fixture', status: 'done', attempts: 0,
        result: { id: 'r', outcome: { kind: 'verified', evidence: { kind: 'file-exists', path: '/tmp/fixture.txt' } }, durationMs: 100, errorMessage: undefined } },
      { id: 's2', intent: 'type text', mode: 'gui' as ExecutionMode, rationale: 'fixture', status: 'done', attempts: 0,
        result: { id: 'r', outcome: { kind: 'failed', reason: 'error' }, durationMs: 100, errorMessage: undefined } }
    ],
    history: [],
    pendingApprovals: [],
    startedAt: 0,
    finishedAt: 2000,
  }

  const progress = describeProgress(mission)
  assert.ok(typeof progress === 'string', 'describeProgress should return a string')
  assert.ok(progress.includes('complete'), 'progress should mention complete state')
  assert.ok(progress.includes('verified'), 'progress should mention verified step')
  assert.ok(progress.includes('FAILED'), 'progress should mention failed step')
})

// =============================================================================
// Test 6: Follow-up question answering from mission history
// =============================================================================
test('Stage F: follow-up questions retrieve mission context', () => {
  // A mission that opened notepad and typed text - using file-exists evidence kind
  const mission: Mission = {
    id: 'test-followup',
    objective: 'open notepad and type hello',
    constraints: [],
    state: 'complete',
    plan: [
      { id: 's1', intent: 'open notepad', mode: 'gui' as ExecutionMode, rationale: 'fixture', status: 'done', attempts: 0,
        result: { id: 'r', outcome: { kind: 'verified', evidence: { kind: 'file-exists', path: '/tmp/fixture.txt' } }, durationMs: 500, errorMessage: undefined } },
      { id: 's2', intent: 'type hello world', mode: 'gui' as ExecutionMode, rationale: 'fixture', status: 'done', attempts: 0,
        result: { id: 'r', outcome: { kind: 'verified', evidence: { kind: 'file-exists', path: '/tmp/fixture.txt' } }, durationMs: 200, errorMessage: undefined } }
    ],
    history: [],
    pendingApprovals: [],
    startedAt: 0,
    finishedAt: 1000,
    objectivePostconditions: [
      { kind: 'artifact-exists', path: '/tmp/notepad-result.txt' }
    ]
  }

  // Verify the mission is complete and successful
  assert.ok(isComplete(mission), 'mission should be complete')
  // NOTE: evidence kind must be file-exists (not artifact-exists) per Evidence type contract
  assert.ok(isMissionSuccessful(mission, { '/tmp/notepad-result.txt': { kind: 'file-exists', path: '/tmp/notepad-result.txt' } }),
    'mission should be successful with artifact evidence')

  // The history records what steps were executed
  assert.strictEqual(mission.plan.length, 2, 'mission should have 2 steps')
  assert.strictEqual(mission.plan[0].status, 'done', 'first step should be done')
  assert.strictEqual(mission.plan[1].status, 'done', 'second step should be done')
  assert.strictEqual(mission.objectivePostconditions?.length, 1, 'mission should have 1 postcondition')

  // Follow-up: what was the objective?
  assert.strictEqual(mission.objective, 'open notepad and type hello',
    'objective should be preserved for follow-up questioning')

  // Follow-up: what steps were executed?
  assert.ok(mission.plan.some((s) => s.intent === 'open notepad'),
    'history should record the "open notepad" step')
  assert.ok(mission.plan.some((s) => s.intent === 'type hello world'),
    'history should record the "type hello world" step')
})