/**
 * THE MISSION SUPERVISOR.
 *
 * Drives the loop that `execute()` deliberately does not:
 *
 *   plan -> compile -> execute -> (the world moved) -> RE-OBSERVE -> RECONCILE -> REPLAN
 *        -> RECOMPILE -> execute again -> ...
 *
 * WHY THIS IS NOT INSIDE `execute()`
 *
 * Because the executor must not know what a planner is. If `execute()` could replan, it would
 * need a planner, and every mission - including the ones whose plans are hand-written - would
 * acquire a dependency on planning. Worse, an executor that repairs its own plan can talk itself
 * into believing the plan was fine all along.
 *
 * So the split is: the executor EXECUTES ONE PLAN and reports honestly that the plan no longer
 * matches the world. The supervisor decides what to do about that. Neither can do the other's job.
 *
 * THE LOOP IS BOUNDED
 *
 * `maxAttempts`, default 3. An unbounded recovery loop is a way of spinning forever while
 * appearing busy, and each iteration performs real filesystem work. When the bound is reached the
 * mission FAILS with the reason - it does not return the last attempt's partial state dressed up
 * as progress.
 *
 * NOTHING CARRIES FORWARD WITHOUT EVIDENCE
 *
 * A replanned attempt starts a fresh mission with a fresh id. Verified steps from a previous
 * attempt are NOT inherited: the world changed, so a verification that was true of the old world
 * says nothing about the new one. Re-running them is the honest cost of recovery, and skipping
 * them would be the cheaper-looking option that produces confident wrong answers.
 */

import { execute, type ToolRouter, type Verifier } from './executor.ts'
import { tally } from './state.ts'
import { compilePlan } from '../planner/compile.ts'
import { ObjectiveReconciler, observeDirectories, type FreshObservation, type Substitution } from '../planner/reconcile.ts'
import type { PlanContext, PlanProvider, PlanProposal } from '../planner/plan.ts'
import type { ExecutionEvent } from './events.ts'
import type { ControlSurface } from '../../governance/contract.ts'
import type { Mission } from './state.ts'

/** One attempt at the objective, with everything needed to audit it. */
export interface Attempt {
  readonly index: number
  readonly missionId: string
  /** The objective as attempted. Differs from attempt 1 only after a substitution. */
  readonly objective: string
  readonly proposal: PlanProposal
  readonly events: readonly ExecutionEvent[]
  readonly state: string
  readonly complete: boolean
  readonly verified: number
  readonly failed: number
  readonly skipped: number
  /** Why this attempt needed a replan, when it did. */
  readonly invalidation?: { reason: string; detail: string }
  /** What the step actually saw when it judged the plan invalid. */
  readonly observedAtFailure?: string
}

export interface RecoveryOutcome {
  readonly ok: boolean
  readonly attempts: readonly Attempt[]
  readonly finalMission?: Mission
  /** Every substitution made across every attempt, in order. */
  readonly substitutions: readonly Substitution[]
  /** The fresh observation that drove the final replan. Absent if none was needed. */
  readonly freshObservation?: FreshObservation
  /** Set when recovery was attempted and did not succeed. */
  readonly stopReason?: string
  /**
   * Every step outcome across every attempt, flattened.
   *
   * Present because the event stream alone does not answer "what failed?". A verification
   * rejection emits `evidence-verified` with `accepted: false`, and a tool failure emits
   * `tool-returned` with `ok: false` - so a reader has to know both shapes and correlate them.
   * That correlation belongs here, once, rather than in every consumer.
   */
  readonly stepOutcomes: readonly { attempt: number; stepId: string; kind: string; reason?: string }[]
}

export interface SupervisorDeps {
  readonly provider: PlanProvider
  readonly tools: ToolRouter
  readonly verifier: Verifier
  readonly control: ControlSurface
  readonly config?: Parameters<typeof execute>[1]['config']
  /** Where the reconciler looks for a moved operand. Defaults to the output root's parent. */
  readonly observationRoot?: string
  /**
   * How deep to observe when looking for a moved operand. Default 2.
   *
   * A PARAMETER rather than a constant, because it is a real limit: a folder that moved deeper
   * than this cannot be seen, so it cannot be reconciled, so the mission fails. Failing is the
   * correct direction - a reconciler that guessed beyond its own observation would be worse -
   * but the depth belongs to the caller, not to a number buried here.
   */
  readonly observationDepth?: number
  readonly missionIdPrefix?: string
  readonly maxAttempts?: number
  readonly now?: () => number
}

/**
 * Checks every step's tool against the registry BEFORE anything executes.
 *
 * The compiler cannot do this - it has no router and must not have one, or plan validation would
 * acquire a dependency on what happens to be installed. But leaving it to execution means a
 * plan naming a missing tool runs three steps, does real filesystem work, and only then fails.
 * Discovering a missing capability before starting is strictly better, and on a recovery path
 * where several attempts may run it compounds.
 *
 * Reported as unavailable rather than substituted. The router already refuses to substitute
 * without being asked; this refuses earlier.
 */
