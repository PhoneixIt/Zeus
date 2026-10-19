/**
 * THE DIFF. What changed between the reviewed plan and the amended one.
 *
 * WHY A DIFF AND NOT JUST THE AMENDED PLAN
 *
 * Because the dangerous version of this feature is one where a reviewer sees a plan and cannot tell
 * what was done to it. A model proposing amendments later makes that concrete: the reviewer would be
 * approving text they did not write and could not compare.
 *
 * So the diff is a first-class output rather than a convenience, and it reports the fields that
 * change WHAT HAPPENS - the tool, the arguments, the declared effect, the target, the dependencies -
 * separately from the fields that only change how the plan reads. A changed `intent` sentence is worth
 * showing and is not worth stopping for; a changed tool is the reverse.
 *
 * The diff is computed from the two proposals, never from the amendment list. That matters: a
 * `replace` amendment carries a whole new proposal and no list of what changed, and a diff that
 * trusted the list would report nothing for it.
 */

import { canonicalise } from './digest.ts'
import type { PlanProposal, PlanStep } from '../planner/plan.ts'

/** How much a reviewer should care about a change. */
/**
 * How much a reviewer should care about a change.
 *
 * `args` is `behavioural` and not `structural`, and the distinction is worth stating: an argument is
 * where the machine is touched, which is the thing a reviewer most needs to see. The first version
 * classified it as structural, so the diff's own "material changes" filter - the one meant to be
 * shown on its own - would have excluded the single most consequential kind of change in the system.
 */
export type Significance = 'structural' | 'behavioural' | 'cosmetic'

export interface Change {
  readonly kind: 'added' | 'removed' | 'changed'
  readonly stepId: string
  readonly field?: string
  readonly significance: Significance
  readonly from?: string
  readonly to?: string
  /** A sentence a person can act on. */
  readonly note: string
}

/** Fields whose change alters what the machine does. `args` is here, deliberately. */
const BEHAVIOURAL: Readonly<Record<string, true>> = {
  tool: true, capability: true, mode: true, effect: true, onFailure: true, args: true, dependsOn: true,
}

/** Fields whose change alters only what the plan says. */
const COSMETIC: Readonly<Record<string, true>> = {
  intent: true, rationale: true,
}

function sigOf(field: string): Significance {
  if (BEHAVIOURAL[field]) return 'behavioural'
  if (COSMETIC[field]) return 'cosmetic'
  return 'structural'
}

/** A short, readable account of which operands changed on one step. */
function describeArgChange(id: string, before: Record<string, unknown>, after: Record<string, unknown>): string {
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].sort()
  const changed = keys.filter((k) => canonicalise(before?.[k]) !== canonicalise(after?.[k]))
  if (changed.length === 0) return `"${id}".args unchanged`
  const parts = changed.slice(0, 3).map((k) => `${k}: ${show(before?.[k])} -> ${show(after?.[k])}`)
  return `"${id}".args changed - ${parts.join('; ')}${changed.length > 3 ? ` (+${changed.length - 3} more)` : ''}`
}

function show(v: unknown): string {
  if (v === undefined) return '(absent)'
  return canonicalise(v)
}

