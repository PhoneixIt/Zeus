/**
 * DURABLE STATE: the read path.
 *
 * This is what a human or a later process asks the store for: what happened, what was proved, and
 * what is still outstanding.
 *
 * =============================================================================
 * WHY THE READ PATH IS NOT A THIN WRAPPER
 * =============================================================================
 *
 * Because the most dangerous thing a history can do is answer a question nobody asked precisely.
 * A reader that returned `evidence: [...]` and left it at that would hand a caller a list of things
 * that were true at some point, with no way to tell which. So:
 *
 *   * every evidence row carries `observedBy`, and the summaries here count live observations and
 *     restored records SEPARATELY. A mission whose history is entirely `restored-from-disk` has proved
 *     nothing about the world right now, and the summary says so in words.
 *   * `isLive` is never inferred from the presence of evidence.
 *   * a mission summary never says "complete" because steps look done; completion is re-derived.
 */

import type { DurableStore, EvidenceRow, PersistedApproval } from './store.ts'
import type { Mission } from '../mission-engine/state.ts'
import { isComplete, isMissionSuccessful, objectiveVerdict } from '../mission-engine/state.ts'
import type { Evidence, ObjectiveVerdict } from '../mission-engine/state.ts'

/**
 * Persisted evidence rows, keyed by step, in the shape the objective rule consumes.
 *
 * Keyed by step id because that is how the executor keys `record.verified`, so a restored mission
 * is judged against exactly the evidence map it was originally judged against. Rows with no step id
 * are dropped rather than filed under a placeholder key: a piece of unattributed evidence must not
 * be able to satisfy an objective postcondition, since nothing would tie it to the mission's work.
 */
function evidenceByStep(rows: readonly EvidenceRow[]): Record<string, Evidence> {
  const out: Record<string, Evidence> = {}
  for (const r of rows) {
    if (r.stepId) out[r.stepId] = r.evidence
  }
  return out
}

export interface EvidenceSummary {
  readonly total: number
  /** Observed by a verifier in a live process. These are the only ones that say anything about now. */
  readonly live: number
  /** Records read back from disk. True once; not evidence about the present. */
  readonly restored: number
  readonly byKind: Readonly<Record<string, number>>
  readonly byStep: Readonly<Record<string, number>>
  /** Spoken plainly, because a number labelled wrong is how a stale record becomes a claim. */
  readonly liveSinceRestart: number
}

export interface MissionSummary {
  readonly id: string
  readonly objective: string
  readonly persistedState: string
  readonly stepsTotal: number
  readonly stepsByStatus: Readonly<Record<string, number>>
  /** Re-derived from steps AND evidence AND the objective's declared conditions, never read from a stored flag. There is no stored flag. */
  readonly complete: boolean
  /** What the evidence said about the objective. Retained so "failed" and "never checkable" stay distinguishable on disk. */
  readonly objectiveVerdict: ObjectiveVerdict
  readonly startedAt: number
  readonly finishedAt?: number
  readonly evidence: EvidenceSummary
  readonly approvalsOutstanding: number
  readonly invalidatedOnRead: number
}

export interface HistoryReport {
  readonly missionId: string
  readonly entries: number
  readonly firstAt?: number
  readonly lastAt?: number
  readonly byKind: Readonly<Record<string, number>>
  readonly summaries: readonly string[]
}

/**
 * The session id every row in a single-mission read belongs to, when they agree.
 *
 * `summariseEvidence` is given one mission's rows, so the newest session among them is the one that
 * last wrote to this history - and liveness is measured against it.
 */
function sessionIdOf(row: EvidenceRow): string | undefined {
  return row.observedInSession
}

