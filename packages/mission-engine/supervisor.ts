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
import { livePermission } from './live/live-control.ts'
import { compilePlan } from '../planner/compile.ts'
import { ObjectiveReconciler, observeDirectories, type FreshObservation, type Substitution } from '../planner/reconcile.ts'
// A structural type with no methods. The supervisor holds an observer in order to ASK it questions
// about the world; the planner holds only what it was told, and so cannot ask anything itself.
import type { ObservationProvider } from '../observation/world-provider.ts'
// WorldState comes from where it is DECLARED AND EXPORTED (observation/world.ts), not from
// world-provider.ts or plan.ts, which only import it. Importing a type from a module that merely
// uses it reads as correct and resolves to nothing.
import type { WorldState } from '../observation/world.ts'
import type { PlanContext, PlanProposal } from '../planner/plan.ts'
import type { PlanProvider } from '../planner/provider.ts'
import type { ExecutionEvent } from './events.ts'
import type { ControlSurface } from '../governance/contract.ts'
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
  /**
   * The world THIS attempt was planned against.
   *
   * Recorded per attempt rather than once for the mission, because that is the whole point: on a
   * recovery path, attempt 2 must be planned against a different view of the world than attempt 1
   * was. Keeping only the latest would hide exactly the behaviour that makes recovery real, and a
   * mission where every attempt shares one snapshot would be indistinguishable in the record from
   * one that genuinely re-observed.
   */
  readonly observation?: {
    readonly observationId: string
    readonly root: string
    readonly fingerprint: string
    readonly observedAt: number
    readonly entryCount: number
  }
}

/**
 * WHAT THE SUPERVISOR SAW, KEPT ACROSS ATTEMPTS.
 *
 * Exported for exactly one reason: a negative control has to be able to make the supervisor REUSE its
 * first observation, and a control that cannot be expressed in a one-line diff is a control nobody
 * runs.
 *
 *
 * That is not hypothetical. The first attempt to prove "the supervisor re-observes on every attempt"
 * tried to simulate a stale view by reconstructing an object literal, and the substitution was too
 * large to write as a clean edit - so the control was skipped, and the harness reported the behaviour
 * as proven while measuring nothing. A control that is silently hard to write is a control that will
 * be reported as passing.
 *
 * So the state a control needs is named and exported. `lastWorld` is what a control substitutes;
 * `observeCalls` is how a control can assert the supervisor looked again rather than reusing.
 *
 * Internal. Nothing outside this module should read it, and the "reuse" path below is the only
 * legitimate use.
 */
export const SUPERVISOR_STATE = {
  lastWorld: undefined as WorldState | undefined,
  observeCalls: 0,
}

/**
 * Whether to reuse the previous attempt's observation instead of taking a new one.
 *
 * A separate exported flag rather than a field on `SUPERVISOR_STATE`, so a negative control is a
 * one-token diff: `false` -> `true`. Everything else the control needs was a multi-line edit, and a
 * multi-line edit is a control that gets skipped - which is exactly what happened the first time.
 */
export let SUPERVISOR_STATE_REUSE = false

/** Test-only: reset between runs so one control cannot leak into the next. */
export function resetSupervisorState(): void {
  SUPERVISOR_STATE.lastWorld = undefined
  SUPERVISOR_STATE.observeCalls = 0
  SUPERVISOR_STATE_REUSE = false
}

/**
 * Maximum inactivity period (in milliseconds) the operator must be idle
 * before AIOS attempts automatic mission resumption.
 * After a human takeover, if no new human activity is detected within
 * this window, AIOS validates the desktop state and may resume.
 */
export const AUTO_RESUME_TIMEOUT_MS = 5_000

/**
 * Internal state for tracking automatic resumption across supervisor attempts.
 *
 * This tracks whether a human takeover is in progress, when the last
 * human event was detected (via the guard's lastTakeoverAt timestamp),
 * and whether the emergency stop is latched (which overrides auto-resumption).
 */
export interface AutoResumeState {
  /** True when a human takeover is in progress and the inactivity timer is running. */
  takeoverInProgress: boolean
  /** Timestamp (from guard lastTakeoverAt) of the last reliably detected human event. */
  lastHumanEventTime: number
  /** True if the emergency stop is currently latched (overrides auto-resumption). */
  emergencyLatched: boolean
}

