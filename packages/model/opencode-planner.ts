/**
 * THE OPENCODE PLANNER ADAPTER � a transport, not a second planner.
 *
 * ============================================================================================
 * WHY THIS IS AN ADAPTER AND NOT A NEW PLANNER
 * ============================================================================================
 *
 * `ModelPlanProvider` already does everything that matters: it builds the request from the real
 * observation, renders `SYSTEM_INSTRUCTIONS` and the worked example, sends it, parses the reply with
 * the strict `parseModelPlan`, and attaches a basis the model could not have forged. Its only
 * dependency on the world is `fetchImpl`.
 *
 * So this file supplies a `fetch` that speaks to `opencode run` instead of an HTTP model server. Every
 * line of provider logic, prompt logic and parsing is REUSED unchanged. Writing a parallel planner
 * would have duplicated the request contract and created a second thing to keep correct - which is
 * precisely the failure the mission engine's own comments warn about.
 *
 * ============================================================================================
 * GOVERNANCE: THE MODEL PROPOSES, AND NOTHING ELSE
 * ============================================================================================
 *
 * `opencode run` is an AGENT: it has file and shell tools. A planner must not. Two mechanisms
 * contain that:
 *
 *   1. THE SANDBOX. The planner runs with its working directory set to a scratch directory, NOT the
 *      repository. If the agent reaches for a tool, whatever it touches is in scratch and discarded.
 *      This is the difference between "the model cannot act" and "we asked it not to act".
 *   2. THE TEXT IS ALL THAT IS TAKEN. This adapter extracts the assistant's TEXT and returns it as the
 *      completion. Tool calls, file edits, and any other side effect are discarded because they are
 *      never read.
 *
 * The model therefore proposes a plan, and that plan still has to survive `parseModelPlan`,
 * `plan-invariants`, `compilePlan`, the executor's approval gate and every independent verifier
 * before anything touches the real filesystem.
 *
 * ============================================================================================
 * THE CLI WRAPPER IS NOT THE PLAN
 * ============================================================================================
 *
 * `opencode run --format json` emits a STREAM OF NDJSON EVENTS - `step_start`, `text`, `step_finish` -
 * each with its own envelope. The envelope is not the answer. This adapter concatenates the `text`
 * parts into the completion the provider expects, and counts unparsed lines rather than hiding them.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { DEFAULT_OPENCODE_CLI } from '../agent/opencode-adapter.ts'

export interface OpenCodePlannerOptions {
  readonly model: string
  readonly cliPath?: string
  readonly timeoutMs: number
  /** Set false only in a test. The sandbox is the containment boundary; disabling it is not free. */
  readonly sandbox?: boolean
}

/** The result of one planner call, kept whole so a failure can be diagnosed rather than retried. */
export interface PlannerCallEvidence {
  readonly text: string
  readonly exitCode: number | null
  readonly elapsedMs: number
  readonly sessionId: string
  readonly events: number
  readonly unparsedLines: number
  readonly stderr: string
}

/**
 * Build a `fetch` that routes a chat-completions request through `opencode run`.
 *
 * The returned function is shaped like `fetch` because that is what `ProviderDeps.fetchImpl`
 * declares. It is deliberately NOT a general HTTP client: it answers from the CLI, and a transport
 * failure is reported as a rejected completion rather than as an exception, because `ModelPlanProvider`
 * treats a thrown error as "the reasoner could not be reached" and records that as an outcome.
 */