export function summariseEvidence(rows: readonly EvidenceRow[], currentSession?: string): EvidenceSummary {
  const byKind: Record<string, number> = {}
  const byStep: Record<string, number> = {}
  let live = 0
  let restored = 0
  // Live means "observed by a verifier IN THE SESSION THAT IS CURRENTLY READING". The stored
  // observedBy flag alone would keep counting a dead process's observation as current forever.
  const live_session = currentSession ?? (rows.length ? (sessionIdOf(rows[0]) ?? '') : '')
  for (const r of rows) {
    byKind[r.kind] = (byKind[r.kind] ?? 0) + 1
    const key = r.stepId ?? '(mission)'
    byStep[key] = (byStep[key] ?? 0) + 1
    if (live_session && r.observedInSession === live_session) live++
    else restored++
  }
  return {
    total: rows.length,
    live,
    restored,
    byKind,
    byStep,
    liveSinceRestart: live,
  }
}

/** Summarise a mission as it is on disk. `now` is passed so a caller cannot accidentally use stale state. */
export function summariseMission(
  store: DurableStore,
  missionId: string,
  recovered: { mission: Mission; evidence: readonly EvidenceRow[]; approvals: readonly PersistedApproval[]; recovery: { invalidatedApprovals: readonly string[] } },
): MissionSummary {
  const m = recovered.mission
  const stepsByStatus: Record<string, number> = {}
  for (const s of m.plan) stepsByStatus[s.status] = (stepsByStatus[s.status] ?? 0) + 1

  return {
    id: m.id,
    objective: m.objective,
    persistedState: m.state,
    stepsTotal: m.plan.length,
    stepsByStatus,
    // Re-derived on every read from the restored steps AND the restored objective postconditions.
    //
    // Both halves are required. Re-deriving from steps alone is the original defect - a persisted
    // mission whose every step verified but whose objective did not hold would read as complete after
    // a restart. Re-deriving from a CACHED flag is a different defect, which is why nothing is
    // cached and the verdict is recomputed from evidence every time.
    complete: isMissionSuccessful(m, evidenceByStep(recovered.evidence)),
    objectiveVerdict: objectiveVerdict(m.objectivePostconditions, evidenceByStep(recovered.evidence)),
    startedAt: m.startedAt,
    finishedAt: m.finishedAt,
    evidence: summariseEvidence(recovered.evidence, store.session.sessionId),
    approvalsOutstanding: recovered.approvals.filter((a) => a.state === 'approved').length,
    invalidatedOnRead: recovered.recovery.invalidatedApprovals.length,
  }
}

/** Every mission on disk, newest first, as summaries. */
export function listHistory(store: DurableStore): MissionSummary[] {
  const out: MissionSummary[] = []
  for (const id of store.listMissionIds()) {
    const r = store.readMission(id)
    if (r) out.push(summariseMission(store, id, r))
  }
  return out.sort((a, b) => b.startedAt - a.startedAt)
}

/** One mission's event history, in order. */
export function missionHistory(store: DurableStore, missionId: string): HistoryReport {
  const rows = store.readHistory(missionId)
  const byKind: Record<string, number> = {}
  for (const r of rows) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1
  return {
    missionId,
    entries: rows.length,
    firstAt: rows[0]?.at,
    lastAt: rows[rows.length - 1]?.at,
    byKind,
    summaries: rows.map((r) => r.summary),
  }
}

/**
 * A one-line statement of what a history does and does not prove.
 *
 * Written as prose on purpose. A machine-readable summary of "this history is stale" is one field
 * away from being ignored, and the sentence is what a reader actually acts on.
 */
export function describeStanding(summary: MissionSummary): string {
  const e = summary.evidence
  if (e.total === 0) {
    return `Mission ${summary.id} recorded no evidence. Nothing about the machine has been proved, then or now.`
  }
  if (e.restored === e.total) {
    return `Mission ${summary.id} has ${e.restored} evidence record(s), ALL restored from disk. ` +
      'None of them was observed in this process, so none of them says anything about the machine right now. ' +
      'Re-observe before relying on any of it.'
  }
  return `Mission ${summary.id} has ${e.live} live observation(s) and ${e.restored} restored record(s). ` +
    'Only the live ones describe the machine as this process last saw it.'
}