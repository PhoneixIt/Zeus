/**
 * THE REVIEWER — an independent second opinion on a change, behind a replaceable boundary.
 *
 * ============================================================================================
 * WHY THE INTERFACE EXISTS
 * ============================================================================================
 *
 * The orchestrator must be able to swap its implementation model and its reviewer without being
 * rewritten. Those are DIFFERENT concerns and they fail differently: the implementer is allowed to
 * edit, the reviewer is not. Collapsing them into one "agent" would make it impossible to state that
 * distinction in a type.
 *
 * A reviewer is given TEXT and returns TEXT. It has no repository handle, no write capability and
 * no path to the executor. That is not a promise about the implementation; it is the shape of the
 * dependency, and the shape is checkable.
 *
 * ============================================================================================
 * WHY A REVIEW IS NOT SELF-CERTIFICATION
 * ============================================================================================
 *
 * A reviewer that is the same model, on the same session, with the same context, will agree with the
 * implementer and call it a pass. So `Reviewer` implementations declare WHICH model they use, and
 * the orchestrator RECORDS that. A review by the same model is still recorded - it is a second pass,
 * not an independent one, and the record must not imply otherwise.
 *
 * ============================================================================================
 * CONTEXT IS DELIBERATE, NOT INHERITED
 * ============================================================================================
 *
 * A reviewer has no memory of this conversation, of the project's history, or of why a decision was
 * taken. Everything it can know is what `buildReviewRequest` put in the request. That function is
 * therefore part of the contract: a review is only as good as the context assembled for it, and a
 * reviewer with an empty context produces confident, ungrounded criticism.
 */

import { runTask, type OpenCodeResult } from './opencode-adapter.ts'

export interface ReviewRequest {
  /** What the task was. */
  readonly objective: string
  /** What the implementer actually did, in its own words. */
  readonly implementationNotes: string
  /** Real evidence: diffs, test output, logs. Never a summary of them. */
  readonly evidence: string
  /** Known project constraints a reviewer must not recommend breaking. */
  readonly constraints: readonly string[]
  /** Findings from an earlier round, when this is a re-review. */
  readonly previousFindings?: readonly string[]
  /**
   * How far the reviewer is allowed to go looking for evidence.
   *
   * Added after MEASUREMENT, not taste. Without it the reviewer behaves as a general agent: it
   * explores, and when the evidence it wants is absent - a test file that should exist and does not -
   * it keeps searching until the wall-clock bound kills it. On the first full evaluation that cost
   * 600s across two cases and produced `unavailable` instead of an opinion.
   *
   * The caller states what is authoritative. The reviewer is always still told to find what is wrong;
   * this only stops it from going somewhere the evidence has already settled.
   */
  readonly scopeNote?: string
}

export type ReviewVerdict = 'approve' | 'request-changes' | 'unavailable'

export interface ReviewResult {
  readonly verdict: ReviewVerdict
  readonly text: string
  /** Which model produced this. Recorded so an identical-model review is never read as independent. */
  readonly model: string
  readonly independent: boolean
  readonly elapsedMs: number
  readonly failure?: string
}

export interface Reviewer {
  readonly name: string
  readonly model: string
  /** True when this reviewer is NOT the same model that did the implementation. */
  readonly isIndependent: boolean
  review(request: ReviewRequest, cwd: string, timeoutMs: number): Promise<ReviewResult>
}

/**
 * Assemble the review request.
 *
 * EVIDENCE GOES IN WHOLE AND LABELLED. A reviewer told "the tests pass" reviews a claim; a reviewer
 * shown the output reviews a fact. The labels exist because an unlabelled block of output reads as
 * the reviewer's own material.
 */
