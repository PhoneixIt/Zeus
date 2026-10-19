import type { DeclaredEffect } from '../governance/approval.ts'

/**
 * Re-exported so that `Step.effect` can be consumed without reaching into governance.
 *
 * `Step` has carried `effect?: DeclaredEffect` since M3, but the type was imported and not re-exported,
 * so anything that needed it had to import `governance/approval.ts` directly - which `planner/plan.ts`
 * did, and which broke Control E ("no planner module can import anything that could execute").
 *
 * That control is right and the import was wrong. This is the seam that lets the planner DECLARE an
 * effect without being able to REACH the approval store that judges it: one source of truth, and the
 * boundary intact. `governance/approval.ts` still imports nothing, so this cannot become a cycle.
 */
export type { DeclaredEffect }

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
   * for a world that no longer exists (Â§16).
   */
  | { kind: 'replan-required'; reason: string; invalidation: PlanInvalidation }
  /**
   * The step was never attempted, because a precondition stopped it.
   *
   * Distinct from `failed` because the distinction is load-bearing for anyone reading the
   * mission: "I tried and it did not work" is a different fact from "I was never allowed to
   * try". Recording a gate as a failure inflates the apparent unreliability of the plan and
   * buries the real cause.
   *
   * An earlier version recorded dependency-blocked steps as `failed`, which failed toward
   * caution and so was not unsafe - but it misdescribed what happened, and misdescribing
   * state is the defect class this whole engine was built to eliminate.
   */
  | { kind: 'skipped'; reason: string; blockedBy?: string }
  /**
   * THE MACHINE MIGHT HAVE CHANGED AND WE CANNOT SAY WHETHER IT DID.
   *
   * Added by M16, and it is the most important variant in this union.
   *
   * It exists because of one specific sequence:
   *
   *     1. the executor records that it is about to act      (durable)
   *     2. the tool acts                                     (REAL WORLD CHANGES)
   *     3. the executor records what came back               (FAILS)
   *
   * At that point the honest state is "unknown", and the two available answers are both wrong.
   * Calling it `failed` says the action did not take effect, which is exactly the "failed therefore
   * safe to retry" assumption that turns a lost record into a duplicated action - a second email, a
   * second purchase, a second delete. Calling it `verified` is worse: it invents a success.
   *
   * So it is neither. `isComplete` does not count it, no retry is permitted, and recovery treats it
   * as a state requiring fresh observation before anything else happens.
   */
  | {
      kind: 'outcome-unknown'
      reason: string
      /** The attempt number whose outcome was lost. */
      attempt: number
      /** What was durably known BEFORE the action: the tool, the intent, the operands. */
      attempted: { tool?: string; intent: string; args?: Readonly<Record<string, unknown>> }
      /** What could not be recorded, for the reconciliation note. */
      persistenceError: string
    }

/**
 * Evidence that something actually happened.
 *
 * The `kind` is deliberately narrow. An executor claiming "done" must attach one of these,
 * and each names an independent way of checking - a file exists, a process is running, a
 * page contains text. The point is that the executor CANNOT manufacture evidence: producing
 * it requires actually going and looking.
 */
