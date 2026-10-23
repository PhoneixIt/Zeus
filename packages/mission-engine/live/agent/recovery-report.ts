/**
 * STAGE C: OBLIGATIONS-BASED RECOVERY, THE READ SIDE, ON THE CHAT PATH.
 *
 * =============================================================================
 * WHY THIS FILE EXISTS
 * =============================================================================
 *
 * Stage B made every chat mission leave a durable write-ahead record. That closed the
 * "a crash loses the history" half of the problem and opened the other half: when the
 * process dies mid-step, the ledger holds a mission that never settled and a step with a
 * durably recorded ATTEMPT and no recorded outcome. The action may or may not have
 * reached the machine, and NOTHING in the production path ever looked at that fact. The
 * person reopened the window to a blank slate while the record that was supposed to
 * protect them sat unread in a database.
 *
 * This module is that read side. It does two things, and the discipline of both is the
 * same one `recover.ts` was written to enforce:
 *
 *   1. `listObligations` - what does a previous session owe this one? READ-ONLY, always:
 *      a surfaced obligation is reported, never settled, and a normal read's recovery
 *      side-effect (running -> pending, foreign approvals invalidated) is deliberately
 *      suppressed so that looking can never quietly become doing.
 *
 *   2. `composeResume` - what would settling one interrupted mission actually mean? The
 *      answer is a FRESH governed run with a recovery brief, never a continuation of the
 *      old one. The permit from `resumeMission` is obligations, not permission; the
 *      consuming read happens only when a human has explicitly asked, and a quarantined
 *      record refuses to be resumed at all.
 *
 * The chat server wires both (`/recovery`, `POST /recover`, and the startup notice);
 * the policy lives here so it is testable without a server, exactly as `/approve`'s
 * matching discipline lives in `approval-route.ts`.
 *
 * WHAT THIS FILE MUST NEVER BECOME
 *
 * An authority. Nothing here can make a mission runnable, no field means "approved",
 * and the recovery brief a resumed run is given says so in its own text: the record is
 * CONTEXT, and a crash is never a way to obtain authorisation.
 */

import type { DurableStore } from '../../../persistence/store.ts'
import type { Recorder } from '../../../persistence/recorder.ts'
import { resumeMission, type ResumeObligation } from '../../../persistence/recover.ts'

/**
 * Mission states that owe nothing: the mission reached an end and its record explains it.
 *
 * Everything else - including states a crash can leave behind that are not even in the
 * `MissionState` union (`runGoal`'s chat missions start life persisted as 'running') -
 * is unsettled and belongs in front of a human.
 */
const TERMINAL_STATES = new Set(['complete', 'failed', 'abandoned'])

/**
 * The settlement cross-link (Stage D) as it sits on THIS chain, or nothing.
 *
 * Reads only what the accepted/carried notes wrote (their `detail.phase` marker); every
 * other history row - including the store's own recovery rows - is ignored, so no other
 * part of the ledger can grow a claim of "carried" by accident.
 */
function readCrossLink(
  history: readonly { readonly detail?: unknown }[],
): RecoveryObligation['carriedBy'] {
  let accepted: RecoveryObligation['carriedBy'] = undefined
  let carried: RecoveryObligation['carriedBy'] = undefined
  for (const h of history) {
    const d = h.detail as { phase?: unknown; routeId?: unknown; ledgerMissionId?: unknown; state?: unknown } | undefined
    if (!d || typeof d !== 'object') continue
    if (typeof d.routeId !== 'string') continue
    if (d.phase === 'accepted') {
      // The FIRST note may be superseded by the run's actual end, never by nothing.
      accepted = { routeId: d.routeId }
    } else if (d.phase === 'carried') {
      carried = {
        routeId: d.routeId,
        ...(typeof d.ledgerMissionId === 'string' ? { ledgerMissionId: d.ledgerMissionId } : {}),
        ...(typeof d.state === 'string' ? { endedState: d.state } : {}),
      }
    }
  }
  return carried ?? accepted
}

