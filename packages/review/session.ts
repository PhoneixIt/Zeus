/**
 * THE REVIEW SESSION.
 *
 * One object that ties the pieces together: propose, show, amend, diff, dry-run, compile, and hand
 * back a mission that is tied to the exact proposal the reviewer saw.
 *
 * WHAT IT IS NOT
 *
 * It is not an authority. It cannot grant an approval, it cannot mark a step done, and it does not
 * execute. It produces a `PlanProposal` and a `Mission` and nothing else, and the executor and the
 * governance layer remain the only components that decide whether anything runs.
 *
 * THE ONE POWER IT HAS, AND WHY IT IS SAFE
 *
 * It stamps a digest on the mission and carries it to execution, where the executor re-checks it. So
 * the sequence "review, amend, execute the mission that was already compiled" is detected rather than
 * executed. That is the whole mechanism behind "amendment produces a new proposal, never an in-place
 * mutation": the new proposal is compiled into a NEW mission, and the old mission cannot be used in
 * its place because its digest no longer matches what was reviewed.
 *
 * THREE THINGS KEPT SEPARATE, DELIBERATELY
 *
 *   REVIEW      "is this plan understandable and correct"
 *   AUTHORISE   "is this consequential action permitted"          (M3, unchanged)
 *   VERIFY      "did it actually succeed"                          (unchanged)
 *
 * There is no `approvePlan()` on this class, and there is no field on the proposal that would make one
 * unnecessary. A review produces a reviewed digest; it does not produce a permission. Conflating the
 * three is how a "the user said yes" turns into "the action happened" and "the action worked", and all
 * three are distinct claims with distinct evidence.
 */

import type { PlanProposal, PlanContext } from '../planner/plan.ts'
import { compilePlan } from '../planner/compile.ts'
import type { Mission } from '../mission-engine/state.ts'
import { amend, amendAll, describe, type Amendment, type AmendmentOutcome } from './amend.ts'
import { diffPlans, summarise, consequentialChanges, type Change } from './diff.ts'
import { digestOf, authorityLookingFields } from './digest.ts'
import { dryRun, type DryRunContext, type DryRunReport } from './dry-run.ts'

export interface ReviewSession {
  /** The proposal as generated, before any amendment. Never mutated. */
  readonly original: PlanProposal
  /** The proposal as it stands now. */
  readonly current: PlanProposal
  /** The digest of the CURRENT proposal - what a reviewer is being asked to accept. */
  readonly digest: string
  /** The digest of the ORIGINAL, so a change is visible even if it is later reverted. */
  readonly originalDigest: string
  readonly amendments: readonly Amendment[]
  readonly history: readonly { readonly at: number; readonly summary: string }[]
}

export type AmendResult =
  | { readonly ok: true; readonly session: ReviewSession; readonly changes: readonly Change[]; readonly summary: string }
  | { readonly ok: false; readonly reason: string }

export function beginReview(proposal: PlanProposal, at: number): ReviewSession {
  const d = digestOf(proposal)
  return {
    original: structuredClone(proposal),
    current: structuredClone(proposal),
    digest: d,
    originalDigest: d,
    amendments: [],
    history: [{ at, summary: 'proposal generated' }],
  }
}

export function applyAmendment(session: ReviewSession, change: Amendment, at: number): AmendResult {
  const r: AmendmentOutcome = amend(session.current, change)
  if (!r.ok) return { ok: false, reason: r.reason }

  // Recomputed from the two proposals, never from the amendment list: a `replace` carries a whole new
  // proposal and no list of what changed, and a diff that trusted the list would report nothing.
  const changes = diffPlans(session.current, r.proposal)
  const summary = `${describe(change)}  (${summarise(changes)})`
  return {
    ok: true,
    changes,
    summary,
    session: {
      ...session,
      current: r.proposal,
      digest: digestOf(r.proposal),
      amendments: [...session.amendments, change],
      history: [...session.history, { at, summary }],
    },
  }
}

export function preview(session: ReviewSession, ctx: DryRunContext): DryRunReport {
  return dryRun(session.current, ctx)
}

export type CompileResult =
  | { readonly ok: true; readonly mission: Mission; readonly reviewedDigest: string }
  | { readonly ok: false; readonly reason: string }

/**
 * Compiles the CURRENT proposal, from scratch.
 *
 * A new mission id every time, because a mission is a record of one execution attempt and an amended
 * plan is a different attempt. Reusing the id would put two different histories under one name.
 */
export function commit(session: ReviewSession, missionId: string, at: number): CompileResult {
  const c = compilePlan(session.current, missionId, at)
  if (!c.ok) return { ok: false, reason: c.reason }
  return { ok: true, mission: c.mission, reviewedDigest: session.digest }
}

/** Convenience: the changes from the original to the current, for the review surface. */
export function changesFromOriginal(session: ReviewSession): Change[] {
  return diffPlans(session.original, session.current)
}

/** The changes that alter what the machine does. A reviewer can insist on seeing only these. */
export function materialChanges(session: ReviewSession): Change[] {
  return consequentialChanges(changesFromOriginal(session))
}

/** Whether the session has been amended at all. */
export function isAmended(session: ReviewSession): boolean {
  return session.digest !== session.originalDigest
}

/** Fields on the proposal that look like they grant authority, and do not. */
export function inertAuthorityFields(session: ReviewSession): string[] {
  return authorityLookingFields(session.current)
}