export type Evidence =
  | {
      kind: 'file-exists'
      path: string
      bytes?: number
      /**
       * A human-readable sentence describing how this was observed.
       *
       * Same reason as on `file-read-back`: producers were interpolating their diagnostics into
       * `path`, which is an operand. Anything compared against a path has to find a path there.
       */
      note?: string
    }
  | { kind: 'process-running'; name: string; pid?: number }
  | { kind: 'process-exited'; name: string; exitCode: number }
  | { kind: 'window-present'; title: string; hwnd: number }
  | { kind: 'window-gone'; title: string }
  | { kind: 'screen-text-present'; text: string }
  | { kind: 'screen-text-absent'; text: string }
  | { kind: 'command-exit-code'; command: string; code: number }
  | { kind: 'http-status'; url: string; status: number }
  | { kind: 'api-response'; endpoint: string; matched: boolean }
  /**
   * Input occurred and the control layer attributed it to a known actor.
   *
   * Separate from every observation evidence kind because it answers a different question.
   * "The window is there" is an observation. "Input happened AND the control layer proved who
   * produced it" is an attribution claim, and the two must never be read as interchangeable.
   */
  | { kind: 'input-attributed'; detail: string; actor: 'operator' | 'human' | 'none'; proven: boolean }
  /**
   * Input occurred, but WHO produced it cannot be established.
   *
   * A first-class evidence kind rather than a note, because it is the outcome that most easily
   * gets lost. `verdict` distinguishes the two states that matter:
   *
   *   attribution-unproven  - the record is silent or ambiguous
   *   attribution-defective - the path's ownership tagging is MEASURED not to work
   *
   * A step carrying this evidence is not a pass and must never be summarised as one. The
   * honest reading is "input occurred; ownership unestablished".
   */
  | { kind: 'input-unattributed'; detail: string; verdict: 'attribution-unproven' | 'attribution-defective' }
  /**
   * Folder and file evidence for the filesystem capability.
   *
   * Separate kinds rather than one generic "ok" because each answers a different question, and
   * collapsing them is how "the folder exists" becomes "the summary is correct". A mission that
   * proved only the first has not proved the second.
   */
  | {
      kind: 'directory-present'
      path: string
      entries: number
      /** Provenance for a count made independently of the tool that produced the listing. */
      note?: string
    }
  | { kind: 'folder-contents'; path: string; entries: number; names: readonly string[] }
  | { kind: 'summary-composed'; bytes: number; provenance: string; folder: string }
  | { kind: 'file-written'; path: string; bytes: number; lines: number }
  | {
      kind: 'file-read-back'
      path: string
      bytes: number
      heading: string
      /**
       * SHA-256 of the exact bytes this verifier just read.
       *
       * Added because `heading` carries ONE LINE and `bytes` carries A LENGTH, and a length is not a
       * content claim: a report of the right size holding the wrong facts satisfies both. Without a
       * digest of the body, an objective postcondition can prove an artefact EXISTS and is STABLE
       * but can never prove it SAYS THE RIGHT THING - which is the whole question an objective asks.
       *
       * Optional because a producer that genuinely cannot hash what it read must not be made to
       * claim it did. Its absence is meaningful: an objective that requires content and meets only
       * un-hashed evidence is UNMET, not satisfied. Optionality here is a fail-closed affordance.
       *
       * Computed over the bytes the verifier read, never over the bytes a tool claimed: a digest of
       * the tool's own account would make the process its own witness, which is precisely what this
       * evidence kind exists to prevent.
       */
      sha256?: string
      /**
       * A human-readable sentence describing how this evidence was obtained.
       *
       * Present because three producers were putting exactly this text INTO `path`, which made the
       * field unmatchable: `artifact-exists` and friends compare paths, and `"C:\out\report.md
       * (368 bytes, independently re-read)"` is not a path. A machine-readable field has to stay
       * machine-readable, so the sentence lives here where nothing matches on it.
       */
      note?: string
    }
  /**
   * A consequential action was independently confirmed to have happened.
   *
   * Separate from every observation kind because it answers a governance question as well as a
   * physical one, and both answers are needed: the action was PERMITTED (at the gate, by a human)
   * and it OCCURRED (here, corroborated from outside the tool). Neither implies the other - an
   * approved action can fail, and an action that happened can have been unapproved.
   */
  | { kind: 'file-deleted'; path: string; effect?: string; corroboratedBy: string }
  /**
   * A terminal step's effect was independently confirmed on the filesystem.
   *
   * Deliberately carries NO stdout and NO claim derived from the process's own output. The
   * corroboration string is fixed at construction time to say where the evidence came from,
   * because the whole point of this evidence kind is that the process is not its own witness: an
   * exit code of 0 and a cheerful stdout line are the process's account of itself, and the only
   * reason to record this as verified is that the verifier looked at the world and agreed.
   */
  | {
      kind: 'command-verified'
      executable: string
      path: string
      bytes: number
      exitCode: number | null
      durationMs: number
      /** How many environment variables the child actually received, measured not assumed. */
      envVarCount: number
      corroboratedBy: string
    }

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
   * Recorded per step rather than globally because Â§8 requires the system to choose per
   * task, and recording it makes that choice auditable after the fact. A GUI step where a
   * filesystem step would do is a finding, not a style preference.
   */
  readonly mode: ExecutionMode
  /**
   * The ABSTRACT CAPABILITY this step requires, carried from the proposal.
   *
   * Present so the executor can check that the resolved tool still serves the requirement. Not a
   * second selection path: resolution happened at compile time and is not redone. The check exists
   * because a plan and a router that disagree about what a step needs would otherwise show up as a
   * tool quietly doing something else, which is the failure this project refuses everywhere else.
   */
  readonly capability?: string
  /** Why this step is needed - what breaks without it. */
  readonly rationale: string
  /**
 * The CONSEQUENTIAL EFFECT this step declares, if any.
 *
 * A DECLARATION, not a permission. It obliges the step to obtain human authorisation before the
 * tool runs, and there is deliberately no field anywhere on a plan meaning "approved" - so a plan
 * can require an approval but can never grant one. The executor is the authority.
 */
