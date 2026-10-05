/**
 * AMENDMENT. How a reviewer changes a plan.
 *
 * EVERY AMENDMENT PRODUCES A NEW PROPOSAL. None of them touches a compiled mission, and none of them
 * decides whether the result is executable.
 *
 * THAT DIVISION IS THE WHOLE DESIGN
 *
 *   this file      proposes changes, and says what changed
 *   `compile.ts`  decides whether the result may run
 *
 * An amendment layer that validated would be a second, weaker compiler, and the two would disagree
 * about the same plan for different reasons. So these functions are deliberately PERMISSIVE: they
 * will happily produce a proposal with a dangling dependency, a cycle, an unknown capability, an
 * operand outside every boundary, or a missing verification. All of those are rejected at compile
 * time, where the rejection is authoritative and where the message has the whole plan in front of it.
 *
 * The one thing these functions do check is whether the thing being amended EXISTS. Refusing to
 * remove a step that is not there is not validation of the plan; it is refusing to invent a
 * difference between two plans that are already identical.
 *
 * WHY NOT PATCH THE MISSION
 *
 * Because a `Mission` is the executor's state. It carries `state`, `history`, `pendingApprovals`,
 * `attempts` and a `result` per step - a record of what has happened. A reviewer amending that would
 * be editing history, and the first thing an executor must be able to trust is that its own state was
 * not edited by something outside it. So an amendment rewrites the PROPOSAL and the plan is compiled
 * again from scratch: new mission id, new step results, and a fresh digest to compare against.
 */

import type { PlanProposal, PlanStep } from '../planner/plan.ts'

export type Amendment =
  | { readonly kind: 'set-arg'; readonly stepId: string; readonly key: string; readonly value: unknown }
  | { readonly kind: 'remove-step'; readonly stepId: string }
  | { readonly kind: 'add-step'; readonly step: PlanStep }
  | { readonly kind: 'set-depends'; readonly stepId: string; readonly dependsOn: readonly string[] }
  | { readonly kind: 'set-verification'; readonly stepId: string; readonly verification: unknown }
  | { readonly kind: 'set-effect'; readonly stepId: string; readonly effect: unknown }
  | { readonly kind: 'set-constraint'; readonly index: number; readonly value: string }
  /**
   * Change which capability a step requires.
   *
   * Separate from `set-arg` because the capability is a FIELD of the step, not an operand. Writing it
   * through `set-arg` would put `capability: 'filesystem.telepathy'` into `args`, leave the step
   * requiring what it always required, and produce a plan that looks amended and is not - which is
   * the worst outcome available, since the diff would show a change and the executor would ignore it.
   */
  | { readonly kind: 'set-capability'; readonly stepId: string; readonly capability: string }
  /** Wholesale replacement, for a caller that already holds a whole proposal. */
  | { readonly kind: 'replace'; readonly proposal: PlanProposal }

export type AmendmentOutcome =
  | { readonly ok: true; readonly proposal: PlanProposal; readonly applied: Amendment }
  | { readonly ok: false; readonly reason: string; readonly applied?: Amendment }

/**
 * Applies ONE amendment and returns a NEW proposal.
 *
 * The original is never mutated. It is returned alongside the result so a caller can diff the two, and
 * so a caller that keeps a reference to the original still has the plan the user actually saw.
 */
