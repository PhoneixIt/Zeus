/**
 * A deterministic fake ControlSurface and tool set.
 *
 * The executor must be testable without a desktop, and more importantly the TESTS must be
 * deterministic: a test that depends on timing, focus or a real window is a test that will
 * pass or fail for reasons unrelated to what it checks.
 *
 * Nothing here reaches Windows. That is the point - it is also what makes it safe to run
 * these tests at any time without a human present.
 */

import type {
  ControlSurface, Observation, Permission, Point,
  ScreenRegion, TargetIdentity, TargetVerification, InputResult, WindowInfo,
} from '../../governance/contract.ts'
import type { Evidence, Step } from '../state.ts'
import type { Tool, ToolContext, ToolResult, ToolRouter, Verifier } from '../executor.ts'

// ---------------------------------------------------------------- fake control

export interface FakeControlOptions {
  /** Observation returned by every observe() call. */
  observation?: Partial<Observation>
  /** If set, observe() throws - stands in for the control surface being unavailable. */
  observeThrows?: Error
}

export function fakeControl(opts: FakeControlOptions = {}): ControlSurface & { calls: string[] } {
  const calls: string[] = []
  const windows: WindowInfo[] = [
    { hwnd: 1000, pid: 100, title: 'Notepad', visible: true, rect: { x: 0, y: 0, w: 800, h: 600 } },
  ]
  const permission: Permission = {
    control: 'ARMED',
    input: opts.observeThrows ? 'BLOCKED' : 'PERMITTED',
    blockedBy: opts.observeThrows ? 'control surface is unavailable' : null,
    infrastructureHealthy: !opts.observeThrows,
  }
  const observation: Observation = {
    screen: { width: 1920, height: 1080, session: 1 },
    windows,
    foreground: windows[0],
    permission,
    warnings: [],
    ...opts.observation,
  }

  const target: TargetVerification = {
    ok: true, reason: 'ok', hwnd: 1000, pid: 100, title: 'Notepad', visible: true, foreground: true,
  }

  // Every input method REFUSES. The executor is not permitted to inject, and the fake makes
  // that structural: there is no code path here that could produce real input even if the
  // executor tried.
  const refuse = (what: string): InputResult => {
    calls.push(what)
    return { attempted: true, delivered: false, refusedBy: 'the fake control surface does not permit injection' }
  }

  return {
    calls,
    observe: async () => { calls.push('observe'); if (opts.observeThrows) throw opts.observeThrows; return observation },
    captureScreen: async () => { calls.push('captureScreen'); return Buffer.alloc(0) },
    verifyTarget: async (_t: TargetIdentity) => { calls.push('verifyTarget'); return target },
    move: async (_t, _x: number, _y: number) => refuse('move'),
    click: async (_t, _x: number, _y: number) => refuse('click'),
    doubleClick: async (_t, _x: number, _y: number) => refuse('doubleClick'),
    drag: async () => refuse('drag'),
    scroll: async () => refuse('scroll'),
    type: async () => refuse('type'),
    pressKey: async () => refuse('pressKey'),
  }
}

// ---------------------------------------------------------------- fake tools

/** A tool that returns data the verifier will accept. */
export function dataTool(name = 'reader', summary = 'read 3 records'): Tool {
  return {
    name,
    mode: 'cli',
    async run(_ctx: ToolContext): Promise<ToolResult> {
      return { kind: 'data', data: { records: 3 }, summary }
    },
  }
}

/** A tool that succeeds but leaves nothing behind - the classic empty-but-happy case. */
export function emptyTool(reason = 'no matching records exist'): Tool {
  return {
    name: 'finder',
    mode: 'filesystem',
    async run(): Promise<ToolResult> {
      return { kind: 'nothing-found', reason }
    },
  }
}

/** A tool that fails. `times` lets a test exercise retry exhaustion precisely. */
export function failingTool(reason = 'the target process is not running', times = Infinity): Tool {
  let calls = 0
  return {
    name: 'fragile',
    mode: 'api',
    async run(): Promise<ToolResult> {
      calls++
      if (calls <= times) return { kind: 'failed', reason }
      return { kind: 'data', data: { ok: true }, summary: 'recovered' }
    },
  }
}

/** A tool that claims success but is caught lying by the verifier. */
export function liarTool(summary = 'claims everything worked'): Tool {
  return {
    name: 'optimist',
    mode: 'api',
    async run(): Promise<ToolResult> {
      return { kind: 'data', data: { wrote: 'everything' }, summary }
    },
  }
}

export function needsHumanTool(reason = 'this action needs approval'): Tool {
  return {
    name: 'consequential',
    mode: 'api',
    async run(): Promise<ToolResult> {
      return { kind: 'needs-human', reason }
    },
  }
}

export function replanTool(reason = 'the window closed'): Tool {
  return {
    name: 'fragile-window',
    mode: 'gui',
    async run(): Promise<ToolResult> {
      return { kind: 'replan-required', reason, invalidation: { reason: 'window-closed', title: 'Notepad' } }
    },
  }
}

export function throwingTool(message = 'unexpected null reference'): Tool {
  return {
    name: 'buggy',
    mode: 'cli',
    async run(): Promise<ToolResult> { throw new Error(message) },
  }
}

// ---------------------------------------------------------------- router

export function router(tools: Record<string, Tool>, fallback?: Tool): ToolRouter {
  return {
    resolve(step: Step) {
      if (step.tool && tools[step.tool]) {
        return { tool: tools[step.tool], fellBack: false, reason: 'the step named this tool' }
      }
      if (fallback) return { tool: fallback, fellBack: true, reason: `no tool named "${step.tool ?? '(none)'}"; used the declared fallback` }
      return { unavailable: `no tool registered for "${step.tool ?? step.id}"`, candidates: Object.keys(tools) }
    },
  }
}

// ---------------------------------------------------------------- verifiers

/**
 * Verifies against an INDEPENDENT source, not the tool's own return value.
 *
 * The `exists` set stands in for "I went and looked". A tool claiming to have written a file
 * that is not in this set is rejected - which is exactly what a real existence check does.
 */
export function existenceVerifier(exists: readonly string[]): Verifier {
  return {
    verifies: () => true,
    async verify(step: Step): Promise<{ evidence: Evidence } | { rejected: string }> {
      const file = step.id.replace(/^step-/, '')
      if (exists.includes(file)) return { evidence: { kind: 'file-exists', path: file } }
      return { rejected: `went and looked for "${file}"; it is not there` }
    },
  }
}

/** A verifier that rejects everything - proves unverified work cannot complete. */
export function strictVerifier(reason = 'independent check failed'): Verifier {
  return {
    verifies: () => true,
    async verify(): Promise<{ rejected: string }> { return { rejected: reason } },
  }
}

/** No verifier registered for anything. */
export const noVerifier: Verifier = {
  verifies: () => false,
  async verify() { return { rejected: 'no verifier' } },
}