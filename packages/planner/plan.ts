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
// A structural type with no methods. Importing the world's SHAPE is not importing a way to reach the
// world: there is no provider here, no observer, and no function that could re-read the machine.
import type { WorldState } from '../observation/world.ts'
// The DECLARATION of a consequential effect. Imported as a type only, and `governance/approval.ts`
// imports nothing at all, so this cannot become a cycle - and it must stay that way. If approval ever
// needed a planner, that would be the moment this design is wrong: the planner would be able to name
// an effect that the governance layer must then judge, which is a direction of dependence that makes
// "a plan can require approval but never grant it" unenforceable.
// The DECLARATION of a consequential effect.
//
// ROUTED THROUGH `mission-engine/state.ts`, NOT `governance/approval.ts` DIRECTLY, and that indirection
// is required rather than incidental.
//
// Control E (`observation.test.ts`, "no planner module can import anything that could execute") forbids
// every planner module from importing `governance/contract` or `governance/approval`. The point is
// directional: the planner may DECLARE an effect, and the governance layer judges it. A planner that can
// reach into governance can also reach the approval store, and a plan that could grant its own approval
// would make "a plan may require authorisation but never confer it" unenforceable rather than merely
// untested.
//
// `state.ts` is where `Step.effect` already lives, it already imports `DeclaredEffect` from
// governance, and it is NOT on Control E's list. So this reaches the type through a module that is
// already downstream of governance, without the planner importing governance itself - one source of
// truth, and the boundary intact.
//
// The first version of this imported `DeclaredEffect` straight from `governance/approval.ts`, which
// broke Control E. The control was right and the import was wrong; the test was not weakened.
import type { DeclaredEffect } from '../mission-engine/state.ts'

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
  /**
   * WHAT THIS STEP NEEDS, not what will provide it.
   *
   * The router resolves a capability to a tool. A plan that named tools would be coupled to the
   * current implementations, and - worse - a planner reasoning about a specific tool's behaviour is
   * reasoning about the implementation rather than about the task, which is the confusion that turns
   * a capability into a hard-coded workflow.
   */
  readonly capability: Capability
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
  /**
   * The CONSEQUENTIAL EFFECT this step declares, if any.
   *
   * A DECLARATION, not a permission. It obliges the step to obtain human authorisation before the tool
   * runs, and there is deliberately no field anywhere on a plan meaning "approved" - so a plan can
   * REQUIRE an approval but can never GRANT one. The executor is the authority.
   *
   * This field was MISSING from `PlanStep` while the compiler copied it, the reviewer rendered it and
   * the model parser validated it - all of which read `s.effect` off a type that never declared it.
   * `Step` in the execution state has carried it since M3.
   *
   * That is not a cosmetic gap. `compile.ts` documents the consequence in its own comment: when the
   * declared effect was not copied, a plan declaring a consequential effect had it silently dropped,
   * the executor's approval gate never saw it, and the action ran UNAPPROVED. The controls missed it
   * because every test hand-built a `Mission` with `effect` already on the step, bypassing the
   * compiler - so the only path turning a DECLARATION into a mission was untested.
   *
   * A missing field in a type is precisely how that hole reopens. The type now states it, so the next
   * attempt to drop it is a compile error rather than a governance failure.
   */
  readonly effect?: DeclaredEffect
}

/**
 * AN ABSTRACT CAPABILITY. What a step needs, not what will provide it.
 *
 * A plan says `filesystem.inspect`, never `read-back`. The planner names a requirement and the
 * router satisfies it, which means a plan stays valid when an implementation is swapped, and - the
 * reason this matters - it means a planner cannot accidentally become coupled to one concrete tool
 * and start reasoning about that tool's quirks as though they were facts about the world.
 *
 * A capability the router cannot satisfy is a PLANNING FAILURE, not a substitution. Silently serving
 * a request with a different capability is the failure this project has already built a whole
 * refusal path to prevent, and it would be worse here: the plan's own text would no longer describe
 * what runs.
 */
export const CAPABILITIES = [
  'filesystem.inspect',   // establish what exists: a folder's presence and readability
  'filesystem.list',      // enumerate a folder's entries, from a prior step's confirmed path
  'filesystem.read',      // read a file's content
  'filesystem.confirm',   // confirm a written artifact exists and reads back
  'filesystem.write',     // create a file the plan specifies
  'filesystem.transform', // process a folder's observed contents into summary text
  'terminal.run',         // launch an allowlisted program
] as const

export type Capability = (typeof CAPABILITIES)[number]

export function isCapability(name: string): name is Capability {
  return (CAPABILITIES as readonly string[]).includes(name)
}

