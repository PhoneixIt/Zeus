/**
 * The mission executor.
 *
 * The shape it implements, from the objective:
 *
 *   MISSION -> EXECUTOR -> TOOL SELECTION -> CONTROL SURFACE -> RESULT
 *           -> INDEPENDENT EVIDENCE -> STATE TRANSITION -> NEXT STEP
 *
 * THE ONE INVARIANT THAT MATTERS MOST
 *
 * The executor cannot manufacture success.
 *
 * A step becomes `done` only when a TOOL RETURNED and INDEPENDENT VERIFICATION then accepted
 * it. Those are two separate calls, and the second does not trust the first. A tool that
 * reports success, returns empty, or throws cannot by itself complete anything.
 *
 * This exists because three separate production bugs were the same shape: a failure became an
 * empty value, and the empty value was indistinguishable from success. One run where EVERY
 * specialist agent threw was recorded `completed`, durably, in a database. A mission engine
 * that lets a tool's own return value settle the question would reproduce all three.
 *
 * WHY IT HAS NO INJECTION
 *
 * The executor holds a `ControlSurface` and cannot do anything with it except call the
 * observation methods and route capability calls. It has no mouse, no keyboard, no
 * SendInput, and no HTTP route to the host. Every input decision belongs to the control core,
 * which refuses on its own evidence (Â§35: governance enforceable independently of the AI).
 */

import type {
  ControlSurface,
  Permission,
  Observation,
} from '../governance/contract.ts'
import type {
  Evidence,
  ExecutionMode,
  HistoryEntry,
  Mission,
  MissionState,
  PlanInvalidation,
  Step,
  StepOutcome,
  StepResult,
} from './state.ts'
import {
  tally, isRetryable, isMissionSuccessful, objectiveVerdict,
} from './state.ts'
import type { ExecutionEvent, ExecutionRecord } from './events.ts'
import { midActionTransportLoss } from './transport-loss.ts'
import { keyFor, type ApprovalKey, type ApprovalStore, type DeclaredEffect } from '../governance/approval.ts'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { RecoveryPolicy } from './recovery.ts'

// ---------------------------------------------------------------- tool contract

export interface ToolContext {
  readonly missionId: string
  readonly stepId: string
  readonly attempt: number
  /** Observation is passed IN, so a tool never has to guess the current state. */
  readonly observation: Observation
  /**
   * Results of EARLIER steps in this mission, keyed by step id.
   *
   * This did not exist, and its absence was a structural limitation rather than a missing
   * convenience: `recordResult` stored `output: undefined`, so nothing a tool returned ever
   * reached anything else. A step could not consume the result of the step before it, which
   * meant any plan needing data flow - compose text in one step, write it in the next - had to
   * either re-read the world and hope it matched, or collapse into a single step that both
   * computed and wrote, which is exactly the step that cannot be independently verified.
   *
   * `prior` holds only steps that have already produced a result, so a tool reads what happened
   * rather than predicting it. It is a record of the past, not a channel for a later step to
   * influence an earlier one - execution order is fixed by `dependsOn` and this does not change
   * it.
   */
  readonly prior: Readonly<Record<string, StepResult>>
  readonly signal: AbortSignal
}

/**
 * What a tool returns.
 *
 * Note what is absent: there is no `success: true` shorthand. A tool returns DATA and an
 * EXPLANATION of what that data means; whether it satisfies the step is not the tool's call.
 */
export type ToolResult =
  | { kind: 'data'; data: unknown; summary: string }
  | { kind: 'nothing-found'; reason: string }
  | { kind: 'failed'; reason: string }
  /**
   * THE TRANSPORT DIED WHILE THE ACTION WAS IN FLIGHT, and the tool cannot say what landed.
   *
   * This is the one result a tool returns that the executor refuses to retry, ever. `failed`
   * claims the action did not take effect, and a claim like that is what authorizes a second
   * attempt; when the request may have partially reached the machine (a keystroke batch, a
   * click stream), the honest report is "unknown", which `isRetryable` treats as terminal and
   * Stage D recovery surfaces for reconciliation before anything else runs. A tool that cannot
   * prove nothing happened must say so here rather than guessing `failed`.
   */
  | { kind: 'outcome-unknown'; reason: string }
  | { kind: 'needs-human'; reason: string }
  | { kind: 'replan-required'; reason: string; invalidation: PlanInvalidation; observed?: string }

export interface Tool {
  readonly name: string
  readonly mode: ExecutionMode
  /** For the modes that need a target. Absent for observation-only capabilities. */
  readonly needsTarget?: boolean
  /** Declared arguments for the model/tool schema. Optional because not all tools declare them. */
  readonly args?: ReadonlyArray<{ name: string; type: string; required: boolean; description: string }>
  run(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult>
}

/**
 * INDEPENDENT VERIFICATION.
 *
 * Deliberately a separate interface from Tool. A tool cannot verify itself, because a tool
 * that could would be exactly the defect described above. The verifier goes and LOOKS - a
 * file that exists, a window that is present, an exit code - and returns an Evidence value or
 * refuses.
 */
export interface Verifier {
  /** The step ids this verifier can speak to. A step with no verifier cannot complete. */
  readonly verifies: (step: Step) => boolean
  verify(step: Step, ctx: ToolContext, toolData: unknown): Promise<{ evidence: Evidence } | { rejected: string }>
}

export interface ToolRouter {
  resolve(step: Step): { tool: Tool; fellBack: boolean; reason: string } | { unavailable: string; candidates: readonly string[] }
  /**
   * Optional: the effect a step WOULD have, according to the tool that would run it.
   *
   * Optional because a router that cannot answer must not be forced to guess. A router that
   * implements it is saying "I have read this step's arguments and here is what it does", which
   * is a stronger claim than "this tool exists" - and the one the approval gate needs, because a
   * tool's consequence can depend on its arguments (`git status` versus `git push`).
   */
  effectOf?(step: Step): DeclaredEffect | undefined
  /** Optional: a refusal the named tool would issue for this step, before authorisation. */
  preflight?(step: Step): { blocked: string; needsHuman: boolean } | undefined
  /**
   * Optional: resolve an ABSTRACT CAPABILITY to a registered tool.
   *
   * A plan says `filesystem.inspect`; this is how that becomes `inspect-folder`. It lives on the
   * router rather than in the planner, because a planner that knew the mapping would be coupled to
   * the current implementations - and a planner reasoning about one tool's behaviour is reasoning
   * about the implementation instead of the task.
   *
   * Returns `unavailable` when nothing registered serves the capability, and there is no fallback
   * here. Serving a request with a different capability is the confident-wrong-answer failure this
   * system exists to prevent, and it would be worst here: the plan's own text would stop describing
   * what runs.
   */
  resolveCapability?(capability: string): { tool: Tool } | { unavailable: string; candidates: readonly string[] }
  /**
   * Optional: whether the router considers this step consequential, INDEPENDENT of the tool's answer.
   *
   * `ToolRouter` in `tool-router/router.ts` has implemented this since M3, but the interface here
   * never declared it - so `deps.tools.isConsequential?.(step)` in the approval gate compiled only
   * because of the optional call, and a caller passing an object literal that satisfied this interface
   * was under no obligation to provide it.
   *
   * That matters more than a missing declaration usually would, because this sits directly on the
   * approval path. `effectOf` is the stronger, preferred signal - it reads the step's actual arguments
   * - and `isConsequential` is the coarser fallback. A router implementing the coarse one but omitting
   * the fine one would have been *silently less governed* than intended, with nothing to catch it.
   */
  isConsequential?(step: Step): boolean | undefined
}

// ---------------------------------------------------------------- executor config

export interface ExecutorConfig {
  /** Retries allowed per step, INCLUDING the first attempt. 1 means no retry. */
  readonly maxAttempts: number
  /** Consulted before every step. This is how emergency stop reaches the executor. */
  readonly permission: () => Promise<Permission>
  /**
   * Re-checked before each step. If it ever returns false the executor halts and records why.
   * Separate from `permission` because "should I stop" and "may I inject" are different
   * questions, and conflating them once made the status panel lie.
   */
  readonly emergencyStop: () => Promise<boolean>
  /** Injectable so execution is deterministic in tests. Never a wall-clock read internally. */
  readonly now: () => number

