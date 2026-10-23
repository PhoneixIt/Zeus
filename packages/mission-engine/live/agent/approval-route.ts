/**
 * THE /approve ROUTE'S DECISION LOGIC, as a pure function.
 *
 * It lives outside chat-server.ts because that module starts an HTTP server the moment it is
 * imported (`void main()`), so the one piece of the approval channel that MUST be unit-tested -
 * how a request from the window becomes a decision on the store - was structurally untestable
 * without binding a port. This is the same seam-everything-depends-on principle as the rest of
 * the system: the route is HTTP plumbing; this is the policy.
 *
 * WHAT THIS FUNCTION GUARANTEES
 *
 *   1. EXACT MATCH OR NOTHING. The key handed to `decide()` is the key the executor REQUESTED,
 *      found by three exact field comparisons (step, kind, target). This code never builds a
 *      key: a decision the store did not already ask for is refused by ApprovalStore.decide
 *      itself, and inventing a key here would be the planner-grants-itself hole by another name.
 *
 *   2. AMBIGUITY IS A REFUSAL, NOT A COIN FLIP. If two outstanding requests match all three
 *      fields, the caller is told to say more. Taking the first match would decide one of two
 *      indistinguishable requests at random - and "which of the two did you mean" is a question
 *      whose wrong answer authorises an action nobody described.
 *
 *   3. NOT FOUND IS A FINAL ANSWER, NOT AN INVITATION. A stepId that matches nothing (already
 *      decided, from another mission, or never existed) is `not-found`. The route answers 404
 *      rather than creating anything - which is also what makes a double-click safe: the second
 *      click finds the request already decided and reports that there is nothing outstanding.
 */

import type { ApprovalKey } from '../../../governance/approval.ts'

export interface OutstandingRequest {
  readonly key: ApprovalKey
  readonly description: string
}

export interface DecisionTarget {
  readonly stepId: string
  readonly kind: string
  readonly target: string
}

export type MatchOutcome =
  | { readonly kind: 'found'; readonly request: OutstandingRequest }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'ambiguous'; readonly count: number }

/**
 * Find the ONE outstanding authorisation request a decision refers to.
 *
 * `outstanding` is the store's live view (requested-but-undecided), so a request that has
 * already been decided is simply not in the list and cannot be decided a second time here.
 */
export function matchOutstanding(
  outstanding: readonly OutstandingRequest[],
  want: DecisionTarget,
): MatchOutcome {
  const matches = outstanding.filter((o) =>
    o.key.stepId === want.stepId
    && o.key.kind === want.kind
    && o.key.target === want.target)
  if (matches.length === 0) return { kind: 'not-found' }
  if (matches.length > 1) return { kind: 'ambiguous', count: matches.length }
  return { kind: 'found', request: matches[0]! }
}

/** The three fields must all be present; a partial identity is not a decision target. */
export function isCompleteTarget(want: DecisionTarget): boolean {
  return want.stepId.trim().length > 0
    && want.kind.trim().length > 0
    && want.target.trim().length > 0
}
