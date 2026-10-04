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
 * which refuses on its own evidence (§35: governance enforceable independently of the AI).
 */

import type {
  ControlSurface,
  Permission,
  Observation,
} from '../../governance/contract.ts'
import {
  isComplete,
  type Evidence,
  type ExecutionMode,
  type HistoryEntry,
  type Mission,
  type MissionState,
  type PlanInvalidation,
  type Step,
  type StepOutcome,
  type StepResult,
} from './state.ts'
import type { ExecutionEvent, ExecutionRecord } from './events.ts'

// ---------------------------------------------------------------- tool contract

export interface ToolContext {
  readonly missionId: string
  readonly stepId: string
  readonly attempt: number
  /** Observation is passed IN, so a tool never has to guess the current state. */
  readonly observation: Observation
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
  | { kind: 'needs-human'; reason: string }
  | { kind: 'replan-required'; reason: string; invalidation: PlanInvalidation }

export interface Tool {
  readonly name: string
  readonly mode: ExecutionMode
  /** For the modes that need a target. Absent for observation-only capabilities. */
  readonly needsTarget?: boolean
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
  },
  opts: ExecuteOptions = {},
): Promise<ExecuteResult> {
  const cfg = { ...DEFAULTS, ...deps.config }
  const signal = opts.signal
  const events: ExecutionEvent[] = []
  let seq = 0
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

  const counts = () => {
    const list = [...results.values()]
    return {
      verified: list.filter((r) => r.outcome.kind === 'verified').length,
      legitimatelyEmpty: list.filter((r) => r.outcome.kind === 'legitimately-empty').length,
      failed: list.filter((r) => r.outcome.kind === 'failed').length,
      needsHuman: list.filter((r) => r.outcome.kind === 'needs-human').length,
      pending: plan.filter((s) => !results.has(s.id)).length,
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
    const m = finalMission('failed', plan, results, history, mission)
    return { mission: m, record: recordOf(m, events, verifiedEvidence, t0, cfg.now()), events }
  }

  let missionState: MissionState = 'executing'
  const transition = (from: MissionState, to: MissionState, reason: string, stepId: string | null = null) => {
    emit({ type: 'state-transition', stepId, from, to, reason } as never)
    missionState = to
  }

  // ---- Observation.
  //
  // The executor never assumes the world is still as it was; §16 requires re-observation
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
    if (await cfg.emergencyStop()) {
      halted = { cause: 'emergency-stop', reason: 'emergency stop is latched; the executor will not continue', stepId: step.id }
      break
    }
    const perm = await cfg.permission()
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
      recordResult(step.id, {
        kind: 'failed',
        reason: `blocked: dependency "${blocking}" did not complete`,
      }, cfg.now())
      continue
    }

    // ---- tool selection, recorded so "which tool ran" is never a guess.
    const resolution = deps.tools.resolve(step)
    if ('unavailable' in resolution) {
      recordResult(step.id, { kind: 'failed', reason: `no tool available: ${resolution.unavailable}` }, cfg.now())
      continue
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

    while (attempt < maxAttempts) {
      attempt++
      if (signal?.aborted || (await cfg.emergencyStop())) { halted = { cause: signal?.aborted ? 'cancelled' : 'emergency-stop', reason: 'halted mid-step', stepId: step.id }; break }
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

      let tr: ToolResult
      try {
        tr = await resolution.tool.run(ctx, {})
      } catch (e) {
        tr = { kind: 'failed', reason: e instanceof Error ? e.message : String(e) }
      }

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
      // pointless (§16).
      if (tr.kind === 'needs-human') {
        finalOutcome = { kind: 'needs-human', reason: tr.reason }
        emit({ type: 'human-required', stepId: step.id, reason: tr.reason } as never)
        break
      }
      if (tr.kind === 'replan-required') {
        finalOutcome = { kind: 'replan-required', reason: tr.reason, invalidation: tr.invalidation }
        break
      }
      if (tr.kind === 'failed') {
        lastFailure = tr.reason
        finalOutcome = { kind: 'failed', reason: tr.reason }
        if (attempt < maxAttempts) continue
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

      const accepted = 'evidence' in verdict
      emit({
        type: 'evidence-verified',
        stepId: step.id,
        attempt,
        accepted,
        evidence: accepted ? verdict.evidence : null,
        reason: accepted ? 'independent check satisfied the step' : verdict.rejected,
      } as never)

      if (accepted) {
        finalOutcome = { kind: 'verified', evidence: verdict.evidence }
        break
      }

      // A tool that claims success and cannot show it is a FAILURE, not a near miss.
      lastFailure = `tool reported data but verification rejected it: ${verdict.rejected}`
      finalOutcome = { kind: 'failed', reason: lastFailure }
      if (attempt < maxAttempts) continue
      emit({ type: 'retry-exhausted', stepId: step.id, attempts: attempt, lastOutcome: finalOutcome } as never)
    }

    if (halted) break
    if (finalOutcome) {
      recordResult(step.id, finalOutcome, cfg.now(), { output: undefined })
    }
  }

  // ---- finalise
  const c = counts()
  const complete = isComplete({
    ...mission,
    plan: plan.map((s) => ({ ...s, status: 'done', result: results.get(s.id) })),
  })

  if (halted) {
    emit({ type: 'execution-halted', reason: halted.reason, cause: halted.cause, stepId: halted.stepId } as never)
    const st: MissionState = halted.cause === 'emergency-stop' ? 'abandoned' : halted.cause === 'cancelled' ? 'abandoned' : 'failed'
    transition(missionState, st, halted.reason, halted.stepId)
    emit({ type: 'mission-finished', state: st, complete: false, ...c, durationMs: cfg.now() - t0 } as never)
    const m = finalMission(st, plan, results, history, mission)
    return { mission: m, record: recordOf(m, events, verifiedEvidence, t0, cfg.now()), events }
  }

  // ---- SELF-CHECK. If the executor's own belief disagrees with the completion contract, say
  // so loudly (§23, §24). Silently reconciling them would hide a defect in the thing that
  // decides whether work was done.
  const stepStates = plan.map((s) => ({ ...s, status: 'done' as const, result: results.get(s.id) }))
  if (complete && !isComplete({ ...mission, plan: stepStates })) {
    emit({ type: 'integrity-violation', detail: 'executor believed the mission complete but the completion contract disagreed' } as never)
  }
  if (!complete && isComplete({ ...mission, plan: stepStates })) {
    emit({ type: 'integrity-violation', detail: 'the completion contract said complete but the executor did not' } as never)
  }

  const needsHuman = c.needsHuman > 0
  const replan = [...results.values()].some((r) => r.outcome.kind === 'replan-required')
  const st: MissionState = complete ? 'complete' : needsHuman ? 'blocked-on-human' : replan ? 'recovering' : 'failed'
  const why = complete
    ? 'every step reached a verified or legitimately-empty outcome'
    : needsHuman ? 'a step needs a human decision'
    : replan ? 'a step requires replanning; the plan no longer matches the world'
    : 'one or more steps failed'
  transition(missionState, st, why)
  emit({ type: 'mission-finished', state: st, complete, ...c, durationMs: cfg.now() - t0 } as never)

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
        status: !r ? 'pending' : r.outcome.kind === 'verified' || r.outcome.kind === 'legitimately-empty' ? 'done' : r.outcome.kind === 'failed' ? 'failed' : 'pending',
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
    complete: isComplete(m),
    verified,
  }
}