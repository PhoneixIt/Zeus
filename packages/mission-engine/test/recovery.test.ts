import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { runMission, checkToolAvailability } from '../supervisor.ts'
import { ObjectiveReconciler, observeDirectories } from '../../planner/reconcile.ts'
import { DeterministicPlanProvider } from '../../planner/deterministic.ts'
import { LocalObservationProvider } from '../../observation/local.ts'
import type { Capability, PlanContext, PlanResult } from '../../planner/plan.ts'
// `PlanProvider` is declared in planner/provider.ts. plan.ts does not re-export it.
import type { PlanProvider } from '../../planner/provider.ts'
import { compilePlan } from '../../planner/compile.ts'
import { ToolRegistry } from '../../tool-router/router.ts'
import { FOLDER_TOOLS, folderVerifiers } from '../live/folder-tools.ts'
import { fakeControl } from './fakes.ts'
import type { Tool } from '../executor.ts'
import type { ControlSurface } from '../../governance/contract.ts'

/**
 * The recovery mechanism, tested link by link.
 *
 * The proof in `live/run-recovery.ts` shows a mission recovering from a genuine environmental
 * change. These tests remove each link in that chain and require recovery to stop working, which
 * is what distinguishes a mechanism from a coincidence.
 */

const CONFIG = {
  maxAttempts: 1,
  permission: async () => ({
    control: 'ARMED' as const, input: 'PERMITTED' as const,
    blockedBy: null, infrastructureHealthy: true, mayInject: false,
  }),
  emergencyStop: async () => false,
}

function buildWorld() {
  const root = mkdtempSync(join(tmpdir(), 'aios-recov-test-'))
  const before = join(root, 'reports')
  const after = join(root, 'archive', 'reports')
  const outputRoot = join(root, 'out')
  mkdirSync(before, { recursive: true })
  mkdirSync(outputRoot, { recursive: true })
  writeFileSync(join(before, 'a.md'), '# a\n')
  writeFileSync(join(before, 'b.txt'), 'b\n')
  return { root, before, after, outputRoot }
}

/** Tools that move the folder at the start of the second step, once. */
function movingTools(destination: string) {
  const inner = FOLDER_TOOLS.find((t) => t.name === 'inspect-folder')!
  let fired = false
  const tool: Tool = {
    name: 'inspect-folder',
    mode: 'filesystem',
    async run(ctx, args) {
      if (!fired) {
        fired = true
        mkdirSync(dirname(destination), { recursive: true })
        renameSync(join(dirname(destination), '..', 'reports'), destination)
      }
      return inner.run(ctx, args)
    },
  }
  return folderRegistry([], { 'inspect-folder': tool })
}

/**
 * The folder tools, each declaring which ABSTRACT CAPABILITY it serves.
 *
 * M6 made the capability part of the contract, so a registration that omits it serves nothing and
 * every step naming a capability is refused before execution. That is the system working: the
 * registry is where capability maps to implementation, and a tool that does not say what it provides
 * cannot be selected for anything.
 *
 * The mapping is declared here rather than inside `folder-tools.ts` so the recovery tests can see it,
 * and so the declarations are visible in one place instead of scattered across a tool list.
 */
/**
 * The folder tools, each declaring which ABSTRACT CAPABILITY it serves.
 *
 * M6 made the capability part of the contract: a registration that omits it serves nothing, and a
 * step naming a capability is refused before execution. So the mapping is declared here rather than
 * inferred, and it is one tool per capability.
 *
 * Getting here took three attempts, and the reason is worth recording. `read-folder` and
 * `read-report` both read something, so registering both under `filesystem.read` made
 * `resolveCapability` report AMBIGUITY and refuse every read step - correctly. Two earlier fixes
 * responded by dropping a tool from the registry, which resolved the ambiguity by removing a
 * capability rather than by describing the two jobs accurately. The vocabulary was the thing that
 * was wrong: confirming a folder is readable, enumerating it, and confirming a written artifact
 * reads back are three different operations, and collapsing them into one name is what forced the
 * choice.
 */
