import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
// @ts-expect-error Node test runner loads the TypeScript source directly.
import { runMission, checkToolAvailability } from '../supervisor.ts'
// @ts-expect-error Node test runner loads the TypeScript source directly.
import { ObjectiveReconciler, observeDirectories } from '../../planner/reconcile.ts'
// @ts-expect-error Node test runner loads the TypeScript source directly.
import { DeterministicPlanProvider } from '../../planner/deterministic.ts'
// @ts-expect-error Node test runner loads the TypeScript source directly.
import { compilePlan } from '../../planner/compile.ts'
// @ts-expect-error Node test runner loads the TypeScript source directly.
import { ToolRegistry } from '../../tool-router/router.ts'
// @ts-expect-error Node test runner loads the TypeScript source directly.
import { FOLDER_TOOLS, folderVerifiers } from '../live/folder-tools.ts'
// @ts-expect-error Node test runner loads the TypeScript source directly.
import { fakeControl } from './fakes.ts'
// @ts-expect-error Node test runner loads the TypeScript source directly.
import type { Tool } from '../executor.ts'
// @ts-expect-error Node test runner loads the TypeScript source directly.
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
  return new ToolRegistry({ registrations: FOLDER_TOOLS.map((t) => ({ tool: t.name === 'inspect-folder' ? tool : t })) })
}

const deps = (tools: ToolRegistry, outputRoot: string, over: Record<string, unknown> = {}) => ({
  provider: new DeterministicPlanProvider(),
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
    assert.equal(out.ok, true, out.stopReason)
    assert.equal(out.attempts.length, 2)
    assert.equal(out.attempts[0].state, 'recovering', 'the first attempt must end in recovering')
    assert.equal(out.attempts[0].complete, false)
    assert.equal(out.attempts[1].complete, true)
    assert.equal(out.substitutions.length, 1)
    assert.ok(out.attempts[1].objective.includes(w.after), 'the retry must target where the folder went')
    assert.equal(out.attempts[1].verified, 5)
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
    const tools = new ToolRegistry({ registrations: FOLDER_TOOLS.map((t) => ({ tool: t.name === 'inspect-folder' ? tool : t })) })
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
    const tools = new ToolRegistry({ registrations: FOLDER_TOOLS.map((t) => ({ tool: t })) })
    const out = await runMission(`Summarise the folder "${w.before}"`, { outputRoot: w.outputRoot, now: () => 1 }, deps(tools, w.outputRoot, { maxAttempts: 3 }))
    assert.equal(out.ok, true, out.stopReason)
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
    const broken: Tool = { name: 'read-folder', mode: 'filesystem', async run() { return { kind: 'failed' as const, reason: 'ordinary failure' } } }
    const tools = new ToolRegistry({ registrations: FOLDER_TOOLS.map((t) => ({ tool: t.name === 'read-folder' ? broken : t })) })
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
    const tools = new ToolRegistry({ registrations: FOLDER_TOOLS.map((t) => ({ tool: t })) })
    // A plan naming a tool nobody registered.
    const provider = new DeterministicPlanProvider()
    const planned = await provider.plan(`Summarise the folder "${w.before}"`, { outputRoot: w.outputRoot, now: () => 1 })
    assert.equal(planned.ok, true)
    if (!planned.ok) return
    const broken = { ...planned.proposal, steps: planned.proposal.steps.map((s) => ({ ...s, tool: 'no-such-tool' })) }
    const c = compilePlan(broken, 'x', 0)
    assert.equal(c.ok, true, 'the compiler has no router and cannot know - by design')
    if (!c.ok) return
    const problems = checkToolAvailability(tools, c.mission)
    assert.equal(problems.length, 5, 'every step is unavailable')
    assert.match(problems[0], /no tool named "no-such-tool"/)
  } finally {
    rmSync(w.root, { recursive: true, force: true })
  }
})

test('a healthy plan passes the availability precheck', () => {
  const tools = new ToolRegistry({ registrations: FOLDER_TOOLS.map((t) => ({ tool: t })) })
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
    const tools = new ToolRegistry({ registrations: FOLDER_TOOLS.map((t) => ({ tool: t.name === 'inspect-folder' ? stepwise : t })) })
    const out = await runMission(`Summarise the folder "${start}"`, { outputRoot: w.outputRoot, now: () => 1 },
      deps(tools, w.outputRoot, { maxAttempts: 4, observationDepth: 3 }))
    assert.equal(out.ok, true, out.stopReason)
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
    const tools = new ToolRegistry({ registrations: FOLDER_TOOLS.map((t) => ({ tool: t.name === 'inspect-folder' ? moveThenBreak : t })) })
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
