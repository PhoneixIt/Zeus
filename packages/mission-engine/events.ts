/**
 * Structured execution events.
 *
 * Section 31 requires the user to be able to understand what the AI is doing, and the audit
 * requirements ask that every execution answer ten questions: what mission, which step, which
 * tool, what result, what evidence, why the transition, what failed, was a retry attempted,
 * was human intervention required, and why the mission finished.
 *
 * These are the answers, typed. There is deliberately no UI here and no log formatting: an
 * audit layer consumes these directly, and a human-facing view is built later on top. Building
 * the view first is how audit trails end up describing the UI rather than the truth.
 *
 * EVERY event carries the mission id and the sequence number. An audit trail that cannot be
 * ordered is not an audit trail, and reconstructing order after the fact from timestamps
 * across processes is guesswork.
 */

import type { Evidence, ExecutionMode, MissionState, StepOutcome, PlanInvalidation } from './state.ts'

export type ExecutionEvent =
  /** The executor began. Carries the resolved plan shape so the trail starts complete. */
  | {
      type: 'mission-started'
      seq: number
      at: number
      missionId: string
      objective: string
      stepCount: number
      /** Steps whose dependencies could never be satisfied, detected before running. */
      unsatisfiable: readonly string[]
    }
  /** A step was selected to run, and why it was eligible now. */
  | {
      type: 'step-started'
      seq: number
      at: number
      missionId: string
      stepId: string
      intent: string
      mode: ExecutionMode
      tool: string | null
      attempt: number
      /** Dependencies already satisfied, for the record. */
      dependenciesSatisfied: readonly string[]
    }
  /** The tool router resolved a capability. Recorded so "which tool" is never a guess. */
  | {
      type: 'tool-selected'
      seq: number
      at: number
      missionId: string
      stepId: string
      requested: string | null
      selected: string
      /** True when the requested tool was unavailable and a declared fallback was used. */
      fellBack: boolean
      reason: string
    }
  /**
   * The tool returned. Recorded SEPARATELY from verification, because conflating them is the
   * original defect: "ran" and "worked" are different claims.
   */
  | {
      type: 'tool-returned'
      seq: number
      at: number
      missionId: string
      stepId: string
      attempt: number
      ok: boolean
      /** Truncated deliberately: an audit trail is not a data store for large payloads. */
      summary: string
      durationMs: number
    }
  /**
   * Independent verification ran and produced a verdict.
   *
   * This is the event that matters most. It carries the evidence and whether it actually
   * satisfied the step, so "completed" is always traceable to an observation rather than to
   * the tool's own opinion of itself.
   */
  | {
      type: 'evidence-verified'
      seq: number
      at: number
      missionId: string
      stepId: string
      attempt: number
      accepted: boolean
      evidence: Evidence | null
      reason: string
    }
  /** A state transition, always with the reason. A transition without a cause is unreadable. */
  | {
      type: 'state-transition'
      seq: number
      at: number
      missionId: string
      stepId: string | null
      from: string
      to: string
      reason: string
    }
  /** A bounded retry, with the bound that allowed it and the count so far. */
  | {
      type: 'retry'
      seq: number
      at: number
      missionId: string
      stepId: string
      attempt: number
      maxAttempts: number
      reason: string
    }
  /** Retries are exhausted. Distinct from failure: the CAUSE was retry exhaustion. */
  | {
      type: 'retry-exhausted'
      seq: number
      at: number
      missionId: string
      stepId: string
      attempts: number
      lastOutcome: StepOutcome
    }
  /** A dependency held a step back. */
  | {
      type: 'dependency-blocked'
      seq: number
      at: number
      missionId: string
      stepId: string
      blockedBy: string
      reason: string
    }
  /** The executor refused to proceed without a human. */
  | {
      type: 'human-required'
      seq: number
      at: number
      missionId: string
      stepId: string | null
      reason: string
    }
  /** The executor itself stopped: emergency stop, or an external cancel. */
  | {
      type: 'execution-halted'
      seq: number
      at: number
      missionId: string
      reason: string
      /** 'emergency-stop' outranks 'cancelled' outranks 'completed'. */
      cause: 'emergency-stop' | 'cancelled' | 'infrastructure'
      stepId: string | null
    }
  /** The mission reached a terminal state, with the honest reason. */
  | {
      type: 'mission-finished'
      seq: number
      at: number
      missionId: string
      state: MissionState
      complete: boolean
      /** Counts per outcome, so "why did it finish" is answerable without replaying. */
      verified: number
      legitimatelyEmpty: number
      failed: number
  replanRequired: number
      needsHuman: number
  skipped: number
      pending: number
      durationMs: number
    }
  /**
   * The executor's own progress does not match the completion contract.
   *
   * Emitted rather than thrown. This is a self-check (§23): if the executor ever believed a
   * mission complete while isComplete() disagreed, that is a defect in the executor and must
   * be visible, not silently reconciled.
   */
  | {
      type: 'integrity-violation'
      seq: number
      at: number
      missionId: string
      detail: string
    }

