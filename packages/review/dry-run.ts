/**
 * DRY RUN. "What would AIOS do?" without doing any of it.
 *
 * WHY THIS IS NOT "EXECUTE AND IGNORE THE RESULTS"
 *
 * Because that is not a dry run, it is an execution whose output is thrown away - and it would have
 * written the file, spawned the process, and made whatever network calls the plan described. A user
 * asking "what would happen if I ran this?" before authorising it is asking precisely because they do
 * not want it to happen yet.
 *
 * So the boundary here is STRUCTURAL, not a flag on the executor:
 *
 *   this module imports NO executor, NO child_process, NO filesystem, and NO control core
 *
 * Which means there is no code path in it that could act, rather than a check that could be bypassed.
 * A `dryRun({ execute: false })` parameter would be a promise; a module that cannot reach a tool is a
 * fact, and the test asserts it by reading the import graph.
 *
 * WHAT IT ANSWERS
 *
 * For every step: which tool would be selected, in what mode, against which operands, depending on
 * what, verified how, with what consequence, whether a human would have to authorise it, and whether
 * the world it was planned against still looks the way it did.
 *
 * The answers come from the SAME places the executor asks - `router.resolveCapability`,
 * `router.effectOf`, `router.preflight` - which is what makes the dry run a prediction rather than a
 * guess. If the router cannot serve a capability, the dry run says so, and so does the executor.
 *
 * AND WHAT IT DELIBERATELY DOES NOT ANSWER
 *
 * Whether a step would SUCCEED. That is unknowable without running it, and any dry run that claimed
 * otherwise would be the exit-code-0 mistake in a new place. The report says "executable" or why not,
 * and stops there.
 */

import type { PlanProposal, PlanStep } from '../planner/plan.ts'
import type { ToolRouter } from '../mission-engine/executor.ts'
import type { WorldState } from '../observation/world.ts'
import { checkFreshness } from '../observation/world.ts'
import { digestOf, authorityLookingFields, unrecognisedFields } from './digest.ts'
import { CAPABILITIES, isCapability } from '../planner/plan.ts'

export interface DryRunContext {
  /** The router, asked the same questions the executor will ask. */
  readonly router: ToolRouter
  /** Injected clock, so "how old" is a fact rather than a wall-clock reading. */
  readonly now: number
  /** How old an observation may be and still be planned against. */
  readonly maxObservationAgeMs: number
  /**
   * A FRESH observation, when the caller has one.
   *
   * Optional, and its absence is reported as `cannot-verify` rather than treated as fine - the same
   * asymmetry M6 established, and for the same reason: a caller holding an old snapshot with no
   * observer cannot produce evidence of freshness, and guessing "fine" would be the dangerous answer.
   */
  readonly refetched?: WorldState
  /**
   * Whether each step's effect is already authorised.
   *
   * Read-only. The dry run is told the ANSWER, because "would this need a human" is exactly what a
   * reviewer needs to know, and a dry run that could not say so would be hiding the most important
   * thing about the plan. It is given a function, not a store, so it has no way to change one.
   */
  readonly isAuthorised?: (step: PlanStep) => boolean
}

export type StepVerdict = 'executable' | 'would-need-authorisation' | 'blocked' | 'not-executable'

export interface StepReport {
  readonly stepId: string
  readonly intent: string
  readonly capability: string
  /** The tool the router WOULD select, or undefined with a reason. */
  readonly tool?: string
  readonly mode: string
  readonly args: Readonly<Record<string, unknown>>
  readonly dependsOn: readonly string[]
  readonly verification: string
  readonly effect?: { readonly kind: string; readonly target: string; readonly irreversible: boolean }
  /** Where the effect came from: the tool's own reading, or the plan's declaration. */
  readonly effectSource?: 'tool' | 'declaration' | 'both-agree' | 'none'
  readonly approvalRequired: boolean
  readonly alreadyAuthorised: boolean
  readonly verdict: StepVerdict
  /** Every reason this step would not run, in words. Empty when it would. */
  readonly blockers: readonly string[]
  /** Warnings that do not block. */
  readonly notes: readonly string[]
}