/** Compares two plans. Order is stable: removals, then additions, then changes in step order. */
export function diffPlans(before: PlanProposal, after: PlanProposal): Change[] {
  const out: Change[] = []
  const bById = new Map(before.steps.map((s) => [s.id, s]))
  const aById = new Map(after.steps.map((s) => [s.id, s]))

  for (const [id, s] of bById) {
    if (!aById.has(id)) {
      out.push({
        kind: 'removed', stepId: id, significance: 'structural',
        from: s.intent,
        note: `step "${id}" was removed: ${s.intent}`,
      })
    }
  }

  for (const [id, a] of aById) {
    const b = bById.get(id)
    if (!b) {
      out.push({
        kind: 'added', stepId: id, significance: 'structural', to: a.intent,
        note: `step "${id}" was added: ${a.intent}`,
      })
      continue
    }

    for (const field of ['capability', 'mode', 'tool', 'args', 'dependsOn', 'verification', 'effect', 'onFailure', 'intent', 'rationale'] as const) {
      const bv = (b as unknown as Record<string, unknown>)[field]
      const av = (a as unknown as Record<string, unknown>)[field]
      if (canonicalise(bv) === canonicalise(av)) continue

      // An if-chain rather than a nested ternary.
      //
      // A ternary version was correct and is shorter, and it could not be parsed: Node's
      // type-stripper rejected the comment block sitting between `?` and its expression, so the whole
      // file failed to load and every test in the suite reported as failing. The if-chain says the
      // same thing and survives a reader adding a comment to it - which is the property that matters
      // in a file whose job is to be read.
      let note = `"${id}".${field} changed`

      if (field === 'tool' || field === 'capability') {
        note = `"${id}" would now use ${String(av)} instead of ${String(bv)}`
      } else if (field === 'dependsOn') {
        note = `"${id}" now depends on [${(av as string[] ?? []).join(', ')}] instead of [${(bv as string[] ?? []).join(', ')}]`
      } else if (field === 'args') {
        note = describeArgChange(id, bv as Record<string, unknown>, av as Record<string, unknown>)
      } else if (field === 'effect') {
        if (bv === undefined) {
          note = `"${id}" now DECLARES a consequential effect, so it will require authorisation`
        } else if (av === undefined) {
          note = `"${id}" no longer declares an effect - the tool's own classification still applies`
        } else {
          note = `"${id}"'s declared effect changed`
        }
      }
      out.push({
        kind: 'changed', stepId: id, field, significance: sigOf(field),
        from: show(bv), to: show(av), note,
      })
    }
  }

  // Proposal-level changes, which are not attached to any step.
  //
  // The objective postconditions are diffed FIRST and marked 'behavioural', because removing one is
  // the single most consequential amendment available: it deletes a condition the mission's success
  // was being judged against, and the diff has to say so rather than fold it into a count. An
  // amendment that quietly drops every postcondition would otherwise read as a tidy summary.
  const bPC = before.objectivePostconditions ?? []
  const aPC = after.objectivePostconditions ?? []
  if (canonicalise(bPC) !== canonicalise(aPC)) {
    const removed = bPC.filter((p) => !aPC.some((q) => canonicalise(q) === canonicalise(p)))
    const added = aPC.filter((p) => !bPC.some((q) => canonicalise(q) === canonicalise(p)))
    out.push({
      kind: 'changed', stepId: '(proposal)', field: 'objectivePostconditions', significance: 'behavioural',
      from: show(bPC), to: show(aPC),
      note: removed.length
        ? `THE OBJECTIVE'S OWN CHECKS CHANGED and ${removed.length} were REMOVED (${removed.map((p) => p.kind).join(', ')}).\n` +
          '      Every removed condition is one the mission no longer has to satisfy to call itself successful.\n' +
          '      This invalidates any approval given to the previous plan.'
        : `the objective's checks changed (${added.map((p) => p.kind).join(', ')} added). This changes what counts as done.`,
    })
  }
  if (canonicalise(before.expectedResult) !== canonicalise(after.expectedResult)) {
    out.push({
      kind: 'changed', stepId: '(proposal)', field: 'expectedResult', significance: 'behavioural',
      from: before.expectedResult, to: after.expectedResult,
      note: `what "done" means changed:\n      was: ${before.expectedResult}\n      now: ${after.expectedResult}`,
    })
  }
  if (canonicalise(before.constraints) !== canonicalise(after.constraints)) {
    out.push({
      kind: 'changed', stepId: '(proposal)', field: 'constraints', significance: 'behavioural',
      from: show(before.constraints), to: show(after.constraints),
      note: 'the plan\'s own constraints changed - read these, they are what the plan promises not to do',
    })
  }
  if (canonicalise(before.basis) !== canonicalise(after.basis)) {
    out.push({
      kind: 'changed', stepId: '(proposal)', field: 'basis', significance: 'structural',
      from: show(before.basis), to: show(after.basis),
      note: 'the plan now rests on a DIFFERENT observation, so it must be recompiled and re-checked against the world',
    })
  }

  return out
}

/** A one-line summary, for a log or a status line. */
export function summarise(changes: readonly Change[]): string {
  if (changes.length === 0) return 'no changes'
  const by = { behavioural: 0, structural: 0, cosmetic: 0 }
  for (const c of changes) by[c.significance]++
  const parts: string[] = []
  if (by.behavioural) parts.push(`${by.behavioural} behavioural`)
  if (by.structural) parts.push(`${by.structural} structural`)
  if (by.cosmetic) parts.push(`${by.cosmetic} cosmetic`)
  return `${changes.length} change(s): ${parts.join(', ')}`
}

/** The changes that change what the machine does. A reviewer can demand sign-off on just these. */
export function consequentialChanges(changes: readonly Change[]): Change[] {
  return changes.filter((c) => c.significance !== 'cosmetic')
}
