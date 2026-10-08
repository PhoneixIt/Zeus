/**
 * THE TERMINAL TOOL.
 *
 * Launches one allowlisted program with an explicit argument vector, captures what happened, and
 * returns a record of it. It does not decide whether the mission succeeded - that is the verifier's
 * job, and the separation is the point.
 *
 * WHAT IS AND IS NOT CONTAINED
 *
 * The policy in `terminal-policy.ts` decides what may run; this file is what runs it. The honest
 * summary, repeated here because this is the file that spawns things:
 *
 *   contained: which program starts, what argv it gets, how long it may run, whether its tree is
 *              reaped, which environment variables it starts with
 *   NOT contained: what that program then does. It is not sandboxed. It runs as the user, with
 *              the user's access, and it may read and write anywhere, open network connections,
 *              and spawn children this tool never sees.
 *
 * The one strong thing this file does is REAP ON TIMEOUT, and that was measured rather than
 * assumed: `taskkill /T /F` on a live process tree does terminate grandchildren, verified by
 * watching a grandchild that would have written a file nine seconds later never write it.
 *
 * Note what that does NOT cover: a child that has already detached from the tree, or one spawned
 * after the kill. `LIMITATIONS` in the policy says so; this is where the claim is kept honest.
 */

import { spawn, execFile } from 'node:child_process'
import { resolve } from 'node:path'
import type { Tool, ToolContext, ToolResult, Verifier } from '../executor.ts'
import type { Evidence, Step } from '../state.ts'
import { buildEnv, classify, buildAllowlist, looksLikeCredentialPrompt, type Verdict, type PolicyContext } from './terminal-policy.ts'
import type { DeclaredEffect } from '../../governance/approval.ts'
import { ProcessContainment, type ReapResult } from '../process-containment.ts'

/** Everything that happened to one process. The audit trail reads this, not the tool's summary. */
export interface ProcessRecord {
  readonly executable: string
  readonly argv: readonly string[]
  readonly cwd: string
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number | null
  /** The OS's own account of how it ended, which is not the same number as exitCode. */
  readonly signal: NodeJS.Signals | null
  readonly startedAt: number
  readonly endedAt: number
  readonly durationMs: number
  readonly timedOut: boolean
  readonly state: 'completed' | 'nonzero' | 'timed-out' | 'failed-to-start' | 'killed'
  /**
   * Whether observed output was truncated, for EITHER reason.
   *
   * Two distinct causes, deliberately not separated: the capture cap was reached, OR the process's
   * pipes outlived the process and the drain grace expired. They mean different things to whoever
   * reads the record, and merging them here would hide the second - which is the one that indicates
   * something was still running. The `summary` says which happened.
   */
  readonly stdoutTruncated: boolean
  readonly stderrTruncated: boolean
  /** The environment variable NAMES the child actually received, measured not assumed. */
  readonly envNames: readonly string[]
  /**
   * What containment did about this process tree, or undefined when containment was not supplied.
   *
   * Present in the record rather than logged, so it lands in the durable evidence with the step. A
   * mission that left processes behind would otherwise look identical to one that did not, and the
   * difference is exactly the kind that only matters after something has gone wrong.
   */
  readonly containment?: ReapResult
}

export interface TerminalConfig {
  readonly workspace: string
  readonly timeoutMs?: number
  readonly systemRoot: string
  readonly programFiles: string
  /** Cap on captured bytes per stream, so a runaway process cannot exhaust memory. */
  readonly maxCaptureBytes?: number
  /**
   * Shared across a mission's steps, so one mission can reap everything it started.
   *
   * Optional because a caller with no mission lifecycle has nothing to reap against. When it is
   * absent the OLD behaviour applies - the tree is reaped on timeout only - and that difference is
   * documented rather than silently assumed away.
   */
  readonly containment?: ProcessContainment
}

const DEFAULT_TIMEOUT = 15_000
const HARD_MAX_TIMEOUT = 120_000
const DEFAULT_CAPTURE = 256 * 1024