export interface DryRunReport {
  readonly digest: string
  readonly objective: string
  readonly expectedResult: string
  readonly world: {
    readonly observationId: string
    readonly root: string
    readonly fingerprint: string
    readonly observedAt: number
    readonly ageMs: number
    readonly fresh: boolean
    /** 'fresh' | 'too-old' | 'world-changed' | 'cannot-verify' | 'no-observation' */
    readonly freshness: string
  }
  readonly steps: readonly StepReport[]
  /** Fields present on the proposal that the system does not read. */
  readonly unrecognised: readonly string[]
  /** Unrecognised fields that LOOK like they grant authority. */
  readonly inertAuthorityFields: readonly string[]
  /** Whether the whole plan could be executed, and why not if it could not. */
  readonly executable: boolean
  readonly planLevelBlockers: readonly string[]
  /** Anything that would need a human before execution. */
  readonly needsAuthorisation: readonly string[]
}

/**
 * Analyses a plan without touching anything.
 *
 * Read-only by import graph, and it takes a `ToolRouter` rather than a `Tool` so it cannot even reach
 * a tool's `run` method except through the two question-shaped methods the interface exposes.
 */
export function dryRun(proposal: PlanProposal, ctx: DryRunContext): DryRunReport {
  const planBlockers: string[] = []
  const notes: string[] = []

  // ---- the world, and whether the plan's view of it still holds
  const basis = proposal.basis
  const world = (() => {
    if (!basis?.observationId) {
      return {
        observationId: '', root: '', fingerprint: '', observedAt: 0,
        ageMs: 0, fresh: false, freshness: 'no-observation' as const,
      }
    }
    const ageMs = ctx.now - basis.observedAt
    if (!ctx.refetched) {
      // No re-observation, so freshness is UNKNOWN. Reported as its own state, because "cannot tell"
      // and "fine" must not look alike to a reviewer who is about to authorise execution.
      return {
        observationId: basis.observationId, root: basis.root, fingerprint: basis.fingerprint,
        observedAt: basis.observedAt, ageMs, fresh: false, freshness: 'cannot-verify' as const,
      }
    }
    const f = checkFreshness(
      { observationId: basis.observationId, observedAt: basis.observedAt, fingerprint: basis.fingerprint,
        scope: { root: basis.root, maxDepth: 0 }, entries: [], capabilities: [], truncated: false, errors: [] },
      { now: ctx.now, maxAgeMs: ctx.maxObservationAgeMs, refetched: ctx.refetched },
    )
    return {
      observationId: basis.observationId, root: basis.root, fingerprint: basis.fingerprint,
      observedAt: basis.observedAt, ageMs,
      fresh: f.fresh,
      freshness: f.fresh ? 'fresh' : f.reason,
    }
  })()

  if (world.freshness === 'no-observation') {
    planBlockers.push('the plan names no observation, so it cannot be checked against the world at all')
  } else if (!world.fresh) {
    planBlockers.push(
      `the world this plan was built against is ${world.freshness === 'cannot-verify' ? 'unverifiable' : world.freshness}` +
      (world.freshness === 'cannot-verify'
        ? ' (no re-observation was supplied, so freshness cannot be established)'
        : ` (the observation is ${Math.round(world.ageMs / 1000)}s old)`) +
      '. Re-observe and replan before executing.',
    )
  }
  if (basis && basis.complete === false) {
    planBlockers.push('the plan was built on a partial observation, so it does not describe the whole folder')
  }
  if (basis && basis.usedFacts.length === 0) {
    planBlockers.push('the plan records no observed facts, so it cannot be distinguished from one produced without looking')
  }

  // ---- per step
  const steps: StepReport[] = proposal.steps.map((s) => analyseStep(s, ctx, notes))

  for (const s of steps) {
    for (const b of s.blockers) planBlockers.push(`${s.stepId}: ${b}`)
  }

  const needsAuthorisation = steps.filter((s) => s.approvalRequired).map((s) => s.stepId)

  return {
    digest: digestOf(proposal),
    objective: proposal.objective,
    expectedResult: proposal.expectedResult,
    world,
    steps,
    unrecognised: unrecognisedFields(proposal).map((u) => `${u.at}.${u.field}`),
    inertAuthorityFields: authorityLookingFields(proposal),
    executable: planBlockers.length === 0,
    // Named explicitly rather than by shorthand. The first version wrote `planLevelBlockers,` - a
    // shorthand for a variable that does not exist, so the field was `undefined` and every consumer
    // of it would have seen nothing. The report would then have claimed a plan was executable while
    // silently omitting the reasons it was not.
    planLevelBlockers: [...planBlockers],
    needsAuthorisation,
  }
}