readonly effect?: DeclaredEffect
  /**
   * What this step operates ON, handed to the tool at run time.
   *
   * This field did not exist, and the executor called `tool.run(ctx, {})` with a literal empty
   * object. Every tool therefore received no parameters at all and had to hardcode whatever it
   * touched. A filesystem step could only ever write the one filename baked into the tool, so
   * it could not be aimed at a chosen target and the mission was not even re-runnable: the
   * second run refused to overwrite the first run's file and failed.
   *
   * An `intent` is prose for a human reader; it cannot be the channel that carries an
   * operand. Without this, "write the report to X" and "write the report to Y" were the same
   * step, which is a plan that cannot express its own objective.
   */
  readonly args?: Readonly<Record<string, unknown>>
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
   * that something ran. Â§31 requires the user to be able to see the active tool.
   */
  readonly tool?: string
  /**
   * `uncertain` is NOT `failed`.
   *
   * A failed step is a step that is known not to have taken effect, so it may be retried. An uncertain
   * step may have changed the machine, so it may not - not until somebody has looked.
   */
  readonly status: 'pending' | 'running' | 'done' | 'failed' | 'skipped' | 'uncertain'
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
  /**
   * THE OBSERVATION THIS PLAN WAS BUILT ON.
   *
   * Present on every compiled mission, because `compile.ts` refuses a proposal without one. Its
   * purpose is staleness detection: a supervisor that re-observes the world can compare fingerprints
   * and know whether the plan still describes reality, and so whether to REPLAN or merely RETRY.
   *
   * Optional only at the type level, so a hand-built mission in a test may omit it. Every mission
   * that came through the compiler has it.
   */
  readonly basis?: import('../planner/plan.ts').PlanBasis
  /**
   * THE DIGEST OF THE PROPOSAL THIS MISSION WAS COMPILED FROM.
   *
   * Stamped by the compiler and re-checked by `execute()` against whatever the caller says the user
   * reviewed. Without it, amending a proposal and then executing the mission compiled from the
   * earlier one would go unnoticed: the amendment would be a change to a document nobody was looking
   * at any more, while a different plan ran.
   *
   * Optional at the type level so a hand-built mission in a test may omit it. Every mission that came
   * through the compiler has it.
   */
  readonly proposalDigest?: string
  /**
   * WHAT THE USER'S GOAL REQUIRES, IN CHECKABLE TERMS.
   *
   * Carried from `PlanProposal` by `compile()`, alongside `basis` and `proposalDigest`, for the same
   * reason those travel: the mission and the document the user approved have to be the same document.
   * A supervisor three attempts later, or a store read back after a crash, can only ask "was the
   * objective actually achieved?" if the objective's requirements came with the mission.
   *
   * Optional, and that is not a convenience. Absent means `unproven`, which means NOT successful -
   * so a mission compiled from a proposal that declared nothing cannot report completion, however
   * cleanly every step ran. The absence is the safety property; making the field required would
   * only move where hand-built missions in tests have to put an empty list, which would then have to
   * be special-cased. Absent and empty are deliberately the same answer.
   */
  readonly objectivePostconditions?: readonly ObjectivePostcondition[]
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
 * Â§20: the AI may PREPARE such an action; the human authorises it; then it executes. So this
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
    // Explicit rather than incidental. `outcome-unknown` falls through to false here anyway, because
    // it is neither `verified` nor `legitimately-empty` - but a completion rule that does not NAME its
    // most dangerous case is a rule that will be quietly redefined the next time the union grows.
    if (s.status === 'uncertain') return false
    return s.result?.outcome.kind === 'verified' || s.result?.outcome.kind === 'legitimately-empty'
  })
}