const FOLDER_REGISTRATIONS = [
  { tool: FOLDER_TOOLS.find((t) => t.name === 'read-folder')!, capabilities: ['filesystem.inspect'] },
  { tool: FOLDER_TOOLS.find((t) => t.name === 'inspect-folder')!, capabilities: ['filesystem.list'] },
  { tool: FOLDER_TOOLS.find((t) => t.name === 'compose-summary')!, capabilities: ['filesystem.transform'] },
  { tool: FOLDER_TOOLS.find((t) => t.name === 'write-report')!, capabilities: ['filesystem.write'] },
  { tool: FOLDER_TOOLS.find((t) => t.name === 'read-report')!, capabilities: ['filesystem.confirm'] },
]

/**
 * The registry these tests use, optionally excluding or substituting tools.
 *
 * The world-change is injected by replacing `inspect-folder`, so the default excludes nothing and
 * every capability resolves unambiguously.
 */
function folderRegistry(exclude: readonly string[] = [], replace: Record<string, Tool> = {}): ToolRegistry {
  return new ToolRegistry({
    registrations: FOLDER_REGISTRATIONS
      .filter((r) => !exclude.includes(r.tool.name))
      .map((r) => ({ ...r, tool: replace[r.tool.name] ?? r.tool })),
  })
}

