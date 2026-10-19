/**
 * THE OPENCODE ADAPTER — the boundary between AIOS and OpenCode.
 *
 * ============================================================================================
 * WHY A CLI AND NOT THE HTTP API
 * ============================================================================================
 *
 * OpenCode v2.0.25 exposes `run --format json`, which prints a STREAM OF NEWLINE-DELIMITED JSON
 * EVENTS (`step_start`, `text`, `step_finish`, ...) and exits. That is verified working on this
 * machine: a bounded probe returned correct text in 3.5s with a session id.
 *
 * The HTTP server (`serve`, `api`) was rejected as the primary path for a concrete reason, not a
 * stylistic one: a long-lived server is another process to supervise, another port to secure, and
 * another thing that can be left holding a stale session. `run` owns its own lifetime, returns a
 * process exit code, and cannot outlive its task. For an orchestrator that must survive restarts,
 * a self-terminating subprocess is the smaller thing that can fail.
 *
 * `serve` remains available for a future always-on integration, and the adapter below is the ONLY
 * place that would change if that happens. Nothing else in the orchestrator knows how OpenCode is
 * invoked.
 *
 * ============================================================================================
 * THE CONTRACT THIS EXPOSES
 * ============================================================================================
 *
 * `runTask` returns TEXT plus the session id, the evidence events, the exit code and the elapsed
 * time. It never returns a boolean "succeeded" - the caller decides what evidence means, because a
 * zero exit code is not a result (the same lesson the mission engine learned).
 *
 * No credential is read, stored, or logged here. Model selection is a caller-supplied string.
 */

import { spawn } from 'node:child_process'

/** Where the verified OpenCode CLI lives on this machine. Overridable, never discovered by search. */
export const DEFAULT_OPENCODE_CLI =
  'C:\\Users\\Samer\\AppData\\Local\\Programs\\@opencodedesktop\\resources\\opencode-cli.exe'

export interface OpenCodeRunOptions {
  readonly cliPath?: string
  readonly model: string
  /** Working directory the agent works in. This is the blast radius. */
  readonly cwd: string
  readonly message: string
  readonly timeoutMs: number
  /** Continue a prior session, so a bounded review cycle builds on what came before. */
  readonly sessionId?: string
  /** A fresh title, so a run is identifiable in `opencode session`. */
  readonly title?: string
  /**
   * Auto-approve permissions the agent has not been explicitly denied.
   *
   * Off by default and left off for anything that edits files, because auto-approval is the single
   * flag that turns a bounded task into an unbounded one. A caller that wants unattended work sets
   * it deliberately, per task, and that choice is recorded in the orchestrator's evidence.
   */
  readonly autoApprove?: boolean
}

export interface OpenCodeResult {
  readonly ok: boolean
  /** The assistant's visible text, concatenated from the `text` events. */
  readonly text: string
  readonly sessionId: string
  readonly exitCode: number | null
  readonly elapsedMs: number
  /** Every parsed event, kept as evidence. Malformed lines are counted, not thrown away. */
  readonly events: unknown[]
  readonly unparsedLines: number
  readonly stderr: string
  /** A refusal rather than a result: the CLI could not be run at all. */
  readonly failure?: string
}

/**
 * One `opencode run`, bounded by a timeout, with its output parsed into evidence.
 *
 * NEVER THROWS for a task-level failure. A model that declines, a non-zero exit and a timeout are
 * all OUTCOMES the caller records; only an unusable adapter (no CLI) is an error, and that is
 * reported as `failure` rather than thrown so a whole queue can survive one bad adapter.
 */
export async function runTask(opts: OpenCodeRunOptions): Promise<OpenCodeResult> {
  const cli = opts.cliPath ?? DEFAULT_OPENCODE_CLI
  const args = ['run', '--format', 'json', '--model', opts.model]
  if (opts.sessionId) args.push('--session', opts.sessionId)
  if (opts.title) args.push('--title', opts.title)
  if (opts.autoApprove) args.push('--auto')
  args.push(opts.message)

  const started = Date.now()
  return await new Promise<OpenCodeResult>((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(cli, args, {
        cwd: opts.cwd,
        shell: false,
        windowsHide: true,
        env: { ...process.env, NO_COLOR: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (e) {
      resolve(base(opts, started, {
        failure: `could not start the OpenCode CLI at ${cli}: ${(e as Error).message}`,
      }))
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false

    const finish = (r: OpenCodeResult) => {
      if (settled) return
      settled = true
      resolve(r)
    }

    const timer = setTimeout(() => {
      try { child.kill() } catch { /* already gone */ }
      finish(base(opts, started, {
        exitCode: null,
        stderr,
        failure: `exceeded ${opts.timeoutMs}ms and was terminated`,
      }))
    }, opts.timeoutMs)

    child.stdout?.on('data', (d) => { if (stdout.length < 8_000_000) stdout += d })
    child.stderr?.on('data', (d) => { if (stderr.length < 200_000) stderr += d })

    child.on('error', (e) => {
      clearTimeout(timer)
      finish(base(opts, started, { stderr, failure: `the CLI could not be run: ${e.message}` }))
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      finish(base(opts, started, { exitCode: code, stderr, stdout }))
    })
  })
}

function base(
  opts: OpenCodeRunOptions,
  started: number,
  extra: { stdout?: string; stderr?: string; exitCode?: number | null; failure?: string },
): OpenCodeResult {
  const events: unknown[] = []
  let text = ''
  let sessionId = ''
  let unparsed = 0

  for (const line of (extra.stdout ?? '').split(/\r?\n/)) {
    const t = line.trim()
    if (!t || !t.startsWith('{')) continue
    let ev: Record<string, unknown>
    try {
      ev = JSON.parse(t) as Record<string, unknown>
    } catch {
      // A malformed line is counted and skipped. Throwing here would lose every good event after
      // it, and a partially-readable stream is more evidence than none.
      unparsed++
      continue
    }
    events.push(ev)
    if (typeof ev.sessionID === 'string' && !sessionId) sessionId = ev.sessionID
    const part = ev.part as Record<string, unknown> | undefined
    if (part && part.type === 'text' && typeof part.text === 'string') text += part.text
  }

  return {
    ok: extra.failure === undefined && extra.exitCode === 0,
    text,
    sessionId,
    exitCode: extra.exitCode ?? null,
    elapsedMs: Date.now() - started,
    events,
    unparsedLines: unparsed,
    stderr: extra.stderr ?? '',
    ...(extra.failure ? { failure: extra.failure } : {}),
  }
}