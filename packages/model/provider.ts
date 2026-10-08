/**
 * THE MODEL PLAN PROVIDER.
 *
 * A `PlanProvider` whose reasoning happens somewhere else.
 *
 * WHAT THIS MODULE CAN REACH
 *
 *   HTTP            to send a request and receive text
 *   the observation, as data
 *
 * WHAT IT CANNOT REACH, AND WHY THAT IS STRUCTURAL
 *
 * It imports no executor, no governance contract, no `ApprovalStore`, no `ControlSurface`, no tool, no
 * `child_process`, and no filesystem module. So there is no code path by which a model - however
 * persuasive its output - can call a tool, reach the control layer, record an approval, mark a step
 * complete, or declare that something succeeded. Those are not rules this provider follows; they are
 * routes it does not have.
 *
 * The two things a model could plausibly try to smuggle through its output, and where each dies:
 *
 *   AN AUTHORISATION        the proposal has no field for one. `parse.ts` reports such a field as
 *                           ignored, `compile.ts` never reads it, and the approval gate consults an
 *                           `ApprovalStore` this provider cannot construct.
 *   A COMMAND STRING        the model controls `args`, and `args` becomes argv. The terminal POLICY
 *                           validates that argv - independently of anything the model said - and
 *                           refuses a shell. So a model that emits `cmd.exe /c ...` is stopped at the
 *                           last line before execution, not merely at the schema.
 *
 * THE BASIS IS OURS, NOT THE MODEL'S
 *
 * A model is told the observation but never asked to describe it. The `basis` is attached from the
 * `WorldState` this process holds, so a model cannot claim a plan rests on evidence it never saw.
 *
 * AND IT NEVER THROWS
 *
 * `PlanProvider.plan` returns a `PlanResult`. A provider that threw would take the decision out of the
 * recorded history, and a timeout or a 500 from a remote endpoint is an ordinary event rather than a
 * programming error.
 */

import { join } from 'node:path'
import { SYSTEM_INSTRUCTIONS, buildExample, CAPABILITY_RULE, type ModelRequest } from './protocol.ts'
import { parseModelPlan, toProposal, type ParseResult } from './parse.ts'
import { CAPABILITIES, type PlanContext, type PlanProposal, type PlanResult } from '../planner/plan.ts'
import type { PlanProvider } from '../planner/provider.ts'
import type { WorldState } from '../observation/world.ts'
import { filesIn, directoriesIn, deepestLevel, extensionsIn } from '../observation/world.ts'

/**
 * WHERE THE MODEL IS.
 *
 * A URL and headers, and nothing else. Any HTTP-speaking model server works - llama.cpp's server,
 * vLLM, ollama, or an OpenAI-compatible endpoint - because the only thing required of it is that it
 * accept a chat-style message and return text.
 */
export interface ModelEndpoint {
  readonly url: string
  readonly headers?: Readonly<Record<string, string>>
  readonly timeoutMs?: number
  /** The model name, where the endpoint needs one. */
  readonly model?: string
}

/** How the provider is described in an audit, and whether its raw output is retained. */
export interface ProviderOptions {
  /** The last raw response, for the audit. Held here rather than logged, so nothing leaks by default. */
  retainRaw?: boolean
}

/**
 * Capabilities that REQUIRE authorisation, stated to the model up front.
 *
 * Which capabilities these are is a property of the ROUTER, not of this file - the provider is given
 * the list by its caller. Hardcoding it here would create a second, drifting copy of a governance
 * fact, and the model would be told something the gate does not believe.
 */
export interface ProviderDeps {
  readonly endpoint: ModelEndpoint
  /** Which capabilities the router can serve. The model may only choose from these. */
  readonly availableCapabilities?: readonly string[]
  readonly options?: ProviderOptions
  /** Injected for tests; defaults to global fetch. */
  readonly fetchImpl?: typeof fetch
}

/**
 * HOW LONG TO WAIT FOR A REASONER.
 *
 * MEASURED, not guessed. On this machine a local 0.5B model produces roughly 7 tokens/second on 2 CPU
 * cores, and a structured plan is 300-500 tokens. The M8 peer answered in milliseconds, so this was
 * originally 60 seconds - which was a timeout that could not fire for a real model, and would have
 * produced a confusing "could not be reached" for what was really "still thinking".
 *
 * It is a CEILING rather than an expectation, and it is set above the measured worst case (a 512-token
 * ceiling at 7 tokens/second is about 73 seconds; the server's own 150-second wall clock binds first).
 * Raising it does not weaken any safety property: the bound still exists, and the server has a second,
 * independent one.
 */
const DEFAULT_TIMEOUT = 200_000

export class ModelPlanProvider implements PlanProvider {
  readonly name: string
  /**
   * Held as a field rather than a TypeScript parameter property (`constructor(private readonly deps)`).
   *
   * Parameter properties are compile-time sugar, and Node's type-stripping - which is how every file in
   * this repository runs - rejects them outright rather than ignoring them. So the whole project avoids
   * them; `deps` is assigned explicitly here for the same reason `require` is never used in an ESM
   * module: both are conveniences that fail only at load time.
   */
  private readonly deps: ProviderDeps
  /** Set by the provider. Read by nothing that could act. */
  private lastRaw: string | null = null

