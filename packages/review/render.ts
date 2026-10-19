/**
 * THE REVIEW SURFACE.
 *
 * What a person reads before deciding to let something run.
 *
 * WHAT IT SHOWS, AND WHY EACH THING IS HERE
 *
 *   what it will do       the steps, in order, with their intents
 *   why it will do that    each step's rationale, and the OBSERVED FACTS the whole plan rests on
 *   what it will touch     every operand, spelled out - this is the list a reviewer scans for paths
 *   which tools it will use the resolved tool per step, not the capability alone, because a capability
 *                          can resolve to something the reviewer did not expect
 *   what depends on what  the dependency edges
 *   what needs approval   named per step, and kept separate from review
 *   what will prove it    the verification requirement per step
 *
 * AND WHAT IT DELIBERATELY DOES NOT SHOW
 *
 * Internal reasoning. There is no "why I think" trace, no chain of deliberation, no confidence
 * narrative - because a planner that emits one is a planner that has been asked to explain itself, and
 * an explanation is not evidence. What appears here is execution information a person can check
 * against the machine: paths, tools, modes, and the facts that were observed. A reviewer can verify
 * every line of it independently. Nothing in this output requires trusting the system's account of its
 * own reasoning.
 *
 * The one judgement-shaped field is the plan's `expectedResult`, and it is shown because it is a
 * claim about the world that independent verification will later test - not because it explains
 * anything.
 */

import type { PlanProposal } from '../planner/plan.ts'
import type { ObjectivePostcondition, Step } from '../mission-engine/state.ts'
import type { Change } from './diff.ts'
import type { DryRunReport, StepReport } from './dry-run.ts'

/** Renders one operand compactly. Long collections are shown, not truncated silently. */
function operand(v: unknown): string {
  if (v === undefined) return '(unset)'
  if (Array.isArray(v)) {
    if (v.length === 0) return '(empty list)'
    if (v.length <= 4) return JSON.stringify(v)
    return `${v.length} items, first: ${JSON.stringify(v[0])} ... last: ${JSON.stringify(v[v.length - 1])}`
  }
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s.length > 110 ? `${s.slice(0, 110)}...` : s
}

/**
 * A postcondition in the words a reviewer needs, including the thing that makes it meaningful.
 *
 * The corroboration clause on `command-exited` is stated rather than hidden, because the difference
 * between "the command succeeded" and "the command succeeded AND something else confirmed it" is
 * the difference between a claim and evidence, and a reviewer approving the first is not approving
 * the second.
 */
function describePostcondition(pc: ObjectivePostcondition): string {
  switch (pc.kind) {
    case 'artifact-exists': return `${pc.path} exists`
    case 'artifact-read-back': return `${pc.path} can be read back independently`
    case 'artifact-byte-count': return `${pc.path} is exactly ${pc.bytes} bytes`
    case 'artifact-content-matches': return `${pc.path} hashes to ${pc.sha256.slice(0, 16)}... (its exact contents)`
    case 'directory-entry-count': return `${pc.path} holds exactly ${pc.entries} entries`
    case 'consequential-deleted': return `${pc.path} was deleted${pc.effect ? ` (${pc.effect})` : ''}, corroborated from outside the tool`
    case 'command-exited': return `${pc.executable} exited ${pc.exitCode}, corroborated from outside the process`
    default: return `${pc.kind} postcondition`
  }
}

