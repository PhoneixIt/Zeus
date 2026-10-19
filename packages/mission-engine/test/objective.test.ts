import assert from 'node:assert/strict'
import test from 'node:test'
import {
  objectiveVerdict,
  isMissionSuccessful,
  verdictPermitsSuccess,
  isComplete,
  type Mission,
  type Step,
  type Evidence,
  type ObjectivePostcondition,
} from '../state.ts'

/**
 * THE OBJECTIVE RULE, tested.
 *
 * `completion.test.ts` pins that a step that ran is a step that ran. These tests pin the separate and
 * later claim: that running every step is not the same as achieving what the user asked for.
 *
 * The defect this file exists for is empirical, not hypothetical. A mission whose objective was
 * "summarise all 10 files in the folder into report.md", given a plan of ONE step, reported
 * `isComplete(): true` and `record.complete: true` while achieving 1 of 10. Every step verified.
 * Objective not achieved. Nothing in the model had a way to say so, because no model existed for
 * the question "was the user's goal achieved" as distinct from "did the plan run".
 *
 * Every negative case below is paired with the mutation that would disable it. A test whose failure
 * mode cannot be demonstrated is decoration.
 */

const step = (id: string, ev: Evidence): Step => ({
  id,
  intent: `do ${id}`,
  mode: 'filesystem',
  rationale: 'test',
  status: 'done',
  result: { id, durationMs: 1, outcome: { kind: 'verified', evidence: ev } },
})

const mission = (steps: Step[], pc?: readonly ObjectivePostcondition[]): Mission => ({
  id: 'm1',
  objective: 'summarise all 10 files in the folder into report.md',
  constraints: [],
  state: 'executing',
  plan: steps,
  history: [],
  pendingApprovals: [],
  startedAt: 0,
  ...(pc ? { objectivePostconditions: pc } : {}),
})

const FULL = 'Folder report\n- a.ts\n- b.ts\n- c.ts\n- d.ts\n- e.ts\n'
const hashOf = (s: string) => `sha-of-${s.length}-${s.charCodeAt(0)}` // stand-in; equality is all the rule uses

const fullEvidence = (path = 'report.md'): Evidence => ({
  kind: 'file-read-back', path, bytes: FULL.length, heading: 'Folder report', sha256: hashOf(FULL),
})
// A report that covers 1 of the 5 files. Every step still verified.
const partialEvidence = (path = 'report.md'): Evidence => ({
  kind: 'file-read-back', path, bytes: 18, heading: 'Folder report', sha256: hashOf('Folder report\n- a.ts\n'),
})

// ============================================================ 1. all steps verified, objective UNMET

test('ALL STEPS VERIFIED BUT OBJECTIVE UNMET: the mission must not report success', () => {
  const ev = partialEvidence()
  const m = mission([step('inspect', ev), step('write', ev), step('confirm', ev)], [
    { kind: 'artifact-exists', path: 'report.md' },
    { kind: 'artifact-content-matches', path: 'report.md', sha256: hashOf(FULL) },
  ])

  // The step contract is satisfied. That is not the question any more.
  assert.equal(isComplete(m), true, 'every step did reach a verified outcome')
  assert.equal(isMissionSuccessful(m, { a: ev, b: ev, c: ev }), false, 'and the mission still failed')

  const v = objectiveVerdict(m.objectivePostconditions, { a: ev, b: ev, c: ev })
  assert.equal(v.kind, 'unmet')
  assert.deepEqual(v.kind === 'unmet' ? v.failed : [], ['artifact-content-matches'])
})

test('the exists-check alone is NOT enough when the content check is also declared', () => {
  const ev = partialEvidence()
  const v = objectiveVerdict([
    { kind: 'artifact-exists', path: 'report.md' },
    { kind: 'artifact-content-matches', path: 'report.md', sha256: hashOf(FULL) },
  ], { a: ev })
  assert.equal(v.kind, 'unmet', 'the artefact exists; it is simply the wrong artefact')
})

// ============================================================ 2. objective satisfied

