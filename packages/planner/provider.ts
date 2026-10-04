/**
 * THE MODEL BOUNDARY.
 *
 * One interface between "something that decides what to do" and everything that executes.
 *
 * TODAY: `DeterministicPlanProvider`. No model, no network, no API key.
 * LATER:  an `AiPlanProvider` that asks a model for a `PlanProposal`.
 *
 * The whole point of this file is that the second one requires NO change to the router, the
 * executor, the tools, the verifiers or the governance contract. If that ever stops being true,
 * the abstraction has leaked and this file has failed at its job.
 *
 * What a provider is NOT allowed to do, because these are enforced by construction rather than
 * by convention:
 *
 *   - execute a tool
 *   - touch the filesystem
 *   - reach a ControlSurface
 *   - inject input
 *   - decide permission
 *   - mark a step complete
 *
 * A provider receives an objective and a `PlanContext`, and returns data. It has no reference to
 * the executor, to `ControlSurface`, or to any tool. There is no seam through which it could
 * act, so "the planner must not execute" is not a rule to remember - it is a property of the
 * types.
 *
 * THE TEST FOR THAT CLAIM IS IN `test/planner.test.ts`, which asserts that the provider module
 * does not import the executor or the governance contract at all.
 */

import type { PlanContext, PlanResult } from './plan.ts'

export interface PlanProvider {
  /** Recorded in the audit, so a mission states which planner produced it. */
  readonly name: string

  /**
   * How this provider describes itself when asked what it can do.
   *
   * Not decoration: a planner that cannot say what it handles invites the caller to discover
   * its limits by feeding it real objectives and reading the failures.
   */
  capabilities(): readonly string[]

  /** Produces a proposal, or explains why it cannot. Never throws. */
  plan(objective: string, ctx: PlanContext): Promise<PlanResult>
}