/**
 * TERMINAL CONTAINMENT - the behavioural regression tests for Stage A2.
 *
 * The defect these exist to prevent: `spawn(cmd, { shell: true })` put a cmd.exe between the
 * terminal allowlist and the operating system. The allowlist read the first token; the shell
 * read the whole line. `authorizeShell` (artifacts.ts) already caught quote-strapped `&`/`|`/`;`
 * chains and space-separated redirects, but three live gaps remained on the chat path:
 *
 *   1. `echo hi>file` - no space before `>`, so the redirect regex missed it and the shell
 *      wrote the file. (FAILS BEFORE: the file is created.)
 *   2. a newline-separated second command - `\r`/`\n` are not in `[&|;]`, so the chain read
 *      as read-only and the shell ran both lines. (FAILS BEFORE: the marker is written.)
 *   3. `%VAR%` - expanded by cmd.exe even inside quotes, so the allowlist read something
 *      other than what ran. (FAILS BEFORE: it expands.)
 *
 * Plus the two containment properties that no parser can provide, tested at the EXECUTION
 * layer (the exported runCommand) because the authorization layer deliberately refuses
 * `node script.js` when the script exists on disk - that refusal is pinned elsewhere, by
 * shell-artifact-contract.test.ts, and must not move:
 *
 *   4. ORPHANS: a child's child outlives the child. (FAILS BEFORE: the grandchild's
 *      heartbeat keeps moving after the command "finished"; the old spawn had no job.)
 *   5. CANCELLATION: an abort during a running command must stop it. (FAILS BEFORE: the
 *      old signature had no signal at all; the promise stayed pending until the 120s timeout.)
 *
 * Test 6 is the no-regression guard: quoting a path with spaces must still work, because a
 * guard that refuses everything has not fixed anything.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { resolveCapability, parseCommandLine, runCommand, AGENT_OUT } from '../live/agent/capabilities.ts'
import {
  buildArtifactContract, registerContract, forgetContract,
} from '../live/agent/artifacts.ts'

/**
 * A mission that HAS declared the named files, so authorizeShell's artifact layer passes the
 * command through and the layer under test is the one that answers.
 *
 * Only safe for files that do NOT exist yet: a declared artifact already on disk is refused by
 * the overwrite guard (correctly - see artifacts.ts, "declared is not the same as replaceable").
 * The newline test's marker.txt fits that; a pre-created parent.js does not, which is why the
 * orphan and cancellation tests live at the runCommand layer instead.
 */
function missionDeclaring(dir: string, names: string[]): string {
  const id = `m-tc-${Math.random().toString(36).slice(2)}`
  const steps = names.map((n, i) => ({
    id: `s${i + 1}`,
    intent: `write ${n}`,
    tool: 'write-file',
    args: { path: join(dir, n) },
  }))
  registerContract(id, buildArtifactContract(steps, null, dir))
  return id
}

/** Run the real terminal capability from the real registry, with a real ToolContext. */
async function runTool(
  command: string,
  opts: { cwd?: string; signal?: AbortSignal; missionId?: string } = {},
): Promise<Record<string, unknown>> {
  const cap = resolveCapability('terminal')
  const tool = (cap as { tool: { run: (c: unknown, a: unknown) => Promise<unknown> } }).tool
  const ctx: Record<string, unknown> = {
    missionId: opts.missionId ?? 'm-terminal-containment',
    stepId: 's1',
    attempt: 1,
    prior: {},
    observation: {},
    ...(opts.signal ? { signal: opts.signal } : {}),
  }
  return await tool.run(ctx, opts.cwd ? { command, cwd: opts.cwd } : { command }) as never
}

// ===========================================================================================
// 1. THE OPERATORS THE SHELL USED TO INTERPRET
// ===========================================================================================

