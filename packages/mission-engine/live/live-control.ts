/**
 * Is the operator host reachable RIGHT NOW?
 *
 * A harness needs this before it can decide why a mission failed. `observe-desktop` depends on the
 * host, so when the host is absent the prerequisite step fails, everything downstream is skipped,
 * and a harness that then asserts on step 2 throws a `TypeError` on a step that never ran - which
 * reads as an implementation failure and hides the real cause.
 *
 * Probed through `livePermission()`, the same connection path the missions use, so a host that
 * answers the guard but not the mission would not be reported as reachable. It returns a result
 * rather than throwing, because a probe that throws is a probe that has to be wrapped again by every
 * caller.
 *
 * Deliberately NOT a cached singleton: the answer must be taken when the harness asks, not when the
 * module was first loaded.
 */
export async function hostAvailability(): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const p = await livePermission()
    // With `livePermission` no longer throwing on a dead host, the VALUE is now the answer to
    // "is the host there?" - the catch below is defense-in-depth only. Reporting ok on an
    // unhealthy consult would invert this probe's whole purpose.
    if (!p.infrastructureHealthy) return { ok: false, reason: p.blockedBy ?? 'the operator host is not answering' }
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * Report a missing prerequisite and stop, WITHOUT evaluating any check.
 *
 * Exit code 2, matching the harnesses' existing "not a check failure" code (REFUSED, HARNESS
 * ERROR): 0 means every check passed, 1 means a check failed, 2 means no check was ever evaluated.
 * A missing prerequisite is the third case, and giving it its own code is what keeps it from being
 * read as either of the others.
 *
 * THE SAFETY PROPERTY: this runs before any assertion is computed, and only when the host probe
 * failed. It can therefore turn a *connection failure* into a blocked result, and it can never turn
 * a *failed assertion* into one - a check that fails still reaches `process.exit(1)` through the
 * harness's own tally, because this function has already returned by then.
 */
export function blockOnHost(avail: { ok: true } | { ok: false; reason: string }): void {
  if (avail.ok) return
  console.log('')
  console.log('=== HOST-BLOCKED ===')
  console.log('  the operator host is not reachable, so the real-machine step cannot run.')
  console.log(`  reason : ${avail.reason}`)
  console.log('  remedy : start it with scripts/start-operator-host.mjs')
  console.log('  no check was evaluated - a prerequisite is missing, not a control failing.')
  process.exit(2)
}

/**
 * The real control surface, spoken to over the actual host.
 *
 * The fake in `fakes.ts` proves the executor's LOGIC. This proves the executor can drive a
 * real Windows desktop observation through the actual governed boundary.
 *
 * It is OBSERVATION ONLY. Nothing here can inject: `ControlSurface`'s input methods are
 * implemented by delegating to the host, and the host's own guard decides independently whether
 * to permit anything. This module never calls them, and the fake-input assertions in the test
 * suite confirm the executor does not either.
 *
 * The point is to close the loop the fake cannot: mission executor -> real ControlSurface ->
 * real Windows host -> real evidence -> real completion.
 */

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { connect } from '../../control-core/operator-client.mjs'
import type {
  ControlSurface, Observation, Permission, Point,
  TargetIdentity, TargetVerification, InputResult,
} from '../../governance/contract.ts'
import type { Tool, ToolContext, ToolResult } from '../executor.ts'
import type { Evidence } from '../state.ts'

// Resolved from THIS FILE's own location. The previous literal was
// 'C:/Users/Samer/Projects/AIOS/packages/control-core/host.json' - an absolute path with the user's
// name and a hand-typed repository casing in it. It happened to resolve on this machine, which is
// exactly what made it dangerous: the same class of bug that start-operator-host.mjs:234-236 records
// in a comment, where a hand-written relative walk resolved to %LOCALAPPDATA%\Projects\AIOS instead
// of the real repository and left the agent reading stale host state. A path that is correct on the
// machine that wrote it and wrong everywhere else cannot be reasoned about.
const DEFAULT_HOST_STATE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'control-core', 'host.json')

