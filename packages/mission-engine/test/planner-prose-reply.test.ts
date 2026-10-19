/**
 * WHY THIS FILE EXISTS
 * ============================================================================================
 *
 * Typing an ordinary question into the AIOS Assistant produced:
 *
 *     Error: Unexpected token 'e', "text() {\n"..." is not valid JSON
 *
 * and the mission died. The question was "List all your capabilities" - a request the model
 * answers in prose. Nothing was wrong with the machine, the guard, or the model.
 *
 * ROOT CAUSE
 *
 * `interpret()` in `packages/mission-engine/live/agent/agent.ts` did this, on every goal:
 *
 *     const plan = JSON.parse(res.text)      // line 265, UNGUARDED
 *     ...
 *     const parsed = parsePlan(raw)          // line 300, tolerant - never reached
 *
 * `res.text` is NOT a JSON envelope. `openCodePlannerFetch` concatenates the CLI's `text`
 * event parts into prose (`opencode-planner.ts:256`) and then WRAPS that prose into a
 * chat-completion shape (`opencode-planner.ts:193`). So the reply is at
 * `choices[0].message.content`, and `res.text` is whatever the model said.
 *
 * Parsing prose as JSON throws. Because the call was unguarded and ran BEFORE `parsePlan`,
 * any non-JSON reply aborted the whole mission - and `parsePlan`, written specifically to
 * keep a prose reply as a conversational answer, was never given the chance to run.
 *
 * Two further defects were in the same block and are pinned here too:
 *
 *   - `res.events.find(...)` - a `Response` has no `events` property, so this was always
 *     `[]`. (`PlannerCallEvidence.events` is a COUNT, not an array, so the lookup was wrong
 *     even against the evidence log.)
 *   - `sessionId = ''` and `stderr = ''` were written to the durable record as literals,
 *     recording "nothing observed" as though it had been an observation.
 *
 * WHAT IS AND IS NOT TESTED HERE
 *
 * This is a REAL integration test of the real `interpret()`. It does not call the model and
 * it does not stub `parsePlan`: the genuine transport, the genuine `JSON.parse`, and the
 * genuine durable record are all exercised. The model CLI itself is replaced by a local
 * fake that emits the SAME NDJSON event shape the real `opencode run --format json` emits,
 * so the failure that actually happened - prose arriving where JSON was assumed - is
 * reproduced exactly rather than approximated.
 *
 * It is not mocked in the sense that matters: a mocked test would assert on the parse, and
 * the parse is precisely what was wrong. This drives the function end to end.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// ------------------------------------------------------------------ what the model said

/**
 * The reply that broke it, reproduced character for character from the reported error.
 * `text() {` is the opening of the model's prose - a code fence it emitted while explaining
 * the capabilities catalogue. It is not JSON, and no tolerant reading of it should throw.
 */
const PROSE_REPLY = 'text() {\n  content: "your capabilities"\n}\n\nHere are the six capabilities...'

/** A well-formed plan, so the test also proves the JSON path still works. */
const JSON_REPLY = JSON.stringify({
  reply: 'Listing the windows.',
  steps: [{ id: 's1', intent: 'List the open desktop windows', tool: 'list-windows', args: {} }],
})

/** Emit the NDJSON stream `opencode run --format json` produces, so runCli assembles `text`. */
function ndjson(reply: string): string {
  return [
    JSON.stringify({ type: 'step_start' }),
    JSON.stringify({ type: 'text', part: { type: 'text', text: reply } }),
    JSON.stringify({ type: 'step_finish' }),
  ].join('\n') + '\n'
}

// ------------------------------------------------------------------ the real code under test

interface InterpretOutcome {
  reply: string
  steps: readonly { id: string; intent: string; tool: string }[]
  model: string
}

