/**
 * STRICT PARSING OF MODEL OUTPUT.
 *
 * The rule this file exists to enforce: AN UNTRUSTED PLAN IS ACCEPTED OR REJECTED, NEVER REPAIRED.
 *
 * WHY "REPAIR" IS THE DANGEROUS WORD
 *
 * A repair step is a step where the system decides the model "meant" something else. Every such
 * decision is a place where authority can leak:
 *
 *   drop an unknown step        the model's plan is no longer the plan that was reviewed
 *   coerce "cli" to a known mode  the model asked for something else and got it anyway
 *   fill in a missing verifier   the plan now claims to prove something the model never asked for
 *   snap a near-miss capability to the closest real one  the model asked for telepathy and got a file read
 *   skip a step whose operands are wrong  the plan is now shorter and was never reviewed that way
 *
 * Every one of those produces a plan that COMPILES and that a person approved on the understanding
 * that it is the model's plan. That is the confident-wrong-answer failure this project has refused
 * everywhere since M1, and it is most dangerous exactly here, where the input came from something
 * designed to be persuasive.
 *
 * THE ONE NORMALISATION THAT IS ACCEPTED
 *
 * Stripping a markdown code fence, and nothing else. A fence is a TRANSPORT artifact - the model
 * wrapped its JSON in prose for a human reader - and unwrapping it does not change what the plan says.
 * It is named explicitly in `TRANSPORT_NORMALISATIONS` so that any future normalisation has to argue
 * its way into a short list rather than appearing as a convenience.
 *
 * WHAT HAPPENS TO EXTRA FIELDS
 *
 * They are REPORTED, not honoured and not silently dropped. A model that emits `approved: true` has
 * told us something about itself, and swallowing that quietly would hide the only signal available.
 * The caller shows them to a reviewer; the compiler ignores them.
 */

import { CAPABILITIES, isCapability, type PlanProposal, type PlanFailure } from '../planner/plan.ts'
import type { ModelPlan, ModelStep } from './protocol.ts'

export interface ParseOk {
  readonly ok: true
  readonly plan: ModelPlan
  /** Fields the model emitted that this system does not read. Reported, never honoured. */
  readonly ignoredFields: readonly string[]
  /** Whether the JSON arrived inside a code fence. */
  readonly unwrapped: boolean
  /** The exact bytes the model returned, for the audit. */
  readonly raw: string
}

export interface ParseRejected {
  readonly ok: false
  readonly code: PlanFailure
  readonly reason: string
  readonly raw: string
}

export type ParseResult = ParseOk | ParseRejected

export type ParseOutcome = ParseResult

/** The ONLY normalisation this file performs. Named, so adding another is a deliberate act. */
export const TRANSPORT_NORMALISATIONS = ['strip an outer markdown code fence'] as const

const KNOWN_STEP_FIELDS = new Set([
  'id', 'capability', 'intent', 'mode', 'tool', 'args', 'dependsOn', 'rationale',
  'verification', 'onFailure', 'effect',
])
const KNOWN_PLAN_FIELDS = new Set(['constraints', 'steps', 'expectedResult', 'refusal'])

const FAILURES = new Set([
  'abort-mission', 'continue', 'replan',
])

const reject = (code: PlanFailure, reason: string, raw: string): ParseRejected => ({ ok: false, code, reason, raw })

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** The one permitted normalisation. */
function unwrap(raw: string): { text: string; unwrapped: boolean } {
  const t = raw.trim()
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/.exec(t)
  return fence ? { text: fence[1].trim(), unwrapped: true } : { text: t, unwrapped: false }
}

/**
 * Parses and structurally validates a model's response.
 *
 * This function is the AI's entire influence on the system. It returns data or a refusal, and the
 * data is then held to the same compiler, router, approval gate and verifiers as a plan written by
 * hand.
 */