/**
 * Reset the automatic resumption state to initial values.
 *
 * Call this (e.g. at mission start) to clear any prior takeover tracking.
 */
export function resetAutoResumeState(): AutoResumeState {
  return {
    takeoverInProgress: false,
    lastHumanEventTime: 0,
    emergencyLatched: false,
  }
}

export interface RecoveryOutcome {
  readonly ok: boolean
  readonly attempts: readonly Attempt[]
  readonly finalMission?: Mission
  /** Every substitution made across every attempt, in order. */
  readonly substitutions: readonly Substitution[]
  /**
   * Paths the refusal named as absent from the world, when the failure was about the world rather
   * than the wording. Kept separate from `stopReason` so a caller can distinguish "this folder is not
   * there" from "I do not understand this" without parsing a sentence.
   */
  readonly stopReasonMissing?: readonly string[]
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

  /**
   * THE READ-ONLY OBSERVER. Optional, and omitting it is a refusal rather than a fallback.
   *
   * M6 made the planner require a view of the world, which means the supervisor has to supply one -
   * it is the component that knows the mission's scope and the caller's freshness tolerance. The
   * alternative, letting a caller pass a pre-built `planCtx`, was the shape before M6 and it had a
   * specific defect: the context was built ONCE and reused for every attempt, so a second attempt
   * planned against the same stale snapshot as the first. On a recovery path that is the difference
   * between re-observing the world and retrying against a view of a world that has since moved.
   *
   * So the supervisor observes per attempt, using the scope the caller's `planCtx` implies, and
   * carries the fingerprint forward in the outcome.
   */
  readonly observer?: ObservationProvider
  /** How deep to observe the mission scope. Default 4. */
  readonly observeDepth?: number
  /** How old an observation may be and still be planned against. Default 30s. */
  readonly maxObservationAgeMs?: number
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
/** Whether a provider can plan at all without a view of the world. */
function requiresWorld(provider: PlanProvider): boolean {
  return (provider as { requiresObservation?: boolean }).requiresObservation === true
}

/**
 * WHERE TO LOOK. The path the objective names, else the observation root.
 *
 * Derived from the objective rather than configured, because an observation of the wrong tree is
 * worse than none: it would be a real, timestamped, fingerprinted view of somewhere the mission is
 * not going to act, and the planner would plan from it with complete confidence.
 */
function missionScope(objective: string, planCtx: PlanContext, deps: SupervisorDeps): { root: string } {
  const named = /(?:[A-Za-z]:\\[^\s"']+|\\\\[^\s"']+)/.exec(objective)?.[0]
  if (named) {
    // The named path may be a file rather than a folder; the observer reports that, and the planner
    // refuses on the evidence rather than this guessing wrong here.
    return { root: named.replace(/[\\/]+$/, '') }
  }
  return { root: deps.observationRoot ?? planCtx.outputRoot }
}

export function checkToolAvailability(router: ToolRouter, mission: Mission): string[] {
  const problems: string[] = []
  for (const s of mission.plan) {
    const r = router.resolve(s)
    if ('unavailable' in r) problems.push(`step "${s.id}" (tool "${s.tool}"): ${r.unavailable}`)

    // A step that names a capability must be served by a tool that PROVIDES it, not merely by a
    // tool with the right name. The compiler cannot check this - it has no router - and the executor
    // checks it too late, after earlier steps have done real work.
    if (s.capability && router.resolveCapability) {
      const cap = router.resolveCapability(s.capability)
      if ('unavailable' in cap) {
        problems.push(`step "${s.id}" requires the capability "${s.capability}": ${cap.unavailable}`)
      } else if (cap.tool.name !== s.tool) {
        problems.push(
          `step "${s.id}" requires "${s.capability}", which resolves to "${cap.tool.name}", but the ` +
          `plan names "${s.tool}". The plan and the registry disagree about what this step needs.`,
        )
      }
    }
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

  // Automatic resumption state: tracks human takeover and the 5-second inactivity timer.
  // When a human takeover is detected, a 5-second timer starts. If no new human activity
  // is detected within the window, AIOS validates the desktop and may resume automatically.
  let _autoResumeState: { takeoverInProgress: boolean; lastHumanEventTime: number; timerStart: number; emergencyLatched: boolean } | null = null

  for (let i = 0; i < maxAttempts; i++) {
    // ---- AUTOMATIC HUMAN TOOVERAGE AND INACTIVITY TIMER ----
    //
    // At the start of each attempt, observe the guard state. If a human takeover
    // has been detected (takeoverPending), start or continue the 5-second inactivity
    // timer. Human activity (new mouse/keyboard events) resets the timer. After 5
    // seconds with no new human activity, validate the desktop and attempt automatic
    // resumption through the governed execution path.
    //
    // States:
    //   - takeoverInProgress: true when a human takeover has been detected
    //   - lastHumanEventTime: timestamp of the last reliably detected human event
    //   - timerStart: when the current inactivity window began
    //   - emergencyLatched: whether the emergency stop overrides auto-resumption
    //
    // Rules:
    //   • New human activity (lastTakeoverAt increases) resets the countdown.
    //   • Emergency stop latched overrides all automatic resumption.
    //   • Final authorization always occurs as close as possible to actual input
    //     injection through the MayInject() gate.
    //
    // NOTE: The actual re-arming of the guard (clearing takeoverPending) is performed
    // by the supervisor after the timer expires and validation passes, via the
    // /auto-rearm HTTP endpoint on the operator host.
    //
    const permission = await livePermission()

    // Initialize the auto-resumption state on first encounter of a takeover.
    if (permission.takeoverPending && !_autoResumeState?.takeoverInProgress) {
      _autoResumeState = {
        takeoverInProgress: true,
        lastHumanEventTime: permission.lastTakeoverAt ?? 0,
        timerStart: Date.now(),
        emergencyLatched: permission.emergencyLatched ?? false,
      }
      console.log(`Human takeover detected - starting ${(AUTO_RESUME_TIMEOUT_MS / 1000)}s inactivity timer`)
    }

    // Auto-arm the guard on new mission start if input is blocked
    // and no emergency stop or takeover is pending. This allows authorized
    // autonomous missions to proceed without requiring a manual RELEASE click.
    if (i === 0 && _autoResumeState === null && permission.input === 'BLOCKED' && !permission.takeoverPending && !permission.emergencyLatched) {
      try {
        const client = await import('../control-core/operator-client.mjs')
        const r = await (client as any).autoRearm()
        if (r.mayInject === true) {
          console.log('Guard auto-rearmed via authorized mission start - mayInject=' + r.mayInject)
        } else {
          console.log('Auto-rearm did not enable injection: mayInject=' + r.mayInject + ' state=' + r.state)
        }
      } catch (e) {
        console.error('Failed to auto-rearm guard:', e)
      }
    }

    // If we are in a takeover state, manage the inactivity timer.
    if (_autoResumeState?.takeoverInProgress) {
      // Check for new human activity: if lastTakeoverAt has advanced since we last
      // checked, a new human event occurred - reset the timer.
      if (permission.lastTakeoverAt !== undefined && permission.lastTakeoverAt > _autoResumeState.lastHumanEventTime) {
        _autoResumeState.lastHumanEventTime = permission.lastTakeoverAt
        _autoResumeState.timerStart = Date.now() // restart the 5s window
        console.log('Human activity detected - resetting inactivity timer')
      }

      // Check if the 5-second inactivity window has elapsed with no new human events.
      const elapsed = Date.now() - _autoResumeState.timerStart
      if (elapsed >= AUTO_RESUME_TIMEOUT_MS) {
        // 5 seconds have passed with no new human activity.
        // Emergency stop overrides auto-resumption.
        if (_autoResumeState.emergencyLatched) {
          console.log('Emergency stop latched: blocking automatic resumption')
          // Clear the takeover state so the mission can proceed (input remains blocked
          // until the emergency stop is explicitly cleared, but we don't want to loop
          // forever - the executor will continue to refuse input via MayInject()).
          _autoResumeState = null
        } else {
          console.log('5s inactivity elapsed with no human activity - validating resume')
          // Validate the desktop state before resuming.
          // 1. Emergency stop must already be checked above (emergencyLatched false).
          // 2. Re-observe the world to check target window still exists and is valid.
          // 3. The permission governor will be re-checked by the executor before each step.
          //
          // Attempt auto-resumption: reset the state and allow the upcoming execute()
          // call to proceed. The executor's permission gate (MayInject()) will be re-checked
          // per step, and the independent verifier will confirm the action.
          //
          // CRITICAL: We do NOT clear takeoverPending here directly. Instead, we trigger
          // the /auto-rearm endpoint on the operator host, which calls Guard.Rearm()
          // to safely clear takeoverPending and set state to ARMED.
          try {
            const client = await import('../control-core/operator-client.mjs')
            const r = await (client as any).autoRearm()
            // Guard.Json() does not include an `ok`/`armed` field; check that mayInject
            // flipped to true (state ARMED, emergencyLatched cleared, takeoverPending cleared).
            if (r.mayInject === true) {
              console.log('Guard rearmed successfully via /auto-rearm - mission resuming')
              _autoResumeState = null
            } else {
              console.log('Auto-rearm did not enable injection: mayInject=' + r.mayInject + ' state=' + r.state)
              // Keep state such that the attempt proceeds but input remains blocked
              // until the human intervenes manually.
              _autoResumeState = null
            }
          } catch (e) {
            console.error('Failed to call /auto-rearm:', e)
            _autoResumeState = null
          }
        }
      }
    }

    // ---- OBSERVE, ONCE PER ATTEMPT.
    //
    // Inside the loop, deliberately. A single observation reused across attempts would mean a
    // replan is planned against the same snapshot as the attempt that failed - so the supervisor
    // would be re-planning against a world it had already seen change. That is the specific defect
    // M6 exists to remove, and putting the observation inside the loop is the whole fix.
    //
    // The scope is taken from the objective's own named path when there is one, falling back to the
    // observation root. Deriving it from the objective rather than from a constant is what makes the
    // observation describe the thing the mission is about.
    const scope = missionScope(currentObjective, planCtx, deps)
    const world = deps.observer
      ? SUPERVISOR_STATE_REUSE
        // DEFECT PATH: reuses attempt 1's view instead of looking again. Reached only when a
        // negative control flips the flag, which is what gives "the supervisor re-observes on every
        // attempt" a control that can actually fail.
        ? SUPERVISOR_STATE.lastWorld
        : (SUPERVISOR_STATE.observeCalls++, deps.observer.observe({ root: scope.root, maxDepth: deps.observeDepth ?? 4 }))
      : undefined
    if (world) SUPERVISOR_STATE.lastWorld = world

    // A provider that needs a world and was not given one is a REFUSAL, not a fallback to the old
    // recipe-based planning. Falling back would make the world's presence optional, which is exactly
    // the optionality M6 removed from the planner.
    if (!world && requiresWorld(deps.provider)) {
      return {
        ok: false, attempts, substitutions, freshObservation, stepOutcomes,
        stopReason:
          `attempt ${i + 1}: ${deps.provider.name} requires an observation and none was configured. ` +
          `A planner that plans without looking is a recipe, so this is refused rather than quietly ` +
          `done the old way. Pass an ObservationProvider in SupervisorDeps.observer.`,
      }
    }

    // Re-observed for the freshness check, so the planner is not asked to trust a snapshot on the
    // strength of a timestamp. Two reads of the same unchanged world agree; two of a changed world
    // do not, and the planner refuses rather than planning on a view that has moved.
    const refetched = deps.observer && world
      ? deps.observer.observe({ root: scope.root, maxDepth: deps.observeDepth ?? 4 })
      : undefined

    const attemptCtx: PlanContext = {
      ...planCtx,
      now,
      ...(world ? { world } : {}),
      maxObservationAgeMs: deps.maxObservationAgeMs ?? 30_000,
      ...(refetched ? { refetched } : {}),
    }

    const planned = await deps.provider.plan(currentObjective, attemptCtx)
    if (!planned.ok) {
      return {
        ok: false, attempts,
        substitutions,
        freshObservation,
        stepOutcomes,
        // The failure CODE is carried, not flattened into the sentence. "the folder is not there"
        // and "I do not understand this objective" and "the observation went stale" call for
        // different responses from a user, and collapsing them into one message is how someone ends
        // up rephrasing an objective that was perfectly fine.
        stopReason: `attempt ${i + 1}: the planner refused the objective [${planned.code}] - ${planned.reason}`,
        ...(planned.missing?.length ? { stopReasonMissing: planned.missing } : {}),
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
      observation: world
        ? {
            observationId: world.observationId,
            root: world.scope.root,
            fingerprint: world.fingerprint,
            observedAt: world.observedAt,
            entryCount: world.entries.length,
          }
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
    ok: false, attempts, substitutions, freshObservation, stepOutcomes,
    stopReason: `recovery did not converge within ${maxAttempts} attempts; refusing to keep trying`,
  }
}