export function buildReviewRequest(r: ReviewRequest): string {
  return [
    'You are an INDEPENDENT reviewer for the AIOS project. You did not write this code.',
    'Another agent implemented a task. Your job is to find what is WRONG with it.',
    '',
    'Look specifically for:',
    '  - claims in the notes that the evidence does not support',
    '  - tests that would pass even if the feature were absent (or missing entirely)',
    '  - security problems: unguarded paths, writes outside a sandbox, secrets in source or logs',
    '  - missing error handling on the paths a real user would hit',
    '  - behaviour that contradicts a stated constraint',
    '  - dead code, or an abstraction with one caller',
    '',
    'Do NOT rewrite the code. Report findings. Be specific and cite the evidence you are looking at.',
    'If you find nothing wrong, say so plainly rather than inventing a concern.',
    // SCOPE, because an unbounded reviewer is a slow one.
    //
    // MEASURED: with no scope statement the reviewer runs as a general agent and EXPLORES. On the case
    // "the task required a test and no test file exists" it searched for one, did not find one, and
    // kept searching until the 300s wall killed it - returning `unavailable` on exactly the cases
    // that mattered most. Two of six cases died that way, costing 600s and proving nothing.
    //
    // The instruction is to reason from the evidence given and not to go looking. It is a scope
    // statement, not a weaker standard: the reviewer is still told to find what is WRONG.
    ...(r.scopeNote ? ['', '=== SCOPE ===', r.scopeNote] : []),
    '',
    '=== TASK ===',
    r.objective,
    '',
    '=== CONSTRAINTS THAT MUST HOLD ===',
    ...r.constraints.map((c) => `  - ${c}`),
    '',
    '=== IMPLEMENTER\'S NOTES (claims, not facts) ===',
    r.implementationNotes || '(none supplied)',
    '',
    '=== EVIDENCE (facts) ===',
    r.evidence || '(no evidence supplied - treat every claim above as unverified)',
    ...(r.previousFindings?.length
      ? ['', '=== FINDINGS FROM THE PREVIOUS ROUND ===', ...r.previousFindings.map((f) => `  - ${f}`)]
      : []),
    '',
    'End your reply with a line of exactly this form:',
    'VERDICT: approve   OR   VERDICT: request-changes',
    'and then one line:',
    'HIGHEST PRIORITY FINDING: <one sentence, or NONE>',
  ].join('\n')
}

/** Read a verdict out of the review text. Absent an explicit line, it is NOT an approval. */
export function readVerdict(text: string): ReviewVerdict {
  const m = /VERDICT:\s*(approve|request-changes)/i.exec(text)
  if (!m) return 'request-changes'
  return m[1]!.toLowerCase() === 'approve' ? 'approve' : 'request-changes'
}

/**
 * Compare two model ids for identity, ignoring the provider prefix.
 *
 * `opencode/space-bunny-free` and `space-bunny-free` name the same model. Treating a difference in
 * spelling as a difference in model would let a caller manufacture independence by reformatting a
 * name, which is exactly the claim this function exists to keep honest.
 */
export function normalizeModelId(id: string): string {
  const i = id.lastIndexOf('/')
  return (i === -1 ? id : id.slice(i + 1)).trim().toLowerCase()
}

/**
 * A reviewer that runs through the OpenCode CLI with no repository write access.
 *
 * `isIndependent` is DERIVED, not asserted.
 *
 * It used to be a constructor argument, which meant any caller could claim independence by passing
 * `true`. Independence here has a precise meaning - the reviewer is a DIFFERENT MODEL from the one
 * that wrote the code, so a shared blind spot cannot produce a self-confirming approval - and that is
 * a fact about two model names, not something a caller should be able to declare.
 *
 * `OpenCodeReviewer.build({ reviewerModel, implementerModel })` computes it. A caller who disagrees
 * can still construct directly, but then they own the claim, and `independent` in the record will not
 * match what the comparison says.
 */
export class OpenCodeReviewer implements Reviewer {
  readonly name: string
  readonly model: string
  readonly isIndependent: boolean

  constructor(opts: { model: string; name?: string; isIndependent?: boolean; cliPath?: string }) {
    this.model = opts.model
    this.name = opts.name ?? `opencode:${opts.model}`
    // Undefined means "unknown", and unknown is NOT independent. Defaulting it to true would let a
    // caller who forgot to say anything be recorded as an independent review.
    this.isIndependent = opts.isIndependent ?? false
    this.cliPath = opts.cliPath
  }
  private readonly cliPath?: string

