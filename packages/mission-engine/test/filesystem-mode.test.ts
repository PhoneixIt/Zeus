import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs'
import { join, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { execute, type Tool, type Verifier } from '../executor.ts'
import type { Mission, Step } from '../state.ts'
import { fakeControl } from './fakes.ts'

/** Defined locally rather than imported: executor.test.ts keeps its builders private. */
const step = (id: string, over: Partial<Step> = {}): Step => ({
  id, intent: `do ${id}`, mode: 'cli', rationale: 'test', status: 'pending', tool: id, ...over,
})
const mission = (plan: Step[], over: Partial<Mission> = {}): Mission => ({
  id: 'm1', objective: 'test mission', constraints: [], state: 'executing',
  plan, history: [], pendingApprovals: [], startedAt: 0, ...over,
})
const ok = { now: () => 1, maxAttempts: 2 }

/**
 * Two things this file exists to hold in place.
 *
 * 1. `Step.args` must actually reach the tool. It did not exist; the executor called
 *    `tool.run(ctx, {})` with a literal empty object. Every tool received no parameters and had
 *    to hardcode whatever it touched, so "write the report to X" and "write the report to Y"
 *    were the same step, and the filesystem mission was not even re-runnable - the second run
 *    refused to overwrite the first run's file.
 *
 * 2. The filesystem mode's workspace containment must refuse to escape. That guarantee was
 *    asserted in comments; a safety property nobody has tested is a comment, not a control.
 */

const echoingTool: Tool = {
  name: 'echo-args',
  mode: 'filesystem',
  async run(_ctx, args) {
    return { kind: 'data', data: { received: args }, summary: `got ${Object.keys(args).length} arg(s)` }
  },
}

const passThrough: Verifier = {
  verifies: () => true,
  async verify(_s, _c, toolData) {
    return { evidence: { kind: 'file-exists', path: JSON.stringify(toolData) } }
  },
}

const plan = (extra: Partial<Step> = {}): Mission =>
  mission([step('a', { mode: 'filesystem', tool: 'echo-args', ...extra })])

// ------------------------------------------------------------- args reach the tool

test('the args declared on a step are handed to the tool', async () => {
  const r = await execute(plan({ args: { rel: 'report.txt', body: 'hello' } }), {
    tools: { resolve: () => ({ tool: echoingTool, fellBack: false, reason: 'exact' }) },
    verifier: passThrough, control: fakeControl(), config: ok,
  })
  const out = r.mission.plan[0].result!.outcome as { evidence: { path: string } }
  const received = JSON.parse(out.evidence.path) as { received: Record<string, unknown> }
  assert.deepEqual(received.received, { rel: 'report.txt', body: 'hello' })
})

test('a step with no args still runs, receiving an empty object rather than undefined', async () => {
  // The earlier code passed `{}` literally, so a tool doing `args.rel` never crashed. That
  // accident must not become a dependency: a tool must be able to tell "no operand" from
  // "an operand that happens to be empty".
  const r = await execute(plan(), {
    tools: { resolve: () => ({ tool: echoingTool, fellBack: false, reason: 'exact' }) },
    verifier: passThrough, control: fakeControl(), config: ok,
  })
  const out = r.mission.plan[0].result!.outcome as { evidence: { path: string } }
  const received = JSON.parse(out.evidence.path) as { received: Record<string, unknown> }
  assert.deepEqual(received.received, {})
})

test('different args produce different work - the step is actually aimed at something', async () => {
  const send = async (rel: string) => {
    const r = await execute(plan({ args: { rel } }), {
      tools: { resolve: () => ({ tool: echoingTool, fellBack: false, reason: 'exact' }) },
      verifier: passThrough, control: fakeControl(), config: ok,
    })
    const out = r.mission.plan[0].result!.outcome as { evidence: { path: string } }
    return (JSON.parse(out.evidence.path) as { received: { rel: string } }).received.rel
  }
  assert.equal(await send('alpha.txt'), 'alpha.txt')
  assert.equal(await send('beta.txt'), 'beta.txt')
})

test('args survive into the finished mission, so the record shows what was acted on', async () => {
  // An audit that cannot say which file was written cannot answer "what did it touch?".
  const r = await execute(plan({ args: { rel: 'audited.txt' } }), {
    tools: { resolve: () => ({ tool: echoingTool, fellBack: false, reason: 'exact' }) },
    verifier: passThrough, control: fakeControl(), config: ok,
  })
  assert.deepEqual(r.mission.plan[0].args, { rel: 'audited.txt' })
})

// ------------------------------------------------- the filesystem tool cannot escape

test('the filesystem mode refuses any path outside its dedicated workspace', async () => {
  const { writeProbeTool, WORKSPACE } = await import('../live/filesystem-mode.ts')

  // A real, sensitive location that must never be written by this mode.
  const outside = mkdtempSync(join(tmpdir(), 'aios-outside-'))
  const victim = join(outside, 'precious.txt')
  writeFileSync(victim, 'ORIGINAL CONTENT', 'utf8')

  try {
    // The traversal targets must be UNIQUE per run. The first version used a fixed
    // `../escape.txt`, so a leak from any earlier run - including a deliberate
    // negative-control run with the guard removed - left `%TEMP%\escape.txt` on disk and made
    // this test fail for a reason that had nothing to do with the code under test. Asserting
    // the absence of a globally-named path makes a test hostage to machine state it does not
    // control; the fix is to assert about a path only this run could have created.
    const tag = `${Date.now()}-${process.pid}`
    const escapes = [`..${sep}escape-${tag}.txt`, `..\\escape-${tag}.txt`, join(outside, 'precious.txt')]
    for (const rel of escapes) {
      const r = await writeProbeTool.run({} as never, { rel })
      assert.equal(r.kind, 'failed', `"${rel}" must be refused`)
      assert.match((r as { reason: string }).reason, /refused|outside/i,
        `the refusal must say why, for "${rel}"`)
    }

    // The proof that matters: the real file outside the workspace is untouched.
    assert.equal(readFileSync(victim, 'utf8'), 'ORIGINAL CONTENT',
      'nothing outside the workspace may be modified')
    for (const leaked of [
      join(WORKSPACE, '..', `escape-${tag}.txt`),
      join(WORKSPACE, '..', `..${sep}escape-${tag}.txt`),
    ]) {
      assert.equal(existsSync(leaked), false, `no traversal may create ${leaked}`)
    }
    assert.equal(existsSync(join(outside, 'escape.txt')), false, 'no escape file was created')
  } finally {
    rmSync(outside, { recursive: true, force: true })
  }
})

test('the filesystem tool refuses to overwrite, so a rerun cannot destroy prior evidence', async () => {
  const { writeProbeTool, WORKSPACE } = await import('../live/filesystem-mode.ts')
  const rel = `overwrite-probe-${Date.now()}.txt`
  try {
    const first = await writeProbeTool.run({} as never, { rel, body: 'FIRST' })
    assert.equal(first.kind, 'data')
    const second = await writeProbeTool.run({} as never, { rel, body: 'SECOND' })
    assert.equal(second.kind, 'failed', 'the second write must be refused')
    assert.match((second as { reason: string }).reason, /already exists/i)
    assert.equal(readFileSync(join(WORKSPACE, rel), 'utf8'), 'FIRST',
      'the original content must survive the refused overwrite')
  } finally {
    rmSync(join(WORKSPACE, rel), { force: true })
  }
})

test('the filesystem verifier rejects a path outside the workspace even if a file exists there', async () => {
  // The verifier is the last line of defence. If it will corroborate a claim about any path on
  // disk, then a compromised or confused tool could get an out-of-workspace write verified.
  const { filesystemVerifier } = await import('../live/filesystem-mode.ts')
  const outside = mkdtempSync(join(tmpdir(), 'aios-outside-'))
  const real = join(outside, 'real.txt')
  writeFileSync(real, 'really here', 'utf8')
  try {
    const v = await filesystemVerifier().verify({ mode: 'filesystem' } as never, {} as never, { path: real })
    assert.ok('rejected' in v, 'a real file outside the workspace must still be refused')
    assert.match((v as { rejected: string }).rejected, /outside the workspace/i)
  } finally {
    rmSync(outside, { recursive: true, force: true })
  }
})

test('the filesystem verifier rejects an empty file - existing is not the same as written', async () => {
  const { filesystemVerifier, ensureWorkspace, WORKSPACE } = await import('../live/filesystem-mode.ts')
  ensureWorkspace()
  const rel = `empty-probe-${Date.now()}.txt`
  const p = join(WORKSPACE, rel)
  writeFileSync(p, '', 'utf8')
  try {
    const v = await filesystemVerifier().verify({ mode: 'filesystem' } as never, {} as never, { path: p })
    assert.ok('rejected' in v, 'a zero-byte file is not a completed write')
  } finally {
    rmSync(p, { force: true })
  }
})

test('the filesystem verifier rejects a directory - only a regular file counts', async () => {
  const { filesystemVerifier, ensureWorkspace, WORKSPACE } = await import('../live/filesystem-mode.ts')
  ensureWorkspace()
  const rel = `dir-probe-${Date.now()}`
  const p = join(WORKSPACE, rel)
  rmSync(p, { recursive: true, force: true })
  mkdirSync(p)
  try {
    const v = await filesystemVerifier().verify({ mode: 'filesystem' } as never, {} as never, { path: p })
    assert.ok('rejected' in v, 'a directory is not a written file')
    assert.match((v as { rejected: string }).rejected, /not a regular file/i)
  } finally {
    rmSync(p, { recursive: true, force: true })
  }
})