export function parseModelPlan(raw: string): ParseResult {
  const { text, unwrapped } = unwrap(raw)

  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (e) {
    return reject(
      'invalid-proposal',
      `the model did not return JSON. Parsing failed: ${(e as Error).message}. ` +
      `Nothing was interpreted on its behalf, so the plan is discarded.`,
      raw,
    )
  }

  if (!isPlainObject(json)) {
    return reject('invalid-proposal', `the model returned ${Array.isArray(json) ? 'an array' : typeof json}, not an object`, raw)
  }

  // A refusal is a legitimate answer and is recorded as one, not as a failure.
  if (typeof json.refusal === 'string') {
    return reject('not-understood', `the model declined to plan this objective: ${json.refusal}`, raw)
  }

  const ignored: string[] = []
  for (const k of Object.keys(json)) if (!KNOWN_PLAN_FIELDS.has(k)) ignored.push(k)

  if (!Array.isArray(json.steps)) {
    return reject('invalid-proposal', 'the plan has no "steps" array', raw)
  }
  if (json.steps.length === 0) {
    return reject('invalid-proposal', 'the plan has zero steps, which is not a plan', raw)
  }
  if (typeof json.expectedResult !== 'string' || json.expectedResult.length === 0) {
    return reject('invalid-proposal', 'the plan does not say what "done" would mean', raw)
  }

  const steps: ModelStep[] = []

  // ---- PASS ONE: every id, before any dependency is checked.
  //
  // The first version collected ids while iterating, so a step that depended on a LATER step was
  // reported as depending on "no such step" - a wrong diagnosis, since the step exists and is right
  // there in the array. The distinction matters: a forward reference and an invented id are different
  // mistakes with different remedies, and collapsing them tells the reader to look for a missing step
  // that is not missing.
  //
  // Collecting the whole id set first is also what lets duplicate ids be reported as duplicates
  // regardless of which copy came first.
  const ids = new Set<string>()
  const rawSteps = json.steps as unknown[]
  for (const [i, rawStep] of rawSteps.entries()) {
    if (!isPlainObject(rawStep)) {
      return reject('invalid-proposal', `step ${i} is not an object`, raw)
    }
    for (const k of Object.keys(rawStep)) if (!KNOWN_STEP_FIELDS.has(k)) ignored.push(`steps[${i}].${k}`)

    if (typeof rawStep.id !== 'string' || rawStep.id.length === 0) {
      return reject('invalid-proposal', `step ${i} has no id`, raw)
    }
    if (ids.has(rawStep.id)) {
      return reject('invalid-proposal', `two steps share the id "${rawStep.id}"`, raw)
    }
    ids.add(rawStep.id)
  }

  // ---- PASS TWO: everything else, with the complete id set available.
  for (const [i, rawStep] of rawSteps.entries()) {
    const step = rawStep as Record<string, unknown>

    // ---- the capability. NEVER snapped to a near match.
    if (typeof step.capability !== 'string') {
      return reject('invalid-proposal', `step "${step.id}" names no capability`, raw)
    }
    if (!isCapability(step.capability)) {
      return reject(
        'resource-missing',
        `step "${step.id}" requests the capability "${step.capability}", which does not exist. ` +
        `It was NOT resolved to the nearest real one. Known: ${CAPABILITIES.join(', ')}`,
        raw,
      )
    }

    // ---- mode. Checked against what the capability actually is, not left to the executor.
    const expectedMode = step.capability === 'terminal.run' ? 'cli' : 'filesystem'
    if (step.mode !== expectedMode) {
      return reject(
        'invalid-proposal',
        `step "${step.id}" is capability "${step.capability}", which is mode "${expectedMode}", ` +
        `but the model said "${String(step.mode)}". Not corrected: the model described an action ` +
        `that does not match the capability it asked for.`,
        raw,
      )
    }

    // ---- tool. Existence is the ROUTER's call, not this file's: it has the registry.
    if (typeof step.tool !== 'string' || step.tool.length === 0) {
      return reject('invalid-proposal', `step "${step.id}" names no tool`, raw)
    }

    // ---- args. Must be an object; its CONTENTS are the tools' business, not the parser's.
    if (!isPlainObject(step.args)) {
      return reject('invalid-proposal', `step "${step.id}" has no args object`, raw)
    }

    // ---- verification. Required, and required to be an object with a kind.
    if (!isPlainObject(step.verification) || typeof step.verification.kind !== 'string' || step.verification.kind.length === 0) {
      return reject(
        'invalid-proposal',
        `step "${step.id}" declares no verification requirement, so nothing could prove it completed. ` +
        `No default was supplied on its behalf.`,
        raw,
      )
    }

    if (typeof step.onFailure !== 'string' || !FAILURES.has(step.onFailure)) {
      return reject(
        'invalid-proposal',
        `step "${step.id}" declares onFailure "${String(step.onFailure)}", which is not one of ${[...FAILURES].join(', ')}`,
        raw,
      )
    }

    // ---- dependencies. Must exist in THIS plan and must appear earlier.
    if (!Array.isArray(step.dependsOn)) {
      return reject('invalid-proposal', `step "${step.id}" has no dependsOn array`, raw)
    }
    // Every element must already be a string. `.map(String)` would coerce a number `7` into `"7"`,
    // which is a silent fix in the one place this file refuses to fix anything - and the coerced id
    // would then fail the lookup below with a message about a step id nobody wrote.
    for (const d of step.dependsOn) {
      if (typeof d !== 'string') {
        return reject('invalid-proposal', `step "${step.id}" depends on a ${typeof d}, not a step id`, raw)
      }
    }
    const deps = step.dependsOn as string[]
    const idsSoFar = new Set(steps.map((s) => s.id))
    for (const d of deps) {
      if (d === step.id) {
        return reject('invalid-proposal', `step "${step.id}" depends on itself`, raw)
      }
      if (!idsSoFar.has(d)) {
        // Either a dangling name or a forward reference. Both are refused; the distinction is
        // reported because a forward reference is a different mistake from an invented step id - and
        // `ids` holds every id in the plan, so this can now tell them apart.
        return reject(
          'invalid-proposal',
          `step "${step.id}" depends on "${d}", which is not an EARLIER step in this plan. ` +
          (ids.has(d) ? 'It appears later, and the executor walks steps in order.' : 'No such step exists.'),
          raw,
        )
      }
    }

    // ---- effect. Optional, and only a DECLARATION.
    let effect: ModelStep['effect']
    if (step.effect !== undefined) {
      if (!isPlainObject(step.effect)) {
        return reject('invalid-proposal', `step "${step.id}" has a non-object effect`, raw)
      }
      if (typeof step.effect.kind !== 'string' || typeof step.effect.target !== 'string') {
        return reject(
          'invalid-proposal',
          `step "${step.id}" declares an effect with no kind or target, so there is nothing specific to authorise`,
          raw,
        )
      }
      effect = {
        kind: step.effect.kind,
        target: step.effect.target,
        reason: typeof step.effect.reason === 'string' ? step.effect.reason : '(no reason given)',
        irreversible: step.effect.irreversible === true,
      }
    }

    steps.push({
      id: step.id,
      capability: step.capability,
      intent: typeof step.intent === 'string' ? step.intent : '',
      mode: step.mode,
      tool: step.tool,
      args: step.args,
      dependsOn: deps,
      rationale: typeof step.rationale === 'string' ? step.rationale : '',
      verification: {
        kind: step.verification.kind,
        description: typeof step.verification.description === 'string' ? step.verification.description : '',
      },
      onFailure: step.onFailure,
      ...(effect ? { effect } : {}),
    })
  }

  // ---- prose fields. Reported if empty rather than filled in, because a step with no intent is a
  //      step a reviewer cannot check, and inventing one is exactly the repair this file forbids.
  const thin = steps.filter((s) => s.intent.length === 0)
  if (thin.length > 0) {
    return reject(
      'invalid-proposal',
      `${thin.length} step(s) have no intent (${thin.map((s) => s.id).join(', ')}). ` +
      `A step nobody can read is a step nobody can review, and no intent was written on its behalf.`,
      raw,
    )
  }

  // `constraints` is the one place a loose value is accepted, and deliberately: it is prose the
  // executor never reads, so coercing it changes no behaviour. It is still reported when it is not a
  // string array, because "the model promised nothing" and "the model promised this" are different
  // plans and a reviewer should see which one arrived.
  let constraints: string[] = []
  if (Array.isArray(json.constraints)) {
    for (const c of json.constraints) {
      if (typeof c !== 'string') {
        return reject('invalid-proposal', `a plan constraint is a ${typeof c}, not a string`, raw)
      }
      constraints.push(c)
    }
  }

  return {
    ok: true,
    plan: { constraints, steps, expectedResult: json.expectedResult },
    ignoredFields: ignored,
    unwrapped,
    raw,
  }
}

