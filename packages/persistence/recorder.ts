/**
 * DURABLE RECORDING: the write-ahead discipline for the executor.
 *
 * =============================================================================
 * WHY THIS FILE EXISTS
 * =============================================================================
 *
 * M15 built a durable store and proved it in isolation. Nothing wrote to it, so a crash still lost
 * the history. This file is the seam, and the seam is where the interesting part lives.
 *
 * A persistence layer wired into an executor has one dangerous failure mode that a store alone does
 * not have: **the real world changes, and then the record of that change is lost.** Every other
 * failure is survivable by retrying. This one is not - a retried action is a second action.
 *
 * =============================================================================
 * THE ORDERING, AND WHY IT IS WRITE-AHEAD
 * =============================================================================
 *
 *     1. record  "about to act"     <- BEFORE the action
 *     2. ACT                          <- the real machine changes here
 *     3. record  "what came back"
 *     4. verify (an independent read)
 *     5. record  the evidence
 *     6. derive the step state from those durable facts
 *
 * Step 1 before step 2 is what makes a crash recoverable rather than mysterious. If the process dies
 * between 1 and 2 the record says an action was ATTEMPTED and nothing more - which is a safe,
 * recoverable state. Without the write-ahead, a crash during step 2 leaves a record that says the
 * step never ran, and the natural response is to run it again.
 *
 * =============================================================================
 * THE RULE THIS FILE ENFORCES
 * =============================================================================
 *
 *   A TOOL FAILURE AND A PERSISTENCE FAILURE ARE DIFFERENT THINGS AND MUST NEVER BE MERGED.
 *
 * If step 3 fails, the honest state is `outcome-unknown`, NOT `failed`. Calling it `failed` asserts
 * the action did not take effect, which is precisely the "failed, therefore safe to retry" reading
 * that turns a lost record into a duplicated one.
 *
 * A caller cannot opt out of this. `Recorder.recordAttemptOutcome` throwing is not an error the
 * executor is free to catch and shrug off - it changes the step's meaning.
 *
 * =============================================================================
 * WHAT AN SQLITE TRANSACTION CANNOT DO, STATED PLAINLY
 * =============================================================================
 *
 * `tx()` in the store makes a set of ROW WRITES atomic. It cannot make a Windows `ShowWindow`, a
 * browser click, a file write or a process launch atomic, and no amount of transaction nesting will
 * change that. The database and the machine are separate systems with no shared journal.
 *
 * So this file never claims a rollback. When a transaction is rolled back, rows revert and the
 * machine does not. Where that matters the step is marked uncertain and a human - or a fresh
 * observation - has to resolve it.
 */

import type { DurableStore } from './store.ts'
import type { Mission, Step, StepResult, Evidence, StepOutcome, MissionState } from '../mission-engine/state.ts'
import type { DeclaredEffect } from '../governance/approval.ts'

/** Thrown by any recorder operation. Never swallowed by the executor as a tool failure. */
export class PersistenceFailure extends Error {
  /**
   * Fields declared explicitly rather than as constructor parameter properties.
   *
   * `constructor(readonly x: string)` is TypeScript that node's strip-only loader rejects AT LOAD TIME,
   * with an error pointing at the parameter rather than at the cause. It is already in
   * DEVELOPMENT-RULES.md, and it is here anyway - which is the argument for reading that file rather
   * than for trusting that you remember it.
   */
  readonly transition: string
  readonly missionId: string
  readonly stepId: string | undefined

