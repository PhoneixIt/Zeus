/**
 * READ-ONLY probe 5: does adding objectivePostconditions to PlanProposal automatically become
 * part of the reviewer digest? PROPOSAL_FIELDS is an explicit ALLOWLIST, so the answer is NO -
 * and a silent exclusion is a security hole, not a cosmetic omission.
 *
 * Nothing under packages/ is touched. This calls the REAL canonicalise() and digest() from the
 * repo, with an extra field smuggled in, and shows whether the digest changes.
 */
import { canonicalise } from './packages/review/digest.ts'

// What a reviewer-approved proposal looks like today.
const approved = {
  objective: 'summarise the demo folder',
  constraints: ['read-only with respect to the observed folder'],
  steps: [{ id: 'inspect-folder', intent: 'list the folder', verification: { kind: 'must-exist', description: 'listed' } }],
  expectedResult: 'summary.md exists and names all 5 files',
  observationId: 'obs-1', observedAt: 1, root: 'C:\\w', fingerprint: 'fp', usedFacts: ['a'], complete: true,
}

// A proposal whose OBJECTIVE POSTCONDITIONS were WEAKENED after review - the exact attack.
const tampered = {
  ...approved,
  objectivePostconditions: [{ kind: 'artifact-exists', path: 'summary.md' }],
}
const tamperedWeakened = {
  ...approved,
  objectivePostconditions: [],
}

// canonicalise() serialises whatever object it is given.
const cApproved = canonicalise(approved)
const cTampered = canonicalise(tampered)
const cWeakened = canonicalise(tamperedWeakened)

console.log('=== DIGEST COVERAGE OF A NEW PROPOSAL FIELD ===\n')
console.log('approved digest            :', cApproved.slice(0, 96), '...')
console.log('tampered (PC added)        :', cTampered.slice(0, 96), '...')
console.log()
console.log('approved == tampered-with-PC ?', cApproved === cTampered)
console.log('  ^ if TRUE, the digest cannot see the postcondition field at all.')
console.log()
console.log('tampered vs WEAKENED (PC removed) differ ?', cTampered !== cWeakened)
console.log('  ^ canonicalise is generic, so THIS would differ - but the repo digest uses the')
console.log('    PROPOSAL_FIELDS ALLOWLIST, which projects the object down to known fields first.')
console.log()

// Reproduce the allowlist behaviour the repo actually uses.
const PROPOSAL_FIELDS = [
  'objective', 'constraints', 'steps', 'expectedResult',
  'observationId', 'observedAt', 'root', 'fingerprint', 'usedFacts', 'complete',
] as const

function project(o: Record<string, unknown>) {
  const out: Record<string, unknown> = {}
  for (const f of PROPOSAL_FIELDS) if (f in o) out[f] = o[f]
  return out
}

const pApproved = canonicalise(project(approved))
const pTampered = canonicalise(project(tampered))
const pWeakened = canonicalise(project(tamperedWeakened))

console.log('=== REPRODUCING THE REPO\'S ALLOWLIST PROJECTION ===\n')
console.log('projected approved  :', pApproved.slice(0, 96), '...')
console.log('projected tampered  :', pTampered.slice(0, 96), '...')
console.log('projected weakened  :', pWeakened.slice(0, 96), '...')
console.log()
console.log('approved == weakened (PC deleted)? ', pApproved === pWeakened)
console.log('  ^ TRUE means: silently deleting every objective postcondition produces the SAME')
console.log('    digest as the plan the reviewer approved. execute() would then accept a mission')
console.log('    whose objective checks were removed after review.')
console.log()
console.log('CONCLUSION: objectivePostconditions MUST be added to PROPOSAL_FIELDS in')
console.log('review/digest.ts, and to diff.ts FIELD lists, or the amendment path is open.')
