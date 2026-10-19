/**
 * THE PROPOSAL DIGEST.
 *
 * A stable fingerprint of a `PlanProposal`, so that "the thing the user reviewed" and "the thing
 * about to execute" can be compared rather than assumed to be the same.
 *
 * WHY THIS EXISTS
 *
 * M6 made a plan declare the observation it was built on, so a plan can be held to the world. M7 needs
 * the same property in a second dimension: held to WHAT THE USER SAW. A user reviews a plan, an
 * amendment changes the proposal, and the mission that was already compiled from the earlier proposal
 * is still sitting there looking perfectly executable. Nothing in the current system notices, because
 * a `Mission` and a `PlanProposal` share no identity.
 *
 * A digest is the smallest thing that closes that gap. It is stamped on the mission at compile time
 * and re-checked at execution time, so an amendment that happens after compilation is detected rather
 * than silently ignored.
 *
 * IT IS A WHITELIST, AND THAT IS THE POINT
 *
 * The canonical form is built from an explicit list of semantic fields. Anything else present on the
 * proposal - including a field someone bolted on to try to make a plan self-authorising - contributes
 * nothing, because it is never read.
 *
 * This is not a stylistic choice. A digest built by serialising whatever the object happens to carry
 * would change when an unknown field appeared, which sounds safer and is not: the injected field would
 * at least be visible. A whitelist makes it inert at both layers - the digest ignores it, and the
 * compiler ignores it - and the tests assert exactly that, because "there is no proposal-level
 * approval authority" is only true while nobody is reading a field that would grant one.
 *
 * THE CANONICAL FORM
 *
 * Keys are emitted in a fixed order and arguments are sorted by key, so two structurally identical
 * proposals hash identically regardless of how they were built. Without that, a digest would change
 * for a reason that has nothing to do with what the plan does, and every such change would be a false
 * alarm.
 */

import { createHash } from 'node:crypto'
import type { PlanProposal, PlanStep } from '../planner/plan.ts'

/** Exactly the fields that constitute a plan, in the order they are canonicalised. */
const STEP_FIELDS = [
  'id', 'capability', 'intent', 'mode', 'tool', 'args', 'dependsOn', 'rationale', 'verification', 'onFailure', 'effect',
] as const

const PROPOSAL_FIELDS = [
  'objective', 'constraints', 'steps', 'expectedResult',
  'observationId', 'observedAt', 'root', 'fingerprint', 'usedFacts', 'complete',
] as const

/**
 * Canonical JSON, with sorted object keys at every level.
 *
 * A `JSON.stringify` of a plan is not stable: two plans with the same arguments in a different
 * insertion order serialise differently. The digest would then report a change where there is none,
 * and a false "this plan is not the one you reviewed" is worse than no check at all - it trains a
 * reviewer to dismiss the warning.
 */
export function canonicalise(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalise).join(',')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalise(v)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/**
 * The semantic form of a proposal: only the fields the system acts on.
 *
 * Note what is absent from `STEP_FIELDS`: `status`, `result`, `attempts`, `evidence` - a proposal has
 * no such fields, and if one appeared it would be evidence of an amendment that tried to smuggle
 * execution state in. Note also what is absent from the top level: anything resembling `approved`,
 * `authorized` or `confirmed`. Those names appear in this file only in the sentence explaining that
 * they do nothing.
 */
function semanticForm(p: PlanProposal): Record<string, unknown> {
  return {
    objective: p.objective,
    constraints: [...(p.constraints ?? [])],
    expectedResult: p.expectedResult,
    // The objective's own requirements are part of what "the plan" means.
    //
    // Without this line the digest is computed over a projection that DROPS the postconditions, so
    // deleting every one of them after a reviewer approved the plan yields a byte-identical digest:
    // `samePlan` reports the weakened plan as the reviewed one, and `execute()`'s proposalDigest
    // check cannot notice. An attacker who can amend a proposal can then remove every objective
    // check without invalidating a single approval. This field is in the allowlist precisely
    // because an absent entry is an invisible permission rather than a missing convenience.
    objectivePostconditions: [...(p.objectivePostconditions ?? [])],
    steps: (p.steps ?? []).map((s: PlanStep) => {
      const out: Record<string, unknown> = {}
      for (const f of STEP_FIELDS) out[f] = (s as unknown as Record<string, unknown>)[f]
      return out
    }),
    observationId: p.basis?.observationId,
    observedAt: p.basis?.observedAt,
    root: p.basis?.root,
    fingerprint: p.basis?.fingerprint,
    usedFacts: [...(p.basis?.usedFacts ?? [])],
    complete: p.basis?.complete,
  }
}

/** The digest. Sixteen hex characters is plenty to detect a difference, and short enough to read aloud. */
export function digestOf(p: PlanProposal): string {
  return createHash('sha256').update(canonicalise(semanticForm(p))).digest('hex').slice(0, 16)
}

/** Whether two proposals are the same plan. The comparison the review layer needs. */
export function samePlan(a: PlanProposal, b: PlanProposal): boolean {
  return digestOf(a) === digestOf(b)
}

/**
 * Reports the fields a proposal carries that the system does not read.
 *
 * Exists to be shown during review. An amendment that bolts on `approved: true` is invisible to the
 * compiler and to the digest, and "invisible" is exactly the property that makes it dangerous to
 * leave unmentioned - so the review surface names it rather than leaving a reviewer to assume that
 * anything a plan says is honoured.
 */
export const KNOWN_STEP_FIELDS: readonly string[] = STEP_FIELDS
export const KNOWN_PROPOSAL_FIELDS: readonly string[] = [...PROPOSAL_FIELDS, 'basis']

/** Field names that would look like authority and are not. */
export const INERT_AUTHORITY_FIELDS: readonly string[] = [
  'approved', 'authorized', 'authorised', 'confirmed', 'granted', 'permit', 'permitted', 'override',
]

export function unrecognisedFields(p: PlanProposal): { at: string; field: string }[] {
  const out: Array<{ at: string; field: string }> = []
  for (const f of Object.keys(p as unknown as Record<string, unknown>)) {
    if (!KNOWN_PROPOSAL_FIELDS.includes(f)) out.push({ at: 'proposal', field: f })
  }
  for (const [i, s] of (p.steps ?? []).entries()) {
    for (const f of Object.keys(s as unknown as Record<string, unknown>)) {
      if (!KNOWN_STEP_FIELDS.includes(f)) out.push({ at: `step ${s.id ?? i}`, field: f })
    }
  }
  return out
}

/** Whether any unrecognised field is one that LOOKS like it grants authority. */
export function authorityLookingFields(p: PlanProposal): string[] {
  return unrecognisedFields(p)
    .filter((u) => INERT_AUTHORITY_FIELDS.includes(u.field.toLowerCase()))
    .map((u) => `${u.at}.${u.field}`)
}