  /**
   * Build a reviewer and DERIVE whether it is independent.
   *
   * Independence is `reviewerModel !== implementerModel`, compared as whole ids so
   * `opencode/space-bunny-free` and `space-bunny-free` are the same model and two spellings of it do
   * not manufacture an independent reviewer.
   */
  static build(opts: { reviewerModel: string; implementerModel: string; name?: string; cliPath?: string }): OpenCodeReviewer {
    const same = normalizeModelId(opts.reviewerModel) === normalizeModelId(opts.implementerModel)
    return new OpenCodeReviewer({
      model: opts.reviewerModel,
      ...(opts.name ? { name: opts.name } : {}),
      isIndependent: !same,
      ...(opts.cliPath ? { cliPath: opts.cliPath } : {}),
    })
  }

  async review(request: ReviewRequest, cwd: string, timeoutMs: number): Promise<ReviewResult> {
    const started = Date.now()
    const res: OpenCodeResult = await runTask({
      model: this.model,
      cwd,
      message: buildReviewRequest(request),
      timeoutMs,
      title: `aios-review-${Date.now()}`,
      // Deliberately NOT auto-approve: a reviewer has no business taking an action.
    })
    if (!res.ok && res.failure) {
      return {
        verdict: 'unavailable', text: '', model: this.model,
        independent: this.isIndependent, elapsedMs: Date.now() - started, failure: res.failure,
      }
    }
    return {
      verdict: readVerdict(res.text),
      text: res.text,
      model: this.model,
      independent: this.isIndependent,
      elapsedMs: Date.now() - started,
    }
  }
}

/**
 * A reviewer that calls an OpenAI-compatible HTTP endpoint.
 *
 * HONESTLY CONFIGURED OR HONESTLY ABSENT. With no key it returns `unavailable` and says why, rather
 * than throwing or - worse - silently falling back to the implementer and calling the result a
 * review. The API is also a DIFFERENT SERVICE from this conversation: it inherits no memory of the
 * project, so `buildReviewRequest` must carry the whole context.
 */
export class OpenAICompatibleReviewer implements Reviewer {
  readonly name: string
  readonly model: string
  readonly isIndependent = true
  // An explicit field rather than a parameter property; see orchestrator.ts for why this repository
  // cannot use `constructor(private readonly ...)`.
  private readonly opts: { baseUrl: string; apiKey: string | undefined; model: string; name?: string }

  constructor(opts: { baseUrl: string; apiKey: string | undefined; model: string; name?: string }) {
    this.opts = opts
    this.model = opts.model
    this.name = opts.name ?? `openai-compatible:${opts.model}`
  }

  async review(request: ReviewRequest, _cwd: string, timeoutMs: number): Promise<ReviewResult> {
    const started = Date.now()
    if (!this.opts.apiKey) {
      return {
        verdict: 'unavailable',
        text: '',
        model: this.model,
        independent: true,
        elapsedMs: 0,
        failure: 'no API key is configured; this reviewer was NOT exercised and its verdict does not exist',
      }
    }
    try {
      const res = await fetch(`${this.opts.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.opts.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          temperature: 0,
          messages: [{ role: 'user', content: buildReviewRequest(request) }],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!res.ok) {
        return {
          verdict: 'unavailable', text: '', model: this.model, independent: true,
          elapsedMs: Date.now() - started, failure: `endpoint answered ${res.status}`,
        }
      }
      const json = await res.json() as { choices?: { message?: { content?: string } }[] }
      const text = json.choices?.[0]?.message?.content ?? ''
      return {
        verdict: readVerdict(text), text, model: this.model,
        independent: true, elapsedMs: Date.now() - started,
      }
    } catch (e) {
      return {
        verdict: 'unavailable', text: '', model: this.model, independent: true,
        elapsedMs: Date.now() - started, failure: (e as Error).message,
      }
    }
  }
}