/**
 * One classifier for "the operator-host transport died with a request in flight" - the single
 * home for that decision, shared by every consumer so there can never be two regex sets, or two
 * verdicts, for the same evidence.
 *
 * There are two consumers, and they must agree:
 *
 *   - the desktop-input capability, which classifies its OWN non-delivery reports
 *     (`!delivered` results and thrown transport errors) before returning a ToolResult;
 *   - the executor's throwing-tool boundary, which classifies a throw it received from any
 *     desktop-acting tool it called - a tool that may not have classified its own failure
 *     (a transport throw escaping from a raw host call, for instance).
 *
 * If the executor classified throws with its own copy of these patterns, the two would drift,
 * and a desktop action would be judged retryable by one layer and not the other - which is
 * precisely the disagreement in which a duplicated desktop action lives.
 */

/**
 * Signatures of a transport failure that happened WITH a request in flight.
 *
 * The distinction is the whole "never blindly retry an action whose outcome may be unknown"
 * rule. `ECONNREFUSED` means the request never left this machine: nothing was injected, and a
 * clean retry is honest. Every other transport death - a reset, a timeout, a socket closed
 * mid-response - means the host may have received the request and injected SOME of it before
 * dying. The 2026-10-22 OpenVault incident is the proof this is not theoretical: the host was
 * killed mid-TYPING after real keystrokes had landed, and the tool reported a plain `failed` -
 * exactly the "failed, therefore safe to retry" reading in which a duplicated desktop action
 * lives. A `failed` from this path is a claim we cannot make, so it is reported as the honest
 * `outcome-unknown`, which `isRetryable` refuses to retry and Stage D recovery surfaces for
 * reconciliation.
 */
const CONNECTION_REFUSED = /ECONNREFUSED/i
const TRANSPORT_LOST_MID_REQUEST = /fetch failed|fetch timeout|socket hang up|terminated|ECONNRESET|ETIMEDOUT|EPIPE|UND_ERR|premature close|other side closed/i

/**
 * True when `reason` describes a transport that died with the request IN FLIGHT, so the
 * action's fate is genuinely unknown. False for a confirmed pre-dispatch refusal
 * (`ECONNREFUSED`: no connection was ever established, so nothing was ever sent) and for
 * messages that carry no transport signature at all.
 *
 * The classifier deliberately errs only TOWARD `outcome-unknown`: a message it does not
 * recognise keeps its ordinary meaning, while every signature it does recognise (except the
 * pre-dispatch refusal) means "cannot prove nothing landed".
 */
export function midActionTransportLoss(reason: string): boolean {
  return TRANSPORT_LOST_MID_REQUEST.test(reason) && !CONNECTION_REFUSED.test(reason)
}