export function openCodePlannerFetch(
  opts: OpenCodePlannerOptions,
  onCall?: (e: PlannerCallEvidence) => void,
): { fetchImpl: typeof fetch; calls: PlannerCallEvidence[] } {
  const calls: PlannerCallEvidence[] = []
  const cli = opts.cliPath ?? DEFAULT_OPENCODE_CLI

  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as {
      messages?: { role: string; content: string }[]
    }) : { messages: [] }

    // The provider already sends an ordered conversation. It is flattened into ONE prompt with the
    // roles kept, because `opencode run` takes a single message. The provider's own request text -
    // the observation, the capabilities, the worked example - is passed through untouched.
    //
    // EXCEPT the tool registry, which is re-rendered as an explicit one-line-per-pair rule.
    //
    // MEASURED, twice. Given the registry as a JSON object in the request, the model chose every
    // registered tool correctly and then transposed the two similar PAIRINGS - `read-folder` with
    // `filesystem.list`, `inspect-folder` with `filesystem.inspect`. The invariant check refused both
    // plans, correctly. A JSON object invites a model to read the shape; a flat list states the fact.
    //
    // The content is not new information and not new authority: it is the router's own registration,
    // extracted from the request the provider built. The invariant check still enforces it.
    const tools = (body.messages ?? [])
      .flatMap((m) => [m.content])
      .map((c) => /"mayUseTools"\s*:\s*(\{.*?\})/.exec(c))
      .find(Boolean)
    let toolRule = ''
    if (tools?.[1]) {
      try {
        const map = JSON.parse(tools[1]) as Record<string, string>
        const lines = Object.entries(map).map(([t, c]) => `  ${t} -> ${c}`)
        if (lines.length) {
          toolRule = [
            '',
            'REGISTERED TOOL -> CAPABILITY. A step naming a tool MUST use exactly that capability.',
            ...lines,
            'Any other tool name, or a different capability for one of these, is refused before anything runs.',
          ].join('\n')
        }
      } catch { /* an unparseable registry simply adds no rule; the invariant check still governs */ }
    }

    // The operand contract, rendered per tool. "from" means a STEP ID and not a path is the single
    // distinction that a tool name cannot carry, and it was measured to be exactly what was missing.
    const argBlock = (body.messages ?? [])
      .map((m) => /"toolArgs"\s*:\s*(\[.*?\])\s*\}/.exec(m.content))
      .find(Boolean)
    let argRule = ''
    if (argBlock?.[1]) {
      try {
        const specs = JSON.parse(argBlock[1]) as {
          tool: string
          args: { name: string; required: boolean; description: string }[]
        }[]
        const lines: string[] = []
        for (const s of specs) {
          for (const a of s.args) {
            lines.push(`  ${s.tool}: ${a.name}${a.required ? ' (required)' : ' (optional)'} - ${a.description}`)
          }
        }
        if (lines.length) {
          argRule = [
            '',
            'ARGUMENTS each tool reads. Supply exactly these names; a tool ignores anything else.',
            ...lines,
          ].join('\n')
        }
      } catch { /* an unparseable registry simply adds no rule; the invariant check still governs */ }
    }

    const prompt = [
      'You are answering a PLANNING REQUEST. Reply with ONE JSON object and nothing else.',
      'No prose before or after it. No markdown fence. No explanation.',
      '',
      'Use ONLY the absolute paths written in the request below. Do NOT use the directory you',
      'happen to be running in, and do NOT invent paths: the working directory is a scratch',
      'sandbox and is unrelated to the task. Every path you need is already given.',
      toolRule,
      'If you genuinely cannot plan, reply exactly {"refusal":"<reason>"} and nothing else.',
      '',
      ...(body.messages ?? []).map((m) => `--- ${m.role.toUpperCase()} ---\n${m.content}`),
    ].join('\n')

    // THE SANDBOX. Never the repository.
    const sandbox = opts.sandbox === false ? process.cwd() : mkdtempSync(join(tmpdir(), 'aios-planner-'))
    const started = Date.now()

    const res = await runCli(cli, opts.model, prompt, sandbox, opts.timeoutMs)

    if (opts.sandbox !== false) {
      try { rmSync(sandbox, { recursive: true, force: true }) } catch { /* Defender may hold it */ }
    }

    const evidence: PlannerCallEvidence = {
      text: res.text,
      exitCode: res.exitCode,
      elapsedMs: Date.now() - started,
      sessionId: res.sessionId,
      events: res.events,
      unparsedLines: res.unparsed,
      stderr: res.stderr,
    }
    calls.push(evidence)
    onCall?.(evidence)

    if (res.failure) {
      // Throwing here is correct: `ModelPlanProvider` catches it and returns
      // `unsupported - the reasoner could not be reached`, which is exactly the true outcome.
      throw new Error(res.failure)
    }

    // Shaped like a chat completion so the existing provider finds `choices[0].message.content`.
    const payload = { choices: [{ message: { role: 'assistant', content: res.text } }] }
    return new Response(JSON.stringify(payload), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch

  return { fetchImpl, calls }
}