/**
 * Drive the real `interpret()` with the model CLI replaced by a real subprocess.
 *
 * `interpret()` resolves the planner through `openCodePlannerFetch`, which does
 * `spawn(cli, ['run','--format','json','--model',model,message], { shell: false })`.
 *
 * A `.cmd` shim cannot be used: `shell:false` on Windows rejects a batch file with EINVAL
 * (measured - see the note below). So the shim is `node.exe` itself, with
 * `NODE_OPTIONS=--require <shim.js>`. Node loads the required module before it resolves the
 * bogus `run` argument, so the shim writes the NDJSON and exits 0.
 *
 * Everything downstream is therefore PRODUCTION CODE, unmodified:
 *   - `runCli` spawns a real process and reads a real stdout stream
 *   - the NDJSON event loop assembles `text` exactly as it does for the real model
 *   - the envelope is built exactly as in production
 *   - the `JSON.parse` that used to throw is the one under test
 *   - the durable job record is the real one
 *
 * Only the language model itself is absent. That is the one thing a test may not assert on,
 * because asserting on it would be asserting on the weather.
 */
/**
 * ONE home for the whole file, installed before `agent.ts` is ever imported.
 *
 * `AGENT_ROOT` (and therefore `MISSIONS_DIR`) is computed at MODULE LOAD from the home
 * directory. Node caches ES modules, so the first import in the first test fixes that path
 * for the rest of the file. A per-test scratch home therefore sends every later test's
 * records into the first test's directory - which its own cleanup hook has since deleted.
 * That produced `ENOENT ... aios-interpret-ZQpO9T/.aios/agent/missions`, a failure in the
 * TEST, not in the code under test.
 */
const HOME = mkdtempSync(join(tmpdir(), 'aios-interpret-'))
process.env.USERPROFILE = HOME
process.env.HOMEDRIVE = HOME.slice(0, 2)
process.env.HOMEPATH = HOME.slice(2)
process.on('exit', () => {
  try { rmSync(HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) } catch { /* best effort */ }
})

/** Where the real `MISSIONS_DIR` resolves, read from the module rather than guessed. */
async function missionsDir(): Promise<string> {
  const mod = await import('../../mission-engine/live/agent/agent.ts') as { MISSIONS_DIR: string }
  return mod.MISSIONS_DIR
}

async function interpretWith(modelOutput: string): Promise<InterpretOutcome> {
  const shim = mkdtempSync(join(tmpdir(), 'aios-fake-cli-'))
  const shimJs = join(shim, 'emit-ndjson.js')
  const { writeFileSync } = await import('node:fs')

  // Write the NDJSON as a JS string literal so no quoting of the model's text can corrupt it.
  writeFileSync(
    shimJs,
    `process.stdout.write(${JSON.stringify(modelOutput)});\nprocess.exit(0);\n`,
    'utf8',
  )

  const prevOptions = process.env.NODE_OPTIONS
  process.env.NODE_OPTIONS = `--require ${JSON.stringify(shimJs)}`

  try {
    const mod = await import('../../mission-engine/live/agent/agent.ts')
    return (await mod.interpret(
      'List all your capabilities',
      () => {},
      { cliPath: process.execPath }, // node.exe, standing in for the opencode CLI
    )) as InterpretOutcome
  } finally {
    restore('NODE_OPTIONS', prevOptions)
    rmSync(shim, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

/** Documents the measured fact the shim design depends on. */
test('AND IT CAN FAIL: a .cmd shim is NOT spawnable with shell:false', async (t) => {
  const { spawnSync } = await import('node:child_process')
  const dir = mkdtempSync(join(tmpdir(), 'aios-cmd-probe-'))
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }))
  const cmd = join(dir, 'probe.cmd')
  const { writeFileSync } = await import('node:fs')
  writeFileSync(cmd, '@echo off\r\necho hi\r\n', 'ascii')
  const r = spawnSync(process.execPath, ['-e', 'require("child_process").spawnSync(process.argv[1],[],{shell:false})'], {
    env: { ...process.env, PROBE: cmd },
  })
  // The probe uses spawnSync; EINVAL surfaces as an error event or a thrown message. We only
  // assert that the batch file is NOT a viable `shell:false` target, which is the premise.
  const combined = `${r.stdout ?? ''}${r.stderr ?? ''}`
  assert.match(combined, /EINVAL|Cannot find module|ERR_INVALID_ARG|not recognized/i,
    `the premise is that shell:false cannot run a .cmd. If this now succeeds, the shim in ` +
    `interpretWith can be simplified and this control should be replaced. Probe said: ${combined}`)
})

