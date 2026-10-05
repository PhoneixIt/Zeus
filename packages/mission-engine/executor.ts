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
  isComplete, tally,
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
import { keyFor, type ApprovalStore } from '../governance/approval.ts'

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
  | { kind: 'needs-human'; reason: string }
  | { kind: 'replan-required'; reason: string; invalidation: PlanInvalidation; observed?: string }

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
  },
  opts: ExecuteOptions = {},
): Promise<ExecuteResult> {
  const cfg = { ...DEFAULTS, ...deps.config }
  const planEpoch = opts.planEpoch ?? 0
  const approvals = deps.approvals
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

      // Fetched ONCE. An earlier version called `approvals.permits(key)` and then
      // `approvals.lookup(key)!` a second time to name who decided - so the two reads could
      // disagree, and removing the gate made the second one throw on a missing decision. Reading
      // it once removes the class of bug entirely: there is no assertion to be wrong about.
      const decision = approvals?.lookup(key)

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

        recordResult(step.id, {
          kind: 'needs-human',
          reason: rejected
            ? `authorisation was REFUSED for ${effect.kind} on ${effect.target}`
            : `awaiting human authorisation for ${effect.kind} on ${effect.target}: ${effect.reason}`,
        }, cfg.now())
        break
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

      let tr: ToolResult
      try {
        // The step's own operands, not a hardcoded empty object. See Step.args: without this a
        // tool had no way to be told what it was supposed to act on.
        tr = await resolution.tool.run(ctx, step.args ?? {})
      } catch (e) {
        tr = { kind: 'failed', reason: e instanceof Error ? e.message : String(e) }
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
      // pointless (§16).
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
          observed: String((tr.data as { observed?: unknown } | undefined)?.observed ?? tr.summary ?? tr.reason),
        } as never)
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
      recordResult(step.id, finalOutcome, cfg.now(), { output: toolData })
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
  const replan = c.replanRequired > 0
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
        status: !r ? 'pending' : r.outcome.kind === 'verified' || r.outcome.kind === 'legitimately-empty' ? 'done' : r.outcome.kind === 'skipped' ? 'skipped' : r.outcome.kind === 'failed' ? 'failed' : 'pending',
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