/**
 * WHAT THE USER'S OBJECTIVE REQUIRES, IN MACHINE-CHECKABLE TERMS.
 *
 * `expectedResult` on a proposal says what "done" means in the user's words, and those words are
 * prose. Prose cannot be checked without a model, and a model judging its own success is the thing
 * this project has refused at every layer so far. So a proposal states the objective's postconditions
 * separately, in a vocabulary that can be evaluated deterministically against `Evidence`.
 *
 * Every variant names a condition that some EXISTING evidence kind can establish. None of them asks
 * a question the evidence vocabulary cannot answer - a postcondition nobody can disprove would be
 * decoration, and decoration reads as coverage.
 *
 * The distinction from `Step.verification` is the whole point of this type. A step verification says
 * "this tool call did what it claimed". An objective postcondition says "the user's goal is real".
 * A mission can pass every one of the first and fail every one of the second, and until this type
 * existed that mission reported complete - which is the silent-failure class this contract exists
 * to refuse.
 */
export type ObjectivePostcondition =
  /** The artefact exists. Satisfied by file-exists, file-written or file-read-back. */
  | { kind: 'artifact-exists'; path: string }
  /** An independent second read of the artefact returned a result at all. */
  | { kind: 'artifact-read-back'; path: string }
  /** The artefact is exactly N bytes. A size claim, not a content claim - see `artifact-content-matches`. */
  | { kind: 'artifact-byte-count'; path: string; bytes: number }
  /**
   * The artefact's bytes hash to this value.
   *
   * The only postcondition that proves an artefact SAYS what it was supposed to say. Requires
   * `file-read-back.sha256`; an un-hashed read-back does not satisfy it, because "the verifier read
   * it" is not "the verifier read THAT".
   */
  | { kind: 'artifact-content-matches'; path: string; sha256: string }
  /** The directory holds exactly N entries, as observed independently of the tool that listed it. */
  | { kind: 'directory-entry-count'; path: string; entries: number }
  /** A consequential deletion was corroborated from outside the tool that performed it. */
  | { kind: 'consequential-deleted'; path: string; effect?: string }
  /**
   * A window is on screen and its RENDERED PIXELS contain this text.
   *
   * WHY THIS EXISTS, because every postcondition above it is about a file.
   *
   * The objective vocabulary was entirely file-shaped - exists, read back, byte count, hash. So a
   * mission that opened a browser and loaded the correct page could not declare an outcome at
   * all, and was graded `unproven`: the user saw a working browser and was told "not achieved".
   * That is not a reporting bug, it is a gap in what "achieved" was allowed to mean.
   *
   * Satisfied by `screen-text-present`, which comes from the OCR engine reading actual pixels -
   * the same instrument used to read text no control exposes. It is therefore evidence about the
   * DISPLAY, not about a window handle: a window can exist and show the wrong page, and a title
   * can claim otherwise. Matching is case-insensitive and substring-based, which is what lets
   * "data protection" be proven by a page full of other words around it.
   */
  | { kind: 'window-shows-text'; text: string }
  /**
   * A command ran, exited with this code, AND was corroborated from outside the process.
   *
   * The corroboration clause is mandatory rather than incidental. A process reporting its own exit
   * code 0 is the process's account of itself; `state.ts` says so at the definition of
   * `command-verified` and this postcondition refuses to be the thing that forgets it.
   */
  | { kind: 'command-exited'; executable: string; exitCode: number }

