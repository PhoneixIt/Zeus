/**
 * The governance contract.
 *
 * Section 35: the governance layer must be "enforceable independently of the AI's intentions".
 * That means the AI never holds a capability the guard would not grant it. The AI can only
 * ASK. Whether input actually happens is decided here, in the host, from observations about
 * the machine - not from anything the caller asserts.
 *
 * Every field below is something the CONTROL CORE observed. Nothing here is a request.
 *
 * WHY A CONTRACT AND NOT A SERVICE CALL
 *
 * A caller that can construct its own "permission" object has already broken the model. The
 * permission is not passed in; it is returned. A caller cannot assert that input is safe -
 * it can only be told.
 */

export type ControlState =
  | 'OBSERVING'
  | 'ARMED'
  | 'WORKING'
  | 'PAUSED'
  | 'RESUMING'
  | 'HUMAN_TAKEOVER'
  | 'EMERGENCY_STOP'

/**
 * EFFECTIVE INPUT PERMISSION - separate from control state, and deliberately so.
 *
 * A real observed condition had `state: ARMED` alongside `mayInject: false`, because a
 * human takeover blocks input without yet changing the control mode. Nothing was wrong with
 * either value; the representation was. Reporting them as one field is how a human reads a
 * green "ARMED" while input is actually blocked.
 */
export type InputPermission = 'PERMITTED' | 'BLOCKED'

export interface Permission {
  /** The control mode. Says which mode the operator is in. Not sufficient to predict input. */
  readonly control: ControlState
  /** The enforcement result. This - not `control` - decides whether input happens. */
  readonly input: InputPermission
  /** Why input is blocked. Non-null exactly when `input` is BLOCKED. */
  readonly blockedBy: string | null
  /**
   * True when the operator's control infrastructure cannot be trusted - hook missing,
   * removed, or not answering its liveness probe.
   *
   * When true the operator injects nothing at all. An operator whose chords and clicks
   * reach the human's desktop is worse than one that does nothing, because the human is
   * relying on the emergency stop working.
   */
  readonly infrastructureHealthy: boolean
}

export interface TargetIdentity {
  readonly hwnd: number
  readonly pid: number
  readonly expectedTitle: string
}

export interface TargetVerification {
  readonly ok: boolean
  readonly reason: string
  readonly hwnd: number
  readonly pid: number
  readonly title: string
  readonly visible: boolean
  readonly foreground: boolean
}

/**
 * The result of an input action.
 *
 * `delivered` is deliberately distinct from `attempted`. An action can be attempted and
 * refused - that is the safe path, and the distinction is what lets a caller tell "I typed
 * it" from "it was typed".
 */
export interface InputResult {
  readonly attempted: boolean
  readonly delivered: boolean
  readonly refusedBy: string | null
  readonly verified?: TargetVerification
}

/**
 * THE CONTRACT THE AI MUST SATISFY.
 *
 * Every computer-control capability in this system goes through exactly this interface.
 * No other route to input exists. That is the property that makes the governance layer
 * enforceable: there is no second path to bypass.
 */
export interface ControlSurface {
  /** Observation only. Cannot inject anything, ever. */
  observe(): Promise<Observation>
  captureScreen(region?: ScreenRegion): Promise<Buffer>
  verifyTarget(t: TargetIdentity): Promise<TargetVerification>

  move(t: TargetIdentity, x: number, y: number): Promise<InputResult>
  click(t: TargetIdentity, x: number, y: number, button?: 'left' | 'right'): Promise<InputResult>
  doubleClick(t: TargetIdentity, x: number, y: number): Promise<InputResult>
  drag(t: TargetIdentity, from: Point, to: Point): Promise<InputResult>
  scroll(t: TargetIdentity, x: number, y: number, notches: number): Promise<InputResult>
  type(t: TargetIdentity, text: string): Promise<InputResult>
  pressKey(t: TargetIdentity, vk: string, modifiers?: string[]): Promise<InputResult>

  // NOT HERE, DELIBERATELY.
  //
  // This interface used to require `permission(): Promise<Permission>`. Nothing ever called it - the
  // executor reads permission from its own configuration (`cfg.permission()`), never from the surface
  // it is about to drive - so it was pure cost: every implementer had to supply a method the design
  // forbids.
  //
  // And it was not merely dead. A permission query ON THE CONTROL SURFACE is precisely the wrong
  // shape: it invites a caller to ask a surface whether input is safe, which makes the surface both
  // the thing being governed and the thing vouching for the governance. The comment above
  // `livePermission` says so in as many words - "asking the CONTROL SURFACE for permission would let
  // a caller ask a surface to bless itself" - and the interface contradicted it.
  //
  // Removing it takes an unsafe affordance away. It grants nothing.
}

export interface Point { x: number; y: number }
export interface ScreenRegion { x: number; y: number; w: number; h: number }

export interface Observation {
  readonly screen: { width: number; height: number; session: number }
  readonly windows: readonly WindowInfo[]
  readonly foreground: WindowInfo | null
  readonly permission: Permission
  /** Set when the operator's own infrastructure is degraded. */
  readonly warnings: readonly string[]
}

export interface WindowInfo {
  readonly hwnd: number
  readonly pid: number
  readonly title: string
  readonly visible: boolean
  readonly rect: { x: number; y: number; w: number; h: number }
}

/**
 * Fail-closed is the DEFAULT, and there is no option to turn it off.
 *
 * A caller that cannot confidently identify its target gets a refusal, never a guess. A
 * guess here is indistinguishable, after the fact, from having typed into the wrong window -
 * and the damage may not be visible until much later.
 */
export const FAIL_CLOSED = true as const