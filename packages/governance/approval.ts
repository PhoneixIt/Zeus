/**
 * CONSEQUENTIAL-EFFECT GOVERNANCE.
 *
 * A mission can now plan, recover, and write files. Before it gains the ability to delete,
 * send, purchase or use credentials, the boundary that authorises those things has to exist and
 * be enforceable — because a system that can *represent* a consequence without being able to
 * *refuse* one has no governance at all. It has a comment.
 *
 * THE DIVISION, AND IT IS NOT A SUGGESTION
 *
 *   the planner   DECLARES that a step has an effect
 *   the executor  CLASSIFIES it and decides whether it may proceed
 *   a human       AUTHORISES
 *
 * The planner cannot authorise. Not because it is asked not to, but because `PlanStep.effect`
 * is a declaration and the approval record it is matched against lives in a different structure
 * that the planner has no reference to and no way to write. There is no field on a plan that
 * means "approved", so a plan cannot assert one.
 *
 * WHY A SIMULATOR, AND WHY IT IS NOT A BYPASS
 *
 * A real deletion or purchase cannot be used to prove a governance boundary. So the
 * consequence is modelled: a tool whose effect is `delete` deletes a probe file inside a
 * disposable directory. It travels the SAME gate as any other consequential step — the gate
 * cannot tell a simulator from the real thing, because the gate never inspects what the tool
 * does. It only reads the declared effect and the approval record.
 *
 * That is the property being proved: the gate is on the DECLARATION, not on the implementation.
 * A real `delete` tool would be governed by exactly this code path, unchanged.
 *
 * APPROVAL IS NOT SUCCESS
 *
 * A human approving means the action is AUTHORISED. It says nothing about whether it worked.
 * Approval and verification are separate, and `APPROVED -> EXECUTED -> VERIFIED` keeps them
 * separate: an approved-and-executed step whose verification fails is `failed`, not `verified`,
 * and an approval can never make a mission complete on its own.
 */

/**
 * The effect classes. Deliberately the existing `PreparedAction` union rather than a new
 * taxonomy — it already models these six and inventing a parallel one would be exactly the
 * "do not duplicate this in incompatible schemas" failure.
 */
export type EffectKind =
  | 'external-send' | 'purchase' | 'delete'
  | 'install' | 'credential-use' | 'security-setting'

/**
 * A step's DECLARED effect.
 *
 * Present on a plan step when the step will do something consequential. Absent otherwise.
 * Declaring one obliges the step to obtain approval; it does not grant it.
 */
export interface DeclaredEffect {
  readonly kind: EffectKind
  /** What is affected. The identity an approval is bound to — see `effectKey`. */
  readonly target: string
  /** Human-readable justification, shown to whoever approves. */
  readonly reason: string
  /** Whether the human should be told the consequences are permanent. */
  readonly irreversible: boolean
}

/**
 * THE APPROVAL KEY.
 *
 * An approval authorises one specific action: this effect kind, on this target, in this mission,
 * at this step. Every component is load-bearing, and each maps to a way a looser key would be
 * exploitable:
 *
 *   mission   an approval must not carry across missions
 *   step      must not carry to a different step
 *   kind      approving a `delete` must not authorise a `purchase`
 *   target    approving a delete of /a must not authorise a delete of /b
 *   planEpoch an approval must not survive a REPLAN of the same step id, because a replanned
 *             step is a different action that happens to share an identifier
 *
 * `planEpoch` is the one that is easy to miss. Step ids are stable across replans precisely
 * because they are generated from the plan's shape, so a step that was replanned keeps its id
 * while meaning something else. An approval keyed on the step id alone would silently authorise
 * the new action.
 */
export interface ApprovalKey {
  readonly missionId: string
  readonly stepId: string
  readonly kind: EffectKind
  readonly target: string
  readonly planEpoch: number
}

/** Stable string form of a key, for logs and for looking approvals up. */
export function effectKey(k: ApprovalKey): string {
  return [k.missionId, k.stepId, k.kind, k.target, `#${k.planEpoch}`].join('|')
}

/** Builds the key for a declared effect. The ONLY place a key is constructed. */
export function keyFor(missionId: string, stepId: string, effect: DeclaredEffect, planEpoch: number): ApprovalKey {
  return { missionId, stepId, kind: effect.kind, target: effect.target, planEpoch }
}

