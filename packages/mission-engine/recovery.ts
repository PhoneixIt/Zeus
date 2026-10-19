/**
 * THE RECOVERY CONTRACT.
 * =============================================================================
 * WHAT THIS IS, AND WHY IT IS A CONTRACT RATHER THAN A HOOK
 * =============================================================================
 *
 * The executor decides WHEN to recover. This file decides WHAT recovery is permitted. Those are
 * different responsibilities and merging them is how a system ends up recovering from things it was
 * never meant to touch.
 *
 * The split:
 *
 *   the EXECUTOR   detects a failure (a tool failed, or independent verification rejected the
 *                  result), asks whether recovery is eligible, and if so EXECUTES it through the
 *                  ordinary step path - same gates, same approvals, same verifier, same recorder -
 *                  then re-runs the failed step and verifies again.
 *
 *   THIS POLICY    answers one question: given this failure, is there a recovery that is clearly
 *                  permitted? It supplies the steps. It never runs them.
 *
 * =============================================================================
 * WHAT IS DELIBERATELY NOT RECOVERABLE
 * =============================================================================
 *
 * Four classes, and the rule behind them is that recovery must never widen authority:
 *
 *   1. AUTHORISATION REFUSALS. A step held for a human, or refused, is a decision the human owns.
 *      Re-attempting it automatically is the machine arguing with its own gate.
 *   2. POLICY DENIALS. A step preflight blocked as out-of-scope or not-permitted is not a transient
 *      fault. "Recovering" would mean finding a route around the policy.
 *   3. OUT-OF-SCOPE ACTIONS. Recovery runs in the SAME workspace root as the step it is recovering.
 *      A recovery cannot reach further than the work it is repairing.
 *   4. AMBIGUOUS DESTRUCTIVE OUTCOMES. `outcome-unknown` means the machine may be in a state nobody
 *      can describe. Restoring a file on top of an unknown state could destroy the only record.
 *
 * Each is refused by `isRecoverableFailure` below, and each refusal is a POSITIVE answer saying why,
 * so a caller can report the reason instead of a bare "no".
 */

import type { Step } from './state.ts'
import type { StepOutcome } from './state.ts'

export interface RecoveryRequest {
  readonly missionId: string
  /** The step that failed. */
  readonly step: Step
  /** Why it failed, in words. Never empty - a recovery decision with no stated cause is not auditable. */
  readonly reason: string
  /** The outcome the step produced. */
  readonly outcome: StepOutcome
}

/** Why a failure is not eligible, stated in words. */
export interface Ineligible {
  readonly permitted: false
  readonly reason: string
}

export interface Eligible {
  readonly permitted: true
  readonly reason: string
}

export type Eligibility = Eligible | Ineligible

/**
 * The outcome kinds that may NOT be recovered from.
 *
 * `needs-human` and `refused` are the machine's own gates answering "not without a person". Treating
 * either as a transient fault and retrying it automatically would make the gate advisory.
 *
 * `outcome-unknown` is the dangerous one: the action may or may not have happened, and nobody can say
 * which. Restoring anything on top of that could destroy the only evidence that exists.
 */
export const UNRECOVERABLE_OUTCOMES = new Set<StepOutcome['kind']>([
  'needs-human',
  'replan-required',
  'outcome-unknown',
])

/**
 * Is this failure eligible for automatic recovery at all?
 *
 * A PURE function of the failure, deliberately: eligibility must not depend on anything the recovery
 * itself will change, or the same failure could be eligible on one run and not the next.
 */
export function isRecoverableFailure(outcome: StepOutcome, reason: string): Eligibility {
  if (!reason.trim()) {
    return { permitted: false, reason: 'the failure has no stated cause, so recovery eligibility cannot be judged' }
  }
  if (UNRECOVERABLE_OUTCOMES.has(outcome.kind)) {
    return {
      permitted: false,
      reason: `a "${outcome.kind}" outcome is not recovered automatically: it is the machine's own gate ` +
        `saying this needs a person, needs a replan, or that the world is unknown. Automatic recovery ` +
        `would be arguing with the gate rather than fixing anything.`,
    }
  }
  // A policy refusal is not a fault, so it is not something to recover FROM. Detected by the words,
  // because preflight and the tool both report refusals through this channel.
  if (/(refused by policy|blocked:|not permitted|outside the workspace|\bDISABLED\b|refusing to)/i.test(reason)) {
    return {
      permitted: false,
      reason: 'this is a POLICY refusal rather than a fault, and recovering from it would mean finding a route around the policy',
    }
  }
  return { permitted: true, reason: 'a fault in the execution of an in-scope action' }
}

/**
 * A policy the executor consults when a step fails.
 *
 * `plan` returns the RECOVERY STEPS for a failure, or refuses. It runs nothing. The executor runs
 * them, through the ordinary path, which is what makes a recovery subject to the same authorisation
 * and the same verification as any other work.
 */
export interface RecoveryPolicy {
  /**
   * Upper bound on recoveries per MISSION, enforced by the executor and re-checked here.
   *
   * Declared in two places on purpose: the executor counts, and the policy can refuse earlier. A
   * bound enforced in only one of them is a bound that one of them can forget.
   */
  readonly maxRecoveries: number

  /** The steps that would repair this failure, or a stated refusal. */
  plan(req: RecoveryRequest): { steps: Step[]; reason: string } | Ineligible
}

/**
 * THE BOUNDED BUDGET.
 *
 * Counts recoveries for one mission and refuses past the limit. Owned by the executor and handed to
 * the policy, so the policy cannot spend recoveries the executor has not counted.
 */
export class RecoveryBudget {
  private used = 0
  // Assigned explicitly rather than as a constructor PARAMETER PROPERTY. Parameter properties are
  // compile-time sugar, and Node's type-stripping - which is how every file here runs - rejects them
  // outright rather than ignoring them. `provider.ts` documents the same rule for the same reason.
  private readonly limit: number
  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 0) {
      throw new Error(`a recovery budget must be a non-negative integer, got ${JSON.stringify(limit)}`)
    }
    this.limit = limit
  }
  get remaining(): number { return Math.max(0, this.limit - this.used) }
  get spent(): number { return this.used }
  /** True when another recovery is within the declared bound. */
  available(): boolean { return this.used < this.limit }
  spend(): boolean {
    if (!this.available()) return false
    this.used += 1
    return true
  }
}

/** What a recovery attempt produced. The executor uses this to decide whether to retry the step. */
export interface RecoveryAttempt {
  /** Did the recovery steps themselves complete AND verify? */
  readonly recovered: boolean
  /** Human-readable account, recorded durably whatever the outcome. */
  readonly summary: string
  /** The recorded outcomes of the recovery steps, for the store and for the report. */
  readonly outcomes: ReadonlyArray<{ stepId: string; outcome: StepOutcome }>
  /** Set when recovery was attempted and did not work - never silently swallowed. */
  readonly failure?: string
}