export function amend(original: PlanProposal, change: Amendment): AmendmentOutcome {
  // A defensive structured copy, so that no amendment path can reach the original through a shared
  // array or object reference.
  //
  // HONESTLY: this is NOT load-bearing, and a negative control proved it. Removing it changed nothing,
  // because every case below builds a new `steps` array by mapping rather than mutating - so the
  // original was already unreachable. The copy is kept because a future amendment kind that pushes
  // into an array would otherwise be a silent aliasing bug, and that is a real risk in a file whose
  // whole job is producing new versions of things.
  //
  // It is recorded here as defence in depth rather than as a protection, because a comment claiming it
  // protects something that a test showed it does not would be worse than no comment.
  const p: PlanProposal = structuredClone(original)

  switch (change.kind) {
    case 'replace':
      return { ok: true, proposal: structuredClone(change.proposal), applied: change }

    case 'set-arg': {
      const step = p.steps.find((s) => s.id === change.stepId)
      if (!step) return { ok: false, reason: `no step named "${change.stepId}" to amend` }
      // No type check on `value`. The compiler validates operands; this layer only records the change,
      // and refusing here would mean a second, weaker notion of what an operand may be.
      return {
        ok: true,
        proposal: { ...p, steps: p.steps.map((s) => (s.id === change.stepId ? { ...s, args: { ...s.args, [change.key]: change.value } } : s)) },
        applied: change,
      }
    }

    case 'remove-step': {
      if (!p.steps.some((s) => s.id === change.stepId)) {
        return { ok: false, reason: `no step named "${change.stepId}" to remove` }
      }
      // Dependencies on the removed step are LEFT DANGLING on purpose. Cleaning them up here would
      // silently repair the plan, and silent repair is what the compiler exists to prevent: a reviewer
      // who removes a step needs to be told that other steps depended on it, not quietly given a plan
      // that works.
      return { ok: true, proposal: { ...p, steps: p.steps.filter((s) => s.id !== change.stepId) }, applied: change }
    }

    case 'add-step':
      return { ok: true, proposal: { ...p, steps: [...p.steps, structuredClone(change.step)] }, applied: change }

    case 'set-depends': {
      const step = p.steps.find((s) => s.id === change.stepId)
      if (!step) return { ok: false, reason: `no step named "${change.stepId}" to amend` }
      return {
        ok: true,
        proposal: { ...p, steps: p.steps.map((s) => (s.id === change.stepId ? { ...s, dependsOn: [...change.dependsOn] } : s)) },
        applied: change,
      }
    }

    case 'set-verification': {
      const step = p.steps.find((s) => s.id === change.stepId)
      if (!step) return { ok: false, reason: `no step named "${change.stepId}" to amend` }
      // Assigning whatever was passed, INCLUDING undefined, so that a reviewer can remove a
      // verification requirement. The compiler then refuses - which is the proof that the requirement
      // was load-bearing, and the reason this cannot be a filtered assignment.
      return {
        ok: true,
        proposal: { ...p, steps: p.steps.map((s) => (s.id === change.stepId ? { ...s, verification: change.verification as never } : s)) },
        applied: change,
      }
    }

    case 'set-effect': {
      const step = p.steps.find((s) => s.id === change.stepId)
      if (!step) return { ok: false, reason: `no step named "${change.stepId}" to amend` }
      // Assigning `undefined` removes a declared effect. A reviewer CAN do that - and the compiler
      // then requires the TOOL's own classification to agree, so removing a declaration from a
      // consequential step does not un-gate it. See `compile.ts`.
      return {
        ok: true,
        proposal: { ...p, steps: p.steps.map((s) => (s.id === change.stepId ? { ...s, effect: change.effect as never } : s)) },
        applied: change,
      }
    }

    case 'set-capability': {
      const step = p.steps.find((s) => s.id === change.stepId)
      if (!step) return { ok: false, reason: `no step named "${change.stepId}" to amend` }
      // No validity check. An unknown capability is the compiler's to refuse, and a reviewer proposing
      // one is exactly the case the compiler exists for. Checking here would mean the review layer
      // silently declined to record a proposal, which is the same failure as refusing to show a diff.
      return {
        ok: true,
        proposal: { ...p, steps: p.steps.map((s) => (s.id === change.stepId ? { ...s, capability: change.capability as never } : s)) },
        applied: change,
      }
    }

    case 'set-constraint': {
      const cs = [...p.constraints]
      if (change.index < 0 || change.index >= cs.length) {
        return { ok: false, reason: `no constraint at index ${change.index}; the plan has ${cs.length}` }
      }
      cs[change.index] = change.value
      return { ok: true, proposal: { ...p, constraints: cs }, applied: change }
    }
  }
}

/** Applies several amendments in order, stopping at the first refusal. */
export function amendAll(original: PlanProposal, changes: readonly Amendment[]): {
  ok: boolean
  proposal: PlanProposal
  applied: Amendment[]
  refused?: { change: Amendment; reason: string }
} {
  let current = original
  const applied: Amendment[] = []
  for (const change of changes) {
    const r = amend(current, change)
    if (!r.ok) return { ok: false, proposal: current, applied, refused: { change, reason: r.reason } }
    current = r.proposal
    applied.push(change)
  }
  return { ok: true, proposal: current, applied }
}

/** A human-readable description of what an amendment claims to do, for the diff and the log. */
export function describe(a: Amendment): string {
  switch (a.kind) {
    case 'set-arg': return `set ${a.stepId}.args.${a.key} = ${JSON.stringify(a.value)}`
    case 'remove-step': return `remove step ${a.stepId}`
    case 'add-step': return `add step ${a.step.id}`
    case 'set-depends': return `set ${a.stepId}.dependsOn = [${a.dependsOn.join(', ')}]`
    case 'set-verification': return `set ${a.stepId}.verification = ${JSON.stringify(a.verification)}`
    case 'set-effect': return `set ${a.stepId}.effect = ${JSON.stringify(a.effect)}`
    case 'set-constraint': return `set constraint[${a.index}] = ${JSON.stringify(a.value)}`
    case 'set-capability': return `set ${a.stepId}.capability = ${a.capability}`
    case 'replace': return 'replace the proposal wholesale'
  }
}