/**
 * WHAT THE EVIDENCE SAYS ABOUT THE OBJECTIVE.
 *
 * Four states, and only one of them permits success. The proliferation is the cost of failing
 * closed honestly: "we cannot tell" and "we checked and it is false" are different answers, and
 * collapsing them into one boolean is what lets an unproven mission be summarised as a successful
 * one.
 */
export type ObjectiveVerdict =
  /** Every declared postcondition was established from evidence. The ONLY state that permits success. */
  | { kind: 'satisfied'; proved: readonly string[] }
  /** At least one declared postcondition is unsupported by the evidence, or is contradicted by it. */
  | { kind: 'unmet'; failed: readonly string[]; reason: string }
  /** The evidence contradicts itself about the objective. Never a pass, however clean the step record. */
  | { kind: 'contradicted'; reason: string }
  /** Nothing was declared, so there is no objective claim to check. Never a pass. */
  | { kind: 'unproven'; reason: string }

/** True only for the single verdict that permits a mission to report success. */
export function verdictPermitsSuccess(v: ObjectiveVerdict): boolean {
  return v.kind === 'satisfied'
}

/** Paths are compared case-insensitively and separator-agnostically, as the platform reports them. */
function normPath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase()
}
function samePath(a: string, b: string): boolean {
  return normPath(a) === normPath(b)
}

/**
 * THE OBJECTIVE RULE.
 *
 * Decides whether the user's goal was achieved, from the evidence the run actually produced, and
 * nothing else. It never reads step status, because `isComplete` already answers that and conflating
 * the two is the defect: a mission whose every step verified but whose summary covers 1 of 10 files
 * is the canonical false success, and only a check that ignores the step record can catch it.
 *
 * Fails closed in every direction:
 *
 *   - nothing declared            -> `unproven`
 *   - zero postconditions declared -> `unproven` (an empty list is an absent claim, not a met one)
 *   - a postcondition with no supporting evidence -> `unmet`
 *   - evidence that disagrees with itself -> `contradicted`
 *
 * There is no path from "no errors occurred" to `satisfied`. Absence of failure is not evidence of
 * success, and a function that could infer one would be inferring the objective rather than checking
 * it.
 */