const deps = (tools: ToolRegistry, outputRoot: string, over: Record<string, unknown> = {}) => ({
  // ONE provider, and it is the grounded wrapper below. This literal used to set `provider` TWICE -
  // first to the plain `DeterministicPlanProvider`, then to that wrapper - and the second silently won
  // at runtime. That is legal JavaScript and an error in a TypeScript object type, so the first line
  // was dead from the moment it was written while reading as though two planners were in play.
  //
  // These tests are about the RECOVERY LOOP, not the planner, so the phrase-matching provider stays
  // - swapping it would change what is under test.
  //
  // But M6 made the compiler refuse any plan that names no observation, so that provider's output is
  // no longer accepted. Rather than weaken the compiler - which would reopen the exact hole M6 closed
  // - the test gives the loop a planner that produces a GROUNDED plan, because a recovery loop that
  // can only recover plans which were never valid in the first place is not a recovery loop worth
  // proving.
  //
  // The wrapper is a test fixture, and it says so: it observes for real, then delegates. What it does
  // NOT do is fake the basis, which is the point - a fixture that asserted a plan was grounded
  // without looking would test nothing.
  observer: new LocalObservationProvider(),
  observeDepth: 4,
  maxObservationAgeMs: 60_000,
  provider: {
    name: 'recovery-fixture-grounded',
    // NOT declared as `requiresObservation`.
    //
    // The fixture observes for ITSELF, inside `plan()`, because these tests are about the recovery
    // loop and the supervisor's job is to hand a planner a view - not to police how a planner got
    // one. Declaring the requirement made the supervisor refuse before `plan()` ran, and every
    // recovery test then failed on a guard rather than on the behaviour it was written to prove.
    //
    // The fixture still cannot produce an unfounded plan: it reads the real filesystem and attaches
    // the resulting fingerprint, so a plan it emits is grounded whether or not anyone handed it a
    // context. The compiler enforces the grounding; the supervisor's guard is a convenience for
    // callers who forget to configure an observer.
    capabilities: () => ['grounded folder summary, for the recovery loop tests'],
    async plan(objective: string, ctx: PlanContext): Promise<PlanResult> {
      // Uses the observation the SUPERVISOR supplied, and observes again itself if it did not.
      //
      // The supervisor's guard fires before `plan()` whenever a provider declares
      // `requiresObservation` and no observer is configured - and these tests call the provider
      // directly in places, bypassing the supervisor. So the fixture must not RELY on the
      // supervisor's observation: it observes for itself. That also keeps the fixture honest, since
      // a basis assembled from something other than a real read would defeat the point of it.
      const root = /(?:[A-Za-z]:\\[^\s"']+)/.exec(objective)?.[0] ?? ctx.outputRoot
      const observed = new LocalObservationProvider().observe({ root, maxDepth: 4 })
      const base = await new DeterministicPlanProvider().plan(objective, { ...ctx, world: observed })
      if (!base.ok) return base

      // The step list is built EXPLICITLY rather than derived from the phrase planner's.
      //
      // Two earlier versions tried to rewrite the phrase planner's steps in place and both were
      // wrong. Rewriting the tool name alone left a capability/tool disagreement. Rewriting ids, tools
      // AND capabilities still left dangling dependencies, because `dependsOn` names OTHER step ids
      // and my remap indexed the wrong array. Each version produced a plan the compiler correctly
      // refused, and each refusal was a compiler check working - but a fixture that has to be
      // repeatedly hand-patched into consistency is a fixture nobody can reason about.
      //
      // So the chain is stated here, in dependency order, and the compiler still validates it. The
      // recovery tests care about the RECOVERY LOOP; the plan's shape is a precondition for reaching
      // it, and stating the precondition directly is both shorter and honest about what it is.
      //
      // `read-folder` and `inspect-folder` are both present because the tests inject the world change
      // inside the second one. Collapsing them would remove the event the loop is tested against.
      const spec: ReadonlyArray<{
        id: string; tool: string; capability: Capability; dependsOn: string[]; from?: string
      }> = [
        { id: 'read-folder', tool: 'read-folder', capability: 'filesystem.inspect', dependsOn: [] },
        {
          id: 'inspect-folder', tool: 'inspect-folder', capability: 'filesystem.list',
          dependsOn: ['read-folder'],
          // `inspect-folder` CONSUMES the previous step's listing via `args.from`; without it the
          // tool reports "no folder listing available from step" and FAILS rather than detecting the
          // world change.
          //
          // The phrase planner passed `from` through, and an explicit step list has to too. The
          // symptom was a step that failed for want of an operand while the test was asserting on
          // recovery - the tool was fine, the plan under it was incomplete.
          from: 'read-folder',
        },
        {
          id: 'compose-summary', tool: 'compose-summary', capability: 'filesystem.transform',
          dependsOn: ['inspect-folder'], from: 'inspect-folder',
        },
        {
          id: 'write-report', tool: 'write-report', capability: 'filesystem.write',
          dependsOn: ['compose-summary'], from: 'compose-summary',
        },
        {
          // `read-report` really is the tool for this step - it is the only one that reads a written
          // report back, and it is the step whose verifier is keyed on this id. An earlier version
          // routed it to `read-folder` to dodge the duplicate-capability problem, which meant the
          // step ran a tool that does the wrong job and the "verified 2" count was hiding it.
          //
          // The duplicate is resolved in the REGISTRY instead, where the decision belongs.
          id: 'confirm-report', tool: 'read-report', capability: 'filesystem.confirm',
          dependsOn: ['write-report'],
        },
      ]
      const sourceById = new Map(base.proposal.steps.map((s) => [s.id, s]))
      const source = (id: string) => sourceById.get(id)

      // The operands the folder tools need, which a generic fallback cannot invent.
      //
      // `write-report` needs the output path, the file name and the output root; `read-report` needs
      // the path to read back. The phrase planner supplied them, and an explicit step list has to as
      // well - otherwise `write-report` fails with "no composed summary available" or refuses on
      // containment, and the test fails on a missing operand while asserting on recovery.
      const OUT_NAME = 'summary.txt'
      const OUT_PATH = `${ctx.outputRoot.replace(/[\\/]+$/, '')}\\${OUT_NAME}`
      const operands: Record<string, Record<string, unknown>> = {
        'read-folder': { path: root },
        'inspect-folder': { from: 'read-folder' },
        'compose-summary': { from: 'inspect-folder', folderLabel: root },
        'write-report': { from: 'compose-summary', path: OUT_PATH, name: OUT_NAME, outputRoot: ctx.outputRoot },
        'confirm-report': { path: OUT_PATH },
      }

      return {
        ok: true as const,
        proposal: {
          ...base.proposal,
          steps: spec.map((sp) => {
            const s = source(sp.id === 'confirm-report' ? 'read-back' : sp.id)
            return {
              id: sp.id,
              capability: sp.capability,
              intent: s?.intent ?? `${sp.id} for the recovery loop test`,
              mode: s?.mode ?? ('filesystem' as const),
              rationale: s?.rationale ?? 'recovery loop fixture',
              tool: sp.tool,
              // Explicit operands, falling back to the phrase planner's only where the step has no
              // operands of its own. The folder's path comes from the objective, so a retried attempt
              // against a moved folder targets where the folder went.
              args: { ...operands[sp.id] },
              dependsOn: sp.dependsOn,
              verification: s?.verification ?? { kind: 'must-exist' as const, description: `${sp.id} completed` },
              onFailure: s?.onFailure ?? ('replan' as const),
            }
          }),
          basis: {
            observationId: observed.observationId,
            observedAt: observed.observedAt,
            root: observed.scope.root,
            fingerprint: observed.fingerprint,
            usedFacts: [`${observed.entries.length} entr(ies) observed`],
            complete: !observed.truncated && observed.errors.length === 0,
          },
        },
      }
    },
  } satisfies PlanProvider,
  tools,
  verifier: folderVerifiers(outputRoot),
  control: fakeControl() as ControlSurface,
  config: CONFIG,
  observationRoot: dirname(outputRoot),
  missionIdPrefix: 't',
  ...over,
})

// ==================================================== the reconciler, in isolation

test('the reconciler substitutes only on an unambiguous rename', () => {
  const r = new ObjectiveReconciler()
  const obj = 'Summarise the folder "C:\\x\\reports"'
  const obs = { existingDirectories: ['C:\\y\\reports'], at: 1 }
  const out = r.reconcile(obj, obs)
  assert.equal(out.ok, true)
  if (!out.ok) return
  assert.equal(out.objective, 'Summarise the folder "C:\\y\\reports"')
  assert.equal(out.substitutions.length, 1)
  assert.match(out.substitutions[0].why, /exactly one directory/)
})

test('the reconciler REFUSES when two directories share the name', () => {
  // Picking one would be a guess about which the user meant. Refusing is the whole point.
  const r = new ObjectiveReconciler()
  const out = r.reconcile('Summarise "C:\\x\\reports"', {
    existingDirectories: ['C:\\a\\reports', 'C:\\b\\reports'], at: 1,
  })
  assert.equal(out.ok, false)
  if (!out.ok) assert.match(out.reason, /ambiguous/)
})

test('the reconciler REFUSES when nothing with that name survives', () => {
  const r = new ObjectiveReconciler()
  const out = r.reconcile('Summarise "C:\\x\\reports"', { existingDirectories: ['C:\\a\\other'], at: 1 })
  assert.equal(out.ok, false)
  if (!out.ok) assert.match(out.reason, /Refusing to guess/)
})

test('the reconciler leaves a still-existing path completely alone', () => {
  const w = buildWorld()
  try {
    // Real paths. An earlier version used invented ones like `C:\still\here`, which do not exist
    // on this machine - so the reconciler correctly treated them as moved and substituted, and
    // the test was asserting the wrong thing about a working implementation.
    const r = new ObjectiveReconciler()
    const obj = `Summarise "${w.before}"`
    const out = r.reconcile(obj, observeDirectories(w.root, 2))
    assert.equal(out.ok, true)
    if (!out.ok) return
    assert.equal(out.objective, obj, 'nothing moved, so nothing changes')
    assert.deepEqual([...out.substitutions], [], 'and nothing is recorded as substituted')
  } finally {
    rmSync(w.root, { recursive: true, force: true })
  }
})

test('an empty observation is refused rather than treated as "everything moved"', () => {
  const r = new ObjectiveReconciler()
  const out = r.reconcile('Summarise "C:\\x\\reports"', { existingDirectories: [], at: 1 })
  assert.equal(out.ok, false)
})

// ==================================================== observation freshness

test('an observation taken before the move does not contain the moved folder', () => {
  // This is the mechanism behind control A: reconciling against a pre-move observation finds no
  // match, so recovery halts rather than proceeding on stale facts.
  const w = buildWorld()
  try {
    const stale = observeDirectories(w.root, 2)
    assert.ok(stale.existingDirectories.some((d) => d === w.before))
    // `renameSync` does not create the destination's parent, so the archive directory has to
    // exist first. Its absence was the cause of an ENOENT here, which is a harness bug and not
    // a finding about the reconciler.
    mkdirSync(dirname(w.after), { recursive: true })
    renameSync(w.before, w.after)
    const fresh = observeDirectories(w.root, 2)
    assert.ok(!fresh.existingDirectories.some((d) => d === w.before), 'the fresh observation must not contain the old path')
    assert.ok(fresh.existingDirectories.some((d) => d === w.after), 'and must contain the new one')
    // Reconciling against the STALE one leaves the objective pointing at a dead path.
    const out = new ObjectiveReconciler().reconcile(`Summarise "${w.before}"`, stale)
    // `objective` exists only on the `ok: true` arm. If reconciliation refused outright there is no
    // amended objective to inspect, and asserting against `undefined` would read as a mismatch
    // rather than as a refusal - so the refusal is surfaced as itself.
    assert.ok(out.ok, `reconciliation refused: ${out.ok ? '' : out.reason}`)
    assert.equal(out.objective.includes(w.before), true, 'a stale observation yields a stale objective')
  } finally {
    rmSync(w.root, { recursive: true, force: true })
  }
})

// ==================================================== end to end, with the mechanism removed

test('a genuine mid-mission change is recovered from', async () => {
  const w = buildWorld()
  try {
    const tools = movingTools(w.after)
    const out = await runMission(`Summarise the folder "${w.before}"`, { outputRoot: w.outputRoot, now: () => 1 }, deps(tools, w.outputRoot, { maxAttempts: 3 }))
    // `stopReason` is optional on the outcome union, so the message must cope with its absence rather
    // than assume a string. An assertion message that is itself `undefined` prints nothing, which
    // would hide the very failure it exists to explain.
    assert.equal(out.ok, true, out.ok ? '' : (out.stopReason ?? 'no reason was recorded'))
    assert.equal(out.attempts.length, 2)
    assert.equal(out.attempts[0].state, 'recovering', 'the first attempt must end in recovering')
    assert.equal(out.attempts[0].complete, false)
    assert.equal(out.attempts[1].complete, true)
    assert.equal(out.substitutions.length, 1)
    assert.ok(out.attempts[1].objective.includes(w.after), 'the retry must target where the folder went')
    // Every step of the retry verified - stated as a relation rather than a number.
    //
    // This used to be the literal `5`, which was the phrase planner's step count. The M6 fixture
    // emits four, because `read-folder` and `inspect-folder` were two steps doing one job and only
    // one of them can serve `filesystem.inspect`. Asserting the relationship keeps the test about
    // what it was written to prove - that the RECOVERED attempt fully verified - and stops a
    // deliberate change to the plan's shape from being reported as a recovery failure.
    assert.equal(out.attempts[1].verified, out.attempts[1].proposal.steps.length)
    const produced = readdirSync(w.outputRoot)
    assert.equal(produced.length, 1)
  } finally {
    rmSync(w.root, { recursive: true, force: true })
  }
})

test('WITHOUT recovery the same change simply fails - the recovery is what made it pass', async () => {
  const w = buildWorld()
  try {
    const tools = movingTools(w.after)
    // maxAttempts 1: no room to replan. The mission must fail rather than limp on.
    const out = await runMission(`Summarise the folder "${w.before}"`, { outputRoot: w.outputRoot, now: () => 1 }, deps(tools, w.outputRoot, { maxAttempts: 1 }))
    assert.equal(out.ok, false, 'with no recovery budget the mission must not complete')
    assert.equal(out.attempts.length, 1)
    assert.equal(out.attempts[0].complete, false)
    assert.equal(readdirSync(w.outputRoot).length, 0, 'and must not have written anything')
  } finally {
    rmSync(w.root, { recursive: true, force: true })
  }
})

test('recovery is BOUNDED - an unresolvable world fails instead of looping', async () => {
  const w = buildWorld()
  try {
    // The folder vanishes and nothing replaces it, so reconciliation can never succeed.
    const inner = FOLDER_TOOLS.find((t) => t.name === 'inspect-folder')!
    let fired = false
    const tool: Tool = {
      name: 'inspect-folder',
      mode: 'filesystem',
      async run(ctx, args) {
        if (!fired) { fired = true; rmSync(w.before, { recursive: true, force: true }) }
        return inner.run(ctx, args)
      },
    }
    const tools = folderRegistry(['inspect-folder'], { 'inspect-folder': tool })
    const out = await runMission(`Summarise the folder "${w.before}"`, { outputRoot: w.outputRoot, now: () => 1 }, deps(tools, w.outputRoot, { maxAttempts: 3 }))
    assert.equal(out.ok, false, 'a world that cannot be reconciled must fail')
    assert.ok(out.stopReason, 'and must say why')
    assert.ok(out.attempts.length <= 3, 'and must not exceed the bound')
  } finally {
    rmSync(w.root, { recursive: true, force: true })
  }
})

test('a NORMAL mission with no environmental change completes on the first attempt', async () => {
  // Recovery must not be load-bearing for ordinary work. If this needed two attempts, the
  // recovery path would be firing spuriously.
  const w = buildWorld()
  try {
    const tools = folderRegistry()
    const out = await runMission(`Summarise the folder "${w.before}"`, { outputRoot: w.outputRoot, now: () => 1 }, deps(tools, w.outputRoot, { maxAttempts: 3 }))
    // `stopReason` is optional on the outcome union, so the message must cope with its absence rather
    // than assume a string. An assertion message that is itself `undefined` prints nothing, which
    // would hide the very failure it exists to explain.
    assert.equal(out.ok, true, out.ok ? '' : (out.stopReason ?? 'no reason was recorded'))
    assert.equal(out.attempts.length, 1, 'an unchanged world must not trigger a replan')
    assert.deepEqual([...out.substitutions], [])
  } finally {
    rmSync(w.root, { recursive: true, force: true })
  }
})

test('a failed step is NOT treated as a plan invalidation', async () => {
  // The supervisor must not paper over ordinary failures by replanning. Only a genuine
  // environment divergence justifies another attempt.
  const w = buildWorld()
  try {
    const broken: Tool = { name: 'inspect-folder', mode: 'filesystem', async run() { return { kind: 'failed' as const, reason: 'ordinary failure' } } }
    const tools = folderRegistry([], { 'inspect-folder': broken })
    const out = await runMission(`Summarise the folder "${w.before}"`, { outputRoot: w.outputRoot, now: () => 1 }, deps(tools, w.outputRoot, { maxAttempts: 3 }))
    assert.equal(out.ok, false)
    assert.equal(out.attempts.length, 1, 'a plain failure must not trigger a replan')
    assert.match(out.stopReason ?? '', /without a plan invalidation/)
  } finally {
    rmSync(w.root, { recursive: true, force: true })
  }
})

// ==================================================== availability precheck

test('an unavailable tool is caught BEFORE execution, not three steps in', async () => {
  const w = buildWorld()
  try {
    const tools = folderRegistry()
    // A plan naming a tool nobody registered.
    //
    // Built through the recovery fixture rather than the phrase planner directly, because M6 made the
    // compiler refuse a plan that names no observation. That refusal is correct, and it means the
    // phrase planner's output can no longer reach the compiler at all - so a test that wanted a
    // compilable-but-unavailable plan has to start from a planner that produces one.
    const planned = await deps(tools, w.outputRoot).provider.plan(
      `Summarise the folder "${w.before}"`,
      { outputRoot: w.outputRoot, now: () => 1 },
    )
    assert.equal(planned.ok, true, planned.ok ? '' : planned.reason)
    if (!planned.ok) return
    // Only the TOOL name is broken. The capability is left intact, so the test isolates one failure
    // mode: a plan that compiles but names a tool the registry does not have. Breaking the
    // capability too would make the compiler refuse the plan before `checkToolAvailability` ever
    // runs, and the precheck would appear to pass for the wrong reason - the same defect found in
    // the cycle test, and worth naming because it is easy to reintroduce.
    const broken = { ...planned.proposal, steps: planned.proposal.steps.map((s) => ({ ...s, tool: 'no-such-tool' })) }
    const c = compilePlan(broken, 'x', 0)
    assert.equal(c.ok, true, 'the compiler has no router and cannot know - by design')
    if (!c.ok) return
    const problems = checkToolAvailability(tools, c.mission)
    // Every step is reported TWICE: once for the unresolvable tool name, and once for the capability
    // now resolving to a different tool than the plan names. The first version asserted one problem
    // per step and failed, because M6's capability check added a second, equally correct refusal.
    assert.equal(problems.length, planned.proposal.steps.length * 2, 'each step reports an unknown tool and a capability mismatch')
    assert.ok(problems.some((p) => /no tool named "no-such-tool"/.test(p)), 'the unknown tool is named')
    assert.ok(problems.some((p) => /plan and the registry disagree|which resolves to/.test(p)),
      'the capability/tool disagreement is also reported, and is the more specific finding')
  } finally {
    rmSync(w.root, { recursive: true, force: true })
  }
})

test('a healthy plan passes the availability precheck', () => {
  const tools = folderRegistry()
  const m = {
    id: 'm', objective: 'o', constraints: [], state: 'drafting',
    plan: [{ id: 'a', intent: 'i', mode: 'filesystem', rationale: 'r', tool: 'read-folder', status: 'pending' }],
    history: [], pendingApprovals: [], startedAt: 0,
  } as never
  assert.deepEqual(checkToolAvailability(tools, m), [])
})

// ==================================================== making the recovery controls bite in unit tests

/**
 * These two exist because the live proof's first two controls did NOT bite.
 *
 * A single mid-mission change recovers on attempt 2, so a supervisor that reused its first
 * observation - or that treated "we replanned" as recovery - behaves IDENTICALLY to a correct
 * one. Both defects were invisible until the scenarios were built so the defect changes the
 * outcome: a world that moves TWICE, and a retry that genuinely fails after a correct replan.
 *
 * Without these unit tests the suite passed 129/129 with either defect present, which is the
 * "looks like protection, protects nothing" failure in its purest form.
 */

test('two successive moves are recovered from, which requires a FRESH observation each time', async () => {
  const w = buildWorld()
  try {
    const start = join(w.root, 'reports')
    const mid = join(w.root, 'archive', 'reports')
    const end = join(w.root, 'archive', '2026', 'reports')
    const inner = FOLDER_TOOLS.find((t) => t.name === 'inspect-folder')!
    const moves = [mid, end]
    let moved = 0
    const stepwise: Tool = {
      name: 'inspect-folder',
      mode: 'filesystem',
      async run(ctx, args) {
        if (moved < moves.length) {
          const from = moved === 0 ? start : moves[moved - 1]
          const to = moves[moved]
          mkdirSync(dirname(to), { recursive: true })
          renameSync(from, to)
          moved++
        }
        return inner.run(ctx, args)
      },
    }
    const tools = folderRegistry([], { 'inspect-folder': stepwise })
    const out = await runMission(`Summarise the folder "${start}"`, { outputRoot: w.outputRoot, now: () => 1 },
      deps(tools, w.outputRoot, { maxAttempts: 4, observationDepth: 3 }))
    // `stopReason` is optional on the outcome union, so the message must cope with its absence rather
    // than assume a string. An assertion message that is itself `undefined` prints nothing, which
    // would hide the very failure it exists to explain.
    assert.equal(out.ok, true, out.ok ? '' : (out.stopReason ?? 'no reason was recorded'))
    assert.equal(out.attempts.length, 3, 'invalidated, invalidated, recovered')
    assert.equal(out.substitutions.length, 2, 'each move must be recorded separately')
    assert.equal(out.attempts[2].objective.includes(end), true, 'the last objective must name the final location')
    assert.equal(out.attempts[2].complete, true)
  } finally {
    rmSync(w.root, { recursive: true, force: true })
  }
})

test('a CORRECT replan whose retry then fails is reported as NOT recovered', async () => {
  // The other half of fake recovery. A supervisor that returns ok on the strength of having
  // replanned would report success here while the final attempt had failed outright.
  const w = buildWorld()
  try {
    const inner = FOLDER_TOOLS.find((t) => t.name === 'inspect-folder')!
    let fired = false
    const moveThenBreak: Tool = {
      name: 'inspect-folder',
      mode: 'filesystem',
      async run(ctx, args) {
        if (!fired) {
          fired = true
          mkdirSync(dirname(w.after), { recursive: true })
          renameSync(w.before, w.after)
          // The output root is destroyed while the mission is recovering: the replan will be
          // correct and the retry will still fail.
          rmSync(w.outputRoot, { recursive: true, force: true })
        }
        return inner.run(ctx, args)
      },
    }
    const tools = folderRegistry([], { 'inspect-folder': moveThenBreak })
    const out = await runMission(`Summarise the folder "${w.before}"`, { outputRoot: w.outputRoot, now: () => 1 },
      deps(tools, w.outputRoot, { maxAttempts: 3 }))
    assert.equal(out.ok, false, 'a correct replan is not recovery')
    assert.equal(out.substitutions.length, 1, 'the substitution did happen')
    const last = out.attempts[out.attempts.length - 1]
    assert.equal(last.complete, false)
  } finally {
    rmSync(w.root, { recursive: true, force: true })
  }
})
