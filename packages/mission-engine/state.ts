/**
 * Mission state.
 *
 * Section 4's central requirement, and the thing that separates an operator from a script
 * runner: the mission must know what it was trying to do, what it has actually verified
 * done, and whether the world changed under it.
 *
 * THE FAILURE THIS STRUCTURE EXISTS TO PREVENT
 *
 * Three real defects in the PortAi mission repository were the same shape, and it is worth
 * naming them because mission state is exactly where they hide:
 *
 *   1. An OpenAI response in its array form was silently discarded. Zero drafts were
 *      created and the route reported success. Outreach could stop entirely while the
 *      system reported health and every test passed.
 *   2. A chain downstream of it had `catch { return [] }` and a `|| []` that turned a
 *      provider failure into an empty-but-successful result.
 *   3. A run in which EVERY specialist agent threw was recorded as `completed`, durably,
 *      in the agent_runs table - because the status only consulted whether a provider
 *      credential existed, not whether any work happened.
 *
 * All three are the same error: failure converted to an empty value, and the empty value
 * indistinguishable from success. A mission model that records "what did I accomplish" as
 * a count, or infers completion from a step returning, cannot catch any of them. So
 * completion here is a VERIFIED CLAIM, never an inferred one.
 */

/** What a step is allowed to claim about itself. */
export type StepOutcome =
  /** Did the thing. Verified by an independent observation, not by having run. */
  | { kind: 'verified'; evidence: Evidence }
  /** Did not do it, and that is a legitimate answer - e.g. genuinely nothing matched. */
  | { kind: 'legitimately-empty'; reason: string }
  /** Did not do it, and could not. The honest answer. NOT a success. */
  | { kind: 'failed'; reason: string; recovered?: boolean }
  /** Needs a human: an approval, a credential, a judgement call. */
  | { kind: 'needs-human'; reason: string }
  /**
   * The step cannot proceed because the world is not what the plan assumed.
   *
   * Distinct from `failed` because the remedy differs. A failure says "this approach did
   * not work"; replan-required says "this approach is no longer VALID" - the target closed,
   * the focus moved, a precondition vanished. Retrying such a step would be retrying a plan
   * for a world that no longer exists (§16).
   */
  | { kind: 'replan-required'; reason: string; invalidation: PlanInvalidation }

/**
 * Evidence that something actually happened.
 *
 * The `kind` is deliberately narrow. An executor claiming "done" must attach one of these,
 * and each names an independent way of checking - a file exists, a process is running, a
 * page contains text. The point is that the executor CANNOT manufacture evidence: producing
 * it requires actually going and looking.
 */
export type Evidence =
  | { kind: 'file-exists'; path: string; bytes?: number }
  | { kind: 'process-running'; name: string; pid?: number }
  | { kind: 'process-exited'; name: string; exitCode: number }
  | { kind: 'window-present'; title: string; hwnd: number }
  | { kind: 'window-gone'; title: string }
  | { kind: 'screen-text-present'; text: string }
  | { kind: 'screen-text-absent'; text: string }
  | { kind: 'command-exit-code'; command: string; code: number }
  | { kind: 'http-status'; url: string; status: number }
  | { kind: 'api-response'; endpoint: string; matched: boolean }

/** Why a mission must re-observe before its next action. */
export type PlanInvalidation =
  | { reason: 'human-took-over' }
  | { reason: 'focus-changed'; to: string }
  | { reason: 'window-closed'; title: string }
  | { reason: 'environment-changed'; detail: string }
  | { reason: 'step-failed'; step: string }

/**
 * A step's result.
 *
 * `output` is NOT success. It is what came back. Whether that constitutes success is decided
 * by `outcome`, and a caller that sets outcome: 'verified' without evidence is lying - the
 * type does not prevent it, but the verifier does, and that asymmetry is deliberate: the
 * AI proposes, an independent check disposes.
 */
export interface StepResult {
  readonly id: string
  readonly outcome: StepOutcome
  readonly output?: unknown
  readonly durationMs: number
  readonly errorMessage?: string
}

export type MissionState =
  | 'drafting'
  | 'planning'
  | 'executing'
  | 'verifying'
  | 'blocked-on-human'
  | 'paused-human-takeover'
  | 'recovering'
  | 'complete'
  | 'failed'
  | 'abandoned'