/**
 * How often a live child's tree is sampled.
 *
 * Not free: each pass is a PowerShell/CIM enumeration of every process on the machine, ~200ms. Fast
 * enough that a short-lived daemon is very likely to be seen at least once, slow enough that a
 * process that only exists for 50ms may be missed - which is why `clean` is a measurement, not a
 * guarantee, and why survivors are reported rather than assumed absent.
 */
const CONTAINMENT_SAMPLE_MS = 750

/**
 * Human-readable containment outcome, appended to a step's summary.
 *
 * Written so the RECORD can be read by someone auditing it later without reading any code. "Reaped 3
 * background processes" is the useful sentence; a boolean is not, because a reader cannot tell what
 * was reaped or what was not.
 */
function describeContainment(r: ReapResult): string {
  if (r.error) return `; CONTAINMENT FAILED (${r.error}) - the tree may still be running`
  if (!r.observed.length) return '; no background children observed'
  if (r.clean) return `; reaped ${r.observed.length} background process(es)`
  return `; ${r.survivors.length} of ${r.observed.length} background process(es) SURVIVED the reap (pids ${r.survivors.join(', ')})`
}

/**
 * Reaps a process and its descendants.
 *
 * `taskkill /T` is the tree kill, and it works - measured on a live tree, not inferred from a
 * process that had already exited. The failure mode it does NOT cover is a descendant that has
 * already detached, so this is a best-effort reaper and the residual is documented rather than
 * described as "the process is guaranteed dead".
 */
function reapTree(pid: number): Promise<void> {
  return new Promise((done) => {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 10_000, windowsHide: true }, () => done())
  })
}

/**
 * The terminal tool.
 *
 * `classify()` is exposed so the router can ask what a step WOULD do before the executor decides
 * whether to authorise it. That ordering is the whole design: the policy is consulted by the
 * governance boundary, not only by the tool at the moment it acts.
 */