function runCli(
  cli: string, model: string, message: string, cwd: string, timeoutMs: number,
): Promise<{ text: string; exitCode: number | null; sessionId: string; events: number; unparsed: number; stderr: string; failure?: string }> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(cli, ['run', '--format', 'json', '--model', model, message], {
        cwd, shell: false, windowsHide: true,
        env: { ...process.env, NO_COLOR: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (e) {
      resolve({ text: '', exitCode: null, sessionId: '', events: 0, unparsed: 0, stderr: '',
        failure: `could not start the OpenCode CLI: ${(e as Error).message}` })
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    // The child is REAPED, not abandoned. A close event means the process exited on its own;
    // but on this machine a planning run left an opencode-cli.exe holding 1.1 GB after the call
    // had returned, and a single process of that size is the difference between a laptop with
    // half a gigabyte free and one that is comfortable. Reaper tried this path because spawn's
    // close event fired before stderr drained in at least some cases; either way, nothing this
    // module starts is left running when the promise resolves.
    const reap = () => {
      try { if (child.exitCode === null && child.signalCode === null) child.kill() } catch { /* already gone - which is the desired state */ }
    }
    const done = (r: ReturnType<typeof resolve> extends never ? never : any) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reap()
      resolve(r)
    }

    const timer = setTimeout(() => {
      try { child.kill() } catch { /* gone */ }
      done({ text: '', exitCode: null, sessionId: '', events: 0, unparsed: 0, stderr,
        failure: `planner exceeded ${timeoutMs}ms and was terminated` })
    }, timeoutMs)

    child.stdout?.on('data', (d) => { if (stdout.length < 8_000_000) stdout += d })
    child.stderr?.on('data', (d) => { if (stderr.length < 200_000) stderr += d })

    child.on('error', (e) => {
      clearTimeout(timer)
      reap()
      done({ text: '', exitCode: null, sessionId: '', events: 0, unparsed: 0, stderr,
        failure: `the OpenCode CLI could not be run: ${e.message}` })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      // The process itself has exited; `reap()` is a no-op. Calling it anyway is what makes the
      // failure case explicit rather than something that falls through: even if SIGTERM was never
      // needed, the reaping logic runs on every exit path.
      reap()
      let text = ''
      let sessionId = ''
      let events = 0
      let unparsed = 0
      // Plain-text stdout, and STRUCTURED error events, both kept.
      //
      // Two findings, both measured on this machine, both of which made a real failure look
      // like an unexplained exit code:
      //
      // 1. Under `--format json` the CLI does NOT print errors on stderr - stderr is genuinely
      //    zero bytes. Run by hand WITHOUT that flag it prints "Rate limit exceeded" as plain
      //    text on stderr, which is why the cause looked reachable and then was not.
      //
      // 2. Under `--format json` the error arrives as a first-class event on stdout:
      //
      //      {"type":"error","timestamp":...,"error":"Rate limit exceeded. Please try again later."}
      //
      //    The parse loop below skips nothing that starts with `{`, so this event was parsed
      //    successfully and then ignored: only `part.type === "text"` was looked at. The
      //    machine told us exactly what was wrong, in a field the reader never opened.
      //
      // So the error field is now captured where it actually lives. Without this, five
      // consecutive missions reported "the planner CLI exited 1 with no completion" and every
      // one of them sent the reader to AIOS's planner when the fault was an upstream rate limit.
      const prose: string[] = []
      const errors: string[] = []
      for (const line of stdout.split(/\r?\n/)) {
        const t = line.trim()
        if (!t) continue
        if (!t.startsWith('{')) { if (prose.length < 20) prose.push(t); continue }
        let ev: Record<string, unknown>
        try { ev = JSON.parse(t) as Record<string, unknown> } catch { unparsed++; continue }
        events++
        if (typeof ev.sessionID === 'string' && !sessionId) sessionId = ev.sessionID
        if (ev.type === 'error') {
          const e = ev.error
          const msg = typeof e === 'string' ? e
            : e && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string'
              ? (e as { message: string }).message
              : JSON.stringify(e)
          if (msg) errors.push(msg)
          continue
        }
        const part = ev.part as Record<string, unknown> | undefined
        if (part && part.type === 'text' && typeof part.text === 'string') text += part.text
      }
      done({ text, exitCode: code, sessionId, events, unparsed, stderr,
        ...(code !== 0 && !text
          ? { failure: plannerFailure(code, `${errors.join('\n')}\n${stderr}\n${prose.join('\n')}`) }
          : {}) })
    })
  })
}

/**
 * Name the cause of a planner failure instead of only its exit code.
 *
 * "the planner CLI exited 1 with no completion" is true and useless. Observed for real: five
 * consecutive missions failed with exactly that line, and the actual cause was
 * "Rate limit exceeded. Please try again later." raised by the free model provider, printed by
 * the CLI to stderr, captured here - and then thrown away. Every one of those failures pointed a
 * reader at AIOS's planner when the fault was upstream, external and temporary.
 *
 * A failure that cannot name its cause sends the reader to the wrong file, so stderr is folded
 * in. The ANSI colour codes are stripped because they made the stored message unreadable in the
 * mission log, which is the one place this text is actually read.
 */
function plannerFailure(code: number | null, stderr: string): string {
  const plain = stderr
      .replace(/\u001b\[[0-9;]*m/g, '')
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
  const detail = plain.slice(0, 300)
  if (/rate limit|too many requests|\b429\b/i.test(plain)) {
    return `the free model provider is rate limiting this machine ("${detail}"). `
      + 'This is not a fault in the plan or in the operator: AIOS is waiting on a $0 model that is '
      + 'throttling. Running missions back to back exhausts the allowance - wait a few minutes '
      + 'before starting the next one.'
  }
  return `the planner CLI exited ${String(code)} with no completion`
    + (detail ? `. The CLI said: "${detail}"` : '')
}
