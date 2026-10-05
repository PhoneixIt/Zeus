/**
 * THE TOOL ROUTER.
 *
 * Maps a planned step to an implementation, or refuses.
 *
 * THE ONE RULE THAT MATTERS
 *
 * A router that cannot find a capability says so. It does NOT fall back to something else.
 *
 * The tempting implementation is "if the exact tool is missing, use the nearest thing" - and it
 * is wrong in a way that only shows up in production. A plan step asking to read a web page,
 * silently served by a filesystem tool, returns an empty list; the verifier checks that list
 * against the same empty list; the mission completes. Nothing errors. The user asked a question
 * and received a confident answer built from the wrong capability.
 *
 * A silent fallback is not a degraded success, it is a wrong answer delivered confidently, which
 * is the exact failure this whole system exists to prevent. So `resolve()` either returns the
 * tool the step named, or returns `unavailable` with the candidates it did find.
 *
 * Fallback exists, but it must be REQUESTED: `resolve(step, { allowFallback })`. A caller that
 * wants a substitute has to say so, and the result is marked `fellBack: true` so the audit
 * records that something other than the plan ran.
 */

import type { Tool, ToolRouter } from '../mission-engine/executor.ts'
import type { ExecutionMode, Step } from '../mission-engine/state.ts'

/** One registered capability. */
export interface ToolRegistration {
  readonly tool: Tool
  /**
   * Whether this tool is INHERENTLY consequential, whatever the plan says.
   *
   * Added because the approval gate originally keyed only on the step's DECLARED effect - and
   * that is a hole a planner can walk through: omit the declaration and the delete runs
   * unapproved. A property of the implementation cannot be established by a property of the
   * request, so the tool's own nature is registered here and the executor requires a declaration
   * to MATCH it.
   *
   * The check is on the tool, not on the plan, so it is exactly the "do not rely on each route
   * remembering" principle the injection gate was built on.
   */
  readonly consequential?: boolean
  /**
   * What this tool is a substitute FOR, if anything.
   *
   * Only used when a caller explicitly allows fallback. Keyed by tool name, so the mapping is
   * data rather than a chain of conditionals.
   */
  readonly substituteFor?: readonly string[]
  /** Free-text note, surfaced when reporting an unavailable route. */
  readonly note?: string
}

export interface RegistryOptions {
  readonly registrations: readonly ToolRegistration[]
}

/**
 * A generic registry-backed router.
 *
 * Intentionally small. It maps names to implementations and reports honestly when it cannot; it
 * does not score tools, rank capabilities, or choose between alternatives, because choosing
 * between alternatives is the PLANNER's job and conflating the two is how a router starts
 * making decisions nobody audited.
 */
export class ToolRegistry implements ToolRouter {
  private readonly byName = new Map<string, ToolRegistration>()

  constructor(opts: RegistryOptions) {
    for (const r of opts.registrations) {
      if (this.byName.has(r.tool.name)) {
        // Two implementations claiming one name is a wiring bug that would otherwise be
        // resolved by load order.
        throw new Error(`duplicate tool registration: ${r.tool.name}`)
      }
      this.byName.set(r.tool.name, r)
    }
  }

  /** Every registered name, for diagnostics and for the router's own test of its contents. */
  names(): string[] {
    return [...this.byName.keys()].sort()
  }

  /** Which names could serve `wanted`, following the declared substitute mapping. */
  candidatesFor(wanted: string): string[] {
    const out = new Set<string>()
    for (const r of this.byName.values()) {
      if (r.tool.name === wanted || r.substituteFor?.includes(wanted)) out.add(r.tool.name)
    }
    return [...out].sort()
  }

  /**
   * Whether the named tool is registered as inherently consequential.
   *
   * Consulted by the executor's approval gate. It reads the REGISTRATION, not the plan, so a
   * planner cannot make a consequential tool look harmless by omitting a declaration.
   */
  isConsequential(step: Step): boolean | undefined {
    const r = step.tool ? this.byName.get(step.tool) : undefined
    return r?.consequential === true ? true : undefined
  }

  resolve(step: Step, opts: { allowFallback?: boolean } = {}): ReturnType<ToolRouter['resolve']> {
    const wanted = step.tool
    if (!wanted) {
      return { unavailable: `step "${step.id}" names no tool`, candidates: this.names() }
    }

    const exact = this.byName.get(wanted)
    if (exact) return { tool: exact.tool, fellBack: false, reason: 'exact tool match' }

    // A mode mismatch is a different failure from an absent tool, and conflating them hides a
    // plan defect: the planner asked for a filesystem capability and named a gui tool.
    const wrongMode = this.names().filter((n) => this.byName.get(n)!.tool.mode !== step.mode)
    const sameMode = this.names().filter((n) => this.byName.get(n)!.tool.mode === step.mode)

    if (!opts.allowFallback) {
      return {
        unavailable:
          `no tool named "${wanted}" is registered` +
          (wrongMode.length ? `; registered tools of a different mode (${wrongMode.join(', ')}) exist, but a step may not be served by a different mode` : ''),
        candidates: sameMode,
      }
    }

    for (const r of this.byName.values()) {
      if (!r.substituteFor?.includes(wanted)) continue
      if (r.tool.mode !== step.mode) continue
      return {
        tool: r.tool,
        fellBack: true,
        reason: `"${wanted}" is unavailable; substituted ${r.tool.name}${r.note ? ` (${r.note})` : ''}`,
      }
    }

    return {
      unavailable: `no tool named "${wanted}" is registered, and no declared substitute of mode "${step.mode}" can serve it`,
      candidates: sameMode,
    }
  }
}

/**
 * A registry that is guaranteed to serve nothing.
 *
 * Used by tests and by the "router unavailable" control. Exists so that "no routing" is a real
 * object with real behaviour rather than an absence that a caller has to special-case.
 */
export class EmptyRegistry extends ToolRegistry {
  constructor() {
    super({ registrations: [] })
  }
}

/** Asserts a step's mode is one the registry can serve, before execution rather than during. */
export function modeAvailable(reg: ToolRegistry, mode: ExecutionMode): boolean {
  return reg.names().some((n) => {
    const r = (reg as unknown as { byName: Map<string, ToolRegistration> }).byName.get(n)
    return r?.tool.mode === mode
  })
}