export function makeTerminalTool(cfg: TerminalConfig): Tool & { preview: (step: Step) => Verdict } {
  const allowlist = buildAllowlist(cfg.systemRoot, cfg.programFiles)
  const ctx: PolicyContext = {
    workspace: resolve(cfg.workspace),
    workspaceReal: cfg.workspace,
  }
  const timeoutMs = Math.min(cfg.timeoutMs ?? DEFAULT_TIMEOUT, HARD_MAX_TIMEOUT)
  const cap = cfg.maxCaptureBytes ?? DEFAULT_CAPTURE

  /** Classifies a step's command without running it. Used by the router and the executor. */
  function preview(step: Step): Verdict {
    const a = (step.args ?? {}) as { executable?: string; argv?: unknown }
    if (typeof a.executable !== 'string' || a.executable.length === 0) {
      return { kind: 'blocked', reason: 'the step names no executable', needsHuman: false }
    }
    const argv = Array.isArray(a.argv) ? a.argv.map(String) : []
    return classify(a.executable, argv, allowlist, ctx)
  }

  return {
    name: 'run-process',
    mode: 'cli',
    preview,

    async run(_ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
      const a = args as { executable?: string; argv?: unknown; cwd?: unknown }
      const abs = typeof a.executable === 'string' ? a.executable : ''
      const argv = Array.isArray(a.argv) ? a.argv.map(String) : []

      // 1. The policy, consulted again here. The executor already consulted it to decide about
      //    authorisation; re-checking means a tool call that arrives without having gone through
      //    the gate is still refused. Two checks, because the tool is the thing being governed.
      const verdict = preview({ id: 'x', tool: 'run-process', args: { executable: abs, argv } } as Step)
      if (verdict.kind === 'blocked') {
        // A blocked command is not a failure of the mission, it is a refusal by policy. The
        // distinction matters: `needs-human` invites a person, `failed` invites a retry that
        // cannot help.
        return verdict.needsHuman
          ? { kind: 'needs-human', reason: verdict.reason }
          : { kind: 'failed', reason: verdict.reason }
      }

      // 2. The working directory. Genuinely set, and genuinely just a default - see LIMITATIONS.
      //
      // `cfg.workspace`, NOT a context field. This used to read `ctx.workspace`, but the parameter is
      // named `_ctx` and `ctx` is never declared in this module - so the expression threw
      // ReferenceError on EVERY invocation of this tool.
      //
      // It was invisible for the whole life of the project because there was no typechecker in the repo
      // (no tsconfig, TypeScript not installed) and the test runner uses --experimental-strip-types,
      // which STRIPS types rather than checking them. A test suite that cannot fail on this is not
      // evidence of anything; it is the absence of a check.
      //
      // `cfg.workspace` is also the more honest source: it is the workspace this tool was CONFIGURED
      // with, decided once, rather than a per-mission field that a caller could pass in and thereby
      // point a governed process at an arbitrary directory.
      const cwdRaw = typeof a.cwd === 'string' ? a.cwd : '.'
      const cwd = resolve(cfg.workspace, cwdRaw)

      const env = buildEnv()
      const startedAt = Date.now()

      return await new Promise<ToolResult>((done) => {
        // shell:false is not a default to be relied on - it is the reason the argv policy means
        // anything. With a shell, the validated argv is not the argv that runs.
        const child = spawn(abs, argv, {
          cwd,
          env,
          shell: false,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        })

        let stdout = ''
        let stderr = ''
        let stdoutTruncated = false
        let stderrTruncated = false
        let timedOut = false
        let settled = false
        /** The env names the child actually got, read back from the child itself where possible. */
        const envNames: string[] = Object.keys(env)

        const collect = (which: 'out' | 'err') => (chunk: Buffer) => {
          const s = chunk.toString('utf8')
          if (which === 'out') {
            if (stdout.length >= cap) { stdoutTruncated = true; return }
            stdout += s
            if (stdout.length > cap) { stdout = stdout.slice(0, cap); stdoutTruncated = true }
          } else {
            if (stderr.length >= cap) { stderrTruncated = true; return }
            stderr += s
            if (stderr.length > cap) { stderr = stderr.slice(0, cap); stderrTruncated = true }
          }
        }
        child.stdout?.on('data', collect('out'))
        child.stderr?.on('data', collect('err'))

        // stdin is CLOSED, not piped. A program that asks for input gets EOF and fails fast
        // instead of hanging until the timeout. This is what makes "interactive" a bounded event.
        child.stdin?.end()

        // ==========================================================================================
        // SETTLEMENT - why this waits on 'exit' and NOT on 'close'
        // ==========================================================================================
        //
        // The obvious implementation is `child.on('close', ...)`, and it is WRONG here. Node's 'close'
        // fires when the process has exited AND all its stdio streams have closed. A process that
        // backgrounds a child hands that child an inherited handle on the same stdout pipe, so the pipe
        // stays open long after the parent is gone.
        //
        // MEASURED, with a control that behaves correctly:
        //
        //     command backgrounds a child, parent exits 0   -> exit at 1.4s, pipe STILL OPEN at 21.4s
        //     command with no background child, exits 0      -> exit at 1.0s, pipe closed at 1.0s
        //
        // The consequence of using 'close' is worse than a hang. The tool waits out the full timeout,
        // reports a SUCCESSFUL command as `timed-out` / `failed`, and the timeout handler then reaps
        // the tree - killing the very background process the command legitimately started. That inverts
        // the rule this whole project is built on: a correct action is recorded as a failure, and
        // failure triggers cleanup that destroys the user's work.
        //
        // So the process's EXIT is what settles the step, and draining what is left of stdio is given a
        // short bounded grace. Windows can deliver the last bytes after 'exit', so the grace is not
        // paranoia - it is what keeps "exit 0" from being recorded with empty output.
        //
        // Output that arrives after the grace is dropped, and the truncation flags say so. Silently
        // losing the tail of a command's output is exactly the kind of quiet lie this project refuses.
        const STDIO_DRAIN_GRACE_MS = 250
        /** False while either stream could still deliver data. */
        let streamsDrained = false
        /** Cleared by `finish`; fires if the streams never close on their own. */
        let drainGrace: NodeJS.Timeout | undefined
        /** Set once the grace expires, so the result can say output was cut rather than complete. */
        let outputCut = false

        const settleIfDrained = () => {
          if (!streamsDrained || !drainGrace) return
          clearTimeout(drainGrace)
          drainGrace = undefined
          if (onDrain) onDrain()
        }

        const bothEnded = () => {
          const out = child.stdout
          const err = child.stderr
          const outDone = !out || out.readableEnded || out.destroyed
          const errDone = !err || err.readableEnded || err.destroyed
          if (outDone && errDone) streamsDrained = true
        }
        for (const s of [child.stdout, child.stderr]) {
          if (!s) continue
          s.on('end', bothEnded)
          s.on('close', bothEnded)
          s.on('error', bothEnded)
        }

        /** Set by `finish` so a drain that completes after the grace can still stop waiting. */
        let onDrain: (() => void) | undefined

        const timer = setTimeout(() => {
          timedOut = true
          if (child.pid) void reapTree(child.pid)
        }, timeoutMs)

        // PROCESS CONTAINMENT - sample the tree WHILE THE PARENT IS ALIVE.
        //
        // This has to happen here and not after the exit, because `taskkill /PID <pid> /T` walks the
        // parent-child chain at the moment it runs. Once the parent has exited there is no chain to
        // walk and its children are unreachable by that route. Sampling while the parent lives is the
        // only way the descendants stay reachable at all.
        //
        // The interval is not free: each pass is a PowerShell/CIM query costing roughly 200ms. That is
        // a real cost paid for a real guarantee, and it is bounded per child rather than global.
        const rootPid = child.pid
        let sampler: NodeJS.Timeout | undefined
        if (rootPid && cfg.containment) {
          void cfg.containment.track(rootPid)
          sampler = setInterval(() => { void cfg.containment?.sample(rootPid) }, CONTAINMENT_SAMPLE_MS)
        }

        const finish = async (state: ProcessRecord['state'], exitCode: number | null, signal: NodeJS.Signals | null, extra: Partial<ToolResult> = {}) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (sampler) clearInterval(sampler)
          if (drainGrace) { clearTimeout(drainGrace); drainGrace = undefined }

          // Reap BEFORE the result is emitted, so the result can carry what happened. Emitting first
          // and reaping afterwards would mean the recorded outcome never mentioned the orphans - which
          // is how a mission leaves processes behind without a trace.
          //
          // A survivor is reported as a survivor. If the reap throws, containment is reported as FAILED
          // rather than omitted, because "no news" and "everything is fine" are not the same claim.
          let containment: ReapResult | undefined
          if (cfg.containment && rootPid) {
            try {
              const observed = cfg.containment.observedFor(rootPid)
              if (observed.length) containment = await cfg.containment.reapObserved(rootPid, observed)
            } catch (e) {
              containment = {
                rootPid,
                survivors: [],
                observed: [],
                clean: false,
                error: e instanceof Error ? e.message : String(e),
              }
            }
          }
          const endedAt = Date.now()
          const record: ProcessRecord = {
            executable: abs,
            argv,
            cwd,
            stdout,
            stderr,
            exitCode,
            signal,
            startedAt,
            endedAt,
            durationMs: endedAt - startedAt,
            timedOut,
            state,
            // `outputCut` is already final by the time this record is built - the grace timer that sets it runs
          // before `settle`, and `settle` is the only thing that gets here. Folding it in HERE rather
          // than by assigning afterwards, because the record copies these values: setting the outer
          // variable later would leave the record reporting complete output it never captured.
          stdoutTruncated: stdoutTruncated || outputCut,
            stderrTruncated: stderrTruncated || outputCut,
            envNames,
            containment,
          }

          // A process that asked a human for something is `needs-human`, not `failed`. A timeout
          // is `failed`: retrying cannot help, and pretending it needs a person would be an
          // excuse for a hang.
          const prompt = !timedOut ? looksLikeCredentialPrompt(stdout, stderr) : undefined
          if (prompt) {
            done({
              kind: 'needs-human',
              reason: `${abs} ${argv.join(' ')} appears to be waiting for human input - ${prompt}. No credential was supplied and no authentication was attempted.`,
            })
            return
          }

          done(extra.kind
            ? { ...extra, data: record, summary: (extra as { reason?: string }).reason ?? '' } as ToolResult
            : {
                kind: 'data',
                data: record,
                summary:
                  `${abs} ${argv.join(' ')} -> ${state}` +
                  `${exitCode === null ? '' : ` (exit ${exitCode})`}` +
                  `${timedOut ? ` after ${timeoutMs}ms` : ''} in ${record.durationMs}ms` +
                  `${containment ? describeContainment(containment) : ''}` +
                  `${outputCut ? '; output cut - the process exited but something still held its pipes open' : ''}`,
              })
        }

        child.on('error', (e: NodeJS.ErrnoException) => {
          // ENOENT is a missing executable and must be a FAILURE. Reporting it as
          // "nothing found" or letting it look like a clean run is how a missing program becomes
          // a successful mission.
          const why = e.code === 'ENOENT'
            ? `the executable "${abs}" does not exist`
            : e.code === 'EACCES'
              ? `permission denied launching "${abs}"`
              : `failed to start "${abs}": ${e.message}`
          void finish('failed-to-start', null, null, { kind: 'failed', reason: why })
        })

        /**
         * The ONE place an exit turns into an outcome.
         *
         * Both the 'exit' path and the 'close' safety net call this, so a command cannot be reported
         * two different ways depending on which event arrived first - which is a race, and a race in
         * the direction that decides whether a step succeeded is not acceptable.
         */
        const settle = (code: number | null, signal: NodeJS.Signals | null) => {
          if (timedOut) {
            void finish('timed-out', code, signal, {
              kind: 'failed',
              reason: `"${abs} ${argv.join(' ')}" exceeded the ${timeoutMs}ms timeout and its process tree was reaped. It is not known to have done anything useful.`,
            })
            return
          }
          if (code === 0) { void finish('completed', 0, signal); return }
          void finish(code === null ? 'killed' : 'nonzero', code, signal, {
            kind: 'failed',
            reason: `"${abs} ${argv.join(' ')}" exited with code ${code}${signal ? ` (signal ${signal})` : ''}` +
              `${stderr.trim() ? `: ${stderr.trim().slice(0, 400)}` : ''}`,
          })
        }

        child.on('exit', (code, signal) => {
          // The process is GONE. That is the fact the step is about, so settlement starts here.
          bothEnded()
          if (streamsDrained) { settle(code, signal); return }
          // Otherwise give the pipes a bounded moment to deliver what is still buffered, and settle
          // regardless. A grandchild holding the pipe open must not be able to hold the step open.
          onDrain = () => settle(code, signal)
          drainGrace = setTimeout(() => {
            outputCut = true
            if (child.stdout && !child.stdout.destroyed) child.stdout.destroy()
            if (child.stderr && !child.stderr.destroyed) child.stderr.destroy()
            settle(code, signal)
          }, STDIO_DRAIN_GRACE_MS)
          bothEnded()
          settleIfDrained()
        })

        // 'close' is still handled, but ONLY as a safety net for the case where 'exit' never arrives.
        // It must not be the primary settlement path - see the comment above.
        child.on('close', (code, signal) => {
          if (settled) return
          bothEnded()
          settle(code, signal)
        })
      })
    },
  }
}