test('a no-space redirect is refused and writes nothing', async () => {
  // The exact gap the old redirect regex missed: `(?:^|\s)>>?` needs whitespace before `>`,
  // and `echo hi>escaped.txt` has none - so the shell wrote the file while the allowlist
  // read a perfectly innocent `echo`.
  const dir = mkdtempSync(join(AGENT_OUT, 'tc-redirect-'))
  try {
    const r = await runTool('echo hi>escaped.txt', { cwd: dir })
    assert.equal(r.kind, 'failed', `a redirect must be refused: ${JSON.stringify(r)}`)
    assert.match(String(r.reason), /shell operator/i)
    assert.equal(existsSync(join(dir, 'escaped.txt')), false,
      'the refused command must not have created the file')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a newline-chained second command is refused and writes nothing', async () => {
  // `\r\n` is not in authorizeShell's `[&|;]` chain set, so a two-line command read as one
  // line - and cmd.exe ran both. The tokenizer refuses every line break. The mission declares
  // marker.txt on purpose: pre-fix that made the whole chain AUTHORIZED (both lines ran, the
  // marker was written), which is the fail-before behaviour this test pins down.
  const dir = mkdtempSync(join(AGENT_OUT, 'tc-newline-'))
  const id = missionDeclaring(dir, ['marker.txt'])
  try {
    const marker = join(dir, 'marker.txt')
    const command = 'node --version\r\n'
      + `node -e "require('fs').writeFileSync('${marker}', 'pwned')"`
    const r = await runTool(command, { cwd: dir, missionId: id })
    assert.equal(r.kind, 'failed', `a line-broken chain must be refused: ${JSON.stringify(r)}`)
    assert.match(String(r.reason), /shell operator/i)
    assert.equal(existsSync(marker), false, 'the second line must never have run')
  } finally {
    forgetContract(id)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('environment-variable expansion is refused, quoted or not', async () => {
  // cmd.exe expands %VAR% inside double quotes too, so the allowlist reading `%USERPROFILE%`
  // as a literal was never what would run. Refused rather than expanded.
  const dir = mkdtempSync(join(AGENT_OUT, 'tc-var-'))
  try {
    const r = await runTool('echo %USERPROFILE%', { cwd: dir })
    assert.equal(r.kind, 'failed', `an expansion request must be refused: ${JSON.stringify(r)}`)
    assert.match(String(r.reason), /expansion/i)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a & chain is refused by the tokenizer even when the artifact layer allows the line', () => {
  // authorizeShell catches bare `&` chains only when they are not fully declared; the
  // tokenizer refuses them unconditionally, as a unit so the layering is pinned.
  const parsed = parseCommandLine('node --version & node --version')
  assert.equal(parsed.ok, false)
  assert.match(parsed.ok === false ? parsed.reason : '', /shell operator/i)
})

// ===========================================================================================
// 2. ORPHANED GRANDCHILDREN DIE WITH THE COMMAND
// ===========================================================================================

test('a grandchild process is dead by the time the command reports completion', async () => {
  // A plain child kill only reaches what Node spawned. `node parent.js` starts a grandchild
  // that beats a file forever; with shell:true the grandchild survived the parent's exit -
  // that is how orphaned processes accumulated after missions finished. Inside the Job
  // Object, closing the job kills the grandchild even though nothing ever held its pid.
  //
  // Tested at the runCommand layer: authorizeShell (the tool's gate) refuses `node script.js`
  // whenever the script exists on disk, and that refusal is its own pinned suite. What is
  // under test HERE is what the execution layer does with processes, not who may invoke it.
  const dir = mkdtempSync(join(AGENT_OUT, 'tc-orphan-'))
  const beat = join(dir, 'beat.txt')
  try {
    writeFileSync(join(dir, 'grandchild.js'), [
      `var beat = ${JSON.stringify(beat)}`,
      'var fs = require("fs")',
      'function tick() { try { fs.writeFileSync(beat, String(Date.now())) } catch (e) {} }',
      'tick()',
      'setInterval(tick, 250)',
      'setTimeout(function () { process.exit(0) }, 60000)',
      '',
    ].join('\n'), 'utf8')
    // The parent waits until the grandchild has demonstrably started (beat exists), so the
    // test can never pass for the wrong reason - a grandchild killed before its first write
    // would leave no heartbeat at all, and "no heartbeat" is not proof of containment.
    writeFileSync(join(dir, 'parent.js'), [
      `var beat = ${JSON.stringify(beat)}`,
      'var fs = require("fs")',
      "var c = require('child_process').spawn(process.execPath, ['grandchild.js'], { stdio: 'ignore' })",
      'var t0 = Date.now()',
      'var iv = setInterval(function () {',
      '  if (fs.existsSync(beat) || Date.now() - t0 > 20000) { clearInterval(iv); c.unref(); process.exit(0) }',
      '}, 100)',
      '',
    ].join('\n'), 'utf8')

    const r = await runCommand('node parent.js', dir)
    assert.equal(r.code, 0, `the command should have run: ${JSON.stringify(r)}`)

    const deadline = Date.now() + 10_000
    while (!existsSync(beat) && Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, 100))
    }
    assert.ok(existsSync(beat), 'the grandchild must have started (otherwise this proves nothing)')

    const t0 = readFileSync(beat, 'utf8')
    await new Promise((res) => setTimeout(res, 1200))
    const t1 = readFileSync(beat, 'utf8')
    assert.equal(t1, t0,
      'the heartbeat must have stopped: a grandchild still beating after the command returned '
      + 'is an orphan the mission can no longer stop')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ===========================================================================================
// 3. CANCELLATION DURING A SUBPROCESS
// ===========================================================================================

test('cancelling during a running command stops it well before the timeout', async () => {
  // Pre-fix the execution layer had no signal at all: an abort during `node long.js` did
  // nothing, and the step kept running for the full 120s timeout after the person pressed
  // Stop. The abort now kills the wrapper, whose job death kills the tree - grandchildren
  // included. (The tool layer threads its ctx.signal into this call - covered by the
  // chat-cancellation suite at mission level; the authorization layer's refusal of `node
  // long.js` via the tool is pinned by shell-artifact-contract tests. This layer owns
  // "does the signal stop the processes".)
  const dir = mkdtempSync(join(AGENT_OUT, 'tc-cancel-'))
  const ac = new AbortController()
  let abortIn: ReturnType<typeof setTimeout> | undefined
  try {
    writeFileSync(join(dir, 'long.js'), 'setInterval(function () {}, 1000)\n', 'utf8')

    const started = Date.now()
    const pending = runCommand('node long.js', dir, ac.signal)
    // THE ABORT ITSELF, mid-run. Without this timer the signal never fires during the race,
    // and the test can only prove that an un-cancelled 120s command takes 120s - which is
    // exactly what it did prove, for three rounds, until review caught the missing timer.
    // 800ms: the wrapper takes ~0.5-1.5s to boot PowerShell and start node, so the abort
    // lands somewhere around spawn-or-just-started; either side of that boundary the run
    // must still settle immediately, which is the property under test.
    abortIn = setTimeout(() => ac.abort(), 800)
    const marker = Symbol('timeout')
    const winner = await Promise.race([
      pending.then(() => 'tool' as const),
      new Promise((res) => setTimeout(() => res(marker), 10_000)),
    ])
    clearTimeout(abortIn)

    assert.equal(winner, 'tool',
      'the run must settle on abort; a timeout here means the signal was ignored')
    const r = await pending
    assert.equal(r.code, -1)
    assert.match(String(r.err), /cancel/i)
    assert.ok(Date.now() - started < 10_000, 'the stop must land in seconds, not at the 120s timeout')
  } finally {
    if (abortIn) clearTimeout(abortIn)
    ac.abort()
    // The cancelled child's handles are released asynchronously on Windows; rmSync can land
    // inside that window and throw EPERM. Retried rather than ignored: the directory must
    // actually go away, which the leak checks confirm it does.
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})

// ===========================================================================================
// 4. QUOTING STILL WORKS (the guard must not refuse everything)
// ===========================================================================================

test('a quoted path containing spaces still runs', async () => {
  const dir = mkdtempSync(join(AGENT_OUT, 'tc quote fx-'))
  try {
    writeFileSync(join(dir, 'note.txt'), 'hello from a spaced directory\n', 'utf8')
    const r = await runTool(`type "${join(dir, 'note.txt')}"`, { cwd: dir })
    assert.notEqual(r.kind, 'failed', `quoted paths must keep working: ${JSON.stringify(r)}`)
    const data = r.data as { output?: string } | undefined
    assert.match(String(data?.output ?? ''), /hello from a spaced directory/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the tokenizer groups quoted arguments and keeps bare words literal', () => {
  const quoted = parseCommandLine('node -e "setInterval(function () {}, 1)"')
  assert.equal(quoted.ok, true)
  assert.deepEqual(quoted.ok === true ? quoted.args : [], ['-e', 'setInterval(function () {}, 1)'])

  const pathArg = parseCommandLine('type "C:\\a b\\c.txt"')
  assert.equal(pathArg.ok, true)
  assert.deepEqual(pathArg.ok === true ? pathArg.args : [], ['C:\\a b\\c.txt'])

  assert.equal(parseCommandLine('echo %PATH%').ok, false)
  assert.equal(parseCommandLine('node -e "unbalanced').ok, false)
})
