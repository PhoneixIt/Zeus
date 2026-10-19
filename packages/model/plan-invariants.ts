/**
 * STRUCTURAL INVARIANTS FOR A MODEL-PROPOSED PLAN.
 *
 * WHY THIS EXISTS ALONGSIDE `parse.ts` AND THE COMPILER
 *
 * The grammar enforces what a byte-level state machine can see: JSON shape, required keys, enums, and
 * (since the last change) no duplicate keys and no step field smuggled inside a free-form `args`.
 * It cannot see VALUES THAT DEPEND ON OTHER VALUES. A grammar has no idea what a step id is, which
 * tools are registered on this router, or whether a plan writes the file the caller asked for.
 *
 * So those live here, in one place, checked BEFORE anything is compiled or executed. This is a
 * validator, not a repairer: it returns a reason or it returns nothing. Nothing here rewrites a plan,
 * and nothing here can turn a rejected plan into an executable one - a caller that gets `ok: false`
 * has no proposal at all.
 *
 * WHAT IT IS DELIBERATELY NOT
 *
 * It is not a second parser. `parse.ts` remains the syntax authority and is unchanged. These are
 * cross-step and registry-level facts, and each rule below cites the concrete defect that made it
 * necessary rather than a general aspiration.
 */

import { CAPABILITIES, type PlanProposal } from '../planner/plan.ts'

export type InvariantResult = { readonly ok: true } | { readonly ok: false; readonly reason: string }

export interface InvariantOptions {
  /** Tool names this router has actually registered. A plan naming anything else is refused. */
  readonly registeredTools: readonly string[]
  /**
   * The capability a registered tool serves, when the router knows one tool per capability.
   *
   * Supplied by the caller rather than hardcoded: which tools exist is a property of the router
   * built for the mission, not of this file.
   */
  readonly capabilityOfTool?: Readonly<Record<string, string>>
  /** Capabilities the objective requires, e.g. the inspection and the write. */
  readonly requiredCapabilities?: readonly string[]
  /** The exact destination the caller asked for, when the plan must write one. */
  readonly expectedOutputPath?: string
  /**
   * Operand values the MACHINE already knows and the plan is therefore not allowed to restate wrongly.
   *
   * Each rule names a tool, an operand of that tool, and the trusted value derived from what the
   * caller observed. A step that omits the operand is fine; a step that supplies the trusted value is
   * fine; a step that supplies anything else is refused BEFORE execution, with the trusted value in
   * the message, so the bounded correction can hand the model the exact string to use.
   *
   * Why this exists: a plan that was correct in every other respect - registered tools, matching
   * capabilities, valid step ids, correct dependencies, all five steps verified, the file written -
   * still produced a wrong artefact, because it was made to REPRODUCE a path string in an operand it
   * did not need to supply. The machine already had the path. Restating machine-known facts is how a
   * model introduces an error the compiler cannot see.
   *
   * Data, not code: the caller supplies which operand is machine-known for which tool, because that
   * is a property of the tool's contract, not of this validator.
   */
  readonly trustedOperands?: readonly {
    readonly tool: string
    readonly operand: string
    /** The value, derived from observed state, that the operand may confirm but not replace. */
    readonly value: string
  }[]
}

/** Capabilities that only ever READ. None of them can justify an effect. */
const READ_ONLY_CAPABILITIES = new Set<string>([
  'filesystem.inspect',
  'filesystem.list',
  'filesystem.read',
  'filesystem.search',
])

/**
 * Effect kinds that would demand a human approval for work that is merely reading.
 *
 * MEASURED: the model attached `{"kind":"install","target":"filesystem.read","irreversible":true}`
 * to a step whose capability was `filesystem.inspect`. That is not a harmless embellishment - an
 * effect is a DECLARATION that obliges the executor to obtain authorisation, so a spurious one
 * demands a human decision before work that requires none, and teaches the operator to dismiss
 * approvals without reading them.
 *
 * Narrow on purpose. An effect is NOT globally forbidden: `filesystem.edit` declares `delete`,
 * `filesystem.move` declares `delete`, and those are correct and are asserted by other controls. The
 * rule is only that a step that only reads may not declare one.
 */
const IRRELEVANT_FOR_A_READ = new Set<string>([
  'install', 'purchase', 'credential-use', 'security-setting', 'external-send',
])

const bad = (reason: string): InvariantResult => ({ ok: false, reason })

/**
 * Check every cross-step and registry-level invariant.
 *
 * The order is deliberate: structural facts that make later checks meaningless are checked first, so
 * a plan with two steps named the same does not produce a confusing dependency error instead of the
 * accurate one.
 */
export function checkPlanInvariants(
  proposal: PlanProposal,
  opts: InvariantOptions,
): InvariantResult {
  const steps = proposal.steps
  if (!steps.length) return bad('the plan has no steps')

  // ---- 1. unique ids. Everything below indexes by id, so a collision corrupts the rest.
  const ids = new Set<string>()
  for (const s of steps) {
    if (ids.has(s.id)) return bad(`two steps share the id "${s.id}"; ids must be unique`)
    ids.add(s.id)
  }

  // ---- 2. every step must be one this router registered.
  //
  // MEASURED: the worked example named `write-summary`, which is not a tool; `folder-tools.ts`
  // registers `write-report`. The model copied the example and the router refused the plan. A plan
  // naming an unregistered tool cannot run, and the refusal belongs BEFORE compilation.
  for (const s of steps) {
    if (!opts.registeredTools.includes(s.tool)) {
      return bad(
        `step "${s.id}" names the tool "${s.tool}", which is not registered. ` +
        `Registered: ${opts.registeredTools.join(', ')}`,
      )
    }
  }

  // ---- 3. capability and mode must agree, and the capability must be real.
  for (const s of steps) {
    if (!(CAPABILITIES as readonly string[]).includes(s.capability)) {
      return bad(`step "${s.id}" names the capability "${s.capability}", which does not exist`)
    }
    const wantMode = s.capability === 'terminal.run' ? 'cli' : 'filesystem'
    if (s.mode !== wantMode) {
      return bad(
        `step "${s.id}" uses capability "${s.capability}" with mode "${s.mode}"; ` +
        `"${s.capability}" requires mode "${wantMode}"`,
      )
    }
    const toolCap = opts.capabilityOfTool?.[s.tool]
    if (toolCap !== undefined && toolCap !== s.capability) {
      return bad(
        `step "${s.id}" pairs the tool "${s.tool}" with the capability "${s.capability}", ` +
        `but "${s.tool}" serves "${toolCap}"`,
      )
    }
  }

  // ---- 4. dependencies: earlier steps only, never a capability, never a cycle.
  //
  //    MEASURED: `dependsOn: ["filesystem.read"]` - a CAPABILITY, not a step id. The capability
  //    vocabulary and the id vocabulary are both lists of words, so nothing but a check distinguishes
  //    them, and a plan naming a capability reads to a human exactly like one naming a step.
  const CAPABILITY_LOOKALIKE = new Set<string>([...CAPABILITIES])
  const earlier = new Set<string>()
  for (const s of steps) {
    for (const d of s.dependsOn) {
      if (d === s.id) return bad(`step "${s.id}" depends on itself`)
      // ORDER MATTERS, and this ordering was a real defect. The capability check used to run first,
      // and its vocabulary included TOOL names - so `read-folder`, which is BOTH a registered tool and
      // a perfectly ordinary step id, was refused as "a capability name". A correct plan was
      // rejected by the check written to catch an incorrect one.
      //
      // A name that IS a step in this plan is a step. Only a name that is NOT - and which is
      // recognisably a capability - is the mistake this rule is for.
      if (ids.has(d)) {
        if (!earlier.has(d)) {
          return bad(`step "${s.id}" depends on "${d}", which is not an EARLIER step; the executor walks steps in order`)
        }
        continue
      }
      if (CAPABILITY_LOOKALIKE.has(d)) {
        return bad(
          `step "${s.id}" depends on "${d}", which is a CAPABILITY name, not a step id. ` +
          `Dependencies name other steps in this plan.`,
        )
      }
      return bad(`step "${s.id}" depends on "${d}", which is not a step in this plan`)
    }
    earlier.add(s.id)
  }

  // ---- 5. cycles. Unreachable given rule 4 accepts only backward edges, and asserted anyway,
  //         because "cycles are rejected" should be a property of this function rather than an
  //         inference about another one.
  const graph = new Map<string, readonly string[]>(steps.map((s) => [s.id, s.dependsOn]))
  const state = new Map<string, number>()
  const walk = (id: string): string | null => {
    if (state.get(id) === 1) return `dependency cycle detected at step "${id}"`
    if (state.get(id) === 2) return null
    state.set(id, 1)
    for (const d of graph.get(id) ?? []) {
      const found = walk(d)
      if (found) return found
    }
    state.set(id, 2)
    return null
  }
  for (const s of steps) {
    const cycle = walk(s.id)
    if (cycle) return bad(cycle)
  }

  // ---- 6. a step that only reads may not declare an effect.
  for (const s of steps) {
    if (!s.effect) continue
    if (!READ_ONLY_CAPABILITIES.has(s.capability)) continue
    return bad(
      `step "${s.id}" uses the read-only capability "${s.capability}" but declares the effect ` +
      `"${s.effect.kind}". Reading changes nothing, so it cannot justify an authorisation request; ` +
      `a spurious effect trains the operator to approve without reading.`,
    )
  }

  // ---- 7. the objective's required operations must actually be planned.
  //
  //    MEASURED: the model produced a plan with an INSPECT step and no WRITE step at all, which the
  //    grammar and the parser both accept - it is a well-formed plan of the wrong plan. A folder
  //    summary that never writes a summary has not done the task, and finding that out only after
  //    execution is finding it out too late.
  for (const cap of opts.requiredCapabilities ?? []) {
    if (!steps.some((s) => s.capability === cap)) {
      return bad(`the plan contains no "${cap}" step, so it cannot accomplish the objective`)
    }
  }

  // ---- 8. the write must target the destination the caller asked for.
  //
  //    MEASURED: the model wrote `summary.txt` when `project-notes.txt` was requested. The
  //    containment checks inside `write-report` only prove the file lands INSIDE the output root;
  //    they cannot know which file inside it was wanted. This is the check that knows.
  if (opts.expectedOutputPath !== undefined) {
    const wanted = opts.expectedOutputPath.toLowerCase()
    const writers = steps.filter((s) => s.capability === 'filesystem.write')
    const targets = writers.map((s) => String((s.args as { path?: string }).path ?? ''))
    if (!targets.some((t) => t.toLowerCase() === wanted)) {
      return bad(
        `no write step targets "${opts.expectedOutputPath}". ` +
        (targets.length ? `The plan writes: ${targets.join(', ')}.` : 'The plan writes nothing.'),
      )
    }
  }

  // ---------------------------------------------------------------- machine-known operands
  //
  // Refuses a plan that restates a fact the machine already holds, wrongly. Omitting is allowed -
  // the tool falls back to the trusted value - so this never forces a model to produce a path it
  // would otherwise never have needed to produce.
  for (const rule of opts.trustedOperands ?? []) {
    const canonical = (p: string): string => p.trim().replace(/[\\/]+$/, '')
    const want = canonical(rule.value)
    for (const s of steps) {
      if (s.tool !== rule.tool) continue
      const raw = (s.args as Record<string, unknown>)[rule.operand]
      if (raw === undefined || raw === null || String(raw).trim() === '') continue
      if (canonical(String(raw)).toLowerCase() !== want.toLowerCase()) {
        return bad(
          `step "${s.id}" sets ${rule.tool}.${rule.operand} to "${String(raw)}", but the folder ` +
          `that was actually observed is "${rule.value}". Omit ${rule.operand} to use the observed ` +
          `folder, or give that exact path.`,
        )
      }
    }
  }

  return { ok: true }
}