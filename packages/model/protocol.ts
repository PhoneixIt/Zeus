/**
 * THE MODEL WIRE FORMAT.
 *
 * What goes to a model, and what may come back.
 *
 * WHY THIS FILE IS A CONTRACT AND NOT A PROMPT
 *
 * Because a prompt is a request and a contract is a boundary. Everything the model is told it may do
 * is expressed here as a type the parser will enforce, and the prompt is a RENDERING of this file
 * rather than the source of truth. A prompt alone would mean the model's obligations were whatever the
 * prose said - and prose is exactly the thing a model can be talked out of.
 *
 * THE MODEL IS TOLD WHAT IT MAY CHOOSE FROM, AND CANNOT WIDEN IT
 *
 * The request carries the list of capabilities the router can actually serve. A model that asks for
 * `filesystem.telepathy` is refused by the compiler, and one that names a tool nobody registered is
 * refused by the router. Neither is negotiable by anything the model says.
 *
 * NOTHING IN THE RESPONSE IS EXECUTABLE
 *
 * The response is data. It becomes a `PlanProposal`, which the compiler validates and which the
 * executor's approval gate governs. There is no field here that means "approved", and if a model emits
 * one it is reported and ignored - the same treatment the M7 digest gives such a field.
 */

/** What the model is asked to produce. Deliberately narrower than `PlanProposal`. */
export interface ModelStep {
  readonly id: string
  readonly capability: string
  readonly intent: string
  readonly mode: string
  /** Kept as a string because the model must name a REGISTERED tool, and the router decides. */
  readonly tool: string
  readonly args: Record<string, unknown>
  readonly dependsOn: readonly string[]
  readonly rationale: string
  readonly verification: { readonly kind: string; readonly description: string }
  readonly onFailure: string
  /** Optional. A DECLARATION, which obliges the step to obtain authorisation and grants nothing. */
  readonly effect?: { readonly kind: string; readonly target: string; readonly reason: string; readonly irreversible: boolean }
}

export interface ModelPlan {
  readonly constraints: readonly string[]
  readonly steps: readonly ModelStep[]
  readonly expectedResult: string
}

/**
 * The whole request. Everything the model is allowed to know.
 *
 * ============================================================================================
 * WHY THESE KEY NAMES ARE WHAT THEY ARE
 * ============================================================================================
 *
 * MEASURED: with keys named `objective`, `availableCapabilities`, `outputRoot` and `world`, the model
 * returned an object with THOSE SAME KEYS. It was echoing the request. Four attempts, four echoes, and
 * two of them produced something that parsed as JSON - echoing a request rather than answering it.
 *
 * The cause is a property of completion models rather than of small ones: a model reads a JSON object as
 * a template for what comes next. So a request whose top-level shape resembles the response teaches the
 * model the wrong shape, and no amount of instruction says otherwise. The four keys below are renamed so
 * that NO request key can be mistaken for a response key - `task` where the answer says `objective`,
 * `mayUse` for `availableCapabilities`, `mayWriteHere` for `outputRoot`, `observed` for `world`.
 *
 * This is a change to what the model is READ. It changes nothing about what the system ACCEPTS: the
 * response contract, `parse.ts`, the compiler, the router and every verifier are untouched. Making a
 * model answer a question is a prompt problem; making a bad plan acceptable would be a safety change,
 * and that remains off the table regardless of how the validity rate looks.
 */
export interface ModelRequest {
  /** The user's objective. Named `task` so it cannot be echoed back as a response key. */
  readonly task: string
  /** Capabilities the router can serve. The model may only choose from these. */
  readonly mayUse: readonly string[]
  /** The output root. Named explicitly so a model does not invent one. */
  readonly mayWriteHere: string
  /** A compact, factual rendering of the observation. NOT prose, NOT interpretation. */
  readonly observed: {
    readonly root: string
    readonly observationId: string
    readonly observedAt: number
    readonly fingerprint: string
    readonly files: readonly { readonly path: string; readonly relative: string; readonly bytes: number; readonly extension: string }[]
    readonly directories: readonly string[]
    readonly maxDepth: number
    readonly extensions: readonly string[]
    /**
     * Executables the observer found, with ABSOLUTE paths.
     *
     * The path is included deliberately. The terminal policy refuses a bare program name - a name
     * cannot be resolved without a choice being made, and the choice is not the model's to make -
     * so a model told only "node.exe is permitted" could never construct a step the policy would
     * accept. Handing over the observed path is what makes a lawful terminal step expressible; it
     * is still not permission, because the policy re-derives every decision from its own allowlist.
     */
    readonly programs: readonly { readonly name: string; readonly path: string; readonly exists: boolean; readonly permitted: boolean }[]
  }
}