/**
 * Which host state file to read, decided at CALL time rather than at module load.
 *
 * The default is unchanged - the mirror at packages/control-core/host.json. The override exists
 * so a test can point the live path at a deterministic dead port (or a fixture host) WITHOUT
 * touching the real state file, which is live machine state the running system depends on.
 * Same principle as operator-client's PORTAI_OPERATOR_DIR: a seam for the PATH, never for the
 * SEMANTICS - whatever file this names, a permission consult still means exactly what it says.
 */
function hostStatePath(): string {
  const override = process.env.AIOS_OPERATOR_STATE
  return override && override.length > 0 ? override : DEFAULT_HOST_STATE
}

interface Client {
  guard(): Promise<Record<string, unknown>>
  raw(path: string, opts?: { method?: string; body?: Record<string, unknown> }): Promise<{ status: number; body: Record<string, unknown> }>
  /** Read text off the screen with the Windows OCR engine. See liveControl.ocr. */
  ocr(region?: { x?: number; y?: number; w?: number; h?: number }): Promise<{
    ok: boolean
    language?: string
    text?: string
    lines: Array<{ text: string; x: number; y: number; w: number; h: number }>
    error?: string
  }>
  windows(): Promise<unknown>
  uiasurvey(t: { hwnd: number; max?: number }): Promise<unknown>
  uiaread(t: { hwnd: number; name?: string; max?: number }): Promise<unknown>
  screenshot: unknown
  focus(t: unknown): Promise<unknown>
  controlByName(t: unknown): Promise<unknown>
}

// THE HOST CAN BE REPLACED WHILE THIS PROCESS IS ALIVE.
//
// This is the whole `fetch failed` incident, and the reason it survived every earlier attempt to
// explain it. The host picks a port, writes it to its state file, and is re-launched - on a restart,
// under a new pid and usually a new port. Anything holding a client built from the OLD state file
// is holding the address of a process that no longer exists.
//
// Measured, not assumed, on this machine:
//   chat server  pid 19580  started 2026-10-18 20:48:04  and cached the then-current host address
//   operator host pid 18024 started 2026-10-18 21:56:39  on the port now in host.json
//   mission 1bf33c09 "oepn nakivo folder and scan all files inside" at 03:45:26 -> `fetch failed`
//
// The planner had already succeeded (job-mvej944y, createdAt === completedAt, exitCode 0), so the
// failure was in EXECUTION, on the first step that needed the host - and the bare string
// `fetch failed` is Node's undici message for "connection refused", which is what a request to a
// dead port returns. The launcher had mirrored the state file correctly since an earlier fix, so
// the FILE was right and the IN-MEMORY client was not. Fixing the file cannot fix that; only
// re-reading it can.
//
// So the cache is keyed on the host's IDENTITY rather than on mere existence. A client is reused
// only while host.json still describes the same host; when the host moves, the client is rebuilt.
// This is the same principle `hostAvailability` above already states in prose - "the answer must be
// taken when the harness asks, not when the module was first loaded" - which the singleton silently
// contradicted.
//
// Re-reading a ~100 byte file per call is not the cost that matters here. A mission whose every
// GUI step fails with `fetch failed` until someone notices is far more expensive.
let client: Client | null = null
let clientIdentity: string | null = null

/** The identity of the host currently described by the state file. */
function hostIdentity(): string | null {
  try {
    const path = hostStatePath()
    if (!existsSync(path)) return null
    const s = JSON.parse(readFileSync(path, 'utf8')) as { port?: unknown; pid?: unknown }
    const port = typeof s.port === 'number' ? s.port : String(s.port)
    const pid = typeof s.pid === 'number' ? s.pid : String(s.pid)
    return `${String(pid)}@${port}`
  } catch {
    // An unreadable or malformed state file must not be reported as a distinct host, or a
    // transient read error would silently invalidate a working client. `connect()` raises the real
    // error on the call that actually needs the host.
    return clientIdentity
  }
}