export function checkToolAvailability(router: ToolRouter, mission: Mission): string[] {
  const problems: string[] = []
  for (const s of mission.plan) {
    const r = router.resolve(s)
    if ('unavailable' in r) problems.push(`step "${s.id}" (tool "${s.tool}"): ${r.unavailable}`)
  }
  return problems
}

export async function runMission(objective: string, planCtx: PlanContext, deps: SupervisorDeps): Promise<RecoveryOutcome> {
  const now = deps.now ?? (() => Date.now())
  const maxAttempts = deps.maxAttempts ?? 3
  const reconciler = new ObjectiveReconciler()

  const attempts: Attempt[] = []
  const stepOutcomes: Array<{ attempt: number; stepId: string; kind: string; reason?: string }> = []
  const substitutions: Substitution[] = []
  let currentObjective = objective
  let freshObservation: FreshObservation | undefined

  for (let i = 0; i < maxAttempts; i++) {
    const planned = await deps.provider.plan(currentObjective, planCtx)
    if (!planned.ok) {
      return {
        ok: false, attempts,
        substitutions,
        freshObservation,
        stepOutcomes,
        stopReason: `attempt ${i + 1}: the planner refused the objective - ${planned.reason}`,
      }
    }

    const missionId = `${deps.missionIdPrefix ?? 'mission'}-a${i + 1}`
    const compiled = compilePlan(planned.proposal, missionId, now())
    if (!compiled.ok) {
      return {
        ok: false, attempts, substitutions, freshObservation,
        stepOutcomes,
        stopReason: `attempt ${i + 1}: the plan was rejected by the compiler - ${compiled.reason}`,
      }
    }

        // Tool availability is checked BEFORE execution, so a plan naming a capability nobody
    // registered is refused rather than discovered three steps in.
    const unavailable = checkToolAvailability(deps.tools, compiled.mission)
    if (unavailable.length) {
      return {
        ok: false, attempts, substitutions, freshObservation,
        stepOutcomes,
        stopReason: `attempt ${i + 1}: the plan calls for capabilities that are not available - ${unavailable.join('; ')}`,
      }
    }

    const result = await execute(compiled.mission, {
      tools: deps.tools,
      verifier: deps.verifier,
      control: deps.control,
      config: deps.config,
    })

    const t = tally(result.mission)
    const invalidation = result.mission.plan
      .map((s) => s.result?.outcome)
      .find((o): o is Extract<typeof o, { kind: 'replan-required' }> => o?.kind === 'replan-required')

    const invalidationEvent = result.events.find((e) => e.type === 'plan-invalidated')

    attempts.push({
      index: i + 1,
      missionId,
      objective: currentObjective,
      proposal: planned.proposal,
      events: result.events,
      state: result.mission.state,
      complete: result.record.complete,
      verified: t.verified,
      failed: t.failed,
      skipped: t.skipped,
      invalidation: invalidation
        ? {
          reason: invalidation.reason,
          detail: invalidation.invalidation.reason === 'environment-changed'
            ? invalidation.invalidation.detail
            : JSON.stringify(invalidation.invalidation),
        }
        : undefined,
      observedAtFailure: invalidationEvent && 'observed' in invalidationEvent
        ? String(invalidationEvent.observed)
        : undefined,
    })

    for (const s of result.mission.plan) {
      const o = s.result?.outcome
      if (!o) continue
      stepOutcomes.push({
        attempt: i + 1,
        stepId: s.id,
        kind: o.kind,
        reason: 'reason' in o ? String((o as { reason?: unknown }).reason ?? '') || undefined : undefined,
      })
    }

    if (result.record.complete) {
      return { ok: true, attempts, substitutions, freshObservation, stepOutcomes, finalMission: result.mission }
    }

    // Not complete. Only ONE reason justifies another attempt: the plan itself is invalid. Every
    // other terminal state - a failed step, a blocked-on-human, a halt - is the executor or the
    // human saying stop, and retrying it would be ignoring them.
    if (!invalidation) {
      return {
        ok: false, attempts, substitutions, freshObservation,
        stepOutcomes,
        stopReason:
          `attempt ${i + 1} ended in state "${result.mission.state}" without a plan invalidation ` +
          `(verified ${t.verified}, failed ${t.failed}, skipped ${t.skipped}). ` +
          `Recovery only continues when the plan itself is invalid.`,
      }
    }

    // ---- re-observe. Mandatory, and it must be a FRESH read.
    const root = deps.observationRoot ?? planCtx.outputRoot
    freshObservation = observeDirectories(root, deps.observationDepth ?? 2)
    const rec = reconciler.reconcile(currentObjective, freshObservation)
    if (!rec.ok) {
      return {
        ok: false, attempts, substitutions, freshObservation,
        stepOutcomes,
        stopReason: `attempt ${i + 1}: after the world moved, the objective could not be reconciled - ${rec.reason}`,
      }
    }

    substitutions.push(...rec.substitutions)
    currentObjective = rec.objective
  }

  return {
    ok: false, attempts, substitutions, freshObservation,
    stopReason: `recovery did not converge within ${maxAttempts} attempts; refusing to keep trying`,
  }
}
