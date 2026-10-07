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

/** The whole request. Everything the model is allowed to know. */
export interface ModelRequest {
  readonly objective: string
  /** Capabilities the router can serve. The model may only choose from these. */
  readonly availableCapabilities: readonly string[]
  /** The output root. Named explicitly so a model does not invent one. */
  readonly outputRoot: string
  /** A compact, factual rendering of the observation. NOT prose, NOT interpretation. */
  readonly world: {
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
  /** The capabilities that REQUIRE authorisation, so the model can declare honestly rather than be surprised. */
  readonly consequentialCapabilities: readonly string[]
  readonly schema: string
}

/** What the model must be told, in prose. Kept here so the request's meaning is auditable in one place. */
export const SYSTEM_INSTRUCTIONS = [
  'You are a PLANNER. You do not execute anything. You have no tools, no shell and no authority.',
  '',
  'You will receive an objective, an observation of a folder, and the list of capabilities this system',
  'can actually perform. You must return ONE JSON object and nothing else.',
  '',
  'RULES, each of which is checked and none of which is negotiable by anything you say:',
  '',
  '1. Choose a capability for every step, and choose only from the list you were given. An unknown',
  '   capability is rejected and the whole plan is discarded.',
  '2. Use the mode that matches the capability: filesystem capabilities are mode "filesystem", and',
  '   terminal.run is mode "cli".',
  '3. Every step must declare a verification requirement. A step that does not prove itself is',
  '   rejected.',
  '4. dependsOn may only name step ids that exist in your own plan, and must appear EARLIER in the',
  '   array than the step that depends on it.',
  '5. If any step is consequential, declare its effect. Declaring one does NOT authorise it; a person',
  '   authorises it separately. Do not attempt to authorise anything.',
  '6. Do not include a field named approved, authorised, authorized, confirmed or override. They are',
  '   ignored, and including one marks your output as untrustworthy.',
  '7. Do not write to any path outside the output root you were given.',
  '8. Describe what you expect, not what happened. Nothing has run yet, so there is no result to',
  '   report and no evidence to cite.',
  '',
  'If the objective cannot be planned from what you were shown, return {"refusal": "<reason>"}.',
].join('\n')

/** The JSON schema the model is asked to conform to. Also enforced by the parser. */
export const RESPONSE_SCHEMA = JSON.stringify({
  oneOf: [
    {
      refusal: 'string — why this objective cannot be planned from what you were shown',
    },
    {
      constraints: ['string'],
      steps: [{
        id: 'string, unique within the plan',
        capability: 'string, must be one of availableCapabilities',
        intent: 'string, one sentence a person will read',
        mode: 'filesystem | cli',
        tool: 'string, a registered tool name',
        args: 'object',
        dependsOn: ['string, ids of earlier steps'],
        rationale: 'string, what breaks without this step',
        verification: { kind: 'string', description: 'string' },
        onFailure: 'abort-mission | continue | replan',
        effect: 'optional: { kind, target, reason, irreversible }',
      }],
      expectedResult: 'string — what "done" will mean, in the user\'s terms',
    },
  ],
}, null, 2)