/** One unsettled mission, described in facts the store can prove. */
export interface RecoveryObligation {
  readonly missionId: string
  readonly objective: string
  /** The state as the store reads it after a restart - nobody is executing anything now. */
  readonly state: string
  readonly startedAt: number
  /** Steps with a durable ATTEMPT and no outcome. Their result is unknown, never assumed. */
  readonly inFlightSteps: readonly { stepId: string; intent: string; tool?: string }[]
  readonly quarantined: boolean
  /** Present only when the record could not even be read - the most quarantined of all. */
  readonly readError?: string
  readonly lastSessionId?: string
  /**
   * The settlement cross-link (Stage D): the fresh run a human's recovery started to carry
   * this objective, as THIS chain recorded it.
   *
   * Read back from the history the accepted/carried notes wrote - never inferred, and never
   * a settlement: the mission row is untouched, and an obligation carrying this field is
   * still listed, still unsettled, still the human's to decide about.
   */
  readonly carriedBy?: {
    readonly routeId: string
    /** The fresh run's LEDGER identity - present only once the run reported one back. */
    readonly ledgerMissionId?: string
    /** The fresh run's own end, as its result stated it. Absent when no end was ever recorded. */
    readonly endedState?: string
  }
}

/**
 * Every unsettled mission on disk, oldest first.
 *
 * Read-only BY CONSTRUCTION: each lookup goes through `readMission(id, { readonly: true })`,
 * whose suppression is what keeps a server start from consuming recovery for missions the
 * human has not asked to settle. (The alternative - `listHistory` in query.ts - performs
 * the consuming read on every mission it touches and would rewrite an interrupted step
 * back to `pending` merely by reporting it.)
 */
export function listObligations(store: DurableStore): RecoveryObligation[] {
  const out: RecoveryObligation[] = []
  for (const id of store.listMissionIds()) {
    let r: ReturnType<DurableStore['readMission']>
    try {
      r = store.readMission(id, { readonly: true })
    } catch (err) {
      // A record whose own rows cannot be parsed still owes the human an account, and the
      // production path must not HANG or crash on it. (`readMission` parses evidence
      // payloads unguarded, so a corrupted payload throws rather than reaching the store's
      // quarantine classification - measured. Surfaced here as the most quarantined of
      // obligations: unreadable, inspect the ledger directly, never resumed.)
      out.push({
        missionId: id,
        objective: '(the record could not be read)',
        state: 'unreadable',
        startedAt: 0,
        inFlightSteps: [],
        quarantined: true,
        readError: err instanceof Error ? err.message : String(err),
      })
      continue
    }
    if (!r) continue
    if (TERMINAL_STATES.has(r.mission.state)) continue
    const carriedBy = readCrossLink(r.mission.history)
    out.push({
      missionId: id,
      objective: r.mission.objective,
      state: r.mission.state,
      startedAt: r.mission.startedAt,
      inFlightSteps: r.mission.plan
        .filter((s) => s.status === 'running')
        .map((s) => ({ stepId: s.id, intent: s.intent, tool: s.tool })),
      quarantined: r.recovery.kind === 'quarantined',
      lastSessionId: r.recovery.lastSessionId,
      ...(carriedBy ? { carriedBy } : {}),
    })
  }
  return out.sort((a, b) => a.startedAt - b.startedAt)
}

/**
 * What the window is told, in words.
 *
 * Written as prose because this is a sentence a person acts on, and a structured field
 * naming "recovery: true" is one screen away from being ignored. It states the three
 * things that must never be smoothed over: an action was ATTEMPTED and its outcome is
 * unknown, nothing has been re-run, and the record authorises nothing.
 */