async function c(): Promise<Client> {
  const id = hostIdentity()
  if (!client || clientIdentity !== id) {
    client = (await connect({ statePath: hostStatePath() })) as unknown as Client
    clientIdentity = id
  }
  return client
}

// ============================================================ UI AUTOMATION (uia mode)

/**
 * One element of the accessibility tree, as the host reports it.
 *
 * This is the `uia` execution mode's observation surface. It is a genuinely DIFFERENT
 * mechanism from the `cli` mode: `cli` polls the host's HTTP guard/window endpoints, while
 * `uia` walks the Windows accessibility tree through IUIAutomation COM. Renaming `cli` to
 * `uia` would prove nothing about mode handling, so the second mode travels a real,
 * structurally different code path.
 */
export interface UiaElement {
  index: number
  name: string
  /**
   * The CONTENT of the control, read through its Value/Text pattern.
   *
   * `name` is the accessible label and `text` is what the control holds; Notepad's editor is
   * named "Text editor" both empty and full, so only this field can answer "did my text land".
   * Empty string when the control exposes neither pattern.
   */
  text: string
  automationId: string
  className: string
  controlType: string
  rect: { x: number; y: number; w: number; h: number }
  offscreen: boolean
  enabled: boolean
  isSelected: boolean
  patterns: string[]
}

/**
 * Completes a human handover: moves the guard from RESUMING to ARMED, and only ever that.
 *
 * `Guard.Release` sets RESUMING, and `Guard.MayInject` permits injection only in ARMED or
 * WORKING. RESUMING therefore refuses injection by name, and nothing in the release path
 * advanced it - so a human clicking RELEASE and walking away produced a permanently blocked
 * machine. That is the whole reason desktop control never worked in this project, across dozens
 * of accepted releases.
 *
 * `/arm` is the host's own operator endpoint, the same one the Ctrl+Alt+O chord calls.
 * `Guard.Arm` is `Set(ARMED, detail)` and deliberately does NOT clear `takeoverPending`, so this
 * is not a bypass and must not be treated as one:
 *
 *   - it is called only when the state is already RESUMING, which is set by exactly one thing:
 *     the human's own release click or the Ctrl+Alt+G chord. AIOS cannot reach this state alone.
 *   - if a human is present then `takeoverPending` is true, arming changes only the label, and
 *     injection stays refused. Verified against the live guard, not assumed.
 *   - any later human input re-latches `takeoverPending` immediately and the host refuses.
 *
 * @returns true if this call performed the transition.
 */