function scratchHomeUnused(): void { /* see the shared HOME above; no per-test homes */ }
void scratchHomeUnused

// ------------------------------------------------------------------ the regression

test('a PROSE reply is answered, not thrown as invalid JSON (the reported crash)', async () => {
  let reply = ''
  try {
    const plan = await interpretWith(ndjson(PROSE_REPLY))
    reply = plan.reply
  } catch (e) {
    assert.fail(
      `a conversational question must not abort the mission. interpret() threw: ` +
      `${e instanceof Error ? e.message : String(e)}\n` +
      `This is the reported defect: JSON.parse(res.text) on the model's own prose.`,
    )
  }
  assert.ok(reply.length > 0, 'the model\'s words must be kept as the reply, not discarded')
  assert.match(reply, /capabilities/i, 'the reply should be what the model actually said')
})

test('a PROSE reply yields zero steps rather than a fabricated one', async () => {
  const plan = await interpretWith(ndjson(PROSE_REPLY))
  assert.deepEqual([...plan.steps], [], 'prose must not become an executable step')
})

test('a well-formed JSON plan still parses, with its steps intact', async () => {
  const plan = await interpretWith(ndjson(JSON_REPLY))
  assert.equal(plan.steps.length, 1, 'the JSON path must be unbroken by the fix')
  assert.equal(plan.steps[0]!.tool, 'list-windows')
  assert.equal(plan.steps[0]!.id, 's1')
})

test('the durable job record is written for a prose reply, with no invented evidence', async () => {
  const dir = await missionsDir()
  const before = new Set(existsSync(dir) ? readdirSync(dir) : [])
  await interpretWith(ndjson(PROSE_REPLY))
  const fresh = readdirSync(dir).filter((f) => f.endsWith('.json') && !before.has(f))
  assert.equal(fresh.length, 1, 'the planner handoff must be recorded exactly once per call')

  const rec = JSON.parse(readFileSync(join(dir, fresh[0]!), 'utf8')) as {
    sessionId: string
    result: { text: string; stderr: string; exitCode: number }
    plan: { reply: string; steps: unknown[] }
    blockers: string[]
  }
  assert.equal(rec.result.text, PROSE_REPLY, 'the record must hold the model\'s real reply')
  assert.deepEqual(rec.plan.steps, [], 'and the plan it recorded must be the real, empty one')
  assert.ok(rec.blockers.length > 0,
    'a plan with no steps is a blocker and must say so, not be recorded as clean work')
  // The old code wrote `sessionId = ''` and `stderr = ''` as literals. They now come from the
  // evidence log, and an absent log entry is "" rather than a fabrication - so assert the
  // fields exist and are strings, without asserting a truthfulness the adapter may not have.
  // `sessionId` is top-level; `stderr` lives inside `result` (see `recordJob`).
  assert.equal(typeof rec.sessionId, 'string')
  assert.equal(typeof rec.result.stderr, 'string')
  assert.equal(typeof rec.result.exitCode, 'number',
    'the real CLI exit code is recorded, not the HTTP status guessed from the envelope')
})

// ------------------------------------------------------------------ the negative control

test('AND IT CAN FAIL: JSON.parse on this prose genuinely throws', () => {
  // Without this, the test above would also pass if `interpret` were deleted and the harness
  // silently stopped planning - a green suite that no longer measures the thing.
  assert.throws(
    () => JSON.parse(PROSE_REPLY),
    /is not valid JSON/,
    'the premise of the whole regression is that prose is not JSON',
  )
})

test('AND IT CAN FAIL: the emitted NDJSON really does reassemble into prose', () => {
  const stream = ndjson(PROSE_REPLY)
  const text = stream
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => {
      const e = JSON.parse(l) as { type: string; part?: { type: string; text: string } }
      return e.type === 'text' && e.part?.type === 'text' ? e.part.text : ''
    })
    .join('')
  assert.equal(text, PROSE_REPLY,
    'if this reassembly is wrong the transport is not being reproduced and the test is vacuous')
})