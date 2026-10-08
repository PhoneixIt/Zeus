/**
 * DURABLE STATE: recovery, and the boundary that keeps it from becoming authority.
 *
 * =============================================================================
 * THE DANGEROUS VERSION OF THIS FEATURE
 * =============================================================================
 *
 * The tempting implementation is: persist the mission, restart, load it, carry on. That is a system
 * where a crash is a way to obtain authority - because whatever was in flight when the process died
 * comes back looking decided.
 *
 * Every function here exists to make that impossible.
 *
 *   * `resumeMission` returns a `ResumePermit`, and a permit is a list of things still TO DO, not a
 *     promise that the mission may run. It carries no `executable: true` field, and its type has no
 *     such member to set.
 *   * it always requires a fresh observation. Not "if the world changed" - ALWAYS.
 *   * it reports what was recovered rather than smoothing it over.
 *
 * =============================================================================
 * WHAT SURVIVES AND WHAT DOES NOT
 * =============================================================================
 *
 * SURVIVES: the objective, the plan, step results, evidence with its provenance, history, and the
 * FACT that an approval once existed (with its effect key and plan epoch).
 *
 * DOES NOT SURVIVE, BY DESIGN: authority, permission to inject, the latched emergency-stop state, the
 * operator's armed state, and any approval's validity. Those are properties of a running process and
 * of a human's presence in front of the machine, and a file cannot testify to either.
 */

import type { DurableStore, RecoveredMission } from './store.ts'
import { observedInThisSession } from './store.ts'
import type { Mission } from '../mission-engine/state.ts'

/**
 * What must be re-established before the mission may act again.
 *
 * Note what is NOT in this type: any field meaning "may execute", "is authorised", "is armed". The
 * omission is the point. A caller that wants to know whether it may act has to ask the live
 * governance layer, which is the only place that answer belongs.
 */
export interface ResumePermit {
  readonly missionId: string
  /** The record as persisted. Never mutated into something runnable. */
  readonly mission: Mission
  /** MUST be done before any step may act. Never empty, by construction. */
  readonly obligations: readonly ResumeObligation[]
  readonly recoveredSteps: readonly string[]
  readonly invalidatedApprovals: readonly string[]
  /** Always true. Typing it as the literal `true` means a future edit must consciously remove it. */
  readonly requiresFreshObservation: true
  /** Evidence observed by a verifier in THIS process. Empty immediately after a restart. */
  readonly liveEvidence: readonly string[]
}

export type ResumeObligation =
  | { kind: 're-observe'; detail: string }
  | { kind: 're-obtain-approval'; stepId: string; effectKey: string; detail: string }
  | { kind: 'recover-step'; stepId: string; detail: string }
  | { kind: 'revalidate-plan'; detail: string }
  | { kind: 'quarantined'; detail: string }

export interface ResumeOptions {
  /** Called to check a step's effect still requires approval. Governance's answer, not this file's. */
  readonly requiresApproval?: (mission: Mission, stepId: string) => boolean
  /** Called with the persisted plan basis so the caller can compare it against a fresh observation. */
  readonly compareBasis?: (mission: Mission) => string | undefined
}

/**
 * Decide what it would take to resume a persisted mission.
 *
 * Returns obligations, not permission. Nothing in this function can make a mission runnable, and a
 * caller that skips the obligations has not been authorised by anyone - it has simply ignored a
 * function.
 */
