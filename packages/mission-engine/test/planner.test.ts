import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
// @ts-expect-error Node test runner loads the TypeScript source directly.
import { DeterministicPlanProvider } from '../../planner/deterministic.ts'
// @ts-expect-error Node test runner loads the TypeScript source directly.
import { compilePlan } from '../../planner/compile.ts'
// @ts-expect-error Node test runner loads the TypeScript source directly.
import { renderPlan } from '../../planner/inspect-plan.ts'
// @ts-expect-error Node test runner loads the TypeScript source directly.
import { checkNewOutputFile, checkReadableFolder, isInside, expandPath } from '../../planner/paths.ts'
// @ts-expect-error Node test runner loads the TypeScript source directly.
import { StructuredSummarizer } from '../../planner/summarizer.ts'
// @ts-expect-error Node test runner loads the TypeScript source directly.
import { ToolRegistry, EmptyRegistry } from '../../tool-router/router.ts'
// @ts-expect-error Node test runner loads the TypeScript source directly.
import type { PlanContext, PlanProposal } from '../../planner/plan.ts'

/**
 * The planner boundary, the compiler's validation, operand safety, and the router's refusal to
 * substitute.
 *
 * The central claim under test: THE PLANNER PROPOSES, THE EXECUTOR DECIDES. That is not a
 * convention, so it is tested three ways - by reading the planner's imports, by checking the
 * compiler refuses malformed proposals, and by checking the router will not serve a step with
 * something the plan did not ask for.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const world = join(HERE, '..', '..', '.tmp-planner-test')
const sourceDir = join(world, 'src')
const outputRoot = join(world, 'out')

function seed(): void {
  rmSync(world, { recursive: true, force: true })
  mkdirSync(sourceDir, { recursive: true })
  mkdirSync(outputRoot, { recursive: true })
  mkdirSync(join(sourceDir, 'sub'), { recursive: true })
  writeFileSync(join(sourceDir, 'a.md'), '# a\n')
  writeFileSync(join(sourceDir, 'b.txt'), 'b\n')
}
seed()

const ctx: PlanContext = { outputRoot, now: () => 1_700_000_000_000 }
const provider = new DeterministicPlanProvider()
const objective = `Summarise the contents of the folder "${sourceDir}"`

test.after(() => rmSync(world, { recursive: true, force: true }))

// ==================================================== separation: the strongest claim

test('the planner cannot execute, because it does not import anything that can', () => {
  // Not a style rule. If the planner module transitively imports the executor or the governance
  // contract, then "the planner must not execute" is a promise rather than a property, and a
  // later edit could break it without any test noticing.
  const files = [
    join(HERE, '..', '..', 'planner', 'deterministic.ts'),
    join(HERE, '..', '..', 'planner', 'plan.ts'),
    join(HERE, '..', '..', 'planner', 'provider.ts'),
    join(HERE, '..', '..', 'planner', 'summarizer.ts'),
  ]
  for (const f of files) {
    const src = readFileSync(f, 'utf8')
    assert.doesNotMatch(src, /from\s+['"].*mission-engine\/executor/, `${f} must not import the executor`)
    assert.doesNotMatch(src, /from\s+['"].*governance\/contract/, `${f} must not import the governance contract`)
    assert.doesNotMatch(src, /from\s+['"].*control-core/, `${f} must not import the control core`)
  }
})

test('the planner has no filesystem write capability at all', () => {
  // `paths.ts` may READ for validation. Nothing in the planner may WRITE, because a planner that
  // can write is a planner that can act, and "proposes" stops meaning anything.
  const src = readFileSync(join(HERE, '..', '..', 'planner', 'deterministic.ts'), 'utf8')
  assert.doesNotMatch(src, /writeFileSync|appendFileSync|mkdirSync|rmSync|unlinkSync|renameSync/)
  assert.doesNotMatch(src, /from\s+['"]node:fs['"]/)
})

test('the planner produces a proposal, never a Mission', () => {
  // The proposal is plain data with no execution state on it. If it carried `state` or
  // `history`, a planner could assert where a mission is, and the separation would be cosmetic.
  return provider.plan(objective, ctx).then((r) => {
    assert.equal(r.ok, true)
    if (!r.ok) return
    const p = r.proposal as unknown as Record<string, unknown>
    for (const forbidden of ['state', 'history', 'pendingApprovals', 'startedAt', 'result', 'status']) {
      assert.equal(p[forbidden], undefined, `a proposal must not carry "${forbidden}"`)
    }
    for (const s of p.steps as Array<Record<string, unknown>>) {
      for (const forbidden of ['status', 'attempts', 'result', 'evidence']) {
        assert.equal(s[forbidden], undefined, `a plan step must not carry "${forbidden}"`)
      }
    }
  })
})

// ==================================================== the contract's required fields

test('the proposal carries every field the contract requires', async () => {
  const r = await provider.plan(objective, ctx)
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.proposal.objective, objective)
  assert.ok(r.proposal.constraints.length > 0, 'a plan must state what it is forbidden to do')
  assert.ok(r.proposal.expectedResult.length > 0)
  assert.equal(r.proposal.steps.length, 5)
  for (const s of r.proposal.steps) {
    assert.ok(s.id && s.intent && s.mode && s.tool && s.rationale, `step ${s.id} is missing a required field`)
    assert.ok(s.verification?.kind, `step ${s.id} must declare a verification requirement`)
    assert.ok(s.onFailure, `step ${s.id} must declare failure behaviour`)
    assert.equal(typeof s.args, 'object')
  }
})

test('dependencies are declared and acyclic', async () => {
  const r = await provider.plan(objective, ctx)
  assert.equal(r.ok, true)
  if (!r.ok) return
  const ids = r.proposal.steps.map((s) => s.id)
  for (const s of r.proposal.steps) {
    for (const d of s.dependsOn) assert.ok(ids.includes(d), `${s.id} depends on unknown ${d}`)
  }
  // The first step depends on nothing; every later step depends on something.
  assert.deepEqual(r.proposal.steps[0].dependsOn, [])
  assert.ok(r.proposal.steps.slice(1).every((s) => s.dependsOn.length > 0))
})

test('the plan is inspectable before anything runs', async () => {
  const r = await provider.plan(objective, ctx)
  assert.equal(r.ok, true)
  if (!r.ok) return
  const text = renderPlan(r.proposal, { missionId: 'm1' })
  for (const needle of ['PROPOSED PLAN', 'intent', 'depends on', 'verification', 'on failure', 'constraints', 'm1']) {
    assert.ok(text.includes(needle), `the report must show "${needle}"`)
  }
})

// ==================================================== the compiler validates

const goodProposal = async (): Promise<PlanProposal> => {
  const r = await provider.plan(objective, ctx)
  assert.equal(r.ok, true, r.ok ? '' : `the planner refused a valid objective: ${r.reason}`)
  if (!r.ok) throw new Error('unreachable')
  return r.proposal
}

test('a well-formed proposal compiles into a mission in DRAFTING with no history', async () => {
  const c = compilePlan(await goodProposal(), 'm1', 0)
  assert.equal(c.ok, true)
  if (!c.ok) return
  assert.equal(c.mission.state, 'drafting', 'a fresh mission has not started')
  assert.deepEqual(c.mission.history, [])
  assert.deepEqual(c.mission.pendingApprovals, [])
  assert.equal(c.mission.plan[0].status, 'pending', 'no step may arrive pre-completed')
})

test('a proposal with a dangling dependency is REFUSED, not repaired', async () => {
  const p = await goodProposal()
  const broken: PlanProposal = { ...p, steps: p.steps.map((s, i) => (i === 1 ? { ...s, dependsOn: ['no-such-step'] } : s)) }
  const c = compilePlan(broken, 'm1', 0)
  assert.equal(c.ok, false)
  if (c.ok) return
  assert.match(c.reason, /not a step in this plan/)
})

test('a proposal with a dependency CYCLE is refused', async () => {
  const p = await goodProposal()
  const steps = p.steps
  const cyclic: PlanProposal = {
    ...p,
    steps: steps.map((s, i) => (i === 0 ? { ...s, dependsOn: ['confirm-report'] } : s)),
  }
  const c = compilePlan(cyclic, 'm1', 0)
  assert.equal(c.ok, false, 'a cycle must be refused')
  if (!c.ok) assert.match(c.reason, /cycle|after it/)
})

test('a proposal whose dependency is listed LATER is refused', async () => {
  // The executor walks steps in array order, so a forward dependency would be treated as unmet
  // and block. Silently reordering would hide a plan defect.
  const p = await goodProposal()
  const reordered: PlanProposal = { ...p, steps: [p.steps[1], p.steps[0], ...p.steps.slice(2)] }
  const c = compilePlan(reordered, 'm1', 0)
  assert.equal(c.ok, false)
  if (!c.ok) assert.match(c.reason, /listed after it/)
})

test('a proposal with duplicate step ids is refused', async () => {
  const p = await goodProposal()
  const dupe: PlanProposal = { ...p, steps: [p.steps[0], { ...p.steps[0] }, ...p.steps.slice(1)] }
  const c = compilePlan(dupe, 'm1', 0)
  assert.equal(c.ok, false)
  if (!c.ok) assert.match(c.reason, /duplicate step id/)
})

test('a proposal missing a verification requirement is refused', async () => {
  const p = await goodProposal()
  const unverified: PlanProposal = {
    ...p,
    steps: p.steps.map((s, i) => (i === 0 ? { ...s, verification: undefined as never } : s)),
  }
  const c = compilePlan(unverified, 'm1', 0)
  assert.equal(c.ok, false)
  if (!c.ok) assert.match(c.reason, /verification requirement/)
})

// ==================================================== operand safety

test('a nonexistent folder is refused with a reason', () => {
  const c = checkReadableFolder(join(world, 'no-such-folder'))
  assert.equal(c.ok, false)
  if (!c.ok) assert.match(c.reason, /does not exist/)
})

test('a FILE is not accepted where a folder is required', () => {
  const c = checkReadableFolder(join(sourceDir, 'a.md'))
  assert.equal(c.ok, false)
  if (!c.ok) assert.match(c.reason, /is a file, not a folder/)
})

test('an output name containing a path is refused', () => {
  for (const bad of ['../escape.md', 'sub\\escape.md', 'a/b.md', 'C:\\abs.md']) {
    const c = checkNewOutputFile(outputRoot, bad)
    assert.equal(c.ok, false, `"${bad}" must be refused`)
  }
})

test('an existing output file is refused, so nothing can be overwritten', () => {
  writeFileSync(join(outputRoot, 'taken.md'), 'existing\n')
  const c = checkNewOutputFile(outputRoot, 'taken.md')
  assert.equal(c.ok, false)
  if (!c.ok) assert.match(c.reason, /already exists/)
  // And the pre-existing content is untouched.
  assert.equal(readFileSync(join(outputRoot, 'taken.md'), 'utf8'), 'existing\n')
  rmSync(join(outputRoot, 'taken.md'), { force: true })
})

test('containment is not fooled by a shared name prefix', () => {
  // The classic naive-prefix bug: `...\DocumentsEvil` starts with `...\Documents`.
  const root = join(world, 'docs')
  mkdirSync(root, { recursive: true })
  assert.equal(isInside(root, join(world, 'docs', 'a.md')), true)
  assert.equal(isInside(root, join(world, 'docs-evil', 'a.md')), false, 'a sibling with a shared prefix is NOT inside')
  assert.equal(isInside(root, join(world, 'docs')), true, 'the root itself is inside')
})

test('the planner refuses an objective naming a folder that does not exist', async () => {
  const r = await provider.plan('Summarise the contents of the folder "C:\\nope\\not\\here"', ctx)
  assert.equal(r.ok, false)
})

test('the planner refuses an objective it does not recognise, and says what it handles', async () => {
  const r = await provider.plan('Book me a flight to Tokyo next Tuesday', ctx)
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.ok(r.reason.includes('does not recognise'))
  assert.ok(r.reason.includes('summarise') || r.reason.includes('folder'), 'the refusal must say what IS handled')
  assert.deepEqual([...r.unsupported], ['Book me a flight to Tokyo next Tuesday'])
})

test('an empty objective is refused', async () => {
  assert.equal((await provider.plan('   ', ctx)).ok, false)
})

// ==================================================== the router refuses to substitute

const stubTool = (name: string, mode: 'filesystem' | 'cli') => ({
  name, mode,
  async run() { return { kind: 'data' as const, data: {}, summary: '' } },
})

test('the router serves an exactly-named tool', () => {
  const reg = new ToolRegistry({ registrations: [{ tool: stubTool('read-folder', 'filesystem') }] })
  const r = reg.resolve({ id: 's', tool: 'read-folder', mode: 'filesystem' } as never)
  assert.ok('tool' in r)
  if ('tool' in r) assert.equal(r.fellBack, false)
})

test('the router REFUSES an unregistered tool rather than substituting', () => {
  // The defect this prevents: a step asking for a capability nobody registered silently served
  // by the nearest thing, returning an empty result that verifies against itself.
  const reg = new ToolRegistry({ registrations: [{ tool: stubTool('read-folder', 'filesystem') }] })
  const r = reg.resolve({ id: 's', tool: 'read-webpage', mode: 'filesystem' } as never)
  assert.ok('unavailable' in r, 'an unknown tool must be unavailable')
  if ('unavailable' in r) assert.match(r.unavailable, /no tool named "read-webpage"/)
})

test('the router does not substitute across execution modes', () => {
  // A gui step must never be served by a filesystem tool, even with fallback enabled.
  const reg = new ToolRegistry({
    registrations: [{ tool: stubTool('read-folder', 'filesystem'), substituteFor: ['do-anything'] }],
  })
  const r = reg.resolve({ id: 's', tool: 'do-anything', mode: 'gui' }, { allowFallback: true })
  assert.ok('unavailable' in r, 'a mode mismatch must not be substituted across')
})

test('fallback happens only when asked for, and is marked', () => {
  const reg = new ToolRegistry({
    registrations: [{ tool: stubTool('read-folder', 'filesystem'), substituteFor: ['read-entries'], note: 'closer' }],
  })
  const step = { id: 's', tool: 'read-entries', mode: 'filesystem' } as never
  const strict = reg.resolve(step)
  assert.ok('unavailable' in strict, 'strict mode must not fall back')
  const loose = reg.resolve(step, { allowFallback: true })
  assert.ok('tool' in loose)
  if ('tool' in loose) {
    assert.equal(loose.fellBack, true)
    assert.match(loose.reason, /substituted/)
  }
})

test('an empty registry serves nothing and says so', () => {
  const reg = new EmptyRegistry()
  const r = reg.resolve({ id: 's', tool: 'anything', mode: 'filesystem' } as never)
  assert.ok('unavailable' in r)
  assert.deepEqual(reg.names(), [])
})

test('a duplicate registration is refused rather than resolved by load order', () => {
  assert.throws(
    () => new ToolRegistry({ registrations: [{ tool: stubTool('dup', 'cli') }, { tool: stubTool('dup', 'cli') }] }),
    /duplicate tool registration/,
  )
})

// ==================================================== the summarizer boundary

test('the summarizer is a pure function of its listing and declares its provenance', async () => {
  const s = new StructuredSummarizer()
  const entries = [
    { name: 'a.md', kind: 'file' as const, bytes: 10, extension: 'md' },
    { name: 'b.md', kind: 'file' as const, bytes: 20, extension: 'md' },
    { name: 'sub', kind: 'directory' as const, extension: '' },
  ]
  const r = await s.generate({ folderLabel: 'F', entries })
  assert.equal(r.provenance, 'deterministic')
  assert.equal(r.entryCount, 3)
  assert.equal(r.fileCount, 2)
  assert.equal(r.directoryCount, 1)
  assert.match(r.text, /3 entries total/)
  assert.match(r.text, /md \(2\)/)
  assert.match(r.text, /did not read file contents/, 'the artefact must state its own limits')
  assert.match(r.text, /no claim about meaning/, 'and must not imply it understood the files')
  // Deterministic: the same input gives the same output.
  const again = await s.generate({ folderLabel: 'F', entries })
  assert.equal(again.text, r.text)
})

test('the summarizer receives a listing and cannot read anything itself', async () => {
  const src = readFileSync(join(HERE, '..', '..', 'planner', 'summarizer.ts'), 'utf8')
  assert.doesNotMatch(src, /from\s+['"]node:fs['"]/, 'the summarizer must not touch the filesystem')
})