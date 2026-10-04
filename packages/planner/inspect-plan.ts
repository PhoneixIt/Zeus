/**
 * PLAN INSPECTION.
 *
 * "What I intend to do", in a form a human can read before approving it.
 *
 * This exists because the eventual desktop application has to show a person the plan before
 * anything runs. A CLI report is enough for this milestone, but the SHAPE is the point: the
 * report is derived from the `PlanProposal`, not from a mission mid-execution, so it is exactly
 * what was proposed rather than a reconstruction of what happened.
 *
 * It prints intent, mode, tool, dependencies, verification and failure behaviour per step,
 * because those are the five things a person needs in order to decide whether to let it run.
 * A plan view that showed only step names would be decoration.
 */

import type { PlanProposal, PlanStep } from './plan.ts'

const ARROW = '->'

export function renderPlan(proposal: PlanProposal, opts: { missionId?: string } = {}): string {
  const L: string[] = []
  L.push('=== PROPOSED PLAN ===')
  L.push(`  objective       ${proposal.objective}`)
  L.push(`  expected result ${proposal.expectedResult}`)
  if (opts.missionId) L.push(`  mission id      ${opts.missionId}`)
  L.push('')
  L.push('  constraints (what this plan is forbidden to do):')
  for (const c of proposal.constraints) L.push(`    - ${c}`)
  L.push('')
  L.push(`  ${proposal.steps.length} step(s):`)
  for (const [i, s] of proposal.steps.entries()) {
    L.push('')
    L.push(`  ${i + 1}. [${s.id}]  mode=${s.mode}  tool=${s.tool}`)
    L.push(`     intent        ${s.intent}`)
    L.push(`     why           ${s.rationale}`)
    L.push(`     depends on    ${s.dependsOn.length ? s.dependsOn.join(', ') : '(nothing)'}`)
    L.push(`     verification  [${s.verification.kind}] ${s.verification.description}`)
    L.push(`     on failure    ${s.onFailure}`)
    const args = renderArgs(s)
    if (args) L.push(`     operands      ${args}`)
  }
  L.push('')
  L.push(`  execution order ${proposal.steps.map((s) => s.id).join(` ${ARROW} `)}`)
  L.push('=== END PLAN ===')
  return L.join('\n')
}

/** Operands, rendered as `key=value`, with anything long or path-like left visible. */
function renderArgs(s: PlanStep): string {
  const keys = Object.keys(s.args)
  if (!keys.length) return ''
  return keys.map((k) => `${k}=${JSON.stringify(s.args[k])}`).join('  ')
}

/** Machine-readable form, for a UI that wants to render rather than print. */
export function planAsJson(proposal: PlanProposal): string {
  return JSON.stringify(proposal, null, 2)
}