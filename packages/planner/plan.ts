/**
 * THE PLAN CONTRACT.
 *
 * What a planner produces. Nothing more.
 *
 * WHY THIS IS NOT `Mission`
 *
 * `Mission` is the EXECUTOR's state: it carries `state`, `history`, `pendingApprovals`,
 * `startedAt`, `invalidatedBy`. A planner has no business producing or knowing any of that -
 * the moment a planner emits a `Mission` it owns execution state it cannot influence, and the
 * separation between "proposing" and "deciding" collapses.
 *
 * So the planner emits a `PlanProposal`, and a separate, tested adapter (`compile.ts`) turns it
 * into a `Mission`. That adapter is the boundary: an eventual model emits the same
 * `PlanProposal` and nothing downstream changes.
 *
 * The rule this enforces, stated once so it can be tested:
 *
 *   THE PLANNER PROPOSES. THE EXECUTOR DECIDES WHAT MAY RUN.
 *
 * FIELD-BY-FIELD, AND WHY EACH IS HERE
 *
 *   objective      the user's words, verbatim. Not a paraphrase: the audit has to be able to
 *                  show what was actually asked for.
 *   constraints    what the plan is forbidden to do. Carried on the mission so every later
 *                  reader - human or auditor - sees the limits alongside the steps.
 *   steps          the work.
 *   expectedResult what "done" means in the user's terms, stated before execution rather than
 *                  inferred afterwards from whatever happened.
 *
 * Every other field a plan might want is deliberately absent. `status`, `result`, `evidence`,
 * `attempts` and `durationMs` belong to the executor. A planner that could set them could
 * declare success, which is the one thing this whole system exists to prevent.
 */

import type { ExecutionMode } from '../mission-engine/state.ts'

/**
 * What must be independently established before a step may count as done.
 *
 * A requirement, NOT a result. This is the planner saying "here is what would prove this
 * worked"; the verifier decides whether it did. Keeping those apart is what stops a plan from
 * being able to assert its own success.
 *
 * `kind` is a short discriminator so a router or UI can reason about the requirement without
 * parsing prose. `description` is the human-readable form, because a human will read it.
 */
export interface VerificationRequirement {
  /**
   * - `independent-source`  corroborate from a different mechanism than the one that acted
   * - `must-exist`          the artefact is present on disk
   * - `must-contain`        the artefact holds something specific
   * - `must-read-back`      re-reading the artefact yields what was written
   */
  readonly kind: 'independent-source' | 'must-exist' | 'must-contain' | 'must-read-back'
  readonly description: string
}

/** What should happen if this step cannot complete. */
export type FailureBehaviour = 'abort-mission' | 'continue' | 'replan'

/** One proposed step. A proposal, not an instruction to the executor. */
export interface PlanStep {
  readonly id: string
  /** Human-readable, because a human will read the plan before approving it. */
  readonly intent: string
  readonly mode: ExecutionMode
  /** The capability this step needs. The router maps it to an implementation, or fails. */
  readonly tool: string
  /**
   * What this step operates ON.
   *
   * Every operand the plan uses appears here, validated, rather than being implied by prose in
   * `intent`. A path in a sentence is not an operand; a validated path in `args` is.
   */
  readonly args: Readonly<Record<string, unknown>>
  readonly dependsOn: readonly string[]
  /** Why this step is needed - what breaks without it. */
  readonly rationale: string
  readonly verification: VerificationRequirement
  readonly onFailure: FailureBehaviour
}

/** A complete proposed plan. */
export interface PlanProposal {
  /** The user's objective, verbatim. */
  readonly objective: string
  readonly constraints: readonly string[]
  readonly steps: readonly PlanStep[]
  /** What "done" means, in the user's terms, decided before execution. */
  readonly expectedResult: string
}

/**
 * Planning either produces a proposal or explains why it cannot.
 *
 * A discriminated union rather than a thrown error, because "I could not plan this" is an
 * OUTCOME the system must be able to record and show, not an exception it has to survive. A
 * planner that throws takes the decision out of the recorded history.
 */
export type PlanResult =
  | { readonly ok: true; readonly proposal: PlanProposal }
  | {
      readonly ok: false
      /** Why no plan was produced, in words a user can act on. */
      readonly reason: string
      /** What this planner recognised but cannot honour. Empty when nothing matched. */
      readonly unsupported: readonly string[]
    }

/** Facts about the request that are not part of the objective text. */
export interface PlanContext {
  /**
   * Where output may be written. A hard boundary, supplied by the caller rather than derived
   * from the objective - because an objective that names its own output directory is not a
   * constraint, it is a preference.
   */
  readonly outputRoot: string
  /** Injected so a planner can be deterministic in tests and dated later. */
  readonly now: () => number
}