import assert from 'node:assert/strict'
import test from 'node:test'
import { digestOf, samePlan } from '../digest.ts'
import { diffPlans } from '../diff.ts'
import { renderProposal } from '../render.ts'
import type { PlanProposal } from '../../planner/plan.ts'
import type { ObjectivePostcondition } from '../../mission-engine/state.ts'

/**
 * THE REVIEW SECURITY BOUNDARY.
 *
 * A postcondition is the condition a mission's success is judged against. If an amendment can remove
 * one without invalidating the reviewer's approval, then the whole objective contract is decorative:
 * the reviewed plan and the running plan differ in exactly the way that matters, and nothing says so.
 *
 * This was measured, not assumed. Before these fields were added to the digest's allowlist, deleting
 * every `objectivePostconditions` entry from an approved proposal produced a BYTE-IDENTICAL digest,
 * so `samePlan` reported the stripped plan as the reviewed one and `execute()`'s proposalDigest
 * check had nothing to catch.
 */

const PC: readonly ObjectivePostcondition[] = [
  { kind: 'artifact-exists', path: 'report.md' },
  { kind: 'artifact-content-matches', path: 'report.md', sha256: 'a'.repeat(64) },
]

const approved: PlanProposal = {
  objective: 'summarise all 10 files into report.md',
  constraints: ['read-only with respect to the observed folder'],
  steps: [],
  expectedResult: 'report.md names all 10 files',
  basis: { observationId: 'obs-1', observedAt: 1, root: 'C:\\w', fingerprint: 'fp', usedFacts: ['a'], complete: true },
  objectivePostconditions: PC,
}

test('REMOVING a postcondition changes the digest', () => {
  const stripped = { ...approved, objectivePostconditions: PC.slice(0, 1) }
  assert.notEqual(digestOf(approved), digestOf(stripped), 'dropping a check must be visible')
  assert.equal(samePlan(approved, stripped), false)
})

test('REMOVING ALL postconditions changes the digest', () => {
  const stripped = { ...approved, objectivePostconditions: [] }
  assert.notEqual(digestOf(approved), digestOf(stripped))
  assert.equal(samePlan(approved, stripped), false, 'this is the exact attack the allowlist previously hid')
})

test('REMOVING the field entirely changes the digest', () => {
  const { objectivePostconditions: _gone, ...withoutField } = approved
  assert.notEqual(digestOf(approved), digestOf(withoutField as PlanProposal),
    'absent and empty are the same verdict, so they must be the same plan to the digest')
})

test('WEAKENING a postcondition changes the digest', () => {
  const weakened: PlanProposal = {
    ...approved,
    objectivePostconditions: [{ kind: 'artifact-exists', path: 'report.md' }] as readonly ObjectivePostcondition[],
  }
  assert.notEqual(digestOf(approved), digestOf(weakened))
})

test('a content check cannot be silently swapped for an existence check', () => {
  const swapped: PlanProposal = {
    ...approved,
    objectivePostconditions: [{ kind: 'artifact-exists', path: 'report.md' }] as readonly ObjectivePostcondition[],
  }
  assert.notEqual(digestOf(approved), digestOf(swapped), 'these are different standards of done')
})

test('the diff REPORTS removed postconditions, and names them', () => {
  const changes = diffPlans(approved, { ...approved, objectivePostconditions: [] })
  const pc = changes.find((c) => c.field === 'objectivePostconditions')
  assert.ok(pc, 'a reviewer must be told the objective checks were removed')
  assert.equal(pc.significance, 'behavioural')
  assert.match(pc.note, /REMOVED/)
  assert.match(pc.note, /artifact-exists/)
  assert.match(pc.note, /artifact-content-matches/)
  assert.match(pc.note, /invalidates any approval/i, 'and told the approval no longer holds')
})

test('the diff reports an ADDED postcondition too', () => {
  const changes = diffPlans({ ...approved, objectivePostconditions: [] }, approved)
  const pc = changes.find((c) => c.field === 'objectivePostconditions')
  assert.ok(pc)
  assert.match(pc.note, /added/i)
})

test('REVIEW RENDERING shows the checks a reviewer is approving', () => {
  const out = renderProposal(approved, digestOf(approved))
  assert.match(out, /MUST PASS BEFORE THIS MAY BE CALLED SUCCESSFUL/)
  assert.match(out, /report\.md exists/)
  assert.match(out, /its exact contents/)
})

test('REVIEW RENDERING says plainly when NO checks are declared', () => {
  const out = renderProposal({ ...approved, objectivePostconditions: [] }, digestOf(approved))
  assert.match(out, /NONE DECLARED/)
  assert.match(out, /cannot report success/i)
  assert.match(out, /UNPROVEN/)
})

test('an approved proposal digest is stable across repeated computation', () => {
  assert.equal(digestOf(approved), digestOf({ ...approved }), 'no false "this is not the plan you reviewed"')
})
