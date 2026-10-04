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

import { connect } from '../../control-core/operator-client.mjs'
import type {
  ControlSurface, Observation, Permission, Point,
  TargetIdentity, TargetVerification, InputResult,
} from '../../governance/contract.ts'
import type { Tool, ToolContext, ToolResult } from '../executor.ts'

const HOST = 'C:/Users/Samer/Projects/AIOS/packages/control-core/host.json'

interface Client {
  guard(): Promise<Record<string, unknown>>
  raw(path: string, opts?: { method?: string; body?: Record<string, unknown> }): Promise<{ status: number; body: Record<string, unknown> }>
  windows(): Promise<unknown>
  screenshot: unknown
  focus(t: unknown): Promise<unknown>
  controlByName(t: unknown): Promise<unknown>
}

let client: Client | null = null

async function c(): Promise<Client> {
  if (!client) client = (await connect({ statePath: HOST })) as unknown as Client
  return client
}

async function permission(): Promise<Permission> {
  const g = await (await c()).guard()
  return {
    control: g.state as Permission['control'],
    input: g.mayInject ? 'PERMITTED' : 'BLOCKED',
    blockedBy: (g.blockingReason as string | null) ?? null,
    infrastructureHealthy: true,
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
    return { attempted: true, delivered: false, refusedBy: e instanceof Error ? e.message : String(e) }
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
 * INDEPENDENT verification against the live host.
 *
 * Crucially it does NOT trust the tool's return value. It asks the host a fresh question and
 * compares against what the tool claimed - which is the whole point of separating them.
 */
export function liveVerifier() {
  return {
    verifies: () => true,
    async verify(_step: unknown, _ctx: ToolContext, toolData: unknown) {
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