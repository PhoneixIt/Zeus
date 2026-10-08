/**
 * TYPES FOR `operator-client.mjs`.
 *
 * =============================================================================
 * WHY THIS FILE EXISTS
 * =============================================================================
 *
 * `operator-client.mjs` is the ONLY way the TypeScript side reaches the control core, and it had no
 * declaration file. Three live harnesses imported it and every one of them was implicitly `any`.
 *
 * That is not a cosmetic gap. `live-control.ts` builds `ControlSurface` on top of this client, and a
 * client typed as `any` means every call through it typechecks against nothing - `cl.guard()` could
 * return a number, and the code assigning it to a `GuardState` would still compile. The boundary
 * between the mission engine and the control core was, to the compiler, entirely untyped.
 *
 * These declarations are deliberately LOOSE on the response shapes. The host's payloads are the
 * authoritative record - see the proofs - and inventing precise types for them here would be claiming
 * knowledge this file does not have. What IS typed exactly is what the code actually depends on:
 *
 *   - the method NAMES, so a renamed or deleted route is a compile error rather than a runtime
 *     `undefined is not a function`;
 *   - the ARITY of each method, which is what caught the `verifies` bugs elsewhere in this project;
 *   - the `raw` escape hatch's return shape, because callers rely on being able to SEE a refusal
 *     (`{ ok: false, refused: ... }`) rather than having it thrown away - proving that `/release`
 *     refuses is impossible through a helper that throws on refusal.
 *
 * A route typed as returning `Promise<Record<string, unknown>>` says "the host decides what is in
 * here". That is true, and it is the most this file can honestly claim.
 */

/** What the host writes into host.json. */
export interface HostState {
  readonly port: number
  readonly token?: string
  readonly [key: string]: unknown
}

/**
 * A target the host can act on. Window identity plus coordinates or a control name.
 *
 * Loose on purpose: the host validates these and refuses what it will not accept, which is the whole
 * point of the boundary. A strict type here would duplicate that validation and then have to be kept
 * in step with it.
 */
export interface Target {
  readonly hwnd?: number
  readonly title?: string
  readonly x?: number
  readonly y?: number
  readonly name?: string
  readonly [key: string]: unknown
}

export interface Region {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/** The result of a refused call, as the host sent it. */
export interface Refusal {
  readonly ok: false
  readonly refused: string
  readonly error?: string
}

/**
 * The client.
 *
 * Every host response is `Promise<HostPayload>` unless noted. The three that differ are `screen`
 * (returns a Buffer, or a write receipt when given a path), `raw` (returns the transport-level status
 * and body so refusals stay observable), and `findWindow`/`controlByName` (which throw on no match and
 * on AMBIGUOUS match rather than guessing - refusing to pick is a requirement, not a failure mode).
 */
export interface OperatorClient {
  readonly state: HostState

  readonly ping: () => Promise<HostPayload>
  readonly windows: () => Promise<HostPayload>
  readonly tree: (a: { hwnd: number; depth?: number }) => Promise<HostPayload>

  readonly uiasurvey: (target: Target) => Promise<HostPayload>
  readonly uiafind: (target: Target) => Promise<HostPayload>
  readonly uiainvoke: (target: Target) => Promise<HostPayload>
  readonly uiasetvalue: (target: Target) => Promise<HostPayload>
  readonly uiaread: (target: Target) => Promise<HostPayload>
  readonly uiafocus: (target: Target) => Promise<HostPayload>
  readonly uiselected: (target: Target) => Promise<HostPayload>
  readonly vstype: (target: Target) => Promise<HostPayload>

  /** A PNG buffer, or `{ path, bytes }` when a destination was given. */
  readonly screen: (destPath?: string, region?: Region) => Promise<Buffer | { path: string; bytes: number }>

  readonly focus: (target: Target) => Promise<HostPayload>
  readonly restore: (target: Target) => Promise<HostPayload>
  readonly show: (target: Target) => Promise<HostPayload>
  readonly guard: () => Promise<HostPayload>
  readonly indicator: () => Promise<HostPayload>
  readonly display: () => Promise<HostPayload>
  readonly panelgrid: () => Promise<HostPayload>
  readonly pixel: (x: number, y: number) => Promise<HostPayload>

  readonly arm: () => Promise<HostPayload>
  readonly observe: () => Promise<HostPayload>
  readonly pause: () => Promise<HostPayload>
  readonly release: () => Promise<HostPayload>
  readonly emergencyStop: () => Promise<HostPayload>
  readonly rearm: () => Promise<HostPayload>
  readonly drain: () => Promise<HostPayload>
  readonly shutdown: () => Promise<HostPayload>

  /**
   * The escape hatch, and the only way to reach a route whose SUCCESS is not expected.
   *
   * Typed to return the transport status and body rather than to throw, because a refusal has to be
   * observable to be testable. A helper that threw on `{ ok: false, refused }` would make "prove
   * that /release refuses" impossible to express.
   */
  readonly raw: (path: string, opts?: { method?: string; body?: Record<string, unknown> }) =>
    Promise<{ status: number; body: HostPayload }>

  readonly move: (target: Target) => Promise<HostPayload>
  readonly click: (target: Target) => Promise<HostPayload>
  readonly type: (target: Target) => Promise<HostPayload>
  readonly key: (target: Target) => Promise<HostPayload>
  readonly scroll: (target: Target) => Promise<HostPayload>
  readonly scanInput: (target: Target) => Promise<HostPayload>
  readonly wmChar: (target: Target) => Promise<HostPayload>
  readonly integrity: (pid: number) => Promise<HostPayload>
  readonly guiFocus: (hwnd: number) => Promise<HostPayload>

  /** Resolves a unique window by title substring, or THROWS. Ambiguous is an error, not a pick. */
  readonly findWindow: (
    titleFragment: string,
    opts?: { requireForeground?: boolean },
  ) => Promise<WindowInfo>

  /** Centre point of a uniquely-named control, or THROWS. */
  readonly controlByName: (hwnd: number, nameFragment: string) => Promise<ControlInfo>
}

export interface WindowInfo {
  readonly hwnd: number
  readonly title: string
  readonly foreground: boolean
  readonly visible?: boolean
  readonly [key: string]: unknown
}

export interface ControlInfo {
  readonly name: string
  readonly rect?: { readonly left: number; readonly top: number; readonly width: number; readonly height: number }
  readonly [key: string]: unknown
}

/**
 * What the host returns, when the host decides.
 *
 * Deliberately not modelled field by field. The control core's payloads are established by its proofs
 * rather than by this file, and a type that guessed at them would be a second, silent source of truth
 * about what the host sends - the same failure as `ModelRequest` describing a protocol that had
 * already changed.
 */
export type HostPayload = Record<string, unknown>

/**
 * Connect to a running operator host.
 *
 * THROWS if the host is not running, naming the state file it looked for. That is the honest failure:
 * "no host" is not an empty result, and code that treats it as one would silently observe nothing
 * while believing it had observed everything.
 */
export declare function connect(opts?: { statePath?: string }): Promise<OperatorClient>