export function renderProposal(p: PlanProposal, digest: string): string {  const L: string[] = []
  L.push('')
  L.push('  THE OBJECTIVE')
  L.push(`    ${p.objective}`)
  L.push('')
  L.push('  WHAT "DONE" MEANS   (a claim about the world, not a guarantee)')
  L.push(`    ${p.expectedResult}`)
  L.push('')
  // The postconditions are shown because a reviewer is approving the conditions under which the
  // system will call this work successful. Without them the reviewer approves a prose promise while
  // the machine enforces something else, which is the gap this section exists to close.
  L.push('  THE CHECKS THAT MUST PASS BEFORE THIS MAY BE CALLED SUCCESSFUL')
  if (!p.objectivePostconditions || p.objectivePostconditions.length === 0) {
    L.push('    (NONE DECLARED - this plan cannot report success, however well every step runs)')
    L.push('    A mission with no declared checks is UNPROVEN, never satisfied.')
  } else {
    for (const pc of p.objectivePostconditions) {
      L.push(`    - ${describePostcondition(pc)}`)
    }
  }
  L.push('')
  L.push('  WHAT IT PROMISES NOT TO DO')
  for (const c of p.constraints) L.push(`    - ${c}`)
  L.push('')
  L.push('  THE OBSERVATION THIS PLAN RESTS ON')
  if (!p.basis?.observationId) {
    L.push('    (none - this plan names no observation and cannot be compiled)')
  } else {
    L.push(`    observation  ${p.basis.observationId}`)
    L.push(`    taken at     ${new Date(p.basis.observedAt).toISOString()}`)
    L.push(`    of           ${p.basis.root}`)
    L.push(`    fingerprint  ${p.basis.fingerprint}`)
    L.push(`    complete     ${p.basis.complete}`)
    L.push('    facts used:')
    for (const f of p.basis.usedFacts) L.push(`      - ${f}`)
  }
  L.push('')
  L.push(`  ${p.steps.length} STEP(S), in order`)
  for (const [i, s] of p.steps.entries()) {
    L.push('')
    L.push(`    ${i + 1}. [${s.id}]  ${s.capability}  (${s.mode})`)
    L.push(`         intent      ${s.intent}`)
    L.push(`         why         ${s.rationale}`)
    L.push(`         depends on  ${(s.dependsOn ?? []).length ? (s.dependsOn ?? []).join(', ') : '(nothing)'}`)
    L.push(`         verifies    ${describeVerification(s)}`)
    L.push(`         touches     ${describeTouches(s)}`)
    if (s.effect) {
      L.push(`         EFFECT      ${s.effect.kind} on ${s.effect.target}`)
      L.push(`                    ${s.effect.irreversible ? 'IRREVERSIBLE - needs authorisation' : 'needs authorisation'}`)
    } else {
      L.push(`         EFFECT      none declared`)
    }
  }
  L.push('')
  L.push(`  plan digest ${digest}`)
  return L.join('\n')
}

function describeVerification(s: { verification?: { kind?: string; description?: string } }): string {
  const v = s.verification
  if (!v || typeof v !== 'object') return 'NONE DECLARED'
  return `${v.kind}${v.description ? ` - ${v.description}` : ''}`
}

/**
 * Every path the step mentions, pulled out of its operands.
 *
 * Extracted rather than printed wholesale so a reviewer can scan for paths without reading argument
 * JSON - the thing most likely to be wrong in an amended plan is an operand, and an operand is almost
 * always a path.
 */
function describeTouches(s: { args?: Record<string, unknown> }): string {
  const args = s.args ?? {}
  const parts: string[] = []
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string' && /[\\/]/.test(v)) parts.push(`${k}=${v}`)
    else if (Array.isArray(v) && v.some((x) => typeof x === 'string' && /[\\/]/.test(x))) {
      const paths = v.filter((x) => typeof x === 'string' && /[\\/]/.test(x)) as string[]
      parts.push(`${k}=[${paths.length} path(s), first ${paths[0]}]`)
    } else if (Array.isArray(v) && v.length) parts.push(`${k}=[${v.length} item(s)]`)
    else parts.push(`${k}=${operand(v)}`)
  }
  return parts.join('  ')
}

export function renderChanges(changes: readonly Change[], title = 'WHAT CHANGED'): string {
  const L: string[] = ['', `  ${title}`]
  if (changes.length === 0) {
    L.push('    (nothing)')
    return L.join('\n')
  }
  for (const c of changes) {
    const mark = c.significance === 'behavioural' ? '!!' : c.significance === 'structural' ? '! ' : '  '
    L.push(`    ${mark} ${c.note}`)
  }
  return L.join('\n')
}