/** Flattened record shape, for storage and for an audit view built later. */
export interface ExecutionRecord {
  readonly missionId: string
  readonly startedAt: number
  readonly finishedAt?: number
  readonly events: readonly ExecutionEvent[]
  readonly finalState: MissionState
  readonly complete: boolean
  /** Convenience index: every step id that reached a verified outcome, with its evidence. */
  readonly verified: Readonly<Record<string, Evidence>>
}

/** Answers the ten audit questions from a record alone, with no replay required. */
export interface ExecutionSummary {
  mission: string
  objective: string
  finalState: MissionState
  complete: boolean
  stepsRun: number
  toolsUsed: readonly string[]
  results: readonly { stepId: string; ok: boolean; summary: string }[]
  evidence: Readonly<Record<string, Evidence>>
  transitions: readonly { stepId: string | null; from: string; to: string; reason: string }[]
  failures: readonly { stepId: string; reason: string }[]
  retries: readonly { stepId: string; attempt: number; reason: string }[]
  humanRequired: readonly { stepId: string | null; reason: string }[]
  finishReason: string
  integrityViolations: readonly string[]
}

export function summarize(r: ExecutionRecord): ExecutionSummary {
  const pick = <T>(pred: (e: ExecutionEvent) => boolean): readonly ExecutionEvent[] =>
    r.events.filter(pred)

  const started = pick((e) => e.type === 'mission-started')[0]
  const finished = pick((e) => e.type === 'mission-finished')[0]

  const failures = pick((e) => e.type === 'tool-returned' && !e.ok)
    .concat(pick((e) => e.type === 'retry-exhausted'))
    .map((e) => {
      if (e.type === 'retry-exhausted') {
        return { stepId: e.stepId, reason: `retries exhausted after ${e.attempts}: ${e.lastOutcome.reason ?? e.lastOutcome.kind}` }
      }
      return { stepId: (e as { stepId: string }).stepId, reason: e.summary }
    })

  return {
    mission: r.missionId,
    objective: started && started.type === 'mission-started' ? started.objective : '(unknown)',
    finalState: r.finalState,
    complete: r.complete,
    stepsRun: pick((e) => e.type === 'step-started').length,
    toolsUsed: pick((e) => e.type === 'tool-selected').map((e) => (e as { selected: string }).selected),
    results: pick((e) => e.type === 'tool-returned').map((e) => ({
      stepId: (e as { stepId: string }).stepId,
      ok: (e as { ok: boolean }).ok,
      summary: (e as { summary: string }).summary,
    })),
    evidence: r.verified,
    transitions: pick((e) => e.type === 'state-transition').map((e) => {
      const t = e as { stepId: string | null; from: string; to: string; reason: string }
      return { stepId: t.stepId, from: t.from, to: t.to, reason: t.reason }
    }),
    failures,
    retries: pick((e) => e.type === 'retry').map((e) => {
      const t = e as { stepId: string; attempt: number; reason: string }
      return { stepId: t.stepId, attempt: t.attempt, reason: t.reason }
    }),
    humanRequired: pick((e) => e.type === 'human-required').map((e) => {
      const h = e as { stepId: string | null; reason: string }
      return { stepId: h.stepId, reason: h.reason }
    }),
    finishReason: finished && finished.type === 'mission-finished'
      ? `${finished.state}: ${finished.verified} verified, ${finished.failed} failed, ${finished.needsHuman} needing human, ${finished.skipped} skipped, ${finished.replanRequired} needing replan, ${finished.pending} pending`
      : '(did not finish)',
    integrityViolations: pick((e) => e.type === 'integrity-violation').map((e) => (e as { detail: string }).detail),
  }
}
