/**
 * THE BOUNDARY: `PlanProposal` -> `Mission`.
 *
 * THE ONLY PLACE A PLAN BECOMES A MISSION.
 *
 * Everything execution-specific is decided here, not by the planner:
 *
 *   - the mission id
 *   - the initial state (`drafting`)
 *   - empty history, empty approvals, no start time
 *   - `attempts` and `status`, which the executor owns
 *
 * The compiler also VALIDATES the proposal before accepting it, which is the second half of why
 * this file exists. A plan is data from outside the executor - eventually from a language model
 * - so it is untrusted input, and the checks below are the ones that stop a malformed plan from
 * becoming a mission that appears to have run:
 *
 *   - step ids are unique
 *   - every dependency names a step that exists (a dangling dependency would otherwise block
 *     or silently pass)
 *   - the dependency graph has no cycle (the executor walks steps in order and has no cycle
 *     detection of its own)
 *   - every step declares a mode, a tool, a verification requirement and a failure behaviour
 *
 * A proposal that fails any of these is REFUSED. It is not repaired, and it is not executed with
 * the bad field defaulted, because a planner emitting a malformed plan is a finding and repairing
 * it silently would hide the finding.
 */

import type { Mission, Step } from '../mission-engine/state.ts'
// A VALUE import, not a type-only one. `isCapability` and `CAPABILITIES` are needed at runtime: the
// compiler must be able to refuse an unknown capability, and a type-only import would leave the
// check as a comment.
import { CAPABILITIES, isCapability, type PlanProposal } from './plan.ts'

export type CompileResult =
  | { readonly ok: true; readonly mission: Mission; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly reason: string }

/**
 * Turns a validated proposal into a fresh mission.
 *
 * `missionId` is supplied rather than derived so the caller controls identity; a planner that
 * named its own missions would be one more thing producing values nothing else can check.
 */
export function compilePlan(proposal: PlanProposal, missionId: string, startedAt: number): CompileResult {
  const problems: string[] = []
  const warnings: string[] = []

  // ---- ids
  const ids = proposal.steps.map((s) => s.id)
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i)
  if (dupes.length) problems.push(`duplicate step id(s): ${[...new Set(dupes)].join(', ')}`)

  // ---- required fields
  for (const s of proposal.steps) {
    if (!s.mode) problems.push(`step "${s.id}" declares no execution mode`)
    if (!s.tool) problems.push(`step "${s.id}" names no tool`)
    if (!s.verification?.kind) problems.push(`step "${s.id}" declares no verification requirement`)
    if (!s.onFailure) problems.push(`step "${s.id}" declares no failure behaviour`)
    if (!s.intent) problems.push(`step "${s.id}" has no intent for a human to read`)

    // ---- the capability must be one the system knows.
    //
    // Checked HERE, at the boundary, rather than trusted from the planner or discovered at execution
    // time. A capability the router cannot satisfy is a plan defect that a user should see before
    // anything runs; discovering it three steps into a mission turns a planning error into an
    // execution failure, which reads as though the world went wrong rather than the plan.
    if (!s.capability) {
      problems.push(`step "${s.id}" names no capability`)
    } else if (!isCapability(s.capability)) {
      problems.push(
        `step "${s.id}" requests the capability "${s.capability}", which does not exist. ` +
        `Known capabilities: ${CAPABILITIES.join(', ')}. An unknown capability is refused rather ` +
        `than served by something else.`,
      )
    }
  }

  // ---- the plan must say what it was planned against.
  //
  // This is the M6 invariant enforced at the only place that can enforce it. A plan with no basis
  // could have come from anywhere, and a supervisor that sees one has no way to decide whether to
  // re-observe and replan or to simply retry - which is the distinction M2 established for a renamed
  // folder, generalised to every plan.
  if (!proposal.basis || !proposal.basis.observationId) {
    problems.push(
      'the plan names no observation. A plan that cannot say what state of the world it was built ' +
      'against cannot be checked against that world, and a supervisor could not tell a stale plan ' +
      'from a wrong one.',
    )
  } else {
    if (!proposal.basis.fingerprint) problems.push('the plan records no observation fingerprint')
    if (!proposal.basis.usedFacts.length) {
      problems.push(
        'the plan records no observed facts, so it cannot be distinguished from one produced without ' +
        'looking at the machine',
      )
    }
    if (!proposal.basis.complete) {
      problems.push(
        'the plan was built on a partial observation and so cannot be executed as though it were complete',
      )
    }
  }

  // ---- dependencies must resolve
  for (const s of proposal.steps) {
    for (const d of s.dependsOn) {
      if (!ids.includes(d)) problems.push(`step "${s.id}" depends on "${d}", which is not a step in this plan`)
    }
  }

  // ---- acyclic. Depth-first, colouring white/grey/black.
  const colour = new Map<string, 0 | 1 | 2>()
  const byId = new Map(proposal.steps.map((s) => [s.id, s]))
  const walk = (id: string, trail: string[]): void => {
    const c = colour.get(id) ?? 0
    if (c === 2) return
    if (c === 1) {
      problems.push(`dependency cycle: ${[...trail, id].join(' -> ')}`)
      return
    }
    colour.set(id, 1)
    for (const d of byId.get(id)?.dependsOn ?? []) if (byId.has(d)) walk(d, [...trail, id])
    colour.set(id, 2)
  }
  for (const id of ids) walk(id, [])

  // ---- executability order. The executor walks the array in order, so a dependency that
  //      appears LATER would be treated as unmet and block. That is a plan defect worth
  //      reporting rather than reordering silently.
  const seen = new Set<string>()
  for (const s of proposal.steps) {
    for (const d of s.dependsOn) {
      if (byId.has(d) && !seen.has(d)) {
        problems.push(`step "${s.id}" depends on "${d}", which is listed after it; the executor runs steps in order`)
      }
    }
    seen.add(s.id)
  }

  if (problems.length) {
    return { ok: false, reason: `the proposed plan is not executable: ${problems.join('; ')}` }
  }

  const steps: Step[] = proposal.steps.map((s) => ({
    id: s.id,
    intent: s.intent,
    mode: s.mode,
    // The capability travels with the step so the executor can verify the resolved tool still
    // satisfies the requirement. It is a record of what was asked for, not a second resolution.
    capability: s.capability,
    rationale: s.rationale,
    tool: s.tool,
    args: s.args,
    dependsOn: s.dependsOn,
    status: 'pending' as const,
    // The planner's verification requirement and failure behaviour have nowhere to live on
    // `Step`, and inventing fields for them now would be speculative. They are recorded in the
    // plan report and enforced by the router/verifier, so they are checked without widening the
    // execution state model before anything needs them.
    ...(warnings.length ? {} : {}),
  }))

  const mission: Mission = {
    id: missionId,
    objective: proposal.objective,
    constraints: proposal.constraints,
    state: 'drafting',
    plan: steps,
    history: [],
    pendingApprovals: [],
    startedAt,
    // The basis travels WITH the mission. This is what lets a supervisor, three attempts later,
    // ask whether the world still looks the way the plan assumed - and re-observe and replan rather
    // than retry when it does not. Without it, staleness is undetectable after the fact.
    basis: proposal.basis,
  }
  return { ok: true, mission, warnings }
}