test('OBJECTIVE SATISFIED: sufficient evidence permits success', () => {
  const ev = fullEvidence()
  const m = mission([step('confirm', ev)], [
    { kind: 'artifact-exists', path: 'report.md' },
    { kind: 'artifact-read-back', path: 'report.md' },
    { kind: 'artifact-content-matches', path: 'report.md', sha256: hashOf(FULL) },
    { kind: 'directory-entry-count', path: '.', entries: 5 },
  ])
  const evidence = {
    confirm: ev,
    listing: { kind: 'folder-contents', path: '.', entries: 5, names: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'] } as Evidence,
  }
  assert.equal(objectiveVerdict(m.objectivePostconditions, evidence).kind, 'satisfied')
  assert.equal(isMissionSuccessful(m, evidence), true, 'the one case that may report success')
})

test('ALL postconditions must hold; one failure is enough to make it unmet', () => {
  const ev = fullEvidence()
  const v = objectiveVerdict([
    { kind: 'artifact-exists', path: 'report.md' },
    { kind: 'directory-entry-count', path: '.', entries: 10 },  // wrong count
  ], { a: ev, b: { kind: 'folder-contents', path: '.', entries: 5, names: [] } })
  assert.equal(v.kind, 'unmet')
  assert.deepEqual(v.kind === 'unmet' ? v.failed : [], ['directory-entry-count'])
})

// ============================================================ 3. missing / absent / contradictory

test('NO POSTCONDITIONS DECLARED: unproven, never success', () => {
  const ev = fullEvidence()
  assert.equal(objectiveVerdict(undefined, { a: ev }).kind, 'unproven')
  assert.equal(objectiveVerdict([], { a: ev }).kind, 'unproven',
    'an empty list is an absent claim, not a satisfied one')
  assert.equal(verdictPermitsSuccess(objectiveVerdict([], { a: ev })), false)
})

test('MISSING EVIDENCE: a declared postcondition with no evidence is unmet, not assumed', () => {
  const ev = fullEvidence()
  // Nothing whatsoever produced a 'other.md' observation.
  const v = objectiveVerdict([{ kind: 'artifact-exists', path: 'other.md' }], { a: ev })
  assert.equal(v.kind, 'unmet')
  assert.deepEqual(v.kind === 'unmet' ? v.failed : [], ['artifact-exists'])
})

test('CONTRADICTORY EVIDENCE: written and deleted at once is never a pass', () => {
  const v = objectiveVerdict([{ kind: 'artifact-exists', path: 'report.md' }], {
    w: { kind: 'file-written', path: 'report.md', bytes: 40, lines: 6 },
    d: { kind: 'file-deleted', path: 'report.md', corroboratedBy: 'walked the tree again' },
  })
  assert.equal(v.kind, 'contradicted')
  assert.equal(verdictPermitsSuccess(v), false)
})

test('an UN-HASHED read-back does NOT satisfy a content postcondition', () => {
  // This is the whole reason `sha256` is optional-but-required: "the verifier read it" is not
  // "the verifier read THAT". Without the digest the postcondition would be unverifiable, and
  // silently treating it as verified is the exact defect class this contract closes.
  const unHashed: Evidence = { kind: 'file-read-back', path: 'report.md', bytes: 40, heading: 'Folder report' }
  const v = objectiveVerdict([{ kind: 'artifact-content-matches', path: 'report.md', sha256: hashOf(FULL) }], { a: unHashed })
  assert.equal(v.kind, 'unmet')
})

// ============================================================ 4. interrupted / partial

test('a mission whose objective is proven but whose steps did not finish is not successful', () => {
  const ev = fullEvidence()
  const failed: Step = {
    id: 'write', intent: 'write it', mode: 'filesystem', rationale: 'test', status: 'failed',
    result: { id: 'write', durationMs: 1, outcome: { kind: 'failed', reason: 'disk full' } },
  }
  const m = mission([step('confirm', ev), failed], [
    { kind: 'artifact-content-matches', path: 'report.md', sha256: hashOf(FULL) },
  ])
  assert.equal(isComplete(m), false, 'a failed step is still not complete')
  assert.equal(isMissionSuccessful(m, { a: ev }), false, 'a proven objective does not excuse an unfinished plan')
})

test('an UNCERTAIN step is not a step that happened, and not a success', () => {
  const uncertain: Step = {
    id: 'click', intent: 'click it', mode: 'gui', rationale: 'test', status: 'uncertain',
    result: {
      id: 'click', durationMs: 1,
      outcome: {
        kind: 'outcome-unknown',
        reason: 'the outcome was never recorded',
        attempt: 1,
        attempted: { intent: 'click it' },
        persistenceError: 'the process died before the result was written',
      },
    },
  }
  const m = mission([uncertain], [{ kind: 'artifact-exists', path: 'report.md' }])
  assert.equal(isMissionSuccessful(m, {}), false, 'an interrupted mission cannot be upgraded to complete')
})

// ============================================================ 5. governance unaffected

test('objective verification does not weaken a CONSEQUENTIAL-EVIDENCE requirement', () => {
  // `command-exited` must refuse a process that is only certifying itself.
  const corroborated: Evidence = {
    kind: 'command-verified', executable: 'node.exe', path: 'out.txt', bytes: 10,
    exitCode: 0, durationMs: 5, envVarCount: 0, corroboratedBy: 're-read the tree in this process',
  }
  const selfWitnessed = { ...corroborated, corroboratedBy: '' } as Evidence

  assert.equal(objectiveVerdict([{ kind: 'command-exited', executable: 'node.exe', exitCode: 0 }], { a: corroborated }).kind, 'satisfied')
  assert.equal(objectiveVerdict([{ kind: 'command-exited', executable: 'node.exe', exitCode: 0 }], { a: selfWitnessed }).kind, 'unmet',
    'a process grading its own homework is not evidence')
  assert.equal(objectiveVerdict([{ kind: 'command-exited', executable: 'node.exe', exitCode: 1 }], { a: corroborated }).kind, 'unmet',
    'exit code 0 does not satisfy a requirement for exit code 1')
})

test('an EMPTY PLAN cannot report success even with a no-op objective it could satisfy', () => {
  // Requirement 6: an empty plan is unproven. There is no step, and therefore no evidence, and
  // therefore nothing any postcondition could honestly be satisfied by.
  const m: Mission = {
    id: 'm2', objective: 'do nothing', constraints: [], state: 'executing',
    plan: [], history: [], pendingApprovals: [], startedAt: 0,
    objectivePostconditions: [{ kind: 'artifact-exists', path: 'nothing.md' }],
  }
  assert.equal(isComplete(m), false)
  assert.equal(isMissionSuccessful(m, {}), false, 'an empty plan is unproven, not satisfied')
})

// ============================================================ path comparison

test('path comparison is separator- and case-insensitive, as the platform reports paths', () => {
  const ev: Evidence = { kind: 'file-exists', path: 'C:\\Out\\Report.MD' }
  const v = objectiveVerdict([{ kind: 'artifact-exists', path: 'c:/out/report.md' }], { a: ev })
  assert.equal(v.kind, 'satisfied', 'the same path written two ways is the same path')
})