export function objectiveVerdict(
  postconditions: readonly ObjectivePostcondition[] | undefined,
  evidence: Readonly<Record<string, Evidence>>,
): ObjectiveVerdict {
  if (postconditions === undefined) {
    return {
      kind: 'unproven',
      reason: 'the plan declared no objective postcondition, so there is no claim to verify against the evidence',
    }
  }
  if (postconditions.length === 0) {
    return {
      kind: 'unproven',
      reason: 'the plan declared zero objective postconditions; an empty list is an absent claim, not a satisfied one',
    }
  }

  // Contradiction pass, BEFORE per-postcondition checking, so a mission whose evidence
  // disagrees with itself is reported as contradicting rather than as merely incomplete.
  const deleted = new Set<string>()
  for (const e of Object.values(evidence)) if (e.kind === 'file-deleted') deleted.add(normPath(e.path))
  for (const e of Object.values(evidence)) {
    if ((e.kind === 'file-written' || e.kind === 'file-read-back') && deleted.has(normPath(e.path))) {
      return {
        kind: 'contradicted',
        reason: `"${e.path}" is evidenced both as written/read-back and as deleted; the evidence disagrees with itself`,
      }
    }
  }

  const all = Object.values(evidence)
  const failed: string[] = []

  for (const pc of postconditions) {
    let proved = false
    switch (pc.kind) {
      case 'artifact-exists':
        proved = all.some((e) =>
          (e.kind === 'file-exists' || e.kind === 'file-written' || e.kind === 'file-read-back')
          && samePath(e.path, pc.path)
          // `command-verified` counts too, and excluding it would be a defect rather than strictness:
          // its verifier has already `stat`ed that exact path and recorded its size, which is a
          // STRONGER observation than a bare existence check. Ignoring stronger evidence because it
          // arrived under a different name is how a correct mission gets reported unproven.
          // The corroboration clause keeps the same rule that applies to `command-exited`: an
          // un-corroborated record of a process's own account is not an observation of the world.
          || (e.kind === 'command-verified' && e.corroboratedBy.length > 0 && samePath(e.path, pc.path)))
        break
      case 'artifact-read-back':
        proved = all.some((e) => (e.kind === 'file-read-back' || e.kind === 'artifact') && samePath(e.path, pc.path))
        break
      case 'artifact-byte-count':
        proved = all.some((e) =>
          (e.kind === 'file-written' || e.kind === 'file-read-back')
          && samePath(e.path, pc.path) && e.bytes === pc.bytes)
        break
      case 'artifact-content-matches':
        // An un-hashed read-back does NOT satisfy this. That is the entire point of the field.
        proved = all.some((e) => e.kind === 'file-read-back'
          && samePath(e.path, pc.path) && typeof e.sha256 === 'string' && e.sha256 === pc.sha256)
        break
      case 'directory-entry-count':
        proved = all.some((e) =>
          (e.kind === 'directory-present' || e.kind === 'folder-contents')
          && samePath(e.path, pc.path) && e.entries === pc.entries)
        break
      case 'consequential-deleted':
        proved = all.some((e) => e.kind === 'file-deleted' && samePath(e.path, pc.path)
          && (pc.effect === undefined || e.effect === pc.effect))
        break
      case 'window-shows-text':
        // Substring, case-insensitive. The page will be full of other words; the claim is that
        // THIS text is among them. A stricter equality test would fail on every real page and
        // teach the planner to declare goals it cannot meet.
        proved = all.some((e) => e.kind === 'screen-text-present'
          && e.text.toLowerCase().includes(pc.text.toLowerCase()))
        break
      case 'command-exited':
        // Corroboration is REQUIRED. Without it this would be the process grading its own homework.
        proved = all.some((e) => e.kind === 'command-verified'
          && e.executable === pc.executable && e.exitCode === pc.exitCode
          && typeof e.corroboratedBy === 'string' && e.corroboratedBy.length > 0)
        break
    }
    if (!proved) failed.push(pc.kind)
  }

  if (failed.length > 0) {
    return {
      kind: 'unmet',
      failed,
      reason: `${failed.length} of ${postconditions.length} objective postcondition(s) are not established by the evidence: ${failed.join(', ')}`,
    }
  }
  return { kind: 'satisfied', proved: postconditions.map((p) => p.kind) }
}

/**
 * THE MISSION SUCCESS RULE.
 *
 * A mission succeeded when its steps completed AND its objective was independently verified. Both,
 * always - the conjunction is the fix, and either half alone is a way of lying:
 *
 *   steps only  -> "ran the steps" reported as "did the job"   (the defect this rule closes)
 *   objective only -> a goal proven by a plan that never ran
 *
 * `isComplete` is untouched and still means what it says: the step contract. Keeping the two apart
 * is what lets a caller see a mission that passed every step and still failed, instead of having
 * that fact collapsed into one boolean at the point of reporting.
 */
export function isMissionSuccessful(
  m: Mission,
  evidence: Readonly<Record<string, Evidence>>,
): boolean {
  return isComplete(m) && verdictPermitsSuccess(objectiveVerdict(m.objectivePostconditions, evidence))
}