/**
 * WHAT THE MODEL MUST BE TOLD. Kept here so the request's meaning is auditable in one place.
 *
 * ============================================================================================
 * REWRITTEN AFTER MEASUREMENT, AND THE PARSER WAS NOT TOUCHED
 * ============================================================================================
 *
 * The 0.5B model scored 0/4 on this contract. Its raw output is the evidence, and it diagnosed itself:
 * it returned a JSON object whose KEYS were my schema's description text - `"unique within the plan":
 * "string"`, `"one of availableCapabilities": [...]` - and embedded a copy of the request.
 *
 * The cause was the contract, not the model. The old schema was a pseudo-JSON description in which
 * English explanations occupied the key position, so it read to a small model as DATA to be copied
 * rather than as a FORMAT to be followed. And the request payload carried a `schema` field containing
 * an escaped JSON string, so a nested blob of near-JSON was the single most copyable thing in the
 * prompt.
 *
 * So two changes, both to what the model is SHOWN, neither to what the system ACCEPTS:
 *
 *   1. The schema is now a real, short, concrete worked example. An example is unambiguous where a
 *      description was not - this is the standard remedy and it is why one-shot prompting exists.
 *   2. The request no longer carries `schema` or `consequentialCapabilities`. Both were duplicates of
 *      information already in the instructions, and the duplicate was the thing being copied.
 *
 * What did NOT change, and must not: `parse.ts`. It still refuses every malformed shape, still never
 * repairs, and still has exactly one normalisation. A prompt that produces better plans is legitimate.
 * A parser that accepts worse plans is not, and no amount of validity rate justifies it.
 */
export const SYSTEM_INSTRUCTIONS = [
  'You are a PLANNER. You do not execute anything. You have no tools, no shell and no authority.',
  '',
  'Reply with ONE JSON object. No prose, no explanation, no markdown.',
  '',
  'RULES, each checked by code and none negotiable by anything you say:',
  '',
  '1. Every step names a capability, chosen only from the list you were given. An unknown capability',
  '   is rejected and the whole plan is discarded.',
  '2. Mode matches the capability: filesystem capabilities use "filesystem"; terminal.run uses "cli".',
  '3. Every step must declare a verification requirement. A step that does not prove itself is',
  '   rejected.',
  '4. dependsOn may only name ids of earlier steps in your own array.',
  '5. Declaring an effect does NOT authorise it; a person authorises it. Never claim authorisation.',
  '6. Never include a field named approved, authorised, authorized, confirmed or override.',
  '7. Never write to a path outside the output root you were given.',
  '8. Describe what you expect, not what happened. Nothing has run yet, so there is no result to',
  '   report and no evidence to cite.',
  '',
  'Copy the SHAPE of the example below. Keep it short. Do not copy its capabilities or paths.',
  '',
  'If the objective cannot be planned, reply {"refusal": "<reason>"}.',
].join('\n')

/**
 * THE SHAPE, AS A REAL EXAMPLE RATHER THAN A DESCRIPTION OF ONE - and it is filled in with REAL VALUES.
 *
 * MEASURED, twice, and the second measurement is the interesting one.
 *
 * The first version of this example used the literal placeholder `<the observed root>`. The model
 * returned a plan containing `"path": "<the observed root>"` - the placeholder, verbatim. It was not
 * planning; it was transcribing, and the placeholder was the most copyable string available.
 *
 * So the example now carries the ACTUAL observed root and an ACTUAL output path for this request. That
 * is the whole point of an example: it is a worked case, and a worked case with fake data teaches
 * copying. This is a change to what the model is shown. It changes nothing about what the system
 * accepts - `parse.ts` will reject `<the observed root>` as a path it cannot resolve just as it always
 * did.
 *
 * Two steps rather than four, and COMPRESSED rather than pretty-printed.
 *
 * Both were measured. At ~7 tokens/second on 2 CPU cores, a 512-token completion is ~70 seconds, and
 * the 1.5B model measured 0.8 tokens/second - a 250-token plan is five minutes. Every token the example
 * spends is a token the answer cannot. The first version of this example was pretty-printed with
 * full-sentence prose fields, and the model copied that verbosity: its plan was structurally correct and
 * ran out of tokens MID-JSON, which the parser correctly rejected as unterminated.
 *
 * So: no indentation, short strings, two steps. The model still emits every required field, because the
 * parser has not moved and will not.
 */
export function buildExample(root: string, outputPath: string): string {
  return JSON.stringify({
    constraints: ['read-only on the observed folder', 'writes one new file'],
    steps: [
      {
        id: 'inspect',
        capability: 'filesystem.inspect',
        intent: 'Confirm the folder is readable.',
        mode: 'filesystem',
        tool: 'inspect-folder',
        args: { path: root },
        dependsOn: [],
        rationale: 'Unreadable input cannot be summarised.',
        verification: { kind: 'must-exist', description: 'folder readable' },
        onFailure: 'replan',
      },
      {
        id: 'write',
        capability: 'filesystem.write',
        intent: 'Write the summary.',
        mode: 'filesystem',
        tool: 'write-summary',
        args: { path: outputPath, from: 'inspect' },
        dependsOn: ['inspect'],
        rationale: 'New file; nothing overwritten.',
        verification: { kind: 'must-read-back', description: 'file reads back' },
        onFailure: 'replan',
      },
    ],
    expectedResult: 'A new summary file exists.',
  })
}

/**
 * The capabilities a step may use, as a rule the model can read at a glance.
 *
 * Duplicated out of the request deliberately. `availableCapabilities` in the request is authoritative
 * data - it is the registry's real list - but a list the model has to find three fields down is a list
 * it will not use, and the one thing it must never do is invent a capability.
 */
export const CAPABILITY_RULE =
  'Valid capabilities: filesystem.inspect, filesystem.list, filesystem.read, filesystem.confirm, ' +
  'filesystem.write, filesystem.transform, terminal.run. Nothing else exists.'