export function renderDryRun(r: DryRunReport): string {
  const L: string[] = ['']
  L.push('  WHAT WOULD HAPPEN   (nothing has been run)')
  L.push('')
  L.push(`    the world       ${r.world.freshness === 'fresh' ? 'matches the observation' : r.world.freshness.toUpperCase()}`)
  L.push(`    observation     ${r.world.observationId || '(none)'}`)
  L.push(`    fingerprint     ${r.world.fingerprint || '(none)'}`)
  L.push(`    age             ${r.world.observationId ? `${Math.round(r.world.ageMs / 1000)}s` : 'n/a'}`)
  L.push(`    executable      ${r.executable ? 'yes, as it stands' : 'NO'}`)
  for (const b of r.planLevelBlockers) L.push(`      blocked: ${b}`)
  L.push('')
  for (const [i, s] of r.steps.entries()) {
    L.push(`    ${i + 1}. [${s.stepId}]  ${s.capability}`)
    L.push(`         would use     ${s.tool ?? '(unresolved)'}`)
    L.push(`         mode          ${s.mode}`)
    L.push(`         depends on    ${s.dependsOn.length ? s.dependsOn.join(', ') : '(nothing)'}`)
    L.push(`         verifies      ${s.verification}`)
    L.push(`         effect        ${s.effect ? `${s.effect.kind} on ${s.effect.target}  (from the ${s.effectSource})` : 'none'}`)
    L.push(`         authorisation ${s.approvalRequired ? (s.alreadyAuthorised ? 'REQUIRED and present' : 'REQUIRED and NOT granted') : 'not required'}`)
    L.push(`         verdict       ${s.verdict}`)
    for (const b of s.blockers) L.push(`           blocked: ${b}`)
    for (const n of s.notes) L.push(`           note:    ${n}`)
  }
  if (r.needsAuthorisation.length) {
    L.push('')
    L.push(`    ${r.needsAuthorisation.length} STEP(S) NEED A HUMAN BEFORE ANYTHING RUNS: ${r.needsAuthorisation.join(', ')}`)
    L.push('    Reviewing this plan is NOT the same as authorising those steps.')
  }
  // Per-step notes that the step's own line cannot hold. A note about needing authorisation is the
  // most important sentence in the whole report, and the first version put it only in the per-step
  // note channel - which a reviewer scanning the summary section never reads.
  const humanNotes = r.steps.flatMap((s) => s.notes.filter((n) => /needs a human|before it is considered/i.test(n)).map((n) => `${s.stepId}: ${n}`))
  if (humanNotes.length) {
    L.push('')
    L.push('    SOME STEPS NEED A PERSON, NOT JUST AN APPROVAL:')
    for (const n of humanNotes) L.push(`      ${n}`)
  }
  if (r.inertAuthorityFields.length) {
    L.push('')
    L.push('    THIS PLAN CARRIES FIELDS THAT LOOK LIKE PERMISSION AND ARE NOT READ:')
    for (const f of r.inertAuthorityFields) L.push(`      ${f}  - ignored by the compiler and by the digest`)
  } else if (r.unrecognised.length) {
    L.push('')
    L.push(`    unrecognised fields on this plan (ignored): ${r.unrecognised.join(', ')}`)
  }
  return L.join('\n')
}

/** The one-line header a caller prints before the detail. */
export function renderHeader(p: PlanProposal, digest: string, isAmended: boolean): string {
  // `PlanStep.effect` is declared now, so the cast is not needed. It also was not doing what it
  // looked like: it narrowed the array element to `Step`, which is a DIFFERENT and larger type, so
  // the predicate was being checked against a shape the array never contained.
  const consequence = p.steps.filter((s) => s.effect !== undefined).length
  return [
    `  proposal ${digest}${isAmended ? '  (AMENDED)' : ''}`,
    `  objective   ${p.objective}`,
    `  ${p.steps.length} step(s), ${consequence} declaring a consequential effect`,
  ].join('\n')
}