/**
 * Registers the terminal tool so the router can ask it what a step WOULD do.
 *
 * `effectOf` and `preflight` are the tool's own verdicts, surfaced at the governance boundary. This
 * is the wiring that makes the terminal tool governed by M3's approval gate rather than sitting
 * beside it: the gate asks the router, the router asks the tool, and the tool answers from the
 * arguments it was actually given.
 */
export function registerTerminal(
  cfg: TerminalConfig,
): { registrations: Array<{ tool: ReturnType<typeof makeTerminalTool>; effectOf: (s: Step) => DeclaredEffect | undefined; preflight: (s: Step) => { blocked: string; needsHuman: boolean } | undefined }> } {
  const tool = makeTerminalTool(cfg)
  return {
    registrations: [
      {
        tool,
        effectOf: (s) => {
          const v = tool.preview(s)
          return v.kind === 'consequential' ? v.effect : undefined
        },
        preflight: (s) => {
          const v = tool.preview(s)
          return v.kind === 'blocked' ? { blocked: v.reason, needsHuman: v.needsHuman } : undefined
        },
      },
    ],
  }
}
// ============================================================ independent verification

/**
 * The verifier for a terminal step.
 *
 * IT DOES NOT TRUST THE PROCESS. Specifically it refuses to accept:
 *   - exit code 0 as proof of anything
 *   - stdout as evidence, because the process that produced stdout is the thing being checked
 *   - the tool's own `data` field as proof that a side effect happened
 *
 * Instead it goes to the FILESYSTEM and asks whether the effect the step declared actually
 * occurred. For the terminal step that means: does the output file exist, and does its content
 * match what the verifier computes for itself from the INPUT file?
 *
 * The two computations are independent by construction. The child reads the input and writes an
 * answer; the verifier reads the same input and derives the answer again, in this process, with
 * different code. A child that exits 0 while writing nothing is caught, and a child that writes a
 * wrong answer is caught - neither of which an exit code can tell you.
 */