/**
 * Whether a step's outcome is safe to RETRY.
 *
 * Split out because "is it complete" and "may I try again" are different questions and answering the
 * second with the first is how a duplicated action happens. `uncertain` is the case that separates
 * them: not complete, and not retryable either.
 */
export function isRetryable(outcome: StepOutcome | undefined): boolean {
  if (!outcome) return true
  switch (outcome.kind) {
    case 'failed':
      // Do not retry when the refusal reason indicates the file already exists,
      // which means the write was likely already successful in a prior attempt.
      if (outcome.reason && (/already exists|will not be overwritten/i.test(outcome.reason))) return false
      return true
    case 'outcome-unknown': return false   // the machine may already have changed
    case 'needs-human': return false
    case 'replan-required': return false
    default: return false
  }
}/** Steps whose outcome is unknown, and which therefore require reconciliation before anything else. */
export function uncertainSteps(m: Mission): readonly Step[] {
  return m.plan.filter((s) => s.status === 'uncertain' || s.result?.outcome.kind === 'outcome-unknown')
}

/**
 * One tally of mission progress, by OUTCOME.
 *
 * This exists because the previous implementation counted some categories by outcome and one
 * by STATUS, so `pending` and the others were derived from different bases and could disagree
 * - a mission could report "0 pending" while also reporting fewer steps accounted for than
 * it has. The audit events counted the same categories separately, so the human-readable line
 * and the event stream could disagree about the same mission.
 *
 * One function, one basis. `skipped` is counted here, and it is counted SEPARATELY from
 * failed: a step that was never attempted because a gate stopped it is not a failure, and
 * folding the two together inflates the apparent unreliability of a plan.
 */
export interface Progress {
  readonly total: number
  readonly verified: number
  readonly legitimatelyEmpty: number
  readonly failed: number
  readonly skipped: number
  readonly needsHuman: number
  readonly replanRequired: number
  readonly running: number
  readonly pending: number
  /** Every step is accounted for exactly once. Asserted, not assumed. */
  readonly accountedFor: number
}

export function tally(m: Mission): Progress {
  const c = {
    verified: 0, legitimatelyEmpty: 0, failed: 0, skipped: 0,
    needsHuman: 0, replanRequired: 0, running: 0, pending: 0,
  }
  for (const s of m.plan) {
    if (s.result) {
      switch (s.result.outcome.kind) {
        case 'verified': c.verified++; break
        case 'legitimately-empty': c.legitimatelyEmpty++; break
        case 'failed': c.failed++; break
        case 'skipped': c.skipped++; break
        case 'needs-human': c.needsHuman++; break
        case 'replan-required': c.replanRequired++; break
      }
    } else if (s.status === 'running') c.running++
    else c.pending++
  }
  const accountedFor =
    c.verified + c.legitimatelyEmpty + c.failed + c.skipped +
    c.needsHuman + c.replanRequired + c.running + c.pending
  return { total: m.plan.length, ...c, accountedFor }
}

/**
 * The honest summary. Never infers success from having executed something.
 *
 * Built from `tally()` so the human-readable line and the audit event stream cannot disagree
 * about the same mission. `skipped` appears as its own category, phrased as a gate rather
 * than a failure because that is what it was.
 */
export function describeProgress(m: Mission): string {
  const t = tally(m)
  return [
    m.state,
    `${t.verified} verified`,
    t.legitimatelyEmpty ? `${t.legitimatelyEmpty} legitimately empty` : null,
    t.failed ? `${t.failed} FAILED` : null,
    t.skipped ? `${t.skipped} skipped (blocked by a dependency)` : null,
    t.replanRequired ? `${t.replanRequired} need replanning` : null,
    t.needsHuman ? `${t.needsHuman} waiting on human` : null,
    t.running ? `${t.running} running` : null,
    `${t.pending} pending`,
  ].filter(Boolean).join(' | ')
}