  /**
   * Why the last generation was stopped by the grammar, or ''.
   *
   * Held on the instance for the same reason `lastRaw` is: the HTTP response is local to `call()` and
   * does not exist in the scope where the parse result is interpreted. A constrained decoder cuts
   * generation short routinely, and without this the failure is reported as "malformed plan", which is
   * true and useless.
   */
  private lastGrammarStop = ''
  private lastIgnoredFields: readonly string[] = []

  constructor(deps: ProviderDeps) {
    this.deps = deps
    // The endpoint's model name goes in the audit, so a mission states WHICH reasoner planned it.
    this.name = `model:${deps.endpoint.model ?? deps.endpoint.url.replace(/^https?:\/\//, '').slice(0, 40)}`
  }

  capabilities(): readonly string[] {
    return [
      'proposes plans by sending an observation to a remote reasoner and parsing its reply',
      'accepts only the capabilities this system lists, and never repairs an invalid one',
      'has no tool, no approval and no route to the executor',
    ]
  }

  /** The raw last response, for an audit. Empty unless the provider was asked to retain it. */
  rawResponse(): string | null {
    return this.deps.options?.retainRaw ? this.lastRaw : null
  }

  /** Fields the model emitted that this system ignored. Shown to a reviewer, never honoured. */
  ignoredFields(): readonly string[] {
    return this.lastIgnoredFields
  }

  async plan(objective: string, ctx: PlanContext): Promise<PlanResult> {
    // ---- 1. Can we plan without looking? No, and that is the M6 rule, unchanged.
    const world = ctx.world
    if (!world) {
      return {
        ok: false, code: 'observation-missing',
        reason: 'no observation was supplied, so there is nothing to send to a reasoner about',
        unsupported: [],
      }
    }
    // The same freshness contract the deterministic planner holds to. A remote reasoner is not a
    // reason to plan on a stale view of the machine.
    if (typeof ctx.maxObservationAgeMs === 'number') {
      const age = ctx.now() - world.observedAt
      if (age > ctx.maxObservationAgeMs) {
        return {
          ok: false, code: 'observation-stale',
          reason: `the observation is ${Math.round(age / 1000)}s old, beyond this caller's limit`,
          unsupported: [],
        }
      }
      if (!ctx.refetched) {
        return {
          ok: false, code: 'observation-stale',
          reason: 'the observation cannot be verified as current, because no re-observation was supplied',
          unsupported: [],
        }
      }
      if (ctx.refetched.fingerprint !== world.fingerprint) {
        return {
          ok: false, code: 'observation-stale',
          reason: `the world changed between the observation and the plan ` +
            `(${world.fingerprint} -> ${ctx.refetched.fingerprint})`,
          unsupported: [],
        }
      }
    }

    // ---- 2. Build the request. Facts, not interpretation.
    const request = buildRequest(objective, world, ctx.outputRoot, this.deps.availableCapabilities ?? CAPABILITIES)

    // ---- 3. Send it.
    let text: string
    try {
      text = await this.call(request)
    } catch (e) {
      // Never throws: a transport failure is an OUTCOME, and a planner that throws takes the
      // decision out of the recorded history.
      return {
        ok: false, code: 'unsupported',
        reason: `the reasoner could not be reached: ${(e as Error).message}`,
        unsupported: [],
      }
    }
    this.lastRaw = text

    // ---- 4. Parse STRICTLY. Accept or reject; never repair.
    const parsed: ParseResult = parseModelPlan(text)
    if (!parsed.ok) {
      this.lastIgnoredFields = []
      // When the generation was cut short BY THE GRAMMAR, say so.
      //
      // Otherwise the reason is "the plan is malformed", which is true but hides the cause: a tight
      // grammar plus a weak model means "the model asked for something the grammar forbids and there
      // was no legal alternative". That is a completely different finding from "the model produced
      // nonsense", and conflating them would make a constrained-decoding measurement unreadable.
      //
      // The reason arrives as a string on the instance rather than being read off the response here,
      // because the response object does not exist in this scope. An earlier version referenced it
      // anyway - which is a ReferenceError at runtime, found by reading the scopes rather than by
      // running it.
      const exhaustion = this.lastGrammarStop
        ? ` The grammar stopped generation: ${this.lastGrammarStop}`
        : ''
      return {
        ok: false,
        code: parsed.code,
        reason: `the model returned a plan that was REJECTED, not repaired - ${parsed.reason}${exhaustion}`,
        unsupported: [],
      }
    }
    this.lastIgnoredFields = parsed.ignoredFields

    // ---- 5. Our basis, not the model's.
    const proposal = toProposal(parsed.plan, {
      observationId: world.observationId,
      observedAt: world.observedAt,
      root: world.scope.root,
      fingerprint: world.fingerprint,
      facts: observedFacts(world),
      complete: !world.truncated && world.errors.length === 0,
    }, objective)

    return { ok: true, proposal }
  }

