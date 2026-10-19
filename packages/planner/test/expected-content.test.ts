import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, writeFileSync, readFileSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { DeterministicPlanProvider } from '../deterministic.ts'
import { expectedFolderSummary } from '../expected-content.ts'
import { StructuredSummarizer } from '../summarizer.ts'
import type { ObjectivePostcondition } from '../../mission-engine/state.ts'
import type { PlanProposal } from '../plan.ts'
import { compilePlan } from '../compile.ts'
import { LocalObservationProvider } from '../../observation/local.ts'
import { execute } from '../../mission-engine/executor.ts'
import { ToolRegistry } from '../../tool-router/router.ts'
import { FOLDER_TOOLS, folderVerifiers } from '../../mission-engine/live/folder-tools.ts'
import { fakeControl } from '../../mission-engine/test/fakes.ts'
import type { Tool, ToolContext, ToolResult } from '../../mission-engine/executor.ts'

/**
 * THE PREDICTION MUST MATCH WHAT IS WRITTEN.
 *
 * A content postcondition is only worth anything if the planner's predicted hash equals the bytes
 * the executor actually produces. If it does not, every correct mission fails its objective - a
 * permanent false negative, which is worse than not checking, because a permanently red check is a
 * check readers learn to ignore.
 *
 * So this asserts the prediction against the real pipeline: real planner, real observation, real
 * composer, real tools, real verifiers. Not against a hand-built mission.
 */

const byName = (n: string) => FOLDER_TOOLS.find((t) => t.name === n)!

/**
 * The real folder tool stack, optionally with `compose-summary` swapped for another tool.
 *
 * `composeOverride` is a TOOL, not a registration. An earlier version of this helper took a
 * `{ name, tool }` object and passed it straight through as the registration, which registered the
 * substitute with NO capabilities - so the router reported "no registered tool serves the
 * capability filesystem.transform", `compose` failed before writing anything, and the
 * under-reporting control appeared to show a mission that simply never ran.
 *
 * The failure was in this harness, not in the objective rule. It is worth naming because a control
 * that fails for the wrong reason is worse than no control: it looks like evidence and is not.
 */
function folderRegistry(composeOverride?: Tool) {
  return new ToolRegistry({ registrations: [
    { tool: byName('read-folder'), capabilities: ['filesystem.inspect'] },
    { tool: byName('inspect-folder'), capabilities: ['filesystem.list'] },
    { tool: composeOverride ?? byName('compose-summary'), capabilities: ['filesystem.transform'] },
    { tool: byName('write-report'), capabilities: ['filesystem.write'] },
    { tool: byName('read-report'), capabilities: ['filesystem.confirm'] },
  ] })
}

function makeWorld(files: Record<string, number | null>, root: string) {
  mkdirSync(root, { recursive: true })
  for (const [name, size] of Object.entries(files)) {
    if (size === null) mkdirSync(join(root, name), { recursive: true })
    else writeFileSync(join(root, name), 'x'.repeat(size), 'utf8')
  }
}

/** Plans and runs the real folder-summary recipe into a fresh output directory. */
async function planAndRun(root: string, src: string, tools: ToolRegistry, outBase?: string) {
  // `outBase` exists because an output directory created INSIDE the observed folder changes the
  // observation, and therefore the prediction. That is not a hypothetical: it is how a self-
  // referential output path makes a correct mission fail its own content check.
  const out = mkdtempSync(join(outBase ?? root, 'out-'))
  let t = 0
  const now = () => ++t

  const obs = await new LocalObservationProvider().observe({ root } as never)
  const world = 'world' in obs ? (obs as unknown as { world: never }).world : obs

  const provider = new DeterministicPlanProvider()
  const plan = await provider.plan(`summarise all the files in ${src}`, {
    now, outputRoot: out, outputFileName: 'summary.txt', world,
  } as never)
  if (!plan.ok) throw new Error(`planner refused: ${plan.reason}`)
  const compiled = compilePlan(plan.proposal, 'm1', 0)
  if (!compiled.ok) throw new Error(`compiler refused: ${compiled.reason}`)

  const result = await execute(compiled.mission, {
    tools, verifier: folderVerifiers(out) as never,
    control: fakeControl() as never, config: { now, maxAttempts: 2 },
  })
  return { plan, result, out, written: (() => { try { return readFileSync(join(out, 'summary.txt'), 'utf8') } catch { return undefined } })() }
}

