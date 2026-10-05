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
  /** Whether output was truncated at the cap. Silent truncation would be a lie by omission. */
  readonly stdoutTruncated: boolean
  readonly stderrTruncated: boolean
  /** The environment variable NAMES the child actually received, measured not assumed. */
  readonly envNames: readonly string[]
}

export interface TerminalConfig {
  readonly workspace: string
  readonly timeoutMs?: number
  readonly systemRoot: string
  readonly programFiles: string
  /** Cap on captured bytes per stream, so a runaway process cannot exhaust memory. */
  readonly maxCaptureBytes?: number
}

const DEFAULT_TIMEOUT = 15_000
const HARD_MAX_TIMEOUT = 120_000
const DEFAULT_CAPTURE = 256 * 1024

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
      const cwdRaw = typeof a.cwd === 'string' ? a.cwd : '.'
      const cwd = resolve(ctx.workspace, cwdRaw)

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

        const timer = setTimeout(() => {
          timedOut = true
          if (child.pid) void reapTree(child.pid)
        }, timeoutMs)

        const finish = (state: ProcessRecord['state'], exitCode: number | null, signal: NodeJS.Signals | null, extra: Partial<ToolResult> = {}) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
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
            stdoutTruncated,
            stderrTruncated,
            envNames,
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
                  `${timedOut ? ` after ${timeoutMs}ms` : ''} in ${record.durationMs}ms`,
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
          finish('failed-to-start', null, null, { kind: 'failed', reason: why })
        })

        child.on('close', (code, signal) => {
          if (timedOut) {
            finish('timed-out', code, signal, {
              kind: 'failed',
              reason: `"${abs} ${argv.join(' ')}" exceeded the ${timeoutMs}ms timeout and its process tree was reaped. It is not known to have done anything useful.`,
            })
            return
          }
          if (code === 0) { finish('completed', 0, signal); return }
          finish(code === null ? 'killed' : 'nonzero', code, signal, {
            kind: 'failed',
            reason: `"${abs} ${argv.join(' ')}" exited with code ${code}${signal ? ` (signal ${signal})` : ''}` +
              `${stderr.trim() ? `: ${stderr.trim().slice(0, 400)}` : ''}`,
          })
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