/** A complete proposed plan. */
export interface PlanProposal {
  /** The user's objective, verbatim. */
  readonly objective: string
  readonly constraints: readonly string[]
  readonly steps: readonly PlanStep[]
  /** What "done" means, in the user's terms, decided before execution. */
  readonly expectedResult: string
  /**
   * THE OBSERVATION THIS PLAN WAS BUILT ON.
   *
   * Required, not optional. A plan that cannot name the state of the world it was planned against
   * cannot be held to anything: when the world moves, there is no way to tell whether the plan was
   * wrong or merely unlucky. Making it mandatory is what lets the supervisor decide to re-observe
   * and replan rather than retry - the distinction M2 established for a renamed folder, generalised
   * to every plan.
   *
   * A planner with no observation must therefore REFUSE rather than produce an unfounded plan. That
   * is stricter than the previous behaviour, and deliberately so: the old `DeterministicPlanProvider`
   * emitted a fixed recipe with no basis, which is a plan that happens to be right.
   */
  readonly basis: PlanBasis
}

/**
 * Re-exported so the compiler and the mission state can share ONE definition of the basis.
 *
 * A second structurally-identical interface in `mission-engine/state.ts` would be two things to keep
 * in step, and the failure mode of drift is a mission that looks grounded while its basis silently
 * describes something else.
 */
export type { PlanBasis as Basis }

/**
 * What the planner knew when it decided.
 *
 * `world` is a digest rather than the whole observation, so a plan stays small and comparable. The
 * full state is re-derivable from the root, and a stale digest is detectable by fingerprint.
 */
export interface PlanBasis {
  /** Which observation. Empty string means NONE, and the compiler rejects that. */
  readonly observationId: string
  readonly observedAt: number
  /** The root that was observed. */
  readonly root: string
  /** The digest of what was found. Changes when the world changes. */
  readonly fingerprint: string
  /** Facts the plan actually used, named. An empty list means the plan ignored the observation. */
  readonly usedFacts: readonly string[]
  /**
   * Whether the observation was complete. A plan built on a truncated view says so, so a later reader
   * can tell "I saw 40 files" from "I saw 40 of 400 files".
   */
  readonly complete: boolean
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
      /**
       * WHY NO PLAN WAS PRODUCED, as a distinct value rather than a sentence.
       *
       * The user-facing layer will need to tell these apart - "I don't understand this" and "I
       * understand it but the folder isn't there" call for completely different responses, and
       * collapsing them into one message is how a user ends up rephrasing an objective that was
       * fine. These are also not the same as an execution or verification failure, which happen
       * later and are recorded on the mission rather than the plan.
       */
      readonly code: PlanFailure
      /** Why, in words a user can act on. Never the only thing recorded - `code` is the signal. */
      readonly reason: string
      /** What this planner recognised but cannot honour. Empty when nothing matched. */
      readonly unsupported: readonly string[]
      /** Present when the failure is about the world rather than the request. */
      readonly missing?: readonly string[]
    }

/**
 * THE DISTINCT WAYS PLANNING FAILS.
 *
 * Each one is a different situation with a different remedy, which is the whole reason they are
 * enumerated rather than collapsed:
 *
 *   not-understood        the objective was not recognised. Retry with different words.
 *   unsupported           recognised, and deliberately not implemented. Do not retry.
 *   insufficient-info     understood, but the world does not contain what it needs. Look, do not ask.
 *   observation-missing   no observation was supplied. A planner without the world cannot plan.
 *   observation-stale     the observation no longer describes this machine. Re-observe, then replan.
 *   observation-truncated the view was partial. A plan claiming completeness would be false.
 *   resource-missing      a capability the plan requires is not available. Do not substitute.
 *   invalid-proposal      the proposal did not survive the compiler. A defect, not a user error.
 */
export type PlanFailure =
  | 'not-understood'
  | 'unsupported'
  | 'insufficient-info'
  | 'observation-missing'
  | 'observation-stale'
  | 'observation-truncated'
  | 'resource-missing'
  | 'invalid-proposal'

/**
 * The observation a plan was built on, carried onto the mission.
 *
 * The compiler is the only thing that copies this, and it refuses a plan that has none - so by the
 * time a `Mission` exists, the question "what did this plan assume about the machine?" always has
 * an answer recorded in the mission itself.
 */
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

  /**
   * WHAT IS ACTUALLY THERE.
   *
   * The planner's only window onto the machine. It is a plain structural type with no methods, so
   * holding one grants no capability - a planner cannot re-observe, cannot write, and cannot ask
   * anything else of the world than what this snapshot already says.
   *
   * `undefined` is a legitimate and important value: it means "plan without looking", and the
   * compiler refuses such a plan. The alternative - letting a planner proceed with no observation and
   * quietly produce a recipe - is exactly the behaviour M6 exists to remove.
   */
  readonly world?: WorldState

  /**
   * How old an observation may be and still be planned against.
   *
   * The caller sets this, because freshness is a property of the CALLER's tolerance for a stale
   * view, not of the planner. A tool that reports a price may be a second old; a plan that deletes
   * something may not be a minute old.
   */
  readonly maxObservationAgeMs?: number

  /**
   * A fresh re-observation, when the caller has one.
   *
   * Present it and `world` is checked against it, so a plan cannot be built on a view that has since
   * changed. Omit it and the planner says it cannot verify freshness rather than assuming.
   */
  readonly refetched?: WorldState
}