export function obligationNotice(obligations: readonly RecoveryObligation[]): string {
  if (obligations.length === 0) return ''
  const lines: string[] = [
    `DURABLE RECOVERY: ${obligations.length} mission(s) from a previous session were interrupted and are NOT settled.`,
  ]
  for (const o of obligations) {
    lines.push(
      o.inFlightSteps.length
        ? `Mission ${o.missionId} ("${o.objective}") was still mid-flight when the previous session ended. `
          + `Step(s) ${o.inFlightSteps.map((s) => `"${s.intent}" (${s.stepId}, tool ${s.tool ?? 'unknown'})`).join(', ')} `
          + 'have a durably recorded ATTEMPT and NO recorded outcome: whether the action reached the machine is UNKNOWN.'
        : `Mission ${o.missionId} ("${o.objective}") was interrupted mid-mission (state: ${o.state}); `
          + 'no step was in flight and the mission never reached a final state.',
    )
    if (o.quarantined) {
      lines.push('  This record is QUARANTINED - it failed its own consistency checks and must not be resumed; '
        + 'inspect the ledger directly.')
      if (o.readError) lines.push(`  The record could not even be read: ${o.readError}`)
    }
    if (o.carriedBy) {
      // THE CROSS-LINK, SURFACED (Stage D). Still nothing but facts: the obligation above is
      // listed and remains listed, and this paragraph never settles it - it tells the human
      // what a previous settlement already did so that acting again is a decision, not a
      // duplicate stumbled into.
      const from = `A fresh run (route ${o.carriedBy.routeId}`
        + `${o.carriedBy.ledgerMissionId ? `, ledger mission ${o.carriedBy.ledgerMissionId}` : ''})`
        + " was started by a human's recovery to carry this objective"
      lines.push(
        o.carriedBy.endedState === 'completed'
          ? `  ${from} and ended completed. This chain itself never reached a final state, so it stays `
            + 'listed: recovering it AGAIN would repeat work already carried out.'
          : o.carriedBy.endedState
            ? `  ${from} and ended ${o.carriedBy.endedState} - the objective was NOT carried. Settling `
              + 'this chain again remains a human\'s explicit decision.'
            : `  ${from}, and no outcome for it was ever recorded on this chain. If that run also died, `
              + 'it is listed here as its own obligation.',
      )
    }
  }
  lines.push(
    'NOTHING has been re-run and nothing is being re-run: a persisted record is not an instruction. '
    + 'To read the full record: GET /recovery. To settle ONE interrupted mission - as a FRESH governed run '
    + '(fresh observation, fresh plan, fresh approvals; the old record is context, never authority): '
    + 'POST /recover with { "missionId": "<id>" }.',
  )
  return lines.join('\n')
}

export type ResumeDecision =
  | {
      readonly kind: 'resume'
      readonly missionId: string
      readonly objective: string
      /** The goal for the FRESH run: the original objective plus the recovery brief below. */
      readonly goal: string
      /** What the window is told this resume is doing, in words. */
      readonly notice: string
      /** The permit's obligations, verbatim - surfaced alongside the run, never acted on here. */
      readonly obligations: readonly ResumeObligation[]
    }
  | {
      readonly kind: 'refuse'
      readonly reason: string
      /** True only for "that mission is not on disk", so the route can answer 404 vs 409. */
      readonly unknown: boolean
    }

/**
 * Decide whether one interrupted mission may be settled, and if so, as what.
 *
 * The shape mirrors `/approve` on purpose: an exact mission id or a refusal, never a
 * guess. Three refusals are possible and each is fail-closed - the mission is not on
 * disk, the mission already ended, or the record is quarantined. Only the fourth answer
 * starts anything, and what it starts is a new mission through the ordinary governed
 * pipeline; nothing of the old chain is executed.
 */
export function composeResume(store: DurableStore, missionId: string): ResumeDecision {
  // 1. THE CHECK NEVER CONSUMES. A look must not settle: if any of the refusals below
  //    applies, the interrupted step stays exactly as the crash left it.
  let observed: ReturnType<DurableStore['readMission']>
  try {
    observed = store.readMission(missionId, { readonly: true })
  } catch (err) {
    // A record whose rows cannot even be parsed is the most quarantined of all, and it
    // REFUSES rather than resuming on an unreadable history - measured: `readMission`
    // parses evidence payloads unguarded, so corruption throws before the store's own
    // quarantine classification can answer. A settlement channel that hung or 500ed here
    // would be worse than either refusal.
    return {
      kind: 'refuse',
      reason: `mission ${missionId} exists but its record could not be read: `
        + `${err instanceof Error ? err.message : String(err)}. Inspect the ledger directly.`,
      unknown: false,
    }
  }
  if (!observed) {
    return {
      kind: 'refuse',
      reason: `no mission ${missionId} is on disk; a recovery names the exact mission it settles`,
      unknown: true,
    }
  }
  if (TERMINAL_STATES.has(observed.mission.state)) {
    return {
      kind: 'refuse',
      reason: `mission ${missionId} already ended (${observed.mission.state}); there is nothing to resume`,
      unknown: false,
    }
  }
  if (observed.recovery.kind === 'quarantined') {
    return {
      kind: 'refuse',
      reason: `mission ${missionId} is QUARANTINED: ${observed.recovery.reason}. `
        + 'A quarantined record must not be resumed - inspect the ledger directly.',
      unknown: false,
    }
  }

  // 2. THE HUMAN ASKED - and only now does the CONSUMING read happen. `resumeMission`
  //    returns obligations (re-observe always, re-obtain-approval for anything
  //    consequential, recover-step for what was in flight), never permission, and
  //    `requiresApproval: () => true` is the strictly conservative reading: the fresh
  //    run's approval store holds nothing, so every consequential step asks again.
  const permit = resumeMission(store, missionId, { requiresApproval: () => true })
  if (!permit) {
    return {
      kind: 'refuse',
      reason: `mission ${missionId} was on disk a moment ago and is gone; refusing rather than guessing`,
      unknown: true,
    }
  }
  const quarantined = permit.obligations.find((o) => o.kind === 'quarantined')
  if (quarantined && quarantined.kind === 'quarantined') {
    // Belt and braces: the consuming read re-derives the verdict, and if it disagrees
    // with the check above the record is not trustworthy enough to resume on.
    return {
      kind: 'refuse',
      reason: `mission ${missionId} is quarantined on read: ${quarantined.detail}`,
      unknown: false,
    }
  }

  // 3. THE BRIEF. The planner of the fresh run is told what the ledger knows - an action
  //    recorded as ATTEMPTED with no outcome - and told in the same breath that this
  //    context authorises nothing. A model that skipped a guard "because the record said
  //    so" would be reading this text wrongly, and the text says so.
  const goalLines: string[] = [
    permit.mission.objective,
    '',
    '--- RECOVERY BRIEF (context; it authorises nothing) ---',
    'A previous session was interrupted while pursuing this objective. The durable ledger records:',
  ]
  for (const sid of permit.recoveredSteps) {
    const step = permit.mission.plan.find((s) => s.id === sid)
    goalLines.push(
      `- step ${sid} ("${step?.intent ?? 'unknown intent'}", tool ${step?.tool ?? 'unknown'}) has a durably `
      + 'recorded ATTEMPT and NO recorded outcome. Whether the action reached the machine is UNKNOWN: '
      + 'do not assume it happened, and do not assume it did not. The machine must be OBSERVED, not remembered.',
    )
  }
  for (const o of permit.obligations) {
    if (o.kind === 're-observe') {
      goalLines.push('- re-observe the machine before acting: the old plan was built on an observation no living process made.')
    } else if (o.kind === 'revalidate-plan') {
      goalLines.push(`- revalidate the plan against the world: ${o.detail}`)
    } else if (o.kind === 're-obtain-approval') {
      goalLines.push(`- step ${o.stepId} is consequential and requires a fresh human decision in THIS run; approvals do not survive a restart.`)
    }
  }
  goalLines.push(
    'Plan the remaining work from a FRESH observation, accounting for the unknown-outcome step(s) above. '
    + 'The record above is context and authorises nothing: no step may skip a guard, an approval or a '
    + 'verification because of it, and work the old session may have half-done must be checked before it is repeated.',
  )

  const notice = [
    `Resuming interrupted mission ${missionId} ("${permit.mission.objective}") as a NEW governed run.`,
    permit.recoveredSteps.length
      ? `Unknown-outcome step(s) carried into the brief as UNKNOWN: ${permit.recoveredSteps.join(', ')}.`
      : 'No step was in flight when the session ended; the mission simply never settled.',
    'Every consequential step of the resumed run requires a FRESH decision at the window; no old approval carries.',
  ].join(' ')

  return {
    kind: 'resume',
    missionId,
    objective: permit.mission.objective,
    goal: goalLines.join('\n'),
    notice,
    obligations: permit.obligations,
  }
}

// ===========================================================================================
// STAGE D: THE SETTLEMENT CROSS-LINK - THE INTERRUPTED CHAIN NAMES ITS FRESH RUN
// ===========================================================================================
//
// The problem, stated exactly: `POST /recover` returns a ROUTE id (the run's identity in the
// window and the reply), but the ledger rows of the fresh run live under runGoal's INTERNAL
// mission id, which does not exist until the run creates it - after the 202 has already gone
// out. A cross-link written at 202 time with only the route id would be a dangling reference
// to nothing in the ledger; a cross-link written only at completion would leave nothing on
// the old chain if the fresh run died on the way.
//
// So the link is written in TWO durable facts, both on the OLD chain, both by the settlement
// path only, and they join exactly because the second one names both ids:
//
//   1. accepted  - at 202 time: a fresh run (route <id>) started to carry this objective.
//                  Covers the crash window: if the process dies before the run ever ends,
//                  the old chain still says a recovery was in flight for it.
//   2. carried   - when the run ends: runGoal's internal ledger id + the route id + how it
//                  ended. This is the honest solve for the two-id problem - the internal id
//                  exists only here, and this note reports it back into the old chain.
//
// NEITHER note touches the old mission's row: no state change, no outcome, no ending. The
// old chain never claims an ending it never reached and never becomes settled by being
// carried - obligations are surfaced, never auto-settled, and these notes are facts a human
// reads, never a settlement, never authority. The first note THROWS when the ledger cannot
// take it (the route then refuses before anything starts, fail-closed); the second is
// announced rather than fatal, because at that point the fresh run has already ended and a
// bookkeeping write may not repaint that.

/**
 * Note 1 (accepted side): a human's settlement was accepted and a fresh run was started.
 *
 * Written BEFORE the run exists - only `routeId` is knowable here. Throws when the ledger
 * cannot record it, so the route can refuse to start the run at all.
 */
export function noteRecoveryAccepted(
  note: Pick<Recorder, 'note'>,
  missionId: string,
  routeId: string,
): void {
  note.note(missionId, 'recovery',
    `resume accepted: fresh governed run (route ${routeId}) started to carry this objective; `
    + 'its outcome is recorded on this chain when it ends',
    { phase: 'accepted', routeId })
}

/**
 * Note 2 (carried side): the fresh run reported back - its LEDGER identity and its end.
 *
 * `ledgerMissionId` is null only when the run died before it could report one, and the
 * summary says so rather than inventing an id to point at.
 */
export function noteRecoveryCarried(
  note: Pick<Recorder, 'note'>,
  missionId: string,
  fact: {
    readonly routeId: string
    readonly ledgerMissionId: string | null
    readonly state: 'completed' | 'cancelled' | 'failed'
    readonly ok: boolean
  },
): void {
  const summary = fact.state === 'completed' && fact.ledgerMissionId
    ? `objective carried by fresh resume run ${fact.ledgerMissionId} (route ${fact.routeId}), which ended completed`
    : fact.ledgerMissionId
      ? `fresh resume run ${fact.ledgerMissionId} (route ${fact.routeId}) ended ${fact.state}; `
        + 'the objective was not carried'
      : `resume run (route ${fact.routeId}) ended ${fact.state} before reporting a ledger identity; `
        + 'the objective was not carried'
  note.note(missionId, 'recovery', summary, {
    phase: 'carried',
    routeId: fact.routeId,
    ledgerMissionId: fact.ledgerMissionId,
    state: fact.state,
    ok: fact.ok,
  })
}
