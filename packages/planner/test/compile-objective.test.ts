import assert from 'node:assert/strict'
import test from 'node:test'
import { compilePlan } from '../compile.ts'
import type { PlanProposal, PlanStep } from '../plan.ts'
import type { ObjectivePostcondition } from '../../mission-engine/state.ts'

/**
 * THE COMPILER IS THE COURIER, AND THE COURIER IS TESTED.
 *
 * `objectivePostconditions` has to survive the trip from the proposal the user reviewed to the
 * mission that runs. If it does not, every mission silently becomes UNPROVEN and no objective
 * check ever fires - which fails safe, but fails safe the same way for correct and incorrect plans
 * alike, and so detects nothing.
 *
 * The negative control for this is a compile that drops the field, which is why this file exists.
 */

const step: PlanStep = {
  id: 'a', capability: 'filesystem.inspect', intent: 'look', mode: 'filesystem',
  tool: 'inspect', args: {}, dependsOn: [], rationale: 'r',
  verification: { kind: 'must-exist', description: 'd' }, onFailure: 'abort-mission',
}

const PC: readonly ObjectivePostcondition[] = [
  { kind: 'artifact-exists', path: 'report.md' },
  { kind: 'artifact-content-matches', path: 'report.md', sha256: 'a'.repeat(64) },
]

const proposal = (over: Partial<PlanProposal> = {}): PlanProposal => ({
  objective: 'summarise all 10 files into report.md',
  constraints: [],
  steps: [step],
  expectedResult: 'report.md names all 10 files',
  basis: { observationId: 'obs-1', observedAt: 1, root: 'C:\\w', fingerprint: 'fp', usedFacts: ['the folder was listed'], complete: true },
  ...over,
})

test('the compiler CARRIES the postconditions onto the mission', () => {
  const r = compilePlan(proposal({ objectivePostconditions: PC }), 'm1', 0)
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.deepEqual(r.mission.objectivePostconditions, PC, 'the declaration reached the mission intact')
})

test('the postconditions are part of what the mission was compiled FROM', () => {
  // The digest is stamped over the proposal. If the postconditions were outside it, two proposals
  // differing only in their objective checks would compile to missions claiming the same identity -
  // and the executor's "is this the plan you reviewed?" check would wave through the wrong one.
  const a = compilePlan(proposal({ objectivePostconditions: PC }), 'm1', 0)
  const b = compilePlan(proposal({ objectivePostconditions: [] }), 'm1', 0)
  assert.equal(a.ok && b.ok, true)
  if (!a.ok || !b.ok) return
  assert.notEqual(a.mission.proposalDigest, b.mission.proposalDigest,
    'a plan with different objective checks is a different plan')
})

test('a proposal with NO postconditions compiles to a mission that cannot report success', () => {
  const r = compilePlan(proposal(), 'm1', 0)
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.mission.objectivePostconditions, undefined,
    'and the absence is preserved rather than defaulted to something satisfied')
})

test('an EMPTY postcondition list is carried as an empty list, not normalised away', () => {
  const r = compilePlan(proposal({ objectivePostconditions: [] }), 'm1', 0)
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.deepEqual(r.mission.objectivePostconditions, [], 'preserved verbatim')
  // Both absent and empty evaluate to `unproven`, so there is nothing to normalise - and preserving
  // them keeps the reviewer's rendering honest about which case it is.
})
