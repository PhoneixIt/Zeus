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
import type { DeclaredEffect } from '../governance/approval.ts'

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
   * WHAT THIS STEP WOULD ACTUALLY DO, decided by the tool from its own arguments.
   *
   * `consequential: true` above is a static yes/no, which is right for a tool that is always
   * consequential and useless for one whose consequence depends on what it is asked to do. The
   * terminal tool is the case that forced this: `git status` reads and `git push` sends, and a
   * single static flag would either demand a human for the first or wave the second through.
   *
   * So a tool may classify the SPECIFIC step. The executor asks before deciding about
   * authorisation, which means the gate is placed on the command rather than on the capability -
   * and a plan cannot under-declare its way past it, because the tool's own reading of the
   * arguments is the one the gate uses.
   *
   * Returns `undefined` for "no effect", which is a positive claim: the tool has looked and found
   * nothing consequential. A tool that cannot classify must return nothing rather than guess.
   */
  readonly effectOf?: (step: Step) => DeclaredEffect | undefined
  /**
   * A refusal the tool would issue for this step, checked BEFORE authorisation is considered.
   *
   * Separated from `effectOf` because the two answers mean different things: a blocked command is
   * not something a human can authorise (there is no approval that makes `cmd.exe` acceptable),
   * whereas a consequential one is exactly what approval exists for. Asking for approval for a
   * refused command would be asking the human to decide something that was never on the table.
   */
  readonly preflight?: (step: Step) => { blocked: string; needsHuman: boolean } | undefined
  /**
   * Which ABSTRACT CAPABILITIES this registration serves.
   *
   * The mapping from capability to implementation lives HERE, in the registry, rather than in the
   * planner. A plan names what it needs; this decides what provides it. That direction is what lets
   * an implementation be swapped without invalidating a plan, and what stops a planner from
   * reasoning about one tool's quirks as though they were facts about the task.
   *
   * More than one implementation may serve a capability. That is not a fallback: it is two routes to
   * the same requirement, and `resolveCapability` refuses rather than choosing between them.
   */
  readonly capabilities?: readonly string[]
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
  private readonly byCapability = new Map<string, ToolRegistration[]>()

  constructor(opts: RegistryOptions) {
    for (const r of opts.registrations) {
      if (this.byName.has(r.tool.name)) {
        // Two implementations claiming one name is a wiring bug that would otherwise be
        // resolved by load order.
        throw new Error(`duplicate tool registration: ${r.tool.name}`)
      }
      this.byName.set(r.tool.name, r)
      for (const cap of r.capabilities ?? []) {
        const list = this.byCapability.get(cap)
        if (list) list.push(r)
        else this.byCapability.set(cap, [r])
      }
    }
  }

  /** Every abstract capability anything registered can serve. For a planner's `capabilities()`. */
  capabilities(): string[] {
    return [...this.byCapability.keys()].sort()
  }

  /**
   * Resolve an abstract capability to a tool.
   *
   * AMBIGUITY IS REFUSED, not resolved. Two implementations serving one capability is a wiring
   * decision someone has to make deliberately, and picking by registration order would make the
   * system's behaviour depend on the order a list happened to be written in - which is the same
   * class of bug as the duplicate-name check above, one level up.
   */
  resolveCapability(capability: string): { tool: Tool } | { unavailable: string; candidates: readonly string[] } {
    const matches = this.byCapability.get(capability) ?? []
    if (matches.length === 0) {
      return {
        unavailable:
          `no registered tool serves the capability "${capability}". ` +
          `Nothing will be substituted for it: a plan that says "${capability}" must not be served ` +
          `by something else, because then the plan no longer describes what runs.`,
        candidates: this.capabilities(),
      }
    }
    if (matches.length > 1) {
      return {
        unavailable:
          `${matches.length} tools serve the capability "${capability}" ` +
          `(${matches.map((m) => m.tool.name).join(', ')}). Choosing between them is a wiring ` +
          `decision, not something to resolve by load order.`,
        candidates: matches.map((m) => m.tool.name),
      }
    }
    return { tool: matches[0].tool }
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

  /**
   * The effect this step WOULD have, according to the tool that would run it.
   *
   * The dynamic counterpart to `isConsequential`, and preferred where both are available: a tool
   * that can read its own arguments knows more about what it is about to do than a static flag or
   * a plan step's own declaration does.
   */
  effectOf(step: Step): DeclaredEffect | undefined {
    const r = step.tool ? this.byName.get(step.tool) : undefined
    return r?.effectOf?.(step)
  }

  /** A refusal the named tool would issue for this step, if any. */
  preflight(step: Step): { blocked: string; needsHuman: boolean } | undefined {
    const r = step.tool ? this.byName.get(step.tool) : undefined
    return r?.preflight?.(step)
  }

  /**
   * Every registered name that would refuse this step, for diagnostics when a mission fails in a
   * way that looks like a plan defect.
   */
  refusalsFor(step: Step): string[] {
    return this.names()
      .map((n) => this.byName.get(n)!.preflight?.({ ...step, tool: n }))
      .filter((x): x is { blocked: string } => x !== undefined)
      .map((x) => x.blocked)
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