  /**
   * DURABLE RECORDING (M16). Optional, so every existing caller and test is untouched.
   *
   * When supplied, the executor records a write-ahead intent BEFORE each tool call, the tool's
   * outcome after it, and verification evidence after that. If any of those throws, the executor does
   * NOT continue as though the event were recorded - see the attemptOutcome call below for the case
   * that matters, where the machine has already changed.
   *
   * Optional rather than required because a recorder that can be forgotten is still better than none,
   * and because making it mandatory would mean every hand-built Mission in the test suite had to grow
   * one. The live harnesses supply it.
   */
  readonly recorder?: MissionRecorder
  readonly recovery?: RecoveryPolicy
}

/**
 * The subset of the durable recorder the executor needs.
 *
 * Declared here rather than imported so `mission-engine` does not depend on `persistence`. The
 * dependency runs one way: persistence knows about missions; the mission engine does not know about
 * storage. The implementation lives in `persistence/recorder.ts`.
 */
export interface MissionRecorder {
  missionStarted(mission: Mission): void
  missionTransition(missionId: string, from: MissionState, to: MissionState, why: string, at: number): void
  attemptBegin(e: {
    missionId: string; stepId: string; attempt: number; tool?: string; intent: string
    mode: string; args?: Readonly<Record<string, unknown>>; at: number
  }): void
  attemptOutcome(e: {
    missionId: string; stepId: string; attempt: number; ok: boolean
    summary?: string; reason?: string; durationMs: number; at: number; data?: unknown
  }): void
  verified(e: {
    missionId: string; stepId: string; attempt: number; evidence: Evidence; verifier: string; at: number
  }): void
  stepResult(missionId: string, stepId: string, result: StepResult, at: number): void
  missionEnded(missionId: string, state: MissionState, complete: boolean, at: number): void
  note(missionId: string, kind: 'recovery' | 'invalidation' | 'note', summary: string, detail?: unknown, at?: number): void
}

/** A readable name for whichever verifier will judge this step, for provenance. */
function verifierNameFor(step: Step): string {
  return `verifier(${step.mode})`
}

/**
 * The durable step status implied by an outcome.
 *
 * `outcome-unknown` maps to `uncertain`, which is NOT `failed`. This mapping is the second place the
 * distinction is enforced (the first is the retry gate), and it exists as a named function because a
 * ternary one line long is exactly the sort of thing that gets "simplified" into dropping the branch.
 */
function statusForOutcome(o: StepOutcome): Step['status'] {
  switch (o.kind) {
    case 'verified': return 'done'
    case 'legitimately-empty': return 'done'
    case 'skipped': return 'skipped'
    case 'outcome-unknown': return 'uncertain'
    default: return 'failed'
  }
}

/** A short message for any thrown value. Persistence failures arrive as objects, not Errors. */
function msgOf(e: unknown): string {
  if (e instanceof Error) return e.message
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message)
  return String(e)
}

const DEFAULTS: Required<Pick<ExecutorConfig, 'maxAttempts' | 'permission' | 'emergencyStop' | 'now'>> = {
  maxAttempts: 3,
  /**
   * Default: assume healthy. Deliberately NOT fail-closed at construction time, because a
   * missing probe here would make every call throw before the executor ran at all - and a
   * safety check that prevents the system from starting is not a safety check.
   *
   * The fail-closed behaviour lives where it belongs: any REAL control surface supplies its
   * own probe, and if it reports unhealthy the executor halts before the first input. A
   * caller who supplies no probe is a caller with no control surface at all.
   */
  permission: async () => ({
    control: 'ARMED',
    input: 'PERMITTED',
    blockedBy: null,
    infrastructureHealthy: true,
  }),
  emergencyStop: async () => false,
  now: () => Date.now(),
}

// ---------------------------------------------------------------- executor

export interface ExecuteOptions {
  readonly signal?: AbortSignal
  /**
   * WHICH PLAN THIS IS. Part of every approval key.
   *
   * It exists because step ids are stable across replans - they come from the plan's shape - so
   * an approval keyed on the step id alone would silently authorise a DIFFERENT action that
   * happens to share an identifier. A replan increments the epoch, and every approval granted
   * under the old one stops matching.
   *
   * Defaults to 0, so a mission that is never replanned has a stable key.
   */
  readonly planEpoch?: number
  /**
   * THE PROPOSAL THE USER REVIEWED. Its digest.
   *
   * Supply it and the executor will refuse to run a mission compiled from a different proposal. That
   * is the mechanism behind "amendment produces a new plan": a reviewer amends, the plan is compiled
   * again, and the mission that was already compiled cannot be used in its place, because the digest
   * the reviewer holds no longer describes it.
   *
   * OPTIONAL, deliberately. Omitting it means "nobody reviewed this and nobody claims to have" - which
   * is the situation for every mission the supervisor runs on its own. Making it mandatory would buy
   * nothing for those callers and would push them to pass a digest computed from the very proposal
   * they just compiled, which is a check that cannot fail. The review path always supplies one, and
   * that is where it is load-bearing.
   */
  readonly reviewedProposalDigest?: string
}

export interface ExecuteResult {
  readonly mission: Mission
  readonly record: ExecutionRecord
  readonly events: readonly ExecutionEvent[]
}