/**
 * Builds the `PlanProposal` from a parsed model plan.
 *
 * The basis is ATTACHED BY US, not by the model, and this is the single most important line in the
 * file. A model that could name its own observation could claim a plan was grounded in evidence it
 * never saw; so the observed state is stamped on afterwards, from the `WorldState` this process
 * actually holds.
 */
export function toProposal(
  modelPlan: ModelPlan,
  world: { observationId: string; observedAt: number; root: string; fingerprint: string; facts: readonly string[]; complete: boolean },
  objective: string,
): PlanProposal {
  return {
    objective,
    constraints: [...modelPlan.constraints],
    steps: modelPlan.steps.map((s) => ({
      id: s.id,
      capability: s.capability as PlanProposal['steps'][0]['capability'],
      intent: s.intent,
      mode: s.mode as PlanProposal['steps'][0]['mode'],
      tool: s.tool,
      args: s.args,
      dependsOn: [...s.dependsOn],
      rationale: s.rationale,
      verification: s.verification as PlanProposal['steps'][0]['verification'],
      onFailure: s.onFailure as PlanProposal['steps'][0]['onFailure'],
      ...(s.effect ? { effect: s.effect as PlanProposal['steps'][0]['effect'] } : {}),
    })),
    expectedResult: modelPlan.expectedResult,
    basis: {
      observationId: world.observationId,
      observedAt: world.observedAt,
      root: world.root,
      fingerprint: world.fingerprint,
      usedFacts: [...world.facts],
      complete: world.complete,
    },
  }
}