// ============================================================ the composer's own contract

test('the composer output depends on the SET of entries, never on their order', () => {
  // Load-bearing for everything below. The tool lists with `readdirSync`, whose order is a
  // filesystem detail; the planner lists from the observation, sorted by relative path. If the
  // composer cared about order, no prediction could ever match.
  const e = (name: string, kind: 'file' | 'directory', bytes?: number) =>
    ({ name, kind, bytes, extension: kind === 'directory' ? '' : '' })
  const A = [e('zeta.ts', 'file', 500), e('alpha.ts', 'file', 500), e('m.ts', 'file', 900), e('d2', 'directory'), e('d1', 'directory')]
  const B = [e('d1', 'directory'), e('alpha.ts', 'file', 500), e('m.ts', 'file', 900), e('d2', 'directory'), e('zeta.ts', 'file', 500)]

  return Promise.all([
    new StructuredSummarizer().generate({ folderLabel: 'X', entries: A }),
    new StructuredSummarizer().generate({ folderLabel: 'X', entries: B }),
  ]).then(([a, b]) => {
    assert.equal(a.text, b.text, 'byte-tied files and folders must not reorder with the input')
  })
})

// ============================================================ the prediction

test('the planner PREDICTS the exact bytes the executor writes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mc-pred-'))
  try {
    const src = join(root, 'src')
    // Byte TIES and a subdirectory on purpose: the two cases where input order used to leak into
    // the output. A prediction that only works on conveniently-ordered input is not a prediction.
    makeWorld({
      'alpha.ts': 120, 'beta.ts': 80, 'gamma.md': 200,
      'same.ts': 80, 'same2.ts': 80, 'noext': 10,
      sub: null,
    }, src)

    const { plan, written } = await planAndRun(root, src, folderRegistry())
    const content = (plan.proposal.objectivePostconditions ?? [])
      .find((p) => p.kind === 'artifact-content-matches')

    assert.ok(content, 'a complete observation must yield a content postcondition')
    assert.equal(content.kind, 'artifact-content-matches')
    assert.equal(
      content.sha256,
      createHash('sha256').update(written!, 'utf8').digest('hex'),
      'the declared hash IS the hash of the file the executor wrote',
    )
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('expectedFolderSummary DECLINES rather than guessing when the observation cannot support it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mc-decl-'))
  try {
    const src = join(root, 'src')
    makeWorld({ 'a.ts': 10 }, src)
    const obs = await new LocalObservationProvider().observe({ root } as never)
    const world = 'world' in obs ? (obs as unknown as { world: never }).world : obs

    const missing = await expectedFolderSummary(world, join(root, 'nowhere'))
    assert.equal(missing.ok, false, 'an unobserved folder must not produce a prediction')

    const truncated = await expectedFolderSummary({ ...world, truncated: true }, src)
    assert.equal(truncated.ok, false, 'a truncated observation describes what it saw, not what is there')

    const good = await expectedFolderSummary(world, src)
    assert.equal(good.ok, true, 'and a complete observation of a real folder does')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a folder outside the observed scope falls back to the narrower claim, not a wrong hash', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mc-fall-'))
  try {
    const observed = join(root, 'observed')
    const unobserved = join(root, 'unobserved')
    makeWorld({ 'a.ts': 10 }, observed)
    makeWorld({ 'b.ts': 10 }, unobserved)
    const obs = await new LocalObservationProvider().observe({ root: observed } as never)
    const world = 'world' in obs ? (obs as unknown as { world: never }).world : obs

    const r = await expectedFolderSummary(world, unobserved)
    assert.equal(r.ok, false, 'and the helper says so rather than predicting for a folder it never saw')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// ============================================================ FAIL-CLOSED ON AN IMPLAUSIBLE EMPTY PREDICTION

test('GUARD: an empty prediction for the observation ROOT declines instead of hashing nothing', async () => {
  // The silent failure, reproduced deliberately: an observation that claims it descended, whose
  // root is the subject, and which matches zero children. Whether the folder is truly empty or the
  // matching is broken is indistinguishable from here, so the helper must decline rather than return
  // `ok: true` with a hash of an empty summary.
  // The observation CLAIMS it walked three levels deep, yet recorded no children of its own root.
  // Whether the folder is truly empty or the enumeration failed is indistinguishable from here.
  const world = {
    observationId: 'obs-guard', observedAt: 1, fingerprint: 'fp',
    scope: { root: 'C:\\w', maxDepth: 3 },
    entries: [
      { path: 'C:\\w', relative: '', kind: 'directory', depth: 0 },
    ],
    truncated: false, errors: [],
  } as never

  const r = await expectedFolderSummary(world, 'C:\\w')
  assert.equal(r.ok, false, 'an empty prediction at the root with a claimed depth must not be trusted')
  if (r.ok) return
  assert.match(r.reason, /indistinguishable from a broken one/)
})

test('GUARD: a genuinely EMPTY root folder still predicts empty when no depth was claimed', async () => {
  // The guard must not make empty folders unpredictable - only implausibly-empty ones doubtful.
  // `maxDepth: 0` means the observer never descended, so zero children is the honest answer.
  const world = {
    observationId: 'obs-empty', observedAt: 1, fingerprint: 'fp',
    scope: { root: 'C:\\w', maxDepth: 0 },
    entries: [{ path: 'C:\\w', relative: '', kind: 'directory', depth: 0 }],
    truncated: false, errors: [],
  } as never

  const r = await expectedFolderSummary(world, 'C:\\w')
  assert.equal(r.ok, true, 'a real empty folder is a predictable empty summary')
  if (!r.ok) return
  assert.equal(r.entryCount, 0)
  assert.match(r.text, /0 entries total/)
})

test('GUARD: a NON-ROOT empty folder predicts empty even when a depth was claimed', async () => {
  // The guard keys on the subject being the observation ROOT. A subfolder that is empty while the
  // observer descended is an ordinary fact about the world, not a contradiction.
  const root = mkdtempSync(join(tmpdir(), 'mc-guard-'))
  try {
    const src = join(root, 'src')
    const empty = join(src, 'empty')
    mkdirSync(empty, { recursive: true })
    writeFileSync(join(src, 'a.ts'), 'a'.repeat(10), 'utf8')

    const observed = await new LocalObservationProvider().observe({ root: src, maxDepth: 4 } as never)
    const r = await expectedFolderSummary(observed as never, empty)
    assert.equal(r.ok, true, 'an empty subfolder is not a broken prediction')
    if (!r.ok) return
    assert.equal(r.entryCount, 0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// ============================================================ THE NEGATIVE CONTROL

test('REGRESSION: when the observed folder IS the observation root, the prediction is not empty', async () => {
  // Found by running `run-folder-summary`, which observes the SOURCE FOLDER ITSELF rather than a
  // parent of it. The helper selected children by `relative` prefix, and the root's `relative` is
  // spelled differently from a child-bearing prefix, so it matched nothing: the prediction described
  // an EMPTY folder, and every such mission failed its own objective with a perfectly good report on
  // disk.
  //
  // The failure was silent - `ok: true`, a real-looking hash, and a content postcondition declared
  // with confidence. A helper that declines is safe; one that predicts confidently about nothing is
  // not, which is why this asserts the ENTRY COUNT rather than just that a hash exists.
  const root = mkdtempSync(join(tmpdir(), 'mc-root-'))
  try {
    const src = join(root, 'src')
    makeWorld({ 'a.ts': 120, 'b.ts': 80, 'c.md': 200 }, src)

    const observed = await new LocalObservationProvider().observe({ root: src, maxDepth: 4 } as never)
    const predicted = await expectedFolderSummary(observed as never, src)
    assert.equal(predicted.ok, true)
    if (!predicted.ok) return
    assert.equal(predicted.entryCount, 3,
      'the three observed files must be seen - a prediction over an empty folder is worse than no prediction')
    assert.match(predicted.text, /3 entries total: 3 file\(s\)/)

    // And it must agree with what the executor writes for the same world - with the output written
    // OUTSIDE the observed folder, as `run-folder-summary` requires.
    const { written } = await planAndRun(src, src, folderRegistry(), root)
    assert.ok(written, 'a report was written')
    assert.equal(
      predicted.sha256,
      createHash('sha256').update(written!, 'utf8').digest('hex'),
      'the prediction for the observation root is the bytes the executor actually wrote',
    )
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('CONTROL: a writer naming 1 of 5 files cannot report success, with every step verified', async () => {
  // THE scenario, on the real path: real planner, real observation, real composer, real tools, real
  // verifiers, real read-back verifier.
  //
  // The substitute composer is handed all five entries and names one. Everything it produces still
  // looks right - a real file, a plausible size, a stable independent re-read, a well-formed summary
  // - so every STEP passes. Only the objective can catch it, and the objective's content claim is
  // declared by the planner, not by this test.
  const root = mkdtempSync(join(tmpdir(), 'mc-neg-'))
  try {
    const src = join(root, 'src')
    makeWorld({ 'a.ts': 50, 'b.ts': 50, 'c.ts': 50, 'd.ts': 50, 'e.ts': 50 }, src)

    const shortCompose: Tool = {
      name: 'compose-summary', mode: 'filesystem',
      async run(ctx: ToolContext): Promise<ToolResult> {
        const listing = ctx.prior?.['inspect-folder']?.output as { entries?: { name: string }[] } | undefined
        const entries = listing?.entries ?? []
        assert.equal(entries.length, 5, 'it really was given all five entries')
        const text =
          `# Contents of ${src}\n\n- ${entries.length} entries total: ${entries.length} file(s), 0 folder(s)\n` +
          `- by extension: ts (5)\n\n- ${entries[0]!.name} - ${entries[0]!.name} - ${entries[0]!.name} - only this one\n`
        return {
          kind: 'data',
          data: { text, provenance: 'deterministic', entryCount: entries.length, folderLabel: src },
          summary: `composed a summary via under-reporting-writer`,
        }
      },
    }

    const bad = await planAndRun(root, src, folderRegistry(shortCompose))

    // THE PRECONDITION. Without it this is not a control, it is just a failure: the point is that
    // the step layer is entirely green and the objective still refuses.
    assert.ok(bad.written, 'the short report really was written to disk')
    assert.equal(
      bad.result.record.verified['write-report']?.kind, 'file-written',
      'the write step verified',
    )
    assert.equal(
      bad.result.record.verified['confirm-report']?.kind, 'file-read-back',
      'the read-back step verified, from an independent second read',
    )
    assert.equal(bad.result.mission.plan.every((s) => s.status === 'done'),
      true, 'every step reached a done status - the step contract is fully satisfied')

    // ...and the objective still says no.
    assert.equal(bad.result.record.objective.kind, 'unmet')
    assert.equal(bad.result.record.complete, false, 'a report naming one file of five is not a delivered summary')
    assert.equal(bad.result.record.finalState, 'failed')

    const good = await planAndRun(root, src, folderRegistry())
    assert.equal(good.result.record.complete, true, 'the honest writer still succeeds - this is not a blanket refusal')
    assert.equal(good.result.record.objective.kind, 'satisfied')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('CONTROL: dropping the content condition leaves only the checks that a wrong report also passes', async () => {
  // What the content condition is actually buying. Existence and read-back are satisfied by a report
  // of the right shape holding the wrong facts - which is why they alone could never have caught
  // the original defect, and why the content claim is not redundant with them.
  const root = mkdtempSync(join(tmpdir(), 'mc-weaken-'))
  try {
    const src = join(root, 'src')
    makeWorld({ 'a.ts': 50, 'b.ts': 50, 'c.ts': 50 }, src)
    const { plan, written } = await planAndRun(root, src, folderRegistry())
    assert.ok(written, 'a report exists')

    const all: readonly ObjectivePostcondition[] = plan.proposal.objectivePostconditions ?? []
    const kept: readonly string[] = all.filter((p) => p.kind !== 'artifact-content-matches').map((p) => p.kind)
    assert.deepEqual([...kept].sort(), ['artifact-exists', 'artifact-read-back'],
      'the two weaker conditions are exactly existence and an independent re-read')
    assert.ok(all.some((p) => p.kind === 'artifact-content-matches'),
      'and the content condition is an addition to them, not a replacement')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