export async function execute(
  mission: Mission,
  deps: {
    tools: ToolRouter
    verifier: Verifier
    control: ControlSurface
    config?: Partial<ExecutorConfig>
    /**
     * THE APPROVAL AUTHORITY. Absent means NO step may declare a consequential effect - a
     * mission with a consequential step and no store fails that step rather than running it.
     */
    approvals?: ApprovalStore
    /**
     * OPTIONAL HOOK: a decision channel that can WAIT for the human.
     *
     * The gate is synchronous by construction - request, look, decide - so a caller whose
     * decisions arrive from outside (an HTTP route, a window button) had no way to let the
     * executor pause: the step went needs-human the instant the request was recorded and the
     * mission ended, making the approval permanently unusable no matter who answered.
     *
     * THIS HOOK CANNOT GRANT ANYTHING. It is called only when the store holds no approval for
     * the exact key, it receives the key but has no way to write to the store, and when it
     * returns the executor looks at the STORE again - which is still the only authority. A hook
     * that times out, throws, or resolves without a decision leaves the step needs-human, which
     * is the same outcome as not supplying one. Callers without an interactive channel simply
     * omit it and behaviour is unchanged.
     */
    awaitApproval?: (key: ApprovalKey, effect: DeclaredEffect) => Promise<void>
  },
  opts: ExecuteOptions = {},
): Promise<ExecuteResult> {
  const cfg = { ...DEFAULTS, ...deps.config }
  const planEpoch = opts.planEpoch ?? 0
  const approvals = deps.approvals
  const signal = opts.signal
  const events: ExecutionEvent[] = []
  let seq = 0

  // ---- IS THIS THE PLAN SOMEONE REVIEWED?
  //
  // Checked before anything else, and before the loop, because a mismatch means the caller is about
  // to run a plan other than the one they believe they approved. That is worth refusing over
  // everything, including an approval that would otherwise be present and valid.
  //
  // WHY IT IS HERE AND NOT IN THE COMPILER
  //
  // Because the compiler cannot know what a reviewer saw. It knows what it produced; only the review
  // session knows what was put in front of a person. So the compiler stamps the identity and the
  // executor compares it, and neither has to trust the other.
  if (opts.reviewedProposalDigest !== undefined) {
    const stamped = mission.proposalDigest
    if (!stamped) {
      return refusal(
        mission,
        `a reviewed proposal digest was supplied but this mission records none, so it cannot be ` +
        `shown to be the plan that was reviewed. Refusing rather than assuming.`,
      )
    }
    if (stamped !== opts.reviewedProposalDigest) {
      // Record the mission ending durably even though we're refusing to run it.
      // This ensures every mission, even one that never starts, has a persisted record
      // with the correct objective verdict, satisfying the acceptance criterion.
      if (cfg.recorder) {
        try {
          cfg.recorder.missionEnded(mission.id, 'failed', false, cfg.now())
        } catch { /* store refusing writes */ }
      }
      return refusal(
        mission,
        `this mission was compiled from proposal ${stamped}, but the proposal that was reviewed is ` +
        `${opts.reviewedProposalDigest}. The plan was amended after compilation, so this mission is ` +
        `not the reviewed plan. Compile the amended proposal and run that instead.`,
      )
    }
  }
  const t0 = cfg.now()

  const emit = (e: Omit<ExecutionEvent, 'seq' | 'at' | 'missionId'> & { missionId?: string }): void => {
    const { missionId, ...rest } = e as { missionId?: string }
    events.push({ ...(rest as object), seq: ++seq, at: cfg.now(), missionId: missionId ?? mission.id } as ExecutionEvent)
  }

  const plan = mission.plan.map((s) => ({ ...s, status: s.status === 'done' ? s.status : 'pending' }) as Step)
  const byId = new Map(plan.map((s) => [s.id, s]))
  const results = new Map<string, StepResult>()
  const history: HistoryEntry[] = mission.history.slice()
  const verifiedEvidence: Record<string, Evidence> = {}

    // Derived from the SAME tally the human-readable progress line uses, so the audit stream
  // and describeProgress() cannot drift apart. They counted separately before, which is how a
  // mission could report one thing in prose and another in its events.
  const counts = () => {
    const t = tally({
      ...mission,
      plan: plan.map((s) => ({ ...s, result: results.get(s.id) })),
    })
    return {
      verified: t.verified,
      legitimatelyEmpty: t.legitimatelyEmpty,
      failed: t.failed,
      skipped: t.skipped,
      needsHuman: t.needsHuman,
      replanRequired: t.replanRequired,
      pending: t.pending,
    }
  }
  // ---- detect unsatisfiable dependencies BEFORE running anything. A plan that cannot work
  // should say so immediately rather than failing halfway through with a confusing cascade.
  const unsatisfiable: string[] = []
  for (const s of plan) {
    for (const d of s.dependsOn ?? []) {
      if (!byId.has(d)) unsatisfiable.push(`${s.id} depends on unknown step "${d}"`)
    }
  }

  emit({
    type: 'mission-started',
    objective: mission.objective,
    stepCount: plan.length,
    unsatisfiable,
  } as never)

  if (unsatisfiable.length) {
    emit({
      type: 'mission-finished',
      state: 'failed',
      complete: false,
      ...counts(),
      durationMs: cfg.now() - t0,
    } as never)
    if (cfg.recorder) {
      try {
        cfg.recorder.missionEnded(mission.id, 'failed', false, cfg.now())
      } catch { /* the record lags; the stop is what matters */ }
    }
    const m = finalMission('failed', plan, results, history, mission)
    return { mission: m, record: recordOf(m, events, verifiedEvidence, t0, cfg.now()), events }
  }

  let missionState: MissionState = 'executing'
  const transition = (from: MissionState, to: MissionState, reason: string, stepId: string | null = null) => {
    emit({ type: 'state-transition', stepId, from, to, reason } as never)
    missionState = to
    // A transition that could not be recorded is reported, not hidden.
    //
    // It does NOT abort the mission: a transition is an INTERPRETATION of what happened, not an action
    // on the machine, and refusing to stop because the log is unwritable would be a worse failure than
    // the one being logged. The consequence is that the durable record lags - which is exactly what a
    // recovery read is for.
    if (cfg.recorder) {
      try {
        cfg.recorder.missionTransition(mission.id, from, to, reason, cfg.now())
      } catch (e) {
        emit({
          type: 'note', stepId: stepId ?? '(mission)',
          text: `a state transition could not be recorded durably (${msgOf(e)})`,
        } as never)
      }
    }
  }

  // ---- The mission header, recorded before anything else.
  //
  // If THIS fails the mission does not start. A mission whose objective and proposal identity are not
  // on disk cannot be recovered, audited or explained, and starting it anyway would produce work whose
  // provenance nobody could establish.
  //
  // Placed here, after the digest check, because a mission that is not the reviewed plan has no business
  // writing a durable record of itself.
  if (cfg.recorder) {
    try {
      cfg.recorder.missionStarted(mission)
    } catch (e) {
      const reason =
        `the mission was not started: it could not be recorded durably (${msgOf(e)}). No action was taken.`
      if (cfg.recorder) {
        try {
          cfg.recorder.missionEnded(mission.id, 'failed', false, cfg.now())
        } catch { /* the record lags; the stop is what matters */ }
      }
      emit({ type: 'step-refused', seq: 0, at: 0, missionId: mission.id, stepId: '(mission)', reason } as never)
      return {
        mission,
        record: {
          missionId: mission.id, events, startedAt: t0, finishedAt: cfg.now(),
          finalState: 'failed', complete: false, verified: {},
        } as never,
        events,
      }
    }
  }

  // ---- Observation.
  //
  // The executor never assumes the world is still as it was; Â§16 requires re-observation
  // after any interruption. observe() may THROW when the control surface is unavailable, and
  // that must be a safe halt rather than an escaping exception: an executor that crashes when
  // the desktop layer fails has turned a recoverable condition into a mission-killing one,
  // and it leaves no record of why.
  let observation: Observation | null = null
  let halted: { cause: 'emergency-stop' | 'cancelled' | 'infrastructure'; reason: string; stepId: string | null } | null = null
  try {
    observation = await deps.control.observe()
  } catch (e) {
    halted = {
      cause: 'infrastructure',
      reason: `the control surface could not be observed: ${e instanceof Error ? e.message : String(e)}`,
      stepId: null,
    }
  }

  const recordResult = (stepId: string, outcome: StepOutcome, startedAt: number, extra?: Partial<StepResult>): StepResult => {
    const r: StepResult = {
      id: stepId,
      outcome,
      durationMs: cfg.now() - startedAt,
      ...extra,
    }
    results.set(stepId, r)
    if (outcome.kind === 'verified') verifiedEvidence[stepId] = outcome.evidence
    return r
  }

  for (const step of plan) {
    // ---- halt conditions, checked before every step and never bypassed.
    if (halted) break
    if (signal?.aborted) {
      halted = { cause: 'cancelled', reason: 'the caller cancelled this mission', stepId: step.id }
      break
    }
    // THE HALT CONSULTS ARE CONTAINED, not merely called. Both read another system (the guard
    // latch, the permission channel), and a read that THROWS must not unwind the executor: an
    // unwind skips the mission's own terminal transition, the durable ledger is left claiming
    // the mission is still `running`, and the caller sees a bare transport error instead of a
    // halt. This is the 2026-10-22 OpenVault unwind path, closed AT the gate. Fail-closed in
    // both directions - if a consult cannot be read, the mission stops; nothing proceeds on an
    // answer that was never received.
    let emergencyLatched: boolean
    try {
      emergencyLatched = await cfg.emergencyStop()
    } catch (e) {
      halted = {
        cause: 'infrastructure',
        reason: `the emergency-stop consult itself failed (${msgOf(e)}); the executor will not continue without reading the stop`,
        stepId: step.id,
      }
      break
    }
    if (emergencyLatched) {
      halted = { cause: 'emergency-stop', reason: 'emergency stop is latched; the executor will not continue', stepId: step.id }
      break
    }
    let perm: Permission
    try {
      perm = await cfg.permission()
    } catch (e) {
      halted = {
        cause: 'infrastructure',
        reason: `the permission consult itself failed (${msgOf(e)}); the executor will not continue on an unread control state`,
        stepId: step.id,
      }
      break
    }
    if (!perm.infrastructureHealthy) {
      halted = { cause: 'infrastructure', reason: perm.blockedBy ?? 'control infrastructure is unhealthy', stepId: step.id }
      break
    }

    // ---- dependency gate. A dependency must have reached a COMPLETING outcome. Failed and
    // needs-human dependencies BLOCK, because treating them as satisfied is how one bad step
    // becomes a chain of confident-looking successes.
    const depsOf = step.dependsOn ?? []
    const blocking = depsOf.find((d) => {
      const r = results.get(d)
      if (!r) return true
      return !(r.outcome.kind === 'verified' || r.outcome.kind === 'legitimately-empty')
    })
    if (blocking !== undefined) {
      const br = results.get(blocking)
      emit({
        type: 'dependency-blocked',
        stepId: step.id,
        blockedBy: blocking,
        reason: br ? `"${blocking}" ended as ${br.outcome.kind}, which does not satisfy a dependency` : `"${blocking}" has not run`,
      } as never)
      // SKIPPED, not failed. The tool never ran, so calling this a failure would misdescribe
      // what happened and inflate the apparent failure count for anyone auditing the mission.
      recordResult(step.id, {
        kind: 'skipped',
        reason: `not attempted: dependency "${blocking}" did not complete`,
        blockedBy: blocking,
      }, cfg.now())
      continue
    }

    // ---- CONSEQUENTIAL-EFFECT GATE.
    //
    // Runs after the dependency gate and BEFORE tool selection, which is before the tool can be
    // called at all. A step that declares a consequential effect and has no matching approval
    // does not run: it becomes `needs-human` with the request recorded, and the mission stops
    // being able to complete.
    //
    // WHY HERE AND NOT INSIDE THE TOOL
    //
    // A gate a tool can forget is not a gate. The tool is the thing being governed, and in this
    // system the tool is code that will eventually be chosen at runtime. Putting the check in the
    // executor means the decision is made by the component that owns mission state, and that a
    // tool physically cannot reach its effects without passing it.
    //
    // WHY THE KEY IS EXACT
    //
    // The key binds mission, step, effect kind, target AND plan epoch. The epoch is what stops an
    // approval surviving a replan: a replanned step keeps its id (ids come from the plan's shape)
    // while meaning something different, so an approval keyed on the id alone would silently
    // authorise the new action.
    // ---- PREFLIGHT: can this step run AT ALL, regardless of authorisation?
    //
    // Checked before the approval gate, deliberately. A refused command is not something a human
    // can authorise - there is no approval that makes `cmd.exe` an acceptable program - so asking
    // for one would be asking the human to decide something that was never on the table. It also
    // means a blocked command reports WHY, rather than sitting at `needs-human` implying a person
    // could unblock it.
    const preflight = deps.tools.preflight?.(step)
    if (preflight) {
      emit({ type: 'step-refused', stepId: step.id, reason: preflight.blocked } as never)
      recordResult(step.id, {
        kind: preflight.needsHuman ? 'needs-human' : 'failed',
        reason: preflight.blocked,
      }, cfg.now())
      continue
    }

    // ---- THE EFFECT THIS STEP WOULD ACTUALLY HAVE.
    //
    // Three sources, in descending order of authority:
    //
    //   1. the TOOL's own reading of its arguments   - knows what it is about to do
    //   2. the tool's static `consequential` flag     - always the same, whatever the arguments
    //   3. the plan step's DECLARATION                - the weakest, and the only one a planner
    //                                                   controls
    //
    // (1) exists because of the terminal tool. A single static flag is right for a tool that is
    // always consequential and useless for one that depends on its arguments: marking the
    // terminal tool consequential would demand a human for `git status`, and NOT marking it would
    // wave `git push` through. Keying on the command rather than the capability is the difference
    // between a policy that can be used and one that is either ignored or unusable.
    //
    // A disagreement between (1) and (3) is a PLAN DEFECT and fails the step. The tool is taken as
    // the authority on what it will do - it is about to do it - and a plan that describes a
    // different action than the one queued is a plan that cannot be trusted, rather than one to
    // be quietly corrected.
    const toolEffect = deps.tools.effectOf?.(step)
    const declared = step.effect
    if (toolEffect && declared) {
      const mismatch =
        toolEffect.kind !== declared.kind || toolEffect.target !== declared.target
      if (mismatch) {
        recordResult(step.id, {
          kind: 'failed',
          reason:
            `plan defect: the step declares ${declared.kind} on "${declared.target}" but ` +
            `"${step.tool}" reports it would ${toolEffect.kind} on "${toolEffect.target}". ` +
            `The tool is taken as the authority on what it will do, and a plan that describes a ` +
            `different action is not one to be corrected silently.`,
        }, cfg.now())
        continue
      }
    }
    /** The effect the approval key is built from. Never the planner's word for it alone. */
    const effect = toolEffect ?? declared

    if (effect || deps.tools.isConsequential?.(step)) {
      if (!effect) {
        // A plan defect, not a transient failure: retrying cannot help, because the declaration
        // is absent rather than wrong.
        recordResult(step.id, {
          kind: 'failed',
          reason:
            `plan defect: "${step.tool}" is registered as a consequential tool but this step ` +
            `declares no effect, so there is nothing to authorise. Omitting the declaration ` +
            `must not be a way to act.`,
        }, cfg.now())
        continue
      }
      const key = keyFor(mission.id, step.id, effect, planEpoch)
      approvals?.request(key, `${effect.kind} on ${effect.target}: ${effect.reason}`)

      // Read once per consult point. An earlier version called `approvals.permits(key)` and then
      // `approvals.lookup(key)!` a second time to name who decided - so the two reads could
      // disagree, and removing the gate made the second one throw on a missing decision. Each
      // consult reads the store ONCE into a local, and the local is only ever REPLACED by a
      // fresh read after the optional wait - never paired with a second read of a different shape.
      let decision = approvals?.lookup(key)

      // Emergency stop and takeover are checked ABOVE and halt the mission outright, so an
      // approval can never outrank them. Here we decide only authorisation, and a human who has
      // taken the machine is not reachable by any approval.
      if (decision?.state !== 'approved') {
        const rejected = decision?.state === 'rejected'
        emit({
          type: 'approval-required',
          stepId: step.id,
          kind: effect.kind,
          target: effect.target,
          reason: effect.reason,
          irreversible: effect.irreversible,
          state: rejected ? 'rejected' : 'pending',
        } as never)

        // A decision channel may be able to WAIT for the human - the request above is what it
        // shows them. Waiting can never grant: it only lets the executor look at the store again,
        // and the store's answer is still the only way this step runs. Already-rejected is not
        // re-waited (a decision has been made; asking again would be harassment, not safety),
        // and any throw from the hook falls through unapproved.
        if (!rejected && deps.awaitApproval) {
          try {
            await deps.awaitApproval(key, effect)
          } catch { /* the step stays needs-human; a broken channel must not become an approval */ }
          decision = approvals?.lookup(key)
        }

        if (decision?.state !== 'approved') {
          recordResult(step.id, {
            kind: 'needs-human',
            reason: decision?.state === 'rejected'
              ? `authorisation was REFUSED for ${effect.kind} on ${effect.target}`
              : `awaiting human authorisation for ${effect.kind} on ${effect.target}: ${effect.reason}`,
          }, cfg.now())
          break
        }
      }
      emit({
        type: 'approval-satisfied',
        stepId: step.id,
        kind: effect.kind,
        target: effect.target,
        decidedBy: decision.decidedBy,
      } as never)
    }

    // ---- tool selection, recorded so "which tool ran" is never a guess.
    //
    // A compiled step carries BOTH a capability and a tool name. The capability is the requirement
    // and the tool is what the router resolved it to at compile time, so this is a check that the
    // tool still serves the requirement rather than a second selection path. Resolving by capability
    // here would mean the executor and the plan could disagree about what a step needs, and the
    // disagreement would only surface as a tool behaving unexpectedly.
    const declaredCapability = (step as { capability?: string }).capability
    const resolution = deps.tools.resolve(step)
    if ('unavailable' in resolution) {
      recordResult(step.id, { kind: 'failed', reason: `no tool available: ${resolution.unavailable}` }, cfg.now())
      continue
    }
    if (declaredCapability && deps.tools.resolveCapability) {
      const byCap = deps.tools.resolveCapability(declaredCapability)
      if ('unavailable' in byCap) {
        // A capability nobody serves is a PLAN defect, and it is reported as such rather than
        // falling back to the named tool - which is the substitution this project refuses everywhere.
        recordResult(step.id, {
          kind: 'failed',
          reason: `plan defect: step "${step.id}" requires the capability "${declaredCapability}" and ${byCap.unavailable}`,
        }, cfg.now())
        continue
      }
      if (byCap.tool.name !== resolution.tool.name) {
        recordResult(step.id, {
          kind: 'failed',
          reason:
            `plan defect: step "${step.id}" requires "${declaredCapability}", which resolves to ` +
            `"${byCap.tool.name}", but the plan names "${resolution.tool.name}". The plan and the ` +
            `router disagree about what this step needs.`,
        }, cfg.now())
        continue
      }
    }
    emit({
      type: 'tool-selected',
      stepId: step.id,
      requested: step.tool ?? null,
      selected: resolution.tool.name,
      fellBack: resolution.fellBack,
      reason: resolution.reason,
    } as never)

    const maxAttempts = cfg.maxAttempts
    let attempt = 0
    let finalOutcome: StepOutcome | null = null
    let lastFailure = ''
    // Retained so later steps can consume it through `ctx.prior`, and so the audit keeps what
    // the tool actually returned on a step that succeeded. Previously `output` was hardcoded to
    // `undefined`, which discarded every tool result the moment the step ended.
    //
    // Declared out here because the record happens after the retry loop, and the last attempt's
    // data is what must be kept - an earlier version declared it inside the loop and could not
    // see it at the record site.
    let toolData: unknown

    // Hoisted OUT of the retry loop, because the durable result written after the loop needs it and
    // an earlier version referenced the loop-local `startedAt`, which was not in scope there.
    const stepStartedAt = cfg.now()
    while (attempt < maxAttempts) {
      attempt++
      if (signal?.aborted) { halted = { cause: 'cancelled', reason: 'halted mid-step', stepId: step.id }; break }
      // Contained exactly like `control.observe()` below: a consult that THROWS mid-retry is an
      // infrastructure halt with a durable outcome, never an unwind that skips the finalise.
      let latchedMidRetry: boolean
      try {
        latchedMidRetry = await cfg.emergencyStop()
      } catch (e) {
        halted = {
          cause: 'infrastructure',
          reason: `the emergency-stop consult itself failed mid-step (${e instanceof Error ? e.message : String(e)}); the executor will not continue without reading the stop`,
          stepId: step.id,
        }
        break
      }
      if (latchedMidRetry) { halted = { cause: 'emergency-stop', reason: 'halted mid-step', stepId: step.id }; break }
      if (attempt > 1) {
        emit({ type: 'retry', stepId: step.id, attempt, maxAttempts, reason: lastFailure } as never)
      }

      const startedAt = cfg.now()
      // Fresh observation per attempt: an attempt is made against the world as it is NOW.
      //
      // Wrapped, because a control surface that dies mid-mission must halt the mission, not
      // throw out of execute() and leave no record of what happened.
      try {
        observation = await deps.control.observe()
      } catch (e) {
        halted = { cause: 'infrastructure', reason: `the control surface failed mid-mission: ${e instanceof Error ? e.message : String(e)}`, stepId: step.id }
        break
      }
      if (!observation) { halted = { cause: 'infrastructure', reason: 'no observation available', stepId: step.id }; break }
      const ctx: ToolContext = {
        missionId: mission.id,
        stepId: step.id,
        attempt,
        observation,
        prior: Object.fromEntries(results),
        signal: signal ?? new AbortController().signal,
      }

      emit({
        type: 'step-started',
        stepId: step.id,
        intent: step.intent,
        mode: step.mode,
        tool: resolution.tool.name,
        attempt,
        dependenciesSatisfied: depsOf,
      } as never)

      // ---- WRITE-AHEAD (M16). Recorded BEFORE the tool runs.
      //
      // If the process dies between here and the outcome, the durable record says an action was
      // ATTEMPTED, against which operands, by which tool - which is a recoverable state. Without it a
      // crash during the tool call leaves a record saying the step never ran, and the only sensible
      // response to that is to run it again.
      //
      // If this write fails, nothing has happened yet, so `failed` is honest - but it is a failure of
      // the RECORD, not of the tool, and the reason says so. Nothing is retried blindly.
      const rec = cfg.recorder
      if (rec) {
        try {
          rec.attemptBegin({
            missionId: mission.id, stepId: step.id, attempt,
            tool: resolution.tool.name, intent: step.intent, mode: step.mode,
            args: step.args, at: cfg.now(),
          })
        } catch (e) {
          finalOutcome = {
            kind: 'failed',
            reason: `refused to act: the attempt could not be durably recorded first (${msgOf(e)}). No action was taken.`,
          }
          emit({ type: 'step-refused', stepId: step.id, reason: finalOutcome.reason } as never)
          break
        }
      }

      let tr: ToolResult
      try {
        // The step's own operands, not a hardcoded empty object. See Step.args: without this a
        // tool had no way to be told what it was supposed to act on.
        tr = await resolution.tool.run(ctx, step.args ?? {})
      } catch (e) {
        // A THROWN TOOL IS NOT AUTOMATICALLY A FAILED ACTION - for a tool that acts on the
        // desktop through the operator host, at least.
        //
        // This catch used to convert every throw to `failed`, and `failed` is a CLAIM: it says
        // the action did not take effect, and that claim is what authorizes a retry. For a
        // desktop-acting tool whose transport died mid-request the claim is unsupportable - the
        // host may have received the request and executed part of it before dying (the 2026-10-22
        // OpenVault case). The classification below is the one desktop-input applies to its own
        // non-delivery reports, through the SAME shared classifier (transport-loss.ts), so the
        // two layers can never disagree about the same evidence:
        //
        //   - a confirmed PRE-DISPATCH refusal (ECONNREFUSED - the TCP connection was never
        //     established, so no request ever left this machine) stays `failed`: nothing was
        //     dispatched and a clean retry is honest. `midActionTransportLoss` excludes it for
        //     exactly this reason;
        //   - any other transport-loss or timeout signature becomes `outcome-unknown`, which
        //     the branch below refuses to retry (terminal, even with attempts to spare) and the
        //     recorder persists as `uncertain` for Stage D reconciliation;
        //   - everything else - an ordinary tool bug, a bad argument, a missing file - keeps the
        //     ordinary `failed` behavior unchanged. This must not become a blanket
        //     reclassification of tool exceptions as transport failures.
        //
        // The gate is the tool's MODE: `gui` and `uia` are the modes that act on the desktop
        // through this host. Other modes' transports (subprocess pipes, the browser's CDP
        // socket) are not the operator host, and their error strings are not evidence about the
        // desktop. Known cost of the mode-level gate, accepted deliberately: a purely
        // observational gui/uia query that dies mid-request also classifies as unknown - the
        // executor cannot prove from here that the tool only read - and unknown is the
        // fail-closed direction.
        const msg = e instanceof Error ? e.message : String(e)
        const actsOnDesktop = resolution.tool.mode === 'gui' || resolution.tool.mode === 'uia'
        tr = actsOnDesktop && midActionTransportLoss(msg)
          ? {
              kind: 'outcome-unknown',
              reason: `the ${resolution.tool.name} tool threw mid-request (${msg}); the operator `
                + 'transport died with the action in flight, so part of it may already have '
                + 'reached the machine. It must not be blindly retried: the machine has to be '
                + 'observed, or a human asked, before this step is attempted again.',
            }
          : { kind: 'failed', reason: msg }
      }

      // ---- THE MACHINE HAS NOW BEEN ACTED ON. Recording the outcome is therefore different in kind
      // from every other durable write in this function.
      //
      // If THIS throws, we do not know whether the tool changed anything. `failed` would assert that
      // it did not, and the retry loop would then repeat a real-world action - a second email, a
      // second purchase, a second delete. So the step becomes `outcome-unknown`: not complete, not
      // retryable, and requiring fresh observation before anything else happens.
      if (rec) {
        try {
          rec.attemptOutcome({
            missionId: mission.id, stepId: step.id, attempt,
            ok: tr.kind === 'data',
            summary: tr.kind === 'data' ? tr.summary : undefined,
            reason: tr.kind === 'data' ? undefined : tr.reason,
            durationMs: cfg.now() - startedAt, at: cfg.now(), data: toolData,
          })
        } catch (e) {
          finalOutcome = {
            kind: 'outcome-unknown',
            reason:
              'the tool acted and the record of what it returned could not be written. The machine may ' +
              'have changed; this is NOT a failure and must NOT be retried until it has been looked at.',
            attempt,
            attempted: { tool: resolution.tool.name, intent: step.intent, args: step.args },
            persistenceError: msgOf(e),
          }
          emit({ type: 'step-refused', stepId: step.id, reason: finalOutcome.reason } as never)
          break
        }
      }

      // Retained so later steps can consume it through `ctx.prior`, and so the audit keeps what
      // the tool actually returned on a step that succeeded. Previously `output` was hardcoded
      // to `undefined`, which discarded every tool result the moment the step ended.
      toolData = tr.kind === 'data' ? tr.data : undefined

      emit({
        type: 'tool-returned',
        stepId: step.id,
        attempt,
        ok: tr.kind === 'data',
        summary: tr.kind === 'data' ? tr.summary : tr.reason,
        durationMs: cfg.now() - startedAt,
      } as never)

      // ---- terminal outcomes that are NOT retried. Retrying "needs human" would burn
      // attempts waiting for a person who is not coming, and retrying a stale plan is
      // pointless (Â§16).
      if (tr.kind === 'needs-human') {
        finalOutcome = { kind: 'needs-human', reason: tr.reason }
        emit({ type: 'human-required', stepId: step.id, reason: tr.reason } as never)
        break
      }
      if (tr.kind === 'replan-required') {
        finalOutcome = { kind: 'replan-required', reason: tr.reason, invalidation: tr.invalidation }
        // Recorded as its own event, not only as an outcome, so the audit can answer "why was
        // replanning necessary?" directly. `observed` carries the step's own account of what it
        // saw, which is what makes the judgement checkable rather than asserted.
        emit({
          type: 'plan-invalidated',
          stepId: step.id,
          reason: tr.reason,
          invalidation: tr.invalidation,
          // `observed` is a field ON the replan-required variant. This used to dig through
          // `tr.data?.observed ?? tr.summary`, neither of which exists on that arm of the union - so it
          // fell back to `tr.reason` and recorded the reason twice, carrying no observation at all.
          //
          // The reason it does not have a `data` field is the point: a step that requires replanning
          // has not produced a result, so there is nothing to put in one. Inventing a field for it
          // would give the impression that a replan requirement carries step output.
          observed: tr.observed ?? tr.reason,
        } as never)
        break
      }
      // ---- THE ACTION'S FATE IS UNKNOWN, by the tool's own report: the transport died while
      // the request was in flight, so part of the input may already be on the machine. Terminal
      // for this attempt loop - `isRetryable('outcome-unknown')` is false by contract - and
      // recorded as `uncertain`, which Stage D recovery surfaces for reconciliation BEFORE
      // anything re-runs. Retrying here would be the blind retry the whole variant exists to
      // forbid; `persistenceError` carries the transport detail because that IS what could not
      // be established about the machine's state.
      if (tr.kind === 'outcome-unknown') {
        finalOutcome = {
          kind: 'outcome-unknown',
          reason: tr.reason,
          attempt,
          attempted: { tool: resolution.tool.name, intent: step.intent, args: step.args },
          persistenceError: tr.reason,
        }
        emit({ type: 'step-refused', stepId: step.id, reason: tr.reason } as never)
        break
      }
      if (tr.kind === 'failed') {
        lastFailure = tr.reason
        finalOutcome = { kind: 'failed', reason: tr.reason }
        // Do not retry when the tool refused to write because the file already exists.
        // The file was likely written in a prior attempt; retrying would meet the same
        // refusal and prevent the mission from completing. Instead, remember the refusal
        // reason so the post-loop logic can verify the existing file content.
        const alreadyExistsReason =
          typeof finalOutcome.reason === 'string' &&
          (/already exists|will not be overwritten/i.test(finalOutcome.reason))
        if (alreadyExistsReason) {
          // Remember we saw an already-exists refusal so the post-loop logic
          // can verify the existing file instead of marking the step as failed.
          ;(finalOutcome as any)._alreadyExistsReason = finalOutcome.reason
        }
        if (attempt < maxAttempts && isRetryable(finalOutcome)) continue
        emit({ type: 'retry-exhausted', stepId: step.id, attempts: attempt, lastOutcome: finalOutcome } as never)
        break
      }
      if (tr.kind === 'nothing-found') {
        // Nothing found is NOT a success and NOT a failure. It is an answer, and it is recorded
        // as one - because collapsing it into either is the defect this system exists to avoid.
        finalOutcome = { kind: 'legitimately-empty', reason: tr.reason }
        break
      }

      // ---- INDEPENDENT VERIFICATION. The tool said `data`; that is a claim, not a fact.
      let verdict: Awaited<ReturnType<Verifier['verify']>>
      if (!deps.verifier.verifies(step)) {
        verdict = { rejected: `no verifier is registered for this step, so "${step.intent}" cannot be claimed complete` }
      } else {
        try {
          verdict = await deps.verifier.verify(step, ctx, tr.data)
        } catch (e) {
          verdict = { rejected: `verification threw: ${e instanceof Error ? e.message : String(e)}` }
        }
      }

      // ---- DISCRIMINATE THE VERDICT FIRST.
      //
      // Both arms are handled in their own branches rather than through a boolean, because that is the
      // only way the compiler can prove which field exists. Reading `verdict.evidence` and
      // `verdict.rejected` behind an `accepted` boolean does not narrow the union, and the code
      // depended on a shape the type did not guarantee.
      //
      // THIS ORDERING IS A FIX, NOT A STYLE CHOICE.
      //
      // `rec.verified(...)` used to sit ABOVE the accepted/rejected test, so the durable store was
      // told a step had been verified on EVERY verdict - including one that had just been REJECTED,
      // where `evidence` is `undefined`. The audit trail recorded verified work that no verifier had
      // accepted, with no evidence attached.
      //
      // Nothing caught it because nothing typechecked the project. TypeScript flagged
      // `verdict.evidence` as not existing on the `{ rejected }` arm, which is the same defect seen
      // from the other side: the behaviour was wrong before the type was, and the type was never read.
      if ('evidence' in verdict) {
        // ---- DURABLE EVIDENCE, with its provenance.
        //
        // The verification has already HAPPENED - it is a read, not an action - so losing the record
        // of it does not put the machine in an unknown state. But it does mean nobody can later show
        // that this step was verified, so the step cannot be claimed complete: it becomes
        // `outcome-unknown` rather than `verified`. An unverifiable-in-retrospect step is not a
        // verified step.
        if (rec) {
          try {
            rec.verified({
              missionId: mission.id, stepId: step.id, attempt,
              evidence: verdict.evidence, verifier: verifierNameFor(step), at: cfg.now(),
            })
          } catch (e) {
            finalOutcome = {
              kind: 'outcome-unknown',
              reason:
                'the action was performed and independently verified, but the evidence could not be ' +
                'recorded. It cannot be claimed complete, because nobody can show it later.',
              attempt,
              attempted: { tool: resolution.tool.name, intent: step.intent, args: step.args },
              persistenceError: msgOf(e),
            }
            emit({ type: 'step-refused', stepId: step.id, reason: finalOutcome.reason } as never)
            break
          }
        }

        emit({
          type: 'evidence-verified',
          stepId: step.id,
          attempt,
          accepted: true,
          evidence: verdict.evidence,
          reason: 'independent check satisfied the step',
        } as never)

        finalOutcome = { kind: 'verified', evidence: verdict.evidence }
        break
      }

      emit({
        type: 'evidence-verified',
        stepId: step.id,
        attempt,
        accepted: false,
        evidence: null,
        reason: verdict.rejected,
      } as never)

      // A tool that claims success and cannot show it is a FAILURE, not a near miss.
      lastFailure = `tool reported data but verification rejected it: ${verdict.rejected}`
      finalOutcome = { kind: 'failed', reason: lastFailure }
      if (attempt < maxAttempts && isRetryable(finalOutcome)) continue
      emit({ type: 'retry-exhausted', stepId: step.id, attempts: attempt, lastOutcome: finalOutcome } as never)
    }

    if (halted) break
    // Check if the step failed because the file already exists from a prior attempt.
    // If so, verify the existing file content rather than marking the step as failed.
    const alreadyExistsReason = (finalOutcome as { _alreadyExistsReason?: string })?._alreadyExistsReason
    if (alreadyExistsReason) {
      // Record that an "already exists" refusal was encountered during execution.
      // The post-loop logic may use this information to decide whether a read-back
      // of the existing file is appropriate, but the step must still be independently
      // verified by the designated verifier — we do not manufacture verification from
      // an unrelated file existing in the OS temporary directory.
      ;
    }
    if (finalOutcome) {
      // ---- THE DERIVED RESULT, made durable.
      //
      // Derived AFTER the fact from facts already recorded, in the order the brief specifies. If this
      // write fails, the step becomes `outcome-unknown`: a step whose result the store does not hold
      // is a step nobody can account for, and accounting for every step is the store's whole purpose.
      // It is emphatically NOT `failed` - the work may have been done perfectly.
      // `cfg.recorder` rather than the loop-local `rec`, which is not in scope out here.
      if (cfg.recorder) {
        const rec = cfg.recorder
        const dur: StepResult = { id: step.id, outcome: finalOutcome, durationMs: cfg.now() - stepStartedAt, output: toolData }
        try {
          rec.stepResult(mission.id, step.id, dur, cfg.now())
        } catch (e) {
          finalOutcome = {
            kind: 'outcome-unknown',
            reason: 'the step finished but its result could not be recorded, so it cannot be accounted for and must not be retried.',
            attempt,
            attempted: { tool: step.tool, intent: step.intent, args: step.args },
            persistenceError: msgOf(e),
          }
          // The note is best-effort BY DESIGN and this is the one place a failure is swallowed: the
          // store has just refused a write, so a second write is very likely to fail too. The
          // uncertainty is already in the returned outcome, which is where a caller will look.
          try {
            rec.note(mission.id, 'recovery', `step ${step.id}: result could not be recorded (${msgOf(e)})`)
          } catch { /* the store is already refusing writes; the outcome above carries it */ }
        }
      }
      recordResult(step.id, finalOutcome, cfg.now(), { output: toolData })
    }
  }

  // ---- finalise
  const c = counts()
  const completedStepsMission = {
    ...mission,
    plan: plan.map((s) => ({ ...s, status: 'done' as const, result: results.get(s.id) })),
  }
  // Step completion is not mission success: the objective must also be proven by evidence.
  // Without this distinction, a mission with no declared postconditions could end in `complete`
  // while its durable record correctly says `unproven`.
  const complete = isMissionSuccessful(completedStepsMission, verifiedEvidence)

  if (halted) {
    emit({ type: 'execution-halted', reason: halted.reason, cause: halted.cause, stepId: halted.stepId } as never)
    const st: MissionState = halted.cause === 'emergency-stop' ? 'abandoned' : halted.cause === 'cancelled' ? 'abandoned' : 'failed'
    transition(missionState, st, halted.reason, halted.stepId)
    // A latched emergency stop is EPHEMERAL and stays authoritative. Recording that the mission
    // stopped is fine; recording anything readable as "the stop may now be lifted" would not be,
    // and no such column exists in the schema.
    try { cfg.recorder?.missionEnded(mission.id, st, false, cfg.now()) } catch { /* the record lags; the stop is what matters */ }
    emit({ type: 'mission-finished', state: st, complete: false, ...c, durationMs: cfg.now() - t0 } as never)
    const m = finalMission(st, plan, results, history, mission)
    return { mission: m, record: recordOf(m, events, verifiedEvidence, t0, cfg.now()), events }
  }

  // ---- SELF-CHECK. If the executor's own belief disagrees with the completion contract, say
  // so loudly (Â§23, Â§24). Silently reconciling them would hide a defect in the thing that
  // decides whether work was done.
  const stepStates = plan.map((s) => ({ ...s, status: 'done' as const, result: results.get(s.id) }))
  const independentlySuccessful = isMissionSuccessful({ ...mission, plan: stepStates }, verifiedEvidence)
  if (complete && !independentlySuccessful) {
    emit({ type: 'integrity-violation', detail: 'executor believed the mission successful but the success contract disagreed' } as never)
  }
  if (!complete && independentlySuccessful) {
    emit({ type: 'integrity-violation', detail: 'the success contract said successful but the executor did not' } as never)
  }

  const needsHuman = c.needsHuman > 0
  const replan = c.replanRequired > 0
  const st: MissionState = complete ? 'complete' : needsHuman ? 'blocked-on-human' : replan ? 'recovering' : 'failed'
  const why = complete
    ? 'the steps completed and the objective was independently verified'
    : needsHuman ? 'a step needs a human decision'
    : replan ? 'a step requires replanning; the plan no longer matches the world'
    : 'one or more steps failed'
  transition(missionState, st, why)
  emit({ type: 'mission-finished', state: st, complete, ...c, durationMs: cfg.now() - t0 } as never)

  // The terminal state, durably. Reported rather than swallowed when it fails, because a mission that
  // cannot record its own ending is the case where a reader is most likely to be misled.
  if (cfg.recorder) {
    try {
      cfg.recorder.missionEnded(mission.id, st, complete, cfg.now())
    } catch (e) {
      emit({ type: 'note', stepId: '(mission)', text: `the mission's ending could not be recorded (${msgOf(e)})` } as never)
    }
  }

  const m = finalMission(st, plan, results, history, mission)
  return { mission: m, record: recordOf(m, events, verifiedEvidence, t0, cfg.now()), events }
}

function finalMission(
  state: MissionState,
  plan: readonly Step[],
  results: Map<string, StepResult>,
  history: HistoryEntry[],
  original: Mission,
): Mission {
  return {
    ...original,
    state,
    plan: plan.map((s) => {
      const r = results.get(s.id)
      return {
        ...s,
        status: !r ? 'pending' : statusForOutcome(r.outcome),
        result: r,
        attempts: r ? 1 : 0,
      } as Step
    }),
    history: [
      ...history,
      { at: 0, kind: 'note', summary: `mission reached ${state}` },
    ],
  }
}

/**
 * A mission that refuses to start, as a REAL `ExecuteResult`.
 *
 * Both of these refusals used to hand-build a record of the wrong shape:
 *
 *   { missionId, startedAt, finishedAt, state, complete, verified: 0, failed, needsHuman, skipped }
 *
 * against a declared `ExecutionRecord` of
 *
 *   { missionId, startedAt, finishedAt, events, finalState, complete, verified }
 *
 * So the field was `state` where the type says `finalState`, `events` was missing entirely, and
 * `verified` was the NUMBER 0 where the type says `Record<string, Evidence>` - a map of stepId to the
 * evidence that verified it. The extra count-shaped fields do not exist on the record at all.
 *
 * Nothing caught it: the two call sites were the only places in the file that built a record without
 * going through `recordOf`, and `verified: 0` happened to be assignable nowhere but the compiler was
 * never asked. The practical effect was that the "this plan was amended after you reviewed it"
 * refusal - one of the most important refusals in the system - returned a record whose `events` was
 * `undefined` and whose `verified` was not a map.
 *
 * It is built through `recordOf` now, and takes only a reason, so there is no second way to construct
 * one and nothing here can drift from the type again.
 */
function refusal(mission: Mission, reason: string): ExecuteResult {
  const events: ExecutionEvent[] = [{
    type: 'step-refused',
    seq: 0,
    at: 0,
    missionId: mission.id,
    stepId: '(mission)',
    reason,
  } as unknown as ExecutionEvent]
  return {
    mission,
    record: recordOf(mission, events, {}, 0, 0),
    events,
  }
}

function recordOf(
  m: Mission,
  events: ExecutionEvent[],
  verified: Record<string, Evidence>,
  startedAt: number,
  finishedAt: number,
): ExecutionRecord {
  return {
    missionId: m.id,
    startedAt,
    finishedAt,
    events,
    finalState: m.state,
    // Success is steps AND objective. Both, always.
    //
    // `isComplete` alone is the original defect in one expression: a plan of one step that writes a
    // summary covering one of ten files verifies every step it has and reports the user's objective
    // achieved. The verdict is computed here, from the evidence this run actually produced, and
    // recorded alongside rather than folded in, so a reader can see WHICH half was missing.
    objective: objectiveVerdict(m.objectivePostconditions, verified),
    complete: isMissionSuccessful(m, verified),
    verified,
  }
}