export type ApprovalState = 'pending' | 'approved' | 'rejected'

/** One authorisation, granted by a human. Never by a plan. */
export interface Approval {
  readonly key: ApprovalKey
  readonly state: ApprovalState
  /** When the human decided. */
  readonly decidedAt: number
  /** Who decided. Recorded so an audit can distinguish a person from a default. */
  readonly decidedBy: string
  /** The description the human was shown, frozen at request time. */
  readonly description: string
}

/**
 * THE APPROVAL STORE.
 *
 * The authority. The executor asks it; nothing else writes to it.
 *
 * Two properties are enforced here rather than at the call site, because a check performed by
 * the caller is a check the caller can forget:
 *
 *   1. `grant` requires an EXPLICIT decision. There is no "approve anything matching" and no
 *      "the user approved something similar last time". A grant whose key does not match an
 *      outstanding request exactly is refused.
 *   2. `decide` only accepts a key that was actually requested. So a planner cannot pre-approve
 *      a step that has not run, and a stale key cannot be revived.
 */
export class ApprovalStore {
  private readonly requested = new Map<string, { key: ApprovalKey; description: string }>()
  private readonly decided = new Map<string, Approval>()

  /** Called by the executor when a step declares an effect. Records what authorisation is needed. */
  request(key: ApprovalKey, description: string): void {
    const k = effectKey(key)
    // Re-requesting the same key is idempotent: a retry does not silently discard a decision
    // that has already been made.
    if (!this.requested.has(k)) this.requested.set(k, { key, description })
  }

  /** Whether an approval is required and outstanding for this exact key. */
  isPending(key: ApprovalKey): boolean {
    return this.requested.has(effectKey(key)) && !this.decided.has(effectKey(key))
  }

  hasBeenRequested(key: ApprovalKey): boolean {
    return this.requested.has(effectKey(key))
  }

  /**
   * Records a human decision.
   *
   * Refuses a key that was never requested. That single check is what makes "planner grants
   * itself approval" impossible: the planner cannot write to this store, and even if something
   * could, a decision for an unrequested key is rejected.
   */
  decide(key: ApprovalKey, state: 'approved' | 'rejected', decidedBy: string, at: number): Approval {
    const k = effectKey(key)
    const req = this.requested.get(k)
    if (!req) {
      throw new Error(
        `refusing to record an approval for ${k}: no such approval was ever requested. ` +
        `An approval authorises a specific action that must have been asked for.`,
      )
    }
    const approval: Approval = { key, state, decidedAt: at, decidedBy, description: req.description }
    this.decided.set(k, approval)
    return approval
  }

  /** The decision for this exact key, or undefined. Never a "close enough" match. */
  lookup(key: ApprovalKey): Approval | undefined {
    return this.decided.get(effectKey(key))
  }

  /**
   * Whether this key may proceed RIGHT NOW.
   *
   * Exact match only. No heuristics, no "similar", no carry-over. A lookup that finds nothing
   * means the action is not authorised, and the safe answer to a missing approval is always no.
   */
  permits(key: ApprovalKey): boolean {
    return this.lookup(key)?.state === 'approved'
  }

  /**
   * Invalidates every approval granted under a given plan epoch.
   *
   * Called when a mission is replanned. An approval authorised a specific action in a specific
   * world; after a replan the world the step would act on has changed, so the authorisation no
   * longer describes what would happen.
   */
  invalidateEpoch(missionId: string, planEpoch: number, why: string): number {
    let n = 0
    for (const [k, a] of this.decided) {
      if (a.key.missionId === missionId && a.key.planEpoch === planEpoch && a.state === 'approved') {
        this.decided.set(k, { ...a, state: 'rejected', decidedBy: `${a.decidedBy} (invalidated: ${why})` })
        n++
      }
    }
    return n
  }

  /** Everything outstanding, for the audit and for a human about to decide. */
  outstanding(): Array<{ key: ApprovalKey; description: string }> {
    return [...this.requested.entries()]
      .filter(([k]) => !this.decided.has(k))
      .map(([, v]) => v)
  }

  /** Everything decided, for the audit trail. */
  decisions(): Approval[] {
    return [...this.decided.values()]
  }
}
