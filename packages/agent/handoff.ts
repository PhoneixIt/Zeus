/**
 * THE CHATGPT <-> OPENCODE HANDOFF.
 *
 * =============================================================================
 * WHAT THIS IS, HONESTLY
 * =============================================================================
 *
 * A file-based mailbox plus a validator, driven by the LOCAL OpenCode CLI. There is no API
 * here that lets ChatGPT post a message into a running OpenCode session, because none was
 * found: the tool surface exposes session_move, session_rename and model search, and nothing
 * that sends a message. So this does not pretend otherwise.
 *
 * What it DOES do is remove the manual step that actually costs time. Today a task moves
 * from ChatGPT to OpenCode by a human selecting text, pasting it, and copying the answer
 * back by hand - and that hand-transcription is lossy in both directions. This makes the
 * handoff a FILE:
 *
 *   1. ChatGPT (or anything) writes a bounded TASK JSON into `inbox/`.
 *   2. `handoff claim` takes the oldest unclaimed task, marks it claimed, and prints it.
 *   3. The OpenCode CLI is run with that task's message, in that task's cwd.
 *   4. The CLI's own JSON output is written into `outbox/<id>.result.json` - the receiving
 *      side's OWN words, not a human's transcription of them.
 *   5. `handoff verify` re-reads the result from disk and checks it against the task's
 *      acceptance criteria, and prints a verdict the other side can read.
 *
 * The single-writer rule is preserved structurally: a task is CLAIMED with an atomic rename,
 * so two workers cannot both take it, and `verify` never executes anything - it only reads
 * and checks. Nothing here runs a task; `claim` and `verify` are pure mailbox operations.
 *
 * WHY JSON AND NOT A PROMPT STRING
 *
 * A task carries an acceptance criterion. If the answer is a wall of prose, nothing
 * mechanical can say whether it succeeded. The result envelope records exit status, session
 * id and the assistant's text, and `verify` compares the declared outcome against the task's
 * declared evidence requirement. A human reading the chat can see the same verdict.
 *
 * =============================================================================
 * SECURITY
 * =============================================================================
 *
 * `autoApprove` defaults to FALSE and is not settable from the task file. Auto-approval turns
 * a bounded task into an unbounded one, and that decision belongs to whoever starts the work,
 * not to whatever wrote the JSON.
 *
 * `cwd` is the blast radius and is recorded in the result. The validator reports the blast
 * radius rather than assuming it.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join, resolve, isAbsolute } from 'node:path'
import { homedir } from 'node:os'

// ============================================================ the contract

export interface HandoffTask {
  /** Stable id, unique. Used as the filename, so it must be filename-safe. */
  readonly id: string
  /**
   * Ties a task, its result, and whatever the task produced together.
   *
   * The run id is not an alias for the task id: a task can be claimed once and answered once,
   * but one task may produce several artefacts that must be attributable to the same request.
   * The receiving side copies this into its result, and `verifyResult` refuses a result whose
   * correlation id does not match - so a result cannot be filed against the wrong task even if
   * the file names were mixed up somewhere upstream.
   */
  readonly correlationId: string
  /** The single sentence of work. Bounded on purpose. */
  readonly request: string
  /** Where the work happens. This is the blast radius, and it is recorded in the result. */
  readonly cwd: string
  /** What the receiving side must be able to show to count as done. */
  readonly acceptance: string
  /** Optional, caller-supplied. Never auto-approved here. */
  readonly model?: string
  readonly timeoutMs?: number
  readonly createdAt?: number
}

export interface HandoffClaim {
  readonly task: HandoffTask
  readonly path: string
  readonly claimedAt: number
}

export interface HandoffResult {
  readonly taskId: string
  /** Must equal the task's correlationId. Checked, not assumed. */
  readonly correlationId: string
  readonly cwd: string
  /** The CLI's own answer, not a human's transcription of it. */
  readonly text: string
  readonly sessionId: string
  readonly exitCode: number | null
  readonly elapsedMs: number
  /** A refusal rather than a result: the CLI could not be run at all. */
  readonly failure?: string
  readonly claimedAt: number
  readonly finishedAt: number
  /** The receiving side's own claim about whether the acceptance criterion was met. */
  readonly selfReport: {
    readonly met: boolean
    readonly evidence: string
  }
}

export interface Verification {
  readonly taskId: string
  readonly verdict: 'accepted' | 'rejected' | 'missing'
  readonly reason: string
}

// ============================================================ the mailbox

export const DEFAULT_MAILBOX = join(homedir(), '.aios', 'handoff')

const inDir = (root: string) => join(root, 'inbox')
const claimedDir = (root: string) => join(root, 'claimed')
const outDir = (root: string) => join(root, 'outbox')

const ensure = (d: string) => mkdirSync(d, { recursive: true })

const SAFE_ID = /^[A-Za-z0-9._-]{1,80}$/

export function initMailbox(root = DEFAULT_MAILBOX): string {
  ensure(inDir(root)); ensure(claimedDir(root)); ensure(outDir(root))
  return root
}

/**
 * Parse and validate a task file. Returns a refusal rather than a throw: a malformed task
 * dropped in the inbox must not be able to stop the worker.
 */
export function parseTask(raw: string): { task?: HandoffTask; error?: string } {
  let j: unknown
  try { j = JSON.parse(raw) } catch (e) {
    return { error: `not valid JSON: ${e instanceof Error ? e.message : String(e)}` }
  }
  const t = j as Partial<HandoffTask>
  if (!t || typeof t !== 'object') return { error: 'not an object' }
  if (typeof t.id !== 'string' || !SAFE_ID.test(t.id)) {
    return { error: 'id must match [A-Za-z0-9._-]{1,80} - it becomes a filename' }
  }
  if (typeof t.request !== 'string' || t.request.trim().length === 0) {
    return { error: 'request must be a non-empty string' }
  }
  if (typeof t.correlationId !== 'string' || !SAFE_ID.test(t.correlationId)) {
    // Required, not optional. A task without one cannot be attributed to a result, which is
    // the entire point of carrying an id across the boundary.
    return { error: 'correlationId is required and must match [A-Za-z0-9._-]{1,80}' }
  }
  if (typeof t.cwd !== 'string' || !isAbsolute(t.cwd)) {
    return { error: 'cwd must be an absolute path - a relative one would resolve against whatever process happened to start' }
  }
  if (typeof t.acceptance !== 'string' || t.acceptance.trim().length === 0) {
    return { error: 'acceptance must be a non-empty string - without it nothing can be checked' }
  }
  if (t.model !== undefined && typeof t.model !== 'string') return { error: 'model must be a string' }
  // Fields are copied EXPLICITLY, not spread. A spread would carry through anything the writer
  // put in the JSON - including `autoApprove`, which turns a bounded task into an unbounded
  // one. Building the object field by field means an unknown key is simply not carried, and a
  // task file cannot widen its own permissions.
  return {
    task: {
      id: t.id,
      correlationId: t.correlationId,
      request: t.request,
      cwd: t.cwd,
      acceptance: t.acceptance,
      ...(typeof t.model === 'string' ? { model: t.model } : {}),
      ...(typeof t.timeoutMs === 'number' ? { timeoutMs: t.timeoutMs } : {}),
      createdAt: t.createdAt ?? Date.now(),
    },
  }
}

/**
 * Take the oldest unclaimed task, ATOMICALLY.
 *
 * The claim is a rename. Windows rename fails if the destination exists, so exactly one
 * worker can win the rename for a given file - which is how the single-writer rule is
 * enforced here rather than by convention.
 */
export function claimTask(root = DEFAULT_MAILBOX, opts: { now?: () => number } = {}): HandoffClaim | { error: string } {
  initMailbox(root)
  const now = opts.now ?? Date.now
  const files = readdirSync(inDir(root))
    .filter((f) => f.endsWith('.json'))
    .sort((a, b) => {
      // Oldest first, by the task's own createdAt where present.
      const at = (f: string) => {
        const r = parseTask(readFileSync(join(inDir(root), f), 'utf8'))
        return r.task?.createdAt ?? 0
      }
      return at(a) - at(b)
    })

  for (const f of files) {
    const from = join(inDir(root), f)
    const raw = readFileSync(from, 'utf8')
    const parsed = parseTask(raw)
    if (parsed.error) {
      // Park a malformed task where a human will see it, rather than blocking the queue.
      const bad = join(claimedDir(root), `INVALID-${f}`)
      try { renameSync(from, bad) } catch { /* another worker took it */ }
      continue
    }
    const to = join(claimedDir(root), f)
    try {
      renameSync(from, to)
    } catch {
      continue // another worker won this one; try the next
    }
    return { task: parsed.task!, path: to, claimedAt: now() }
  }
  return { error: 'no unclaimed task in the inbox' }
}

/**
 * Check a result against its task. READS ONLY - it never executes anything, so it is safe
 * for the sending side to call and cannot become a second writer.
 */
export function verifyResult(task: HandoffTask, resultRaw: string): Verification {
  let r: HandoffResult
  try { r = JSON.parse(resultRaw) as HandoffResult }
  catch (e) {
    return { taskId: task.id, verdict: 'rejected', reason: `result is not valid JSON: ${e instanceof Error ? e.message : String(e)}` }
  }
  if (r.taskId !== task.id) {
    return { taskId: task.id, verdict: 'rejected', reason: `result is for "${r.taskId}", not "${task.id}"` }
  }
  if (r.correlationId !== task.correlationId) {
    // The correlation id is what binds a result to the request that caused it. If these
    // disagree, the result is describing some OTHER run, and no amount of otherwise-valid
    // content makes it an answer to this task.
    return {
      taskId: task.id,
      verdict: 'rejected',
      reason: `correlation id mismatch: the task is "${task.correlationId}", the result claims "${String(r.correlationId)}"`,
    }
  }
  if (r.failure) {
    return { taskId: task.id, verdict: 'rejected', reason: `the work could not be run: ${r.failure}` }
  }
  if (typeof r.exitCode === 'number' && r.exitCode !== 0) {
    return { taskId: task.id, verdict: 'rejected', reason: `the run exited ${r.exitCode}` }
  }
  // The receiving side must have answered the acceptance question with evidence, not vibes.
  if (!r.selfReport || typeof r.selfReport.met !== 'boolean') {
    return { taskId: task.id, verdict: 'rejected', reason: 'the result does not say whether acceptance was met' }
  }
  if (!r.selfReport.met) {
    return { taskId: task.id, verdict: 'rejected', reason: `the receiving side reported acceptance NOT met: ${r.selfReport.evidence}` }
  }
  if (!r.selfReport.evidence || r.selfReport.evidence.trim().length === 0) {
    return { taskId: task.id, verdict: 'rejected', reason: 'acceptance was claimed with no evidence' }
  }
  if (resolve(r.cwd) !== resolve(task.cwd)) {
    return { taskId: task.id, verdict: 'rejected', reason: `the work ran in ${r.cwd}, not the requested ${task.cwd}` }
  }
  return { taskId: task.id, verdict: 'accepted', reason: `acceptance met, evidence: ${r.selfReport.evidence}` }
}

export function readResult(root: string, taskId: string): string | undefined {
  const p = join(outDir(root), `${taskId}.result.json`)
  return existsSync(p) ? readFileSync(p, 'utf8') : undefined
}

export function writeTask(root: string, task: HandoffTask): string {
  initMailbox(root)
  if (!SAFE_ID.test(task.id)) throw new Error(`unsafe task id: ${task.id}`)
  const p = join(inDir(root), `${task.id}.json`)
  writeFileSync(p, JSON.stringify(task, null, 2), 'utf8')
  return p
}