export function resumeMission(
  store: DurableStore,
  missionId: string,
  opts: ResumeOptions = {},
): ResumePermit | undefined {
  const recovered: RecoveredMission | undefined = store.readMission(missionId)
  if (!recovered) return undefined

  const m = recovered.mission
  const obligations: ResumeObligation[] = []

  // 1. ALWAYS. A plan built on an observation from a previous process is a plan about a machine as it
  //    used to be. This is first because it gates everything else, and it is unconditional.
  obligations.push({
    kind: 're-observe',
    detail: 'the plan was built on an observation this process did not make; a fresh one is required before any step acts',
  })

  // 2. Whether the plan itself still matches reality. The basis is persisted precisely so this can be
  //    ASKED rather than assumed - and the caller supplies the comparison, because comparing an
  //    observation to a basis is the observation layer's job, not a storage layer's.
  const divergence = opts.compareBasis?.(m)
  if (divergence !== undefined) {
    obligations.push({
      kind: 'revalidate-plan',
      detail: `the world has changed since this plan was compiled: ${divergence}`,
    })
  }

  // 3. Steps caught mid-flight.
  for (const sid of recovered.recovery.recoveredSteps) {
    obligations.push({
      kind: 'recover-step',
      stepId: sid,
      detail: 'was in flight when the process ended; its outcome is unknown and must not be assumed either way',
    })
  }

  // 4. Every approval that is not live in THIS session.
  //
  //    Derived from the approval ROWS, not from `recovery.invalidatedApprovals`.
  //
  //    That distinction is not cosmetic. `invalidateForeignApprovals` is a one-shot mutation: the
  //    first read rejects the stale rows, so a SECOND read finds nothing to reject and reports nothing.
  //    A permit built from "what did this read invalidate" therefore reported no approval obligation at
  //    all the second time - which is exactly the case that matters, since that is the call a resuming
  //    process makes. Deriving from the rows makes the permit correct however many times it is asked.
  const liveHere = new Set(
    recovered.approvals
      .filter((a) => a.state === 'approved' && a.sessionId === store.session.sessionId)
      .map((a) => a.id),
  )
  for (const row of recovered.approvals) {
    if (liveHere.has(row.id)) continue
    // `grantedAt` is the durable signal, NOT `state`. After the first read has rejected a stale row its
    // state is 'rejected', so a state-based test would skip it on every subsequent read - and the
    // obligation would evaporate exactly when a resuming process asks. A row that was granted, by a
    // session that is not this one, always needs a human again.
    if (row.grantedAt === undefined) continue
    if (row.sessionId === store.session.sessionId) continue
    obligations.push({
      kind: 're-obtain-approval',
      stepId: row.stepId,
      effectKey: row.effectKey,
      detail: 'an approval was recorded by a previous process; authority does not survive a restart and a human must authorise again',
    })
  }

  // 5. Any step whose effect requires approval and has none in THIS session. Asking governance rather
  //    than assuming keeps this module from becoming a second source of safety truth.
  for (const s of m.plan) {
    if (!s.effect) continue
    if (opts.requiresApproval && !opts.requiresApproval(m, s.id)) continue
    const live = store.approvalsInThisSession().some((a) => a.stepId === s.id && a.state === 'approved')
    if (!live) {
      obligations.push({
        kind: 're-obtain-approval',
        stepId: s.id,
        effectKey: `${m.id}|${s.id}|${s.effect.kind}|${s.effect.target}`,
        detail: 'this step declares a consequential effect and holds no approval from this process',
      })
    }
  }

  if (recovered.recovery.kind === 'quarantined') {
    obligations.push({ kind: 'quarantined', detail: recovered.recovery.reason })
  }

  // Liveness is judged against THIS SESSION, not against the stored flag.
  //
  // `observed_by = 'live-verifier'` records how a row was ORIGINALLY obtained, and it stays true
  // forever. Filtering on it meant a restarted mission believed it had just looked at the machine,
  // because the row it read had been looked at by a process that no longer existed. The permit has to
  // ask "did *I* observe it", which needs the session, not the flag.
  const liveEvidence = recovered.evidence
    .filter((e) => observedInThisSession(e, store.session.sessionId))
    .map((e) => `${e.stepId ?? '(mission)'}:${e.kind}`)

  return {
    missionId,
    mission: m,
    obligations,
    recoveredSteps: recovered.recovery.recoveredSteps,
    invalidatedApprovals: recovered.recovery.invalidatedApprovals,
    requiresFreshObservation: true,
    liveEvidence,
  }
}

/**
 * Whether a persisted history may be shown as describing the machine right now.
 *
 * A narrow predicate on purpose. It exists so that a caller wanting a green light has to ask a
 * question with an answer that is usually "no", rather than defaulting to optimism.
 */
export function historyIsCurrent(permit: ResumePermit): boolean {
  return permit.requiresFreshObservation === true &&
    permit.obligations.length === 0 &&
    permit.liveEvidence.length > 0
}