  constructor(transition: string, missionId: string, stepId: string | undefined, cause: unknown) {
    super(
      `persistence failed at '${transition}'${stepId ? ` for step ${stepId}` : ''}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    )
    this.name = 'PersistenceFailure'
    this.transition = transition
    this.missionId = missionId
    this.stepId = stepId
  }
}

/** Written BEFORE the tool runs. */
export interface AttemptBegin {
  readonly missionId: string
  readonly stepId: string
  readonly attempt: number
  readonly tool?: string
  readonly intent: string
  readonly mode: string
  readonly args?: Readonly<Record<string, unknown>>
  readonly effect?: DeclaredEffect
  readonly at: number
}

/** Written AFTER the tool runs - the observation whose loss creates ambiguity. */
export interface AttemptOutcome {
  readonly missionId: string
  readonly stepId: string
  readonly attempt: number
  readonly ok: boolean
  readonly summary?: string
  readonly reason?: string
  readonly durationMs: number
  readonly at: number
  /** The tool's own return, retained so a later reader can see what was claimed. */
  readonly data?: unknown
}

/** Written after an independent verifier has looked. */
export interface Verified {
  readonly missionId: string
  readonly stepId: string
  readonly attempt: number
  readonly evidence: Evidence
  readonly verifier: string
  readonly at: number
}

/**
 * The seam.
 *
 * Every method either completes durably or THROWS. There is no "best effort" variant, because a
 * best-effort recorder is a recorder that reports having recorded something it did not.
 */
export interface Recorder {
  /** The mission exists, with its plan and its proposal identity. */
  missionStarted(mission: Mission): void
  /** A state transition, with the reason. */
  missionTransition(missionId: string, from: MissionState, to: MissionState, why: string, at: number): void
  /** WRITE-AHEAD. Recorded BEFORE the tool runs. */
  attemptBegin(e: AttemptBegin): void
  /** The tool's outcome. A throw here means the outcome is UNKNOWN, not failed. */
  attemptOutcome(e: AttemptOutcome): void
  /** Independent verification, with its provenance. */
  verified(e: Verified): void
  /** The derived step result. */
  stepResult(missionId: string, stepId: string, result: StepResult, at: number): void
  /** The mission reached a terminal state. */
  missionEnded(missionId: string, state: MissionState, complete: boolean, at: number): void
  /** A durable note - replans, recoveries, quarantine reasons. */
  note(missionId: string, kind: 'recovery' | 'invalidation' | 'note', summary: string, detail?: unknown, at?: number): void
}

/**
 * A recorder backed by the durable store.
 *
 * `failAt` exists for the failure-injection controls and defaults to never failing. It is a seam, not
 * a fault: the tests need to break the database at a chosen transition, and the only honest way to do
 * that is to say where.
 */
export class StoreRecorder implements Recorder {
  private readonly store: DurableStore
  private readonly now: () => number
  /** Transition name -> throw. Injected only by tests. */
  readonly failAt: (transition: string) => string | undefined

  constructor(store: DurableStore, failAt: (transition: string) => string | undefined = () => undefined) {
    this.store = store
    this.now = () => store.session.startedAt
    this.failAt = failAt
  }

  private guard<T>(transition: string, missionId: string, stepId: string | undefined, fn: () => T): T {
    const forced = this.failAt(transition)
    if (forced !== undefined) {
      throw new PersistenceFailure(transition, missionId, stepId, forced)
    }
    try {
      return fn()
    } catch (e) {
      if (e instanceof PersistenceFailure) throw e
      throw new PersistenceFailure(transition, missionId, stepId, e)
    }
  }

  missionStarted(mission: Mission): void {
    this.guard('missionStarted', mission.id, undefined, () => {
      this.store.saveMission(mission)
      this.store.appendHistory(mission.id, {
        at: this.now(),
        kind: 'note',
        summary: `mission started: "${mission.objective}"`,
        detail: {
          proposalDigest: mission.proposalDigest ?? null,
          steps: mission.plan.length,
          session: this.store.session.sessionId,
        },
      })
    })
  }

  missionTransition(missionId: string, from: MissionState, to: MissionState, why: string, at: number): void {
    this.guard('missionTransition', missionId, undefined, () => {
      this.store.appendHistory(missionId, { at, kind: 'note', summary: `mission ${from} -> ${to}: ${why}` })
    })
  }

  attemptBegin(e: AttemptBegin): void {
    this.guard('attemptBegin', e.missionId, e.stepId, () => {
      this.store.saveMission({
        ...this.currentMissionRow(e.missionId),
        plan: this.withStep(e.missionId, e.stepId, { status: 'running', attempts: e.attempt }),
      } as Mission)
      this.store.appendHistory(e.missionId, {
        at: e.at,
        kind: 'step',
        summary: `attempt ${e.attempt} of "${e.intent}" BEGINNING (write-ahead)`,
        detail: { stepId: e.stepId, tool: e.tool ?? null, args: e.args ?? null, effect: e.effect ?? null },
      })
    })
  }

  attemptOutcome(e: AttemptOutcome): void {
    this.guard('attemptOutcome', e.missionId, e.stepId, () => {
      this.store.appendHistory(e.missionId, {
        at: e.at,
        kind: 'step',
        summary: `attempt ${e.attempt} returned ${e.ok ? 'data' : 'a non-success'}: ${e.summary ?? e.reason ?? ''}`,
        detail: { stepId: e.stepId, ok: e.ok, durationMs: e.durationMs, data: e.data ?? null },
      })
      // The step is NOT marked done or failed here. The result is recorded, and the step's status is
      // derived from durable facts afterwards - because at this point nobody has verified anything.
    })
  }

  verified(e: Verified): void {
    this.guard('verified', e.missionId, e.stepId, () => {
      this.store.recordEvidence({
        missionId: e.missionId,
        stepId: e.stepId,
        evidence: e.evidence,
        provenance: `verifier: ${e.verifier}`,
        verifier: e.verifier,
        observedAt: e.at,
        observedBy: 'live-verifier',
      })
      this.store.appendHistory(e.missionId, {
        at: e.at,
        kind: 'observation',
        summary: `verified by ${e.verifier}: ${(e.evidence as { kind?: string }).kind ?? 'evidence'}`,
        detail: { stepId: e.stepId, evidence: e.evidence },
      })
      // Settle the step. `verified` used to record proof that the step had completed and then
      // leave its persisted status at `running` - so the store simultaneously held independent
      // evidence that the action was DONE and a status saying it was still in flight. On the
      // next resume, `readMission` classified that `running` as an interrupted step and issued
      // a `recover-step` obligation, which is the instruction to go and perform an action that
      // had already been independently proved. Repeated proved work is not a safe default.
      //
      // Only a step that is currently `running` is settled. A step that is already `done` or
      // `failed` keeps its status, so this can never resurrect or overwrite a settled outcome.
      const current = this.currentMissionRow(e.missionId)
      const step = current.plan.find((s) => s.id === e.stepId)
      if (step && step.status === 'running') {
        this.store.saveMission({
          ...current,
          plan: current.plan.map((s) => (s.id === e.stepId ? { ...s, status: 'done' as const } : s)),
        } as Mission)
      }
    })
  }

  stepResult(missionId: string, stepId: string, result: StepResult, at: number): void {
    this.guard('stepResult', missionId, stepId, () => {
      this.store.saveMission({
        ...this.currentMissionRow(missionId),
        plan: this.withStep(missionId, stepId, { status: statusFor(result.outcome), result }),
      } as Mission)
      this.store.appendHistory(missionId, {
        at,
        kind: 'step',
        summary: `step ${stepId} recorded as ${result.outcome.kind}`,
        detail: result as unknown,
      })
    })
  }

  missionEnded(missionId: string, state: MissionState, complete: boolean, at: number): void {
    this.guard('missionEnded', missionId, undefined, () => {
      const row = this.currentMissionRow(missionId)
      this.store.saveMission({ ...row, state, finishedAt: at } as Mission)
      this.store.appendHistory(missionId, {
        at,
        kind: 'note',
        summary: `mission ended: ${state}${complete ? ' (complete)' : ''}`,
      })
    })
  }

  note(missionId: string, kind: 'recovery' | 'invalidation' | 'note', summary: string, detail?: unknown, at?: number): void {
    this.guard('note', missionId, undefined, () => {
      this.store.appendHistory(missionId, { at: at ?? this.now(), kind, summary, detail })
    })
  }

  // ---------------------------------------------------------------- helpers

  private currentMissionRow(missionId: string): Mission {
    // `readMissionForWrite`, not `readMission`, and the difference is load-bearing.
    // `readMission` rewrites a persisted `running` step to `pending`, because a RESUMING reader
    // must not believe a dead process is still executing it. A writer that read through that
    // would write `pending` back over its own write-ahead: `attemptBegin`'s `running` survived
    // only until the next recorder call, and an interrupted step was then reported as never
    // having started - so no recovery obligation was ever produced. See
    // `DurableStore.readMissionForWrite`.
    const m = this.store.readMissionForWrite(missionId)
    if (!m) {
      throw new PersistenceFailure('readMission', missionId, undefined, 'the mission is not in the durable store')
    }
    return m
  }

  private withStep(missionId: string, stepId: string, patch: Partial<Step>): Step[] {
    const m = this.currentMissionRow(missionId)
    return m.plan.map((s) => (s.id === stepId ? { ...s, ...patch } : s))
  }
}

/** The durable status implied by an outcome. `uncertain` is the M16 addition. */
export function statusFor(outcome: StepOutcome): Step['status'] {
  switch (outcome.kind) {
    case 'verified': return 'done'
    case 'legitimately-empty': return 'done'
    case 'failed': return 'failed'
    case 'skipped': return 'skipped'
    case 'outcome-unknown': return 'uncertain'
    default: return 'failed'
  }
}

/**
 * Build the outcome for "the action may have happened and the record of it is gone".
 *
 * This is the single most important constructor in M16, and it deliberately does NOT accept a boolean
 * like `maybeSucceeded`. It takes what was durably known BEFORE the action, so the reconciliation
 * note can say what was attempted, by which tool, against which operands - because that is what a
 * person needs in order to look at the machine and decide.
 */
export function uncertainOutcome(args: {
  reason: string
  attempt: number
  step: Step
  persistenceError: string
}): StepOutcome {
  return {
    kind: 'outcome-unknown',
    reason: args.reason,
    attempt: args.attempt,
    attempted: { tool: args.step.tool, intent: args.step.intent, args: args.step.args },
    persistenceError: args.persistenceError,
  }
}