function analyseStep(s: PlanStep, ctx: DryRunContext, planNotes: string[]): StepReport {
  const blockers: string[] = []
  const notes: string[] = []

  // 1. Is the capability one the system knows?
  let capability = String((s as { capability?: unknown }).capability ?? '(none)')
  if (!isCapability(capability)) {
    blockers.push(
      `requests the capability "${capability}", which does not exist. Known: ${CAPABILITIES.join(', ')}`,
    )
  }

  // 2. Would the router serve it? Asked, never called.
  let tool: string | undefined
  const cap = (s as { capability?: string }).capability
  if (cap && isCapability(cap) && ctx.router.resolveCapability) {
    const r = ctx.router.resolveCapability(cap)
    if ('unavailable' in r) blockers.push(r.unavailable)
    else {
      tool = r.tool.name
      if (s.tool && s.tool !== r.tool.name) {
        blockers.push(
          `the plan names the tool "${s.tool}" but "${cap}" resolves to "${r.tool.name}". ` +
          `The plan and the registry disagree about what this step needs.`,
        )
      }
    }
  } else if (!cap) {
    blockers.push('names no capability, so nothing can be resolved to serve it')
  }

  // 3. Would the policy refuse this outright? Asked, before any question of authorisation.
  //
  // `preflight`/`effectOf` are declared over `Step`, and this runs over a `PlanStep` - a proposal
  // that has not been compiled, so it has no `status` yet. That is not an accident to be hidden: it
  // is the whole point of a DRY RUN, which asks "what would happen" before anything is committed.
  //
  // Both read only `tool` and `args`, so the stand-in carries exactly those. Line 245 below was
  // already casting for `effect`; this makes the same narrowing explicit once, in one place, with
  // the reason, instead of leaving two different casts in the same function.
  const asPrecheck = s as unknown as Parameters<NonNullable<typeof ctx.router.preflight>>[0]
  const pre = ctx.router.preflight?.(asPrecheck)
  if (pre) {
    blockers.push(pre.blocked)
    if (pre.needsHuman) notes.push('the policy says this needs a human even before it is considered for authorisation')
  }

  // 4. What consequence does it have, and where does that answer come from?
  //    The TOOL is the authority on what it will do; the plan's declaration is the weaker source.
  const toolEffect = ctx.router.effectOf?.(asPrecheck)
  const declared = s.effect
  let effect = toolEffect
  let effectSource: StepReport['effectSource'] = 'none'
  if (toolEffect && declared) {
    const agree = toolEffect.kind === declared.kind && toolEffect.target === declared.target
    effectSource = agree ? 'both-agree' : 'both-agree'
    if (!agree) {
      blockers.push(
        `the plan declares ${declared.kind} on "${declared.target}" but the tool reports it would ` +
        `${toolEffect.kind} on "${toolEffect.target}". The plan misdescribes its own action.`,
      )
    }
  } else if (toolEffect) {
    effectSource = 'tool'
    planNotes.push(
      `step "${s.id}" does not declare an effect, but "${s.tool ?? 'its tool'}" reports it would ` +
      `${toolEffect.kind} on "${toolEffect.target}". The tool's classification is the one that will be authorised.`,
    )
  } else if (declared) {
    effect = declared as never
    effectSource = 'declaration'
  }

  // 5. Would a human have to authorise it?
  const approvalRequired = Boolean(effect)
  const alreadyAuthorised = ctx.isAuthorised ? ctx.isAuthorised(s) : false
  if (approvalRequired && !alreadyAuthorised) {
    notes.push(
      `this step is consequential (${effect!.kind} on "${effect!.target}") and is NOT authorised. ` +
      `Authorisation is a separate decision from approving the plan.`,
    )
  }

  // 6. Does it verify itself?
  const v = s.verification
  const verification = v && typeof v === 'object' && 'kind' in v ? String(v.kind) : String(v ?? '(none)')
  if (!v) blockers.push('declares no verification requirement, so nothing could prove it completed')

  const verdict: StepVerdict =
    blockers.length > 0 ? 'not-executable'
    : approvalRequired && !alreadyAuthorised ? 'would-need-authorisation'
    : 'executable'

  return {
    stepId: s.id,
    intent: s.intent,
    capability,
    tool,
    mode: String(s.mode),
    args: s.args ?? {},
    dependsOn: s.dependsOn ?? [],
    verification,
    effect: effect ? { kind: effect.kind, target: effect.target, irreversible: Boolean(effect.irreversible) } : undefined,
    effectSource,
    approvalRequired,
    alreadyAuthorised,
    verdict,
    blockers,
    notes,
  }
}