export async function armOperator(): Promise<{ armed: boolean; detail: string }> {
  try {
    const g = (await (await c()).guard()) as { state?: string; takeoverPending?: boolean; emergencyLatched?: boolean }
    if (g.state !== 'RESUMING') return { armed: false, detail: `state is ${g.state}, not RESUMING` }
    if (g.takeoverPending !== false) return { armed: false, detail: 'a human takeover is pending, so arming would change nothing' }
    if (g.emergencyLatched === true) return { armed: false, detail: 'an emergency stop is latched; an explicit re-arm is required' }
    const r = await (await c()).raw('/arm', { method: 'POST', body: {} })
    return { armed: r.body.ok !== false, detail: 'armed after a human release' }
  } catch (e) {
    return { armed: false, detail: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * Reads the accessibility tree for a window.
 *
 * READ-ONLY BY CONSTRUCTION: it calls `/uiasurvey`, which enumerates elements and returns
 * them. The write-capable siblings - `/uiainvoke`, `/uiafocus`, `/uiasetvalue` - are
 * deliberately NOT referenced anywhere in this module, so a `uia` step cannot inject.
 */
export async function surveyWindow(hwnd: number, max = 200): Promise<UiaElement[]> {
  const r = (await (await c()).uiasurvey({ hwnd, max })) as unknown
  const raw = Array.isArray(r) ? r : (r as { elements?: unknown[] })?.elements
  return Array.isArray(raw) ? (raw as UiaElement[]) : []
}

/** Picks the window a mission should inspect: the first visible one with a real title. */
export async function pickInspectableWindow(): Promise<{ hwnd: number; title: string } | null> {
  const o = await liveControl.observe()
  const w = o.windows.find((x) => x.visible && x.hwnd > 0 && x.title.trim().length > 0)
  return w ? { hwnd: w.hwnd, title: w.title } : null
}

/**
 * How long the permission consult waits for the host's guard read before declaring the host
 * unhealthy.
 *
 * A dead port refuses instantly, but a host that accepted the connection and then stopped
 * answering (hung process, stalled event loop) would otherwise hold the consult open for undici's
 * own 300s ceiling - and every caller of `livePermission()` awaits this before deciding whether
 * the machine may be touched. Five seconds is far longer than a healthy host needs (its /guard is
 * an in-memory read) and far shorter than a person should wait to be told the truth. The timer
 * only abandons the WAIT; the consult then reports the host as unhealthy and nothing proceeds on
 * an answer that never arrived.
 */
const GUARD_READ_TIMEOUT_MS = 5_000

/**
 * THE FAIL-CLOSED ANSWER when the host cannot be consulted at all.
 *
 * Every field that would claim an OBSERVATION (control mode, takeover, emergency latch, last
 * input) is deliberately absent or constructed: a host that answered nothing cannot be reported
 * as ARMED or EMERGENCY_STOP, and inventing either is the exact misdescription this contract
 * exists to prevent. `input: BLOCKED` makes even callers that ignore `infrastructureHealthy` fail
 * closed, and `blockedBy` names the infrastructure loss rather than a guard refusal, so the
 * refusal a person reads points at the right remedy.
 */
function hostUnavailablePermission(detail: string): Permission {
  return {
    // CONSTRUCTED, not observed. 'PAUSED' is the nearest honest state - not operating - and it
    // is stated here rather than guessed from a host that answered nothing.
    control: 'PAUSED',
    input: 'BLOCKED',
    blockedBy: `OPERATOR_HOST_UNREACHABLE: ${detail}`,
    infrastructureHealthy: false,
  }
}

async function permission(): Promise<Permission> {
  // THE WHOLE CONSULT IS THE CONTAINMENT BOUNDARY. `guard()` is a network call to another
  // process; when that process is gone, undici throws `fetch failed` and nothing above this
  // line can tell a dead host from a dead program. Measured on 2026-10-22: `livePermission()`
  // threw at the planning/execution boundary and inside the executor's per-step consult,
  // unwinding runs that had ALREADY acted on the machine (mission a0f3190b typed for 4.7
  // minutes mid-request) and leaving the durable ledger claiming they were still running.
  //
  // So a transport failure is no longer an exception, it is a VALUE: infrastructureHealthy
  // false, input BLOCKED. Callers that check the value fail closed; callers that only read
  // `input` fail closed too, because the value says BLOCKED.
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const guard = (await c()).guard()
    const g = await Promise.race([
      guard,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() =>
          reject(new Error(`the host did not answer the guard read within ${GUARD_READ_TIMEOUT_MS}ms`)),
          GUARD_READ_TIMEOUT_MS)
      }),
    ])
    return {
      control: g.state as Permission['control'],
      input: g.mayInject ? 'PERMITTED' : 'BLOCKED',
      blockedBy: (g.blockingReason as string | null) ?? null,
      infrastructureHealthy: true,
      lastTakeoverAt: g.lastTakeoverAt as number | undefined,
      takeoverPending: g.takeoverPending as boolean | undefined,
      emergencyLatched: g.emergencyLatched as boolean | undefined,
    }
  } catch (e) {
    // A timeout is named as a timeout (the raced rejection carries it), not laundered into a
    // generic failure: "did not answer" and "is not there" are different diagnoses with
    // different remedies, and the person reading the refusal needs the one that happened.
    return hostUnavailablePermission(e instanceof Error ? e.message : String(e))
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Current permission, read straight from the host.
 *
 * Not part of ControlSurface, so it is a named export rather than a method. The executor
 * takes it through ExecutorConfig precisely because asking the CONTROL SURFACE for
 * permission would let a caller ask a surface to bless itself.
 */
export async function livePermission(): Promise<Permission> {
  return permission()
}

export const liveControl: ControlSurface = {
  // Declared on ControlSurface and implemented here rather than left to each caller.
  //
  // `raw` was part of the interface from the start and had no implementation, so any capability
  // that reached for it died with "liveControl.raw is not a function" at run time. Nothing
  // caught it because TypeScript only checks the shape of the object literal against the
  // interface - and the object literal satisfied it, since an interface member that is
  // satisfied by `as ControlSurface` or by an omitted-but-cast value is not the same thing as
  // an implemented method. The first mission to call it did so in front of the user.
  //
  // It is here so a capability needing a host route the typed surface does not model yet can
  // still go through the SAME authenticated client, rather than opening a second connection
  // that would need its own token and its own port lookup.
  async raw(path: string, opts?: { method?: string; body?: Record<string, unknown> }) {
    const cl = await c()
    return opts
      ? cl.raw(path, { method: opts.method ?? 'POST', body: opts.body })
      : cl.raw(path)
  },

  /**
   * Read the text that is ON the screen, including text no control exposes.
   *
   * This goes to the host's `/ocr`, which uses the Windows OCR engine built into Windows. It is
   * the answer for applications that draw their interface as pixels - a game, a canvas, a chart,
   * a scanned image, a remote desktop - where the accessibility tree is empty or lies.
   *
   * It is deliberately NOT guarded. Reading the screen changes nothing and injects nothing, and
   * requiring permission would make it useless exactly when a human is at the machine, which is
   * when knowing what is on screen matters most.
   */
  async ocr(region?: { x?: number; y?: number; w?: number; h?: number }): Promise<{
    ok: boolean
    language?: string
    text?: string
    lines: Array<{ text: string; x: number; y: number; w: number; h: number }>
    error?: string
  }> {
    const q = new URLSearchParams()
    if (region?.x !== undefined) q.set('x', String(region.x))
    if (region?.y !== undefined) q.set('y', String(region.y))
    if (region?.w !== undefined) q.set('w', String(region.w))
    if (region?.h !== undefined) q.set('h', String(region.h))
    const r = await (await c()).raw(`/ocr?${q.toString()}`)
    const b = r.body as {
      ok?: boolean
      language?: string
      text?: string
      lines?: Array<{ text: string; x: number; y: number; w: number; h: number }>
      error?: string
    }
    return {
      ok: b.ok === true,
      language: b.language,
      text: b.text,
      lines: Array.isArray(b.lines) ? b.lines : [],
      error: b.error,
    }
  },

  async observe(): Promise<Observation> {
    const cl = await c()
    const [g, wins] = await Promise.all([cl.guard(), cl.windows().catch(() => ({ windows: [] }))])
    // The host returns `{ ok, windows }`, NOT a bare array. An earlier version assumed an
    // array, found `Array.isArray === false`, and silently produced an EMPTY window list -
    // while the host was reporting 8 windows.
    //
    // That is the most dangerous shape of bug in this system: an observation that reports
    // nothing looks exactly like a desktop with nothing open, and a mission would conclude
    // "nothing to do" and complete. The independent verifier caught it, which is precisely
    // what it is for - the tool's zero disagreed with an independent observation's eight.
    const raw = wins as unknown
    const list = (Array.isArray(raw)
      ? raw
      : Array.isArray((raw as { windows?: unknown[] })?.windows)
        ? (raw as { windows: unknown[] }).windows
        : []) as Array<{
      hwnd?: number; pid?: number; title?: string; visible?: boolean
      x?: number; y?: number; width?: number; height?: number
    }>
    const windows = list.map((w) => ({
      hwnd: Number(w.hwnd ?? 0),
      pid: Number(w.pid ?? 0),
      title: String(w.title ?? ''),
      visible: w.visible !== false,
      rect: { x: Number(w.x ?? 0), y: Number(w.y ?? 0), w: Number(w.width ?? 0), h: Number(w.height ?? 0) },
    }))
    return {
      screen: { width: 1536, height: 864, session: 1 },
      windows,
      foreground: windows[0] ?? null,
      permission: await permission(),
      warnings: [],
    }
  },

  async captureScreen(): Promise<Buffer> {
    // The host renders its own PNG; returning the bytes keeps the interface honest without
    // this module needing an image library.
    const r = await (await c()).raw('/screen.png')
    return Buffer.from(String((r.body as { png?: string }).png ?? ''), 'base64')
  },

  /**
   * Capture a baseline for later diffing.
   *
   * The host keeps ONE baseline, set by /screenwatch, compared by /screendiff. This is the
   * "observe before acting" half of verification: you cannot know whether an action changed
   * anything unless you recorded what was there before it.
   *
   * The region is virtualized (input) coordinates - the same space every other coordinate in
   * this system uses - and the host converts to physical for the capture.
   */
  async screenWatch(region: { x: number; y: number; w: number; h: number }): Promise<{
    ok: boolean; error?: string
  }> {
    const r = await (await c()).raw(
      `/screenwatch?x=${region.x}&y=${region.y}&w=${region.w}&h=${region.h}`,
    )
    return { ok: Boolean(r.body?.ok), error: r.body?.error ? String(r.body.error) : undefined }
  },

  /**
   * Diff the current screen against the baseline captured by `screenWatch`.
   *
   * Returns the count and percentage of changed pixels plus a bounding box around them. A
   * bounding box is the useful part: "something changed" is weak, "a 400x159 region at
   * (200,666) changed" is a statement you can act on and a verifier can check.
   */
  async screenDiff(region: { x: number; y: number; w: number; h: number }): Promise<{
    ok: boolean
    changed: boolean
    changedPixels: number
    changedPercent: number
    region: { x: number; y: number; w: number; h: number }
    error?: string
  }> {
    const r = await (await c()).raw(
      `/screendiff?x=${region.x}&y=${region.y}&w=${region.w}&h=${region.h}`,
    )
    const b = r.body ?? {}
    return {
      ok: Boolean(b.ok),
      changed: Boolean(b.changed),
      changedPixels: Number(b.changedPixels ?? 0),
      changedPercent: Number(b.changedPercent ?? 0),
      region: (b.region as { x: number; y: number; w: number; h: number }) ?? { x: 0, y: 0, w: 0, h: 0 },
      error: b.error ? String(b.error) : undefined,
    }
  },

  async verifyTarget(t: TargetIdentity): Promise<TargetVerification> {
    const g = await (await c()).guard()
    return {
      ok: Number(t.hwnd) > 0,
      reason: Number(t.hwnd) > 0 ? 'a live hwnd was supplied' : 'no hwnd',
      hwnd: Number(t.hwnd),
      pid: Number(t.pid),
      title: t.expectedTitle,
      visible: true,
      foreground: g.state !== 'EMERGENCY_STOP',
    }
  },

  // The input methods exist because ControlSurface requires them. They are NOT called by the
  // executor and this mission never reaches them; they delegate to the host, which enforces
  // its own guard. Recording that here so it is explicit rather than assumed.
  async move(t, x, y): Promise<InputResult> { return delegate('move', { ...t, x, y }) },
  async click(t, x, y, button = 'left'): Promise<InputResult> { return delegate('click', { ...t, x, y, button }) },
  async doubleClick(t, x, y): Promise<InputResult> { return delegate('click', { ...t, x, y, clicks: 2 }) },
  async drag(t, from: Point, to: Point): Promise<InputResult> { return delegate('drag', { ...t, from, to }) },
  async scroll(t, x, y, notches): Promise<InputResult> { return delegate('scroll', { ...t, x, y, notches }) },
  async type(t, text): Promise<InputResult> { return delegate('type', { ...t, text }) },
  async pressKey(t, vk, modifiers = []): Promise<InputResult> { return delegate('key', { ...t, vk, modifiers }) },
}

async function delegate(route: string, body: Record<string, unknown>): Promise<InputResult> {
  try {
    const r = await (await c()).raw(`/${route}`, { method: 'POST', body })
    return { attempted: true, delivered: r.body.ok === true, refusedBy: (r.body.error as string) ?? null }
  } catch (e) {
    // The message alone is not enough to decide what happened, and the decision it feeds is
    // whether an action whose outcome is unknown may be retried. undici reports BOTH "the
    // connection was refused before anything was sent" and "the connection died while the
    // request was in flight" as the same bare `fetch failed`; the difference lives on `cause`.
    // A refused connection means nothing was injected (a clean retry is honest); a reset
    // mid-flight means the input may have PARTIALLY landed. Surfacing the cause code here is
    // what lets the caller tell them apart instead of guessing.
    const cause = (e as { cause?: unknown })?.cause as { code?: unknown } | undefined
    const code = typeof cause?.code === 'string' ? cause.code : ''
    const message = e instanceof Error ? e.message : String(e)
    return { attempted: true, delivered: false, refusedBy: code ? `${message} [${code}]` : message }
  }
}

/**
 * A read-only observation tool.
 *
 * It genuinely goes to the host and reports what it found. It cannot write, move, or click,
 * so it is safe to run unattended even though the mission machinery around it is general.
 */
export const observeDesktopTool: Tool = {
  name: 'observe-desktop',
  mode: 'cli',
  async run(ctx: ToolContext): Promise<ToolResult> {
    const o = ctx.observation
    const g = await (await c()).guard()
    const summary =
      `${o.windows.length} window(s), foreground "${o.foreground?.title ?? '(none)'}", ` +
      `control ${o.permission.control}, input ${o.permission.input}`
    return {
      kind: 'data',
      data: {
        windowCount: o.windows.length,
        foregroundTitle: o.foreground?.title ?? null,
        mayInject: g.mayInject === true,
        state: g.state,
        sawTimestamp: Date.now(),
      },
      summary,
    }
  },
}

/**
 * A `uia`-mode tool: survey the accessibility tree of a real window.
 *
 * `needsTarget` is deliberately absent. This tool discovers its own target rather than being
 * handed one, because a UIA survey of the wrong window would return a perfectly valid-looking
 * element list and the mission would verify the wrong thing.
 */
export const surveyAccessibilityTool: Tool = {
  name: 'survey-accessibility',
  mode: 'uia',
  async run(ctx: ToolContext): Promise<ToolResult> {
    const w = await pickInspectableWindow()
    if (!w) return { kind: 'nothing-found', reason: 'no visible window with a title was available to inspect' }

    const elements = await surveyWindow(w.hwnd, 200)
    if (elements.length === 0) {
      // An empty accessibility tree is a real answer for SOME windows (Chromium renders
      // expose almost nothing), and reporting it as such is exactly the honest behaviour the
      // mission engine exists to preserve. It must never be dressed up as a failure or a
      // success.
      return {
        kind: 'nothing-found',
        reason: `window "${w.title}" exposed no accessibility elements`,
      }
    }

    const named = elements.filter((e) => e.name && e.name !== 'Pane')
    const types = [...new Set(elements.map((e) => e.controlType))].sort()
    return {
      kind: 'data',
      data: {
        hwnd: w.hwnd,
        windowTitle: w.title,
        elementCount: elements.length,
        namedCount: named.length,
        controlTypes: types,
        sampleName: named[0]?.name ?? null,
      },
      summary: `${elements.length} accessibility element(s), ${named.length} named, ${types.length} control type(s) in "${w.title}"`,
    }
  },
}

/**
 * INDEPENDENT verification against the live host.
 *
 * Crucially it does NOT trust the tool's return value. It asks the host a fresh question and
 * compares against what the tool claimed - which is the whole point of separating them.
 */
export function liveVerifier() {
  return {
    verifies: () => true,
    async verify(_step: unknown, _ctx: ToolContext, toolData: unknown): Promise<{ evidence: Evidence } | { rejected: string }> {
      const g = await (await c()).guard()
      const claimed = toolData as { windowCount?: number; state?: string } | undefined
      const live = (await liveControl.observe()).windows.length
      // Independent: re-observe rather than read the tool's number back.
      if (claimed && typeof claimed.windowCount === 'number' && claimed.windowCount !== live) {
        return { rejected: `tool reported ${claimed.windowCount} windows; an independent observation saw ${live}` }
      }
      if (claimed?.state && claimed.state !== g.state) {
        return { rejected: `tool reported state ${claimed.state}; the host says ${g.state}` }
      }
      // Evidence must be CHECKABLE. An earlier version returned hwnd 0 and "host pid ?" -
      // technically present, useless for an audit. The evidence names a real window the
      // verifier actually saw, so a later reader can confirm it independently.
      const seen = (await liveControl.observe()).windows
      const target = seen.find((w) => w.visible && w.hwnd > 0) ?? seen[0]
      if (!target) {
        return { rejected: 'independent observation saw no window at all, so nothing can be verified' }
      }
      return {
        evidence: {
          kind: 'window-present',
          title: target.title || '(untitled)',
          hwnd: target.hwnd,
        },
      }
    },
  }
}

/**
 * Independent verification for the `uia` mode.
 *
 * It re-queries the accessibility tree ITSELF and compares against the tool's claim. Reading
 * the tool's numbers back would be verification in name only - the exact conflation the whole
 * architecture exists to prevent.
 *
 * It also checks something the tool cannot fake by accident: that the element types it claims
 * to have seen are actually present on a fresh survey.
 */
export function liveUiaVerifier() {
  return {
    verifies: (step: { mode?: string }) => step.mode === 'uia',
    async verify(_step: unknown, _ctx: ToolContext, toolData: unknown): Promise<{ evidence: Evidence } | { rejected: string }> {
      const claimed = toolData as {
        hwnd?: number; elementCount?: number; windowTitle?: string; controlTypes?: string[]
      } | undefined
      if (!claimed?.hwnd) return { rejected: 'the tool named no window, so there is nothing to verify' }

      // Fresh survey, from here, ignoring what the tool said.
      const live = await surveyWindow(claimed.hwnd, 200)
      if (live.length === 0) {
        return { rejected: `an independent survey of hwnd ${claimed.hwnd} found no elements, so the tool's claim cannot be corroborated` }
      }
      if (claimed.elementCount !== undefined && claimed.elementCount !== live.length) {
        return {
          rejected: `tool reported ${claimed.elementCount} elements; an independent survey of hwnd ${claimed.hwnd} saw ${live.length}`,
        }
      }
      const liveTypes = new Set(live.map((e) => e.controlType))
      for (const t of claimed.controlTypes ?? []) {
        if (!liveTypes.has(t)) {
          return { rejected: `tool claimed control type "${t}", which an independent survey did not find` }
        }
      }
      // Evidence that names something a reader can check: the window and a real control type
      // from it, rather than a count.
      const sample = live.find((e) => e.name && e.name !== 'Pane') ?? live[0]
      return {
        evidence: {
          kind: 'screen-text-present',
          text: `${claimed.windowTitle ?? '(untitled)'} [${[...liveTypes].sort().join('/')}] e.g. ${sample.controlType} "${sample.name || '(unnamed)'}"`,
        },
      }
    },
  }
}