  /**
   * The one network call.
   *
   * The body is a chat-shaped message list, because that is the shape nearly every model server
   * accepts. Nothing else about the transport is assumed, so swapping llama.cpp for a hosted endpoint
   * is a change to this function and nothing else.
   */
  private async call(request: ModelRequest): Promise<string> {
    const f = this.deps.fetchImpl ?? fetch
    const body = {
      model: this.deps.endpoint.model ?? 'local',
      temperature: 0,
      messages: [
        // The instructions, the capability rule, then a real short worked example.
        //
        // The example was ADDED after measurement, and it is a change to what the model is shown and
        // not to what the system accepts. The 0.5B model scored 0/4 against a schema described in
        // English, and returned my descriptions as data. An example is unambiguous where a description
        // was not. `parse.ts` is byte-for-byte unchanged and still refuses every malformed shape.
        { role: 'system', content: `${SYSTEM_INSTRUCTIONS}\n\n${CAPABILITY_RULE}\n\nEXAMPLE, using THIS request's real folder and output path:\n${buildExample(request.input.observed.root, join(request.input.mayWriteHere, 'summary.txt'))}` },
        // COMPACT, not pretty-printed.
        //
        // Measured: the pretty-printed 1672-token request took 26s of prefill and produced echoed
        // output. A single-line JSON object reads as a complete value, whereas indented JSON reads as the
        // start of a document that continues - which is exactly the wrong cue for a completion model
        // that is about to be asked for an object of its own.
        { role: 'user', content: JSON.stringify(request) },
      ],
    }
    const res = await f(this.deps.endpoint.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.deps.endpoint.headers ?? {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.deps.endpoint.timeoutMs ?? DEFAULT_TIMEOUT),
    })
    if (!res.ok) {
      throw new Error(`the reasoner answered ${res.status} ${res.statusText}`)
    }
    const json = await res.json() as {
      local_inference?: { grammar_exhausted?: boolean; grammar_stop_reason?: string }
      choices?: Array<{ message?: { content?: string } }>
      content?: string
      response?: string
    }
    // Three response shapes, because three server families. All of them reduce to TEXT, which is
    // then parsed by the same strict parser. No shape is trusted further than that.
    this.lastGrammarStop = json?.local_inference?.grammar_exhausted === true
      ? String(json?.local_inference?.grammar_stop_reason ?? 'no reason recorded')
      : ''
    const text = json?.choices?.[0]?.message?.content ?? json?.content ?? json?.response
    if (typeof text !== 'string') {
      throw new Error(`the reasoner returned no text content (keys: ${Object.keys(json ?? {}).join(', ')})`)
    }
    return text
  }
}

/** The facts the model is shown. Every value here came from a real filesystem call. */
export function buildRequest(
  objective: string,
  world: WorldState,
  outputRoot: string,
  availableCapabilities: readonly string[],
): ModelRequest {
  return {
    // NESTED UNDER ONE KEY, and this is the third and final attempt at the same problem.
    //
    // v1: top-level keys `objective`, `availableCapabilities`, `outputRoot`, `world`.
    //     MEASURED: the model returned an object with exactly those keys. It was echoing the request.
    // v2: renamed to `task`, `mayUse`, `mayWriteHere`, `observed`.
    //     MEASURED: the 1.5B returned `{"task": {...}}` - it adopted `task` as the container for its
    //     ANSWER. Renaming the keys removed the exact collisions but not the class: four top-level keys
    //     still look like "the four keys an answer has", and the model filled one of them in.
    // v3: ONE top-level key. The request is a single `input` object, so its shape cannot be mistaken
    //     for an answer's shape - there is only one thing at the top level, and the response example
    //     shows three. Whatever key the model picks for its own container, it cannot be one it was given.
    //
    // Measured twice and fixed twice; this is the version that removes the mechanism rather than an
    // instance of it. None of this touches what the system ACCEPTS.
    input: {
      task: objective,
      mayUse: [...availableCapabilities],
      mayWriteHere: outputRoot,
      observed: {
        root: world.scope.root,
        observationId: world.observationId,
        observedAt: world.observedAt,
        fingerprint: world.fingerprint,
        files: filesIn(world).map((f) => ({
          path: f.path, relative: f.relative, bytes: f.sizeBytes ?? 0, extension: f.extension ?? '',
        })),
        directories: directoriesIn(world).map((d) => d.relative),
        maxDepth: deepestLevel(world),
        extensions: extensionsIn(world),
        programs: world.capabilities.map((c) => ({
          name: c.name, path: c.path, exists: c.exists, permitted: c.permitted,
        })),
      },
    },
  }
}

/** The facts a plan records as its basis. Also what a reviewer is shown. */
export function observedFacts(world: WorldState): string[] {
  return [
    `${filesIn(world).length} file(s) observed`,
    `${directoriesIn(world).length} subfolder(s) observed`,
    `extensions: ${extensionsIn(world).join(', ') || 'none'}`,
    `max depth ${deepestLevel(world)}`,
    `node ${world.capabilities.find((c) => c.name === 'node.exe')?.exists ? 'present' : 'ABSENT'}`,
  ]
}