export interface Step {
  readonly id: string
  /** What this step intends. Human-readable, because the human will read this. */
  readonly intent: string
  /**
   * HOW it should be done: gui | uia | browser | cli | filesystem | api.
   *
   * Recorded per step rather than globally because §8 requires the system to choose per
   * task, and recording it makes that choice auditable after the fact. A GUI step where a
   * filesystem step would do is a finding, not a style preference.
   */
  readonly mode: ExecutionMode
  /** Why this step is needed - what breaks without it. */
  readonly rationale: string
  /**
   * Steps that must reach a COMPLETING outcome before this one may start.
   *
   * "Completing", specifically: a dependency that failed or is waiting on a human BLOCKS this
   * step rather than being treated as satisfied. A dependency list that meant merely "was
   * attempted" would let a failed step cascade into a chain of confident-looking successes,
   * which is the same defect shape as inferring completion from having run.
   */
  readonly dependsOn?: readonly string[]
  /**
   * The tool this step calls, resolved through the tool router.
   *
   * Named here rather than inlined so the audit layer can record WHICH tool ran, not merely
   * that something ran. §31 requires the user to be able to see the active tool.
   */
  readonly tool?: string
  readonly status: 'pending' | 'running' | 'done' | 'failed' | 'skipped'
  readonly result?: StepResult
  /** How many times this step has been attempted. Retries are bounded and counted. */
  readonly attempts?: number
}

export type ExecutionMode =
  | 'gui'        // visual interaction; the screen itself is the subject
  | 'uia'        // accessibility tree; reliable when the app exposes it
  | 'browser'    // CDP / DOM
  | 'cli'        // shell, git, builds, tests
  | 'filesystem' // deterministic file work
  | 'api'        // a service endpoint

export interface Mission {
  readonly id: string
  readonly objective: string
  readonly constraints: readonly string[]
  readonly state: MissionState
  readonly plan: readonly Step[]
  /** Recorded the moment the plan stopped being trustworthy, if it did. */
  readonly invalidatedBy?: PlanInvalidation
  /** Everything that happened, including failures. Never pruned. */
  readonly history: readonly HistoryEntry[]
  readonly pendingApprovals: readonly PendingApproval[]
  readonly startedAt: number
  readonly finishedAt?: number
}

export interface HistoryEntry {
  readonly at: number
  readonly kind: 'step' | 'observation' | 'invalidation' | 'approval' | 'recovery' | 'note'
  readonly summary: string
  readonly detail?: unknown
}

/**
 * A consequential action awaiting authorisation.
 *
 * §20: the AI may PREPARE such an action; the human authorises it; then it executes. So this
 * holds a prepared action, never a partially-executed one.
 */
export interface PendingApproval {
  readonly id: string
  readonly description: string
  readonly consequences: readonly string[]
  readonly reversible: boolean
  readonly preparedAction: PreparedAction
}

export type PreparedAction =
  | { kind: 'external-send'; to: string; summary: string }
  | { kind: 'purchase'; item: string; amount: number; currency: string }
  | { kind: 'delete'; paths: readonly string[]; recoverable: boolean }
  | { kind: 'install'; package: string; provenance: string; rollback: string }
  | { kind: 'credential-use'; service: string }
  | { kind: 'security-setting'; setting: string; from: string; to: string }

/**
 * THE COMPLETION RULE
 *
 * A mission is complete when every step has a verified or legitimately-empty outcome. A
 * step that failed is not complete. A step that returned without evidence is not complete.
 *
 * This is deliberately stricter than "all steps ran". That strictness is the whole point:
 * three separate production bugs were exactly the gap between "ran" and "worked".
 */
export function isComplete(m: Mission): boolean {
  if (m.plan.length === 0) return false
  return m.plan.every((s) => {
    if (s.status === 'skipped') return false
    return s.result?.outcome.kind === 'verified' || s.result?.outcome.kind === 'legitimately-empty'
  })
}

/** The honest summary. Never infers success from having executed something. */
export function describeProgress(m: Mission): string {
  const verified = m.plan.filter((s) => s.result?.outcome.kind === 'verified').length
  const empty = m.plan.filter((s) => s.result?.outcome.kind === 'legitimately-empty').length
  const failed = m.plan.filter((s) => s.result?.outcome.kind === 'failed').length
  const waiting = m.plan.filter((s) => s.result?.outcome.kind === 'needs-human').length
  const pending = m.plan.filter((s) => s.status === 'pending').length
  return [
    `${m.state}`,
    `${verified} verified`,
    empty ? `${empty} legitimately empty` : null,
    failed ? `${failed} FAILED` : null,
    waiting ? `${waiting} waiting on human` : null,
    `${pending} pending`,
  ].filter(Boolean).join(' | ')
}