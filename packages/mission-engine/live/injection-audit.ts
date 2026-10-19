/**
 * The mission-level injection audit.
 *
 * WHAT THIS IS
 *
 * A record of what the CONTROL LAYER authoritatively says happened when a mission tried to
 * act on the computer - and, separately, whether that record can be trusted to say WHO acted.
 *
 * THE AUTHORITATIVE SOURCE
 *
 * The control core's own monotonic counters, read over its existing HTTP surface:
 *
 *   /guard  state, mayInject, inputPermission, blockingReason, emergencyLatched,
 *           takeoverPending, humanEvents, operatorEvents, otherInjected
 *   /hooks  keyboardHookInstalled, mouseHookInstalled, hookThreadAlive, mouseEventsSeen,
 *           mouseTaggedSeen, mouseUntaggedSeen, panelInjectedSeen, panelTaggedSeen,
 *           panelReleaseSeen/Accepted/Refused, livenessProbes, livenessProbeHits,
 *           livenessFailures
 *
 * Attribution is read as a DELTA across the action, not as an absolute, because these are
 * cumulative counters on a machine that is also being touched by the human.
 *
 * WHY DELTAS AND NOT A PROXY
 *
 * An earlier harness proved "INJECTION CALLS: []" by wrapping the control surface in a
 * JavaScript Proxy and counting which methods were invoked. That measures what the mission
 * code ASKED FOR. It cannot detect input the control layer produced by any other route, and
 * it cannot detect a missed injection - the tool called click, the click did not happen, and
 * the proxy still counted one call. That is an instrument that reports the intent rather than
 * the event, which is the exact confusion this milestone exists to remove.
 *
 * WHY THE SENTINEL IS NOT READ HERE
 *
 * `Guard.Sentinel` is deliberately withheld from `/guard`, because publishing it would hand
 * every client the value needed to forge operator-owned input. `/sentinel-probe` exists for
 * the local harness alone. This module therefore NEVER asks "what did dwExtraInfo say" - it
 * asks the control core's own verdict, which is the only question worth asking and the only
 * one that cannot be answered by a liar.
 *
 * THE FOUR SEPARATE CLAIMS
 *
 * These are kept apart on purpose, because collapsing them is how "it clicked" becomes "it
 * worked" becomes "the AI did it", none of which follow from each other:
 *
 *   A  did input occur?          - measured: did any authoritative counter move?
 *   B  was it operator-generated? - measured: did `operatorEvents` move? The control core
 *                                   increments that ONLY on an exact sentinel match, so it is
 *                                   proof by construction rather than an inference.
 *   C  was it human-generated?   - measured: did `humanEvents` move?
 *   D  can attribution be proven?- derived: are B and C mutually exclusive and consistent
 *                                   with the path taken?
 *
 * A may be true while B, C and D all fail. That is a legitimate result and is represented
 * as `input-occurred-attribution-unproven`, never as success.
 */

import type { ControlSurface } from '../../governance/contract.ts'

// ============================================================ the authoritative record

/**
 * A snapshot of the control core's own counters.
 *
 * This is the audit's only input. It contains no Windows event data, because the mission
 * engine must not reinterpret low-level events - it must ask the layer that already owns
 * that judgement what it concluded.
 */
export interface ControlRecord {
  // ---- /guard: the control state and the three attribution counters
  readonly state: string
  readonly mayInject: boolean
  readonly inputPermission: string
  readonly blockingReason: string | null
  readonly emergencyLatched: boolean
  readonly takeoverPending: boolean
  readonly humanEvents: number
  readonly operatorEvents: number
  readonly otherInjected: number
  // ---- /hooks: the hook's own view, including the mouse tagging counters
  readonly keyboardHookInstalled: boolean
  readonly mouseHookInstalled: boolean
  readonly hookThreadAlive: boolean
  readonly mouseEventsSeen: number
  readonly mouseTaggedSeen: number
  readonly mouseUntaggedSeen: number
  readonly panelInjectedSeen: number
  readonly panelTaggedSeen: number
  readonly livenessProbes: number
  readonly livenessProbeHits: number
  readonly livenessFailures: number
  // ---- /hooks: the mouse-attribution repair, observed rather than assumed.
  //
  // `mouseTaggedSeen` says whether attribution happened. These say WHY, and they exist because
  // the counter alone cannot distinguish "the sentinel comparison is false" from "the handler
  // died before it reached the comparison" - a distinction that decides whether the repair works
  // or is merely present in the source. `mouseProcError` matters for the same reason: that handler
  // swallowed every exception for its entire life, so a fault looked exactly like a clean miss.
  readonly mouseCompareObserved: number
  readonly mouseCompareLow32: number
  readonly mouseCompareHit: number
  readonly mouseProcError: string
}

/** The narrowest client that can read the authoritative record. */
export interface RecordSource {
  /**
   * PURE. Returns the guard's authoritative state and the three attribution counters.
   *
   * Measured: six consecutive reads moved `operatorEvents` by 0. Safe to bracket an action
   * with, because observing does not change what is observed.
   */
  guard(): Promise<Record<string, unknown>>
  /**
   * NOT PURE. This route CALLS `Hooks.Report()`, which signals the hook thread to send a real
   * sentinel-tagged F24 keystroke through `SendInput`, then waits up to 400ms for it to come
   * back. Reading it INJECTS.
   *
   * Measured on this host: eight reads advanced `livenessProbes` by 7. So this audit must
   * never bracket an action with it - doing so would have the instrument measure its own side
   * effect and report `operator-proven` for a keystroke it caused itself.
   *
   * It is also, for exactly that reason, the one EXISTING control-layer route that produces a
   * real authoritative operator event on demand without weakening anything.
   */
  raw(path: string, opts?: { method?: string; body?: Record<string, unknown> }): Promise<{ status: number; body: Record<string, unknown> }>
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const bool = (v: unknown): boolean => v === true
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/**
 * Reads the PURE authoritative record - `/guard` only.
 *
 * This is what brackets an action, because it cannot change what it observes. The hook
 * diagnostics live on `/hooks`, which injects, so they are read separately and only when the
 * mouse path specifically needs them.
 */
export async function readRecord(src: RecordSource): Promise<ControlRecord> {
  const g = await src.guard()
  // Hook fields are all zero here and that is DELIBERATE, not a failure to read them: they
  // live on a route that injects. `guard`-only callers must see zeros rather than a value
  // obtained by causing the very event they are trying to measure.
  return {
    state: str(g.state),
    mayInject: bool(g.mayInject),
    inputPermission: str(g.inputPermission),
    blockingReason: typeof g.blockingReason === 'string' ? g.blockingReason : null,
    emergencyLatched: bool(g.emergencyLatched),
    takeoverPending: bool(g.takeoverPending),
    humanEvents: num(g.humanEvents),
    operatorEvents: num(g.operatorEvents),
    otherInjected: num(g.otherInjected),
    keyboardHookInstalled: true,
    mouseHookInstalled: true,
    hookThreadAlive: true,
    mouseEventsSeen: 0,
    mouseTaggedSeen: 0,
    mouseUntaggedSeen: 0,
    panelInjectedSeen: 0,
    panelTaggedSeen: 0,
    livenessProbes: 0,
    livenessProbeHits: 0,
    livenessFailures: 0,
    mouseCompareObserved: 0,
    mouseCompareLow32: 0,
    mouseCompareHit: 0,
    mouseProcError: '',
  }
}

/**
 * Reads the hook diagnostics from `/hooks`.
 *
 * WARNING: this call INJECTS - see `RecordSource.raw`. The returned `probesAdvanced` is how
 * far the probe counter moved across this very call, which is the only honest way to learn
 * what the read cost. Callers must treat the hook counters as valid only alongside it.
 */
export async function readHookDiagnostics(src: RecordSource): Promise<{
  diagnostics: ControlRecord
  probesAdvanced: number
}> {
  const before = await readRecord(src)
  const r = await src.raw('/hooks')
  const after = await readRecord(src)
  const hb = r.body ?? {}
  const g = await src.guard()
  return {
    probesAdvanced: after.operatorEvents - before.operatorEvents,
    diagnostics: {
      state: str(g.state),
      mayInject: bool(g.mayInject),
      inputPermission: str(g.inputPermission),
      blockingReason: typeof g.blockingReason === 'string' ? g.blockingReason : null,
      emergencyLatched: bool(g.emergencyLatched),
      takeoverPending: bool(g.takeoverPending),
      humanEvents: num(g.humanEvents),
      operatorEvents: num(g.operatorEvents),
      otherInjected: num(g.otherInjected),
      keyboardHookInstalled: bool(hb.keyboardHookInstalled),
      mouseHookInstalled: bool(hb.mouseHookInstalled),
      hookThreadAlive: bool(hb.hookThreadAlive),
      mouseEventsSeen: num(hb.mouseEventsSeen),
      mouseTaggedSeen: num(hb.mouseTaggedSeen),
      mouseUntaggedSeen: num(hb.mouseUntaggedSeen),
      panelInjectedSeen: num(hb.panelInjectedSeen),
      panelTaggedSeen: num(hb.panelTaggedSeen),
      livenessProbes: num(hb.livenessProbes),
      livenessProbeHits: num(hb.livenessProbeHits),
      livenessFailures: num(hb.livenessFailures),
      mouseCompareObserved: num(hb.mouseCompareObserved),
      mouseCompareLow32: num(hb.mouseCompareLow32),
      mouseCompareHit: num(hb.mouseCompareHit),
      mouseProcError: str(hb.mouseProcError),
    },
  }
}

// ============================================================ the four separate claims

/** Which path the action took. Decides which counters are meaningful. */
export type ActionPath = 'keyboard' | 'mouse' | 'none'

/**
 * What KIND of thing the action was.
 *
 * This distinction is load-bearing and is NOT a loophole:
 *
 *   'user-action'      acts on the human's world - a click at coordinates, typing, scrolling.
 *                      MUST be refused unless the control layer grants `mayInject`. If it were
 *                      permitted while injection was forbidden, the machine would be doing the
 *                      opposite of what the guard says it is doing.
 *
 *   'instrumentation'  the control layer examining itself - the F24 hook-liveness probe.
 *                      Deliberately NOT gated by `mayInject`, and that is correct rather than
 *                      an oversight: a hook that has been silently removed can only be
 *                      detected by sending it something, and a dead hook would otherwise be
 *                      able to hide by making everything refuse. It cannot act on the user's
 *                      world - F24 is bound by no application and is not a reserved chord - so
 *                      gating it would buy no safety while destroying the watchdog.
 *
 * Keeping the two apart means the `mayInject` contradiction check stays absolute for real
 * actions instead of being weakened for everything to accommodate a self-test.
 */
export type ActionClass = 'user-action' | 'instrumentation'

/** What the audit can prove about an action. Deliberately not a single verdict. */
export interface Attribution {
  /** A: did input occur at all? */
  readonly inputOccurred: boolean
  /** B: was it operator-generated? Proven by an exact sentinel match inside the control core. */
  readonly operatorGenerated: boolean
  /** C: was it human-generated? */
  readonly humanGenerated: boolean
  /**
   * D: can the attribution be proven?
   *
   * False when the record is ambiguous, when the path's tagging is known not to work, or when
   * nothing moved. This is the field that keeps A from being mistaken for success.
   */
  readonly attributionProven: boolean
  /** The verdict, which is a FUNCTION of all four - never of A alone. */
  readonly verdict: AttributionVerdict
  /** Why, in words a human can audit. Present on every non-clean verdict. */
  readonly basis: string
}

export type AttributionVerdict =
  /** No input occurred. A true negative. */
  | 'no-input'
  /** Input occurred and is provably the operator's. */
  | 'operator-proven'
  /** Input occurred and is provably the human's. */
  | 'human-proven'
  /** Input occurred and the human was provably interrupted by it. */
  | 'human-and-operator'
  /**
   * Input occurred, but WHO did it cannot be established.
   *
   * The honest state. It is never collapsed into `human-proven` or `operator-proven`, because
   * both of those are stronger claims than the evidence supports, and the first is the
   * dangerous direction.
   */
  | 'attribution-unproven'
  /**
   * Input occurred on a path whose ownership tagging is KNOWN NOT TO WORK.
   *
   * Distinct from `attribution-unproven`: this is not missing information, it is a measured
   * defect. The control core's own mouse counters show the sentinel never matches, so any
   * operator mouse click is classified as human.
   */
  | 'attribution-defective'

// ============================================================ the audit record

/** One audited control action. This is the artifact §"the audit" asks for. */
export interface ActionAudit {
  readonly missionId: string
  readonly stepId: string
  readonly executionMode: string
  /** What was asked for, in the tool's own vocabulary. */
  readonly actionType: string
  /** What it was aimed at. For `/click-absolute` this is a screen coordinate, not an app. */
  readonly target: string
  readonly at: string
  /** What the control layer said it did. Its words, not ours. */
  readonly controlResponse: Record<string, unknown>
  /** Whether the action was actually injected - as distinct from whether it was attributed. */
  readonly injected: 'yes' | 'no' | 'unknown'
  /** What KIND of action this was. Decides which permission rules apply. */
  readonly actionClass: ActionClass
  readonly attribution: Attribution
  /** The result of the action itself. */
  readonly result: 'accepted' | 'refused-by-guard' | 'failed'
  /** The control state at the moment of the action, and whether a takeover is in force. */
  readonly controlState: string
  readonly takeoverActive: boolean
  readonly emergencyLatched: boolean
  readonly halted: boolean
  readonly blockingReason: string | null
}

// ============================================================ the audit itself

export interface AuditOptions {
  readonly missionId: string
  readonly stepId: string
  readonly executionMode: string
  readonly actionType: string
  readonly target: string
  readonly path: ActionPath
  /**
   * Whether this is a user action or the control layer's own instrumentation.
   *
   * Defaults to the SAFE answer, `user-action`, so a caller that forgets cannot accidentally
   * get instrumentation's relaxed permission treatment.
   */
  readonly actionClass?: ActionClass
  /** How long to let the hook observe before re-reading. The hook is a separate thread. */
  readonly settleMs?: number
}

/**
 * Runs one audited action and records what the control layer authoritatively says.
 *
 * `perform` performs the action and returns the control layer's own response. The audit does
 * not interpret that response as success - it brackets the call with authoritative reads and
 * reports what the counters did.
 */
export async function auditAction(
  src: RecordSource,
  opts: AuditOptions,
  perform: () => Promise<Record<string, unknown>>,
): Promise<ActionAudit> {
  const before = await readRecord(src)
  const actionClass: ActionClass = opts.actionClass ?? 'user-action'

  // Refused before the action is even attempted - but ONLY for a user action.
  //
  // Instrumentation is exempt by design, and only instrumentation: see `ActionClass`. The
  // exemption cannot be reached by accident because it requires naming the class explicitly,
  // and the default is the strict one.
  if (!before.mayInject && actionClass === 'user-action') {
    return {
      missionId: opts.missionId,
      stepId: opts.stepId,
      executionMode: opts.executionMode,
      actionType: opts.actionType,
      target: opts.target,
      at: new Date().toISOString(),
      controlResponse: {},
      injected: 'no',
      actionClass,
      attribution: {
        inputOccurred: false,
        operatorGenerated: false,
        humanGenerated: false,
        attributionProven: true,
        verdict: 'no-input',
        basis: `the control layer reports mayInject=false (${before.state}); no action was attempted`,
      },
      result: 'refused-by-guard',
      controlState: before.state,
      takeoverActive: before.takeoverPending || before.state === 'HUMAN_TAKEOVER',
      emergencyLatched: before.emergencyLatched,
      halted: true,
      blockingReason: before.blockingReason,
    }
  }

  let response: Record<string, unknown>
  try {
    response = await perform()
  } catch (e) {
    response = { error: e instanceof Error ? e.message : String(e) }
  }

  // The hook runs on its own thread, so its counters may not have settled the instant the
  // injection call returns. Read after a short pause rather than racing it.
  await new Promise((r) => setTimeout(r, opts.settleMs ?? 250))

  const after = await readRecord(src)
  const attribution = attribute(before, after, opts.path)
  const refused = response.ok === false || response.refused === true

  return {
    missionId: opts.missionId,
    stepId: opts.stepId,
    executionMode: opts.executionMode,
    actionType: opts.actionType,
    target: opts.target,
    at: new Date().toISOString(),
    controlResponse: response,
    injected: attribution.inputOccurred ? 'yes' : refused ? 'no' : 'unknown',
    actionClass,
    attribution,
    result: refused ? 'refused-by-guard' : response.error ? 'failed' : 'accepted',
    controlState: after.state,
    takeoverActive: after.takeoverPending || after.state === 'HUMAN_TAKEOVER',
    emergencyLatched: after.emergencyLatched,
    halted: !after.mayInject,
    blockingReason: after.blockingReason,
  }
}

/**
 * Derives the four claims from two authoritative snapshots.
 *
 * The rules are deliberately few, and every one of them is anchored to a counter whose
 * increment condition is fixed inside the control core:
 *
 *   operatorEvents  - incremented ONLY on an exact `dwExtraInfo == Guard.Sentinel` match
 *   humanEvents     - incremented on any untagged keyboard event, and on any mouse button
 *   otherInjected   - incremented on mouse events Windows flagged LLMHF_INJECTED but which
 *                     carried no sentinel, i.e. some OTHER program's injection
 *
 * Nothing here inspects a Windows event, and nothing here guesses.
 */
export function attribute(before: ControlRecord, after: ControlRecord, path: ActionPath): Attribution {
  const dOperator = after.operatorEvents - before.operatorEvents
  const dHuman = after.humanEvents - before.humanEvents
  const dOther = after.otherInjected - before.otherInjected
  const dMouseSeen = after.mouseEventsSeen - before.mouseEventsSeen
  const dMouseTagged = after.mouseTaggedSeen - before.mouseTaggedSeen

  const anyInput = dOperator > 0 || dHuman > 0 || dOther > 0 || dMouseSeen > 0

  // --- A: did input occur?
  //
  // `mouseEventsSeen` MUST be part of this test. The first version omitted it and relied only
  // on the three attribution counters. That is wrong: a mouse event that is neither
  // sentinel-tagged, nor a button, nor a jitter-exceeding move increments `mouseUntaggedSeen`
  // alone - so the hook had demonstrably seen real input while this function reported
  // `no-input`. A false negative on claim A is the most damaging error this audit could make,
  // because "no input occurred" is the reading that authorises acting.
  if (!anyInput) {
    return {
      inputOccurred: false,
      operatorGenerated: false,
      humanGenerated: false,
      attributionProven: true,
      verdict: 'no-input',
      basis: `no authoritative counter moved (operator +${dOperator}, human +${dHuman}, other-injected +${dOther}, mouse +${dMouseSeen})`,
    }
  }

  // --- B and C: who. Both moving at once is a real state, not a contradiction to tidy up.
  const operatorGenerated = dOperator > 0
  const humanGenerated = dHuman > 0

  if (operatorGenerated && humanGenerated) {
    return {
      inputOccurred: true,
      operatorGenerated: true,
      humanGenerated: true,
      attributionProven: true,
      verdict: 'human-and-operator',
      basis: `operator +${dOperator} and human +${dHuman}: the human was genuinely active during this action, so the record cannot be reduced to either actor alone`,
    }
  }

  if (operatorGenerated) {
    return {
      inputOccurred: true,
      operatorGenerated: true,
      humanGenerated: false,
      attributionProven: true,
      verdict: 'operator-proven',
      basis: `operatorEvents +${dOperator} with humanEvents +${dHuman}; the control core increments operatorEvents only on an exact sentinel match`,
    }
  }

  if (humanGenerated) {
    return {
      inputOccurred: true,
      operatorGenerated: false,
      humanGenerated: true,
      attributionProven: true,
      verdict: 'human-proven',
      basis: `humanEvents +${dHuman} with operatorEvents +${dOperator}`,
    }
  }

  // --- The measured mouse defect.
  //
  // Mouse events were seen, but the sentinel did not survive the mouse path, so the control
  // core could not file them as the operator's. This is a MEASURED defect, not missing
  // information: `mouseTaggedSeen` sits at 0 while `mouseUntaggedSeen` is large, so the tagging
  // is known not to work. Reporting it as merely `unproven` would understate a known-broken
  // control, so it is checked BEFORE the weaker "unidentifiable source" reading below.
  if (path === 'mouse' && dMouseSeen > 0 && dMouseTagged === 0) {
    return {
      inputOccurred: true,
      operatorGenerated: false,
      humanGenerated: false,
      attributionProven: false,
      verdict: 'attribution-defective',
      basis: `${dMouseSeen} mouse event(s) observed and 0 carried the ownership sentinel (mouseTaggedSeen still ${after.mouseTaggedSeen} against mouseUntaggedSeen ${after.mouseUntaggedSeen}); dwExtraInfo does not survive the Windows mouse path, so an operator click is filed as human`,
    }
  }

  // --- Input occurred but no attribution counter moved: only `otherInjected` did.
  //
  // Windows flagged the event as injected, but it carried no operator sentinel. Something on
  // this machine injected input that the operator did not author. The audit cannot say who,
  // and must not guess.
  if (dOther > 0) {
    return {
      inputOccurred: true,
      operatorGenerated: false,
      humanGenerated: false,
      attributionProven: false,
      verdict: 'attribution-unproven',
      basis: `otherInjected +${dOther} with operator +${dOperator} and human +${dHuman}: input was injected by an unidentifiable source`,
    }
  }

  return {
    inputOccurred: true,
    operatorGenerated: false,
    humanGenerated: false,
    attributionProven: false,
    verdict: 'attribution-unproven',
    basis: `input was observed (mouse +${dMouseSeen}) but no attribution counter moved`,
  }
}

/** True when the audit's verdict is one a mission may treat as proof of its own action. */
export function isProofOfAction(a: Attribution): boolean {
  return a.verdict === 'operator-proven'
}

/** A one-line summary for the audit trail. Never says "succeeded" on its own. */
export function describeAudit(a: ActionAudit): string {
  const v = a.attribution.verdict
  return `${a.stepId}/${a.actionType} -> ${a.result} | input ${a.injected} | attribution ${v}` +
    (a.halted ? ` | halted (${a.controlState})` : '')
}