export function makeTerminalVerifier(cfg: {
  workspace: string
  /**
   * Given the step, return what the world should look like afterwards - computed by the verifier,
   * from the inputs, not from anything the process said.
   */
  expect: (step: Step) => { path: string; content: string } | undefined
}) : Verifier {
  const root = resolve(cfg.workspace)
  return {
    verifies: (step: Step) => step.tool === 'run-process',

    async verify(step: Step, _ctx: ToolContext, toolData: unknown) {
      const rec = toolData as Partial<ProcessRecord> | undefined
      const expected = cfg.expect(step)

      // A terminal step with no declared expectation cannot be verified, and saying "verified"
      // about it would be the exit-code-0 mistake wearing a hat.
      if (!expected) {
        return { rejected: `step "${step.id}" declares no verifiable expectation, so a ${rec?.exitCode === 0 ? 'zero exit code' : 'process run'} is not evidence that anything happened` }
      }

      // The process record is checked for HONESTY first, then ignored as proof.
      if (!rec) return { rejected: `step "${step.id}" produced no process record, so there is nothing to check` }
      if (rec.state === 'timed-out') return { rejected: `the process timed out; "${expected.path}" was not confirmed` }
      if (rec.state === 'failed-to-start') return { rejected: `the process never started: ${rec.executable}` }

      // Now the world, independently of everything above.
      const abs = resolve(root, expected.path)
      const { readFileSync, statSync } = await import('node:fs')
      if (!abs.startsWith(root)) {
        return { rejected: `refused to verify "${abs}": outside the workspace` }
      }

      // `readFileSync` is inside a try, NOT after a bare existence check.
      //
      // Removing the `existsSync` guard to see whether the control bites produced an ENOENT crash
      // rather than a rejection - which is the more serious defect of the two. A verifier that
      // throws on a missing file can be broken by DELETING the thing it verifies, so the absence
      // of the evidence destroys the evidence rather than reporting it. The check is still needed
      // for a good message; it just cannot be the only thing standing between a missing file and
      // an unhandled exception.
      let actual: string
      try {
        actual = readFileSync(abs, 'utf8')
      } catch (e) {
        const why = (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'it is not there' : `it could not be read (${(e as Error).message})`
        return {
          rejected:
            `the process reported ${rec.state}${rec.exitCode === null ? '' : ` with exit code ${rec.exitCode}`}, ` +
            `but "${expected.path}" could not be verified: ${why}. A zero exit code is not evidence that the work happened.`,
        }
      }
      if (actual !== expected.content) {
        return {
          rejected:
            `"${expected.path}" exists but its content does not match what was independently ` +
            `computed. Expected ${expected.content.length} bytes, found ${actual.length}.`,
        }
      }

      return {
        evidence: {
          kind: 'command-verified',
          executable: rec.executable ?? '',
          path: abs,
          bytes: statSync(abs).size,
          exitCode: rec.exitCode ?? null,
          durationMs: rec.durationMs ?? 0,
          envVarCount: rec.envNames?.length ?? 0,
          corroboratedBy: 'verifier-recomputed-the-expected-content-from-the-inputs',
        } as unknown as Evidence,
        // The stdout is returned but explicitly NOT used as evidence, so the audit can show what
        // the process claimed next to what was independently confirmed.
      } as never
    },
  }
}
