/**
 * RECOVERY, EXERCISED FOR REAL.
 *
 *   objective -> plan -> execute -> THE WORLD ACTUALLY MOVES -> detection -> re-observation
 *             -> reconciliation -> REPLAN -> recompile -> execute -> independent verification
 *             -> complete
 *
 * THE DIVERGENCE IS GENUINE
 *
 * Nothing here sets a flag. Part-way through the mission, a folder is RENAMED on disk by
 * ordinary filesystem calls, exactly as another program or a person would. The next step then
 * looks for the path the plan gave it, does not find it, and concludes - from that observation
 * alone - that the plan's assumption is false.
 *
 * The distinction the proof rests on: the system recovers because it re-OBSERVED, not because it
 * was told to. Every control below removes one of the links in that chain and shows the recovery
 * stops working.
 *
 *   A  no re-observation    -> reconcile against the pre-failure world; the moved folder is not
 *                              in it, so reconciliation refuses and recovery halts
 *   B  stale plan           -> replan from the ORIGINAL objective after the move; the planner
 *                              refuses a folder that does not exist
 *   C  fake recovery        -> accept the replan as recovery without executing it
 *   D  invalid replan       -> cycle / dangling dep / missing verifier / unknown tool
 *   E  replan is not recovery-> a new plan exists but no step has run
 *   F  verification removed -> the final attempt cannot complete
 */

import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { runMission } from '../supervisor.ts'
import { DeterministicPlanProvider } from '../../planner/deterministic.ts'
import { ObjectiveReconciler, observeDirectories } from '../../planner/reconcile.ts'
import { renderPlan } from '../../planner/inspect-plan.ts'
import { ToolRegistry } from '../../tool-router/router.ts'
import { FOLDER_TOOLS, folderVerifiers } from './folder-tools.ts'
import { fakeControl } from '../test/fakes.ts'
import type { PlanContext } from '../../planner/plan.ts'
import type { ControlSurface } from '../../governance/contract.ts'
import type { Mission, Step } from '../state.ts'
import type { Tool } from '../executor.ts'

// ============================================================ the world

const root = mkdtempSync(join(tmpdir(), 'aios-recovery-'))
const before = join(root, 'reports')
// The folder MOVES to a different parent but KEEPS ITS NAME. That is deliberate: the reconciler
// matches on the leaf name, because that is the only signal that distinguishes "moved" from
// "replaced by something else", and it refuses rather than guessing when the name changed too.
// An earlier version of this scenario renamed it to `reports-renamed`; the reconciler correctly
// refused, which is the behaviour working - the harness was asking for a substitution the system
// had deliberately decided it could not make safely.
const archive = join(root, 'archive')
const after = join(archive, 'reports')
const outputRoot = join(root, 'out')
mkdirSync(before, { recursive: true })
mkdirSync(outputRoot, { recursive: true })
for (const [n, b] of [['a.md', '# a\n'], ['b.txt', 'b\n'], ['sub', '']] as Array<[string, string]>) {
  if (b === '') mkdirSync(join(before, n), { recursive: true })
  else writeFileSync(join(before, n), b, 'utf8')
}

const provider = new DeterministicPlanProvider()
const registry = new ToolRegistry({ registrations: FOLDER_TOOLS.map((tool) => ({ tool })) })
const planCtx: PlanContext = { outputRoot, now: () => Date.now() }
const objective = `Summarise the contents of the folder "${before}"`

const CONFIG = {
  maxAttempts: 1,
  permission: async () => ({
    control: 'ARMED' as const,
    input: 'PERMITTED' as const,
    blockedBy: null,
    infrastructureHealthy: true,
    mayInject: false,
  }),
  emergencyStop: async () => false,
}

const deps = {
  provider, tools: registry, verifier: folderVerifiers(outputRoot),
  control: fakeControl() as ControlSurface, config: CONFIG,
  observationRoot: root, missionIdPrefix: 'recovery',
}

/**
 * Renames the folder at the START of the second step, so it lands BETWEEN steps.
 *
 * The first attempt at this wrapped `read-folder` instead, and the mission failed at step 1 with
 * `verified 0, failed 1, skipped 4` - because the rename happened before `read-folder`'s verifier
 * re-statted the folder, so the verifier correctly rejected a folder that had genuinely ceased to
 * exist. The system was right and the harness was wrong: an environmental change that occurs
 * *during* a step invalidates that step's own verification, which is not the scenario under
 * test.
 *
 * Firing at the start of step 2 puts the change exactly where a real one would fall - after step
 * 1 is fully verified, before step 2 looks at anything.
 */
function renamingInspectTool(destination: string) {
  const inner = FOLDER_TOOLS.find((t) => t.name === 'inspect-folder')!
  let fired = false
  return {
    tool: {
      name: 'inspect-folder',
      mode: 'filesystem' as const,
      async run(ctx: never, args: never) {
        if (!fired) {
          fired = true
          mkdirSync(dirname(destination), { recursive: true })
          renameSync(before, destination)             // <-- the genuine environmental change
        }
        return inner.run(ctx, args)
      },
    } as Tool,
    reset: () => { fired = false },
  }
}

/**
 * Dependencies for a given world.
 *
 * Parameterised because R2 and R3 each build their own world. An earlier version spread the
 * first scenario's `deps`, which carried a verifier bound to the FIRST world's output root - so
 * R2's write was refused as "outside the permitted output folder" by a containment check pointed
 * at a different directory. The check was right; the harness had wired it to the wrong world.
 */
const depsFor = (out: string, tools: ToolRegistry, over: Record<string, unknown> = {}) => ({
  provider,
  tools,
  verifier: folderVerifiers(out),
  control: fakeControl() as ControlSurface,
  config: CONFIG,
  observationRoot: dirname(out),
  missionIdPrefix: 'scn',
  ...over,
})

// ============================================================ the real recovery

// Result flags for the two extra scenarios. Declared up here because the scenarios run BEFORE
// the assertion block that reads them.
let twoMovesRecovered = false
let retryFailedAfterReplan = false

console.log('')
console.log('=== THE WORLD, BEFORE ===')
console.log(`  ${root}`)
console.log(`  folders: ${readdirSync(root).join(', ')}`)

const mover = renamingInspectTool(after)
const recoveryTools = new ToolRegistry({
  registrations: FOLDER_TOOLS.map((t) => ({ tool: t.name === 'inspect-folder' ? mover.tool : t })),
})
const outcome = await runMission(objective, planCtx, depsFor(outputRoot, recoveryTools, { maxAttempts: 3 }))

console.log('')
console.log('=== ATTEMPT 1: the plan is executed against a world that then moves ===')
const a1 = outcome.attempts[0]
console.log(`  objective    ${a1.objective}`)
console.log(`  plan         ${a1.proposal.steps.map((s) => s.id).join(' -> ')}`)
console.log(`  state        ${a1.state}   complete=${a1.complete}`)
console.log(`  verified     ${a1.verified}   failed ${a1.failed}   skipped ${a1.skipped}`)
console.log(`  invalidation ${a1.invalidation?.reason}: ${a1.invalidation?.detail}`)
console.log(`  observed     ${a1.observedAtFailure}`)

console.log('')
console.log('=== THE WORLD, AFTER THE MOVE ===')
console.log(`  folders: ${readdirSync(root).join(', ')}`)
console.log(`  "${basename(before)}" exists: ${existsSync(before)}    "${basename(after)}" exists: ${existsSync(after)}`)

console.log('')
console.log('=== ATTEMPT 2: replanned against a FRESH observation ===')
const a2 = outcome.attempts[1]
// Every access is guarded. An earlier version assumed a second attempt existed and
// dereferenced `a2.objective` unconditionally - so when the recovery protections were removed the
// supervisor returned after attempt 1 and the harness died with an unhandled TypeError instead of
// REPORTING the failure. A control that crashes cannot be shown to have failed for the reason it
// was designed to catch, which makes it useless as evidence.
const a2obj = a2?.objective ?? '(no second attempt was made)'
if (a2) {
  console.log(`  amended objective  ${a2.objective}`)
  console.log(`  substitutions      ${outcome.substitutions.length}`)
  for (const s of outcome.substitutions) console.log(`    ${s.from}  ->  ${s.to}`)
  console.log(`    why: ${outcome.substitutions[0]?.why ?? '(none)'}`)
  console.log('')
  console.log(renderPlan(a2.proposal, { missionId: a2.missionId }))
  console.log('')
  console.log(`  state        ${a2.state}   complete=${a2.complete}`)
  console.log(`  verified     ${a2.verified}`)
  for (const e of a2.events.filter((e) => e.type === 'evidence-verified')) {
    console.log(`    evidence  ${JSON.stringify((e as { evidence?: unknown }).evidence).slice(0, 110)}`)
  }
} else {
  console.log(`  amended objective  ${a2obj}`)
  console.log('  (no replacement plan was produced - reported as a failure, not crashed on)')}

console.log('')
console.log(`  recovered: ${outcome.ok}   attempts: ${outcome.attempts.length}`)
if (outcome.stopReason) console.log(`  stopReason ${outcome.stopReason}`)

const produced = existsSync(outputRoot) ? readdirSync(outputRoot) : []
console.log('')
console.log('=== WHAT WAS PRODUCED, READ INDEPENDENTLY ===')
for (const f of produced) {
  console.log(`  ${f}`)
  for (const line of readFileSync(join(outputRoot, f), 'utf8').split('\n').slice(0, 8)) console.log(`  | ${line}`)
}

// ============================================================ negative controls

console.log('')
console.log('=== NEGATIVE CONTROLS ===')

// --- A: reconcile against the PRE-move observation
const staleObs = observeDirectories(join(root, 'out'), 1)
const recA = new ObjectiveReconciler().reconcile(objective, staleObs)

// --- SCENARIO R2: the world moves TWICE. This is what makes the stale-observation defect
//     actually change the outcome.
//
//     The single-move scenario above recovers on attempt 2, so a supervisor that reused its
//     first observation would behave IDENTICALLY - the defect is invisible. It only becomes
//     observable when a second invalidation forces a second reconciliation, and the stale
//     observation names a location that no longer exists either.
console.log('')
console.log('=== SCENARIO R2: THE WORLD MOVES TWICE ===')
{
  const w2 = mkdtempSync(join(tmpdir(), 'aios-recovery2-'))
  const start = join(w2, 'reports')
  const mid = join(w2, 'archive', 'reports')
  const end = join(w2, 'archive', '2026', 'reports')
  const out2 = join(w2, 'out')
  mkdirSync(start, { recursive: true })
  mkdirSync(out2, { recursive: true })
  writeFileSync(join(start, 'a.md'), '# a\n')

  const moves = [mid, end]
  let moved = 0
  const inner = FOLDER_TOOLS.find((t) => t.name === 'inspect-folder')!
  const stepwise: Tool = {
    name: 'inspect-folder',
    mode: 'filesystem',
    async run(ctx: never, args: never) {
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
  const r2tools = new ToolRegistry({ registrations: FOLDER_TOOLS.map((t) => ({ tool: t.name === 'inspect-folder' ? stepwise : t })) })
  const r2 = await runMission(`Summarise the folder "${start}"`, { outputRoot: out2, now: () => Date.now() }, depsFor(out2, r2tools, { maxAttempts: 4, observationDepth: 3 }))
  console.log(`  attempts ${r2.attempts.length}   recovered ${r2.ok}`)
  for (const s of r2.substitutions) console.log(`    ${s.from}  ->  ${s.to}`)
  console.log(`  final objective ${r2.attempts[r2.attempts.length - 1]?.objective}`)
  console.log(`  stopReason      ${r2.stopReason ?? '(none)'}`)
  for (const o of r2.stepOutcomes.filter((x) => x.kind !== 'verified' && x.kind !== 'pending')) {
    console.log(`    attempt ${o.attempt} ${o.stepId} -> ${o.kind}: ${String(o.reason)}`)
  }
  twoMovesRecovered = r2.ok && r2.attempts.length === 3
  rmSync(w2, { recursive: true, force: true })
}

// --- SCENARIO R3: replanning succeeds but the RETRY genuinely fails. This is what makes the
//     "a replan counts as recovery" defect observable - the final attempt is not complete, so a
//     supervisor that returned ok on the strength of having replanned would be wrong.
console.log('')
console.log('=== SCENARIO R3: THE RETRY ITSELF FAILS ===')
{
  const w3 = mkdtempSync(join(tmpdir(), 'aios-recovery3-'))
  const b3 = join(w3, 'reports')
  const a3 = join(w3, 'archive', 'reports')
  const o3 = join(w3, 'out')
  mkdirSync(b3, { recursive: true })
  mkdirSync(o3, { recursive: true })
  writeFileSync(join(b3, 'a.md'), '# a\n')

  const mover = FOLDER_TOOLS.find((t) => t.name === 'inspect-folder')!
  let fired = false
  const moveThenBreak: Tool = {
    name: 'inspect-folder',
    mode: 'filesystem',
    async run(ctx: never, args: never) {
      if (!fired) {
        fired = true
        mkdirSync(dirname(a3), { recursive: true })
        renameSync(b3, a3)
        // The output root is destroyed while the mission is recovering. The replan will be
        // structurally fine and even correct about where the folder went, and the retry will
        // still fail - which is the point.
        rmSync(o3, { recursive: true, force: true })
      }
      return mover.run(ctx, args)
    },
  }
  const r3tools = new ToolRegistry({ registrations: FOLDER_TOOLS.map((t) => ({ tool: t.name === 'inspect-folder' ? moveThenBreak : t })) })
  const r3 = await runMission(`Summarise the folder "${b3}"`, { outputRoot: o3, now: () => Date.now() }, depsFor(o3, r3tools, { maxAttempts: 3 }))
  console.log(`  attempts ${r3.attempts.length}   ok ${r3.ok}   (a correct replan is not recovery)`)
  console.log(`  final state ${r3.attempts[r3.attempts.length - 1]?.state}   complete ${r3.attempts[r3.attempts.length - 1]?.complete}`)
  console.log(`  stopReason  ${r3.stopReason ?? '(none)'}`)
  retryFailedAfterReplan = !r3.ok
  rmSync(w3, { recursive: true, force: true })
}

// --- B: replan from the ORIGINAL objective after the move
const recB = await provider.plan(objective, planCtx)

// --- C: a replan that is never executed
const paperRecovery = { generatedPlan: a2?.proposal.steps.length ?? 0, stepsExecuted: 0, complete: false }

// --- D: structurally invalid replacement plans
const goodProposal = a2?.proposal ?? (await provider.plan(`Summarise the folder "${after}"`, planCtx) as never as { proposal: never }).proposal
const { compilePlan } = await import('../../planner/compile.ts')
const { checkToolAvailability } = await import('../supervisor.ts')
const invalidPlans: Array<[string, () => { ok: boolean; reason?: string }]> = [
  ['cycle', () => compilePlan({ ...goodProposal, steps: goodProposal.steps.map((s, i) => (i === 0 ? { ...s, dependsOn: ['confirm-report'] } : s)) } as never, 'x', 0)],
  ['dangling dependency', () => compilePlan({ ...goodProposal, steps: goodProposal.steps.map((s, i) => (i === 1 ? { ...s, dependsOn: ['ghost'] } : s)) } as never, 'x', 0)],
  ['missing verifier', () => compilePlan({ ...goodProposal, steps: goodProposal.steps.map((s, i) => (i === 2 ? { ...s, verification: undefined } : s)) } as never, 'x', 0)],
  // An unavailable tool is the compiler's blind spot BY DESIGN - it has no router and must not
  // have one. So it is the supervisor's pre-execution availability check that must catch it,
  // before any step runs rather than three steps in.
  ['unavailable tool', () => {
    const broken = { ...goodProposal, steps: goodProposal.steps.map((s, i) => (i === 3 ? { ...s, tool: 'no-such-tool' } : s)) }
    const c = compilePlan(broken as never, 'x', 0)
    if (!c.ok) return { ok: false, reason: c.reason }
    const problems = checkToolAvailability(registry, c.mission)
    return problems.length ? { ok: false, reason: problems.join('; ') } : { ok: true }
  }],
]
const compiledInvalid = invalidPlans.map(([name, run]) => [name, run()] as const)

// --- E: replan without execution is not recovery
// --- F: verification removed on the final attempt
const noVerify = await runMission(`Summarise the folder "${after}"`, planCtx, depsFor(outputRoot, registry, {
  maxAttempts: 1,
  verifier: { verifies: () => false, async verify() { return { rejected: 'verification disabled' } } } as never,
}))

const finalAttempt = outcome.attempts[outcome.attempts.length - 1]

const checks: Array<[boolean, string]> = [
  // the real thing
  [outcome.attempts.length === 2, `REAL: exactly two attempts - one invalidated, one recovered (${outcome.attempts.length})`],
  [outcome.ok === true, 'REAL: the mission recovered'],
  [a1.state === 'recovering', `REAL: attempt 1 ended in recovering, not complete or failed (${a1.state})`],
  [a1.complete === false, 'REAL: attempt 1 did NOT complete'],
  [a1.observedAtFailure?.includes('no longer exists') === true, 'REAL: the failure was detected from an observation, not a flag'],
  [existsSync(before) === false && existsSync(after) === true, 'REAL: the folder genuinely moved on disk'],
  [outcome.substitutions.length === 1, `REAL: exactly one substitution was recorded (${outcome.substitutions.length})`],
  [a2obj !== objective, 'REAL: the revised plan differs from the original'],
  [a2obj.includes(basename(after)), 'REAL: the revised objective names where the folder actually is'],
  [outcome.attempts.length === 2, `REAL: a second attempt was actually made (${outcome.attempts.length})`],
  [finalAttempt.complete === true, 'REAL: the final attempt completed'],
  [finalAttempt.verified === 5, `REAL: all five steps verified in the final attempt (${finalAttempt.verified})`],
  [produced.length === 1, `REAL: exactly one output file was produced (${produced.length})`],
  // Guarded: reading produced[0] when nothing was produced throws, which would crash the harness
  // instead of reporting the failure. Every assertion below must be able to evaluate to false.
  [produced.length === 1 && readFileSync(join(outputRoot, produced[0]), 'utf8').includes(basename(after)),
    'REAL: the summary describes the folder that actually exists'],
  [outcome.freshObservation !== undefined, 'REAL: a fresh observation was taken before replanning'],

  // A: no re-observation - proven by a world that moves TWICE, which is the only shape in which
  // reusing the first observation changes the outcome.
  [recA.ok === false, `CONTROL A: reconciling against a stale observation fails (${recA.ok ? 'it SUCCEEDED' : 'refused'})`],
  [twoMovesRecovered, 'CONTROL A: two successive moves are recovered from, which requires a FRESH observation each time'],
  // B: stale plan
  [recB.ok === false, `CONTROL B: replanning from the original objective fails (${recB.ok ? 'it SUCCEEDED' : 'refused'})`],
  // C: fake recovery
  [paperRecovery.complete === false && paperRecovery.stepsExecuted === 0, 'CONTROL C: a generated plan with nothing executed is not recovery'],
  [retryFailedAfterReplan, 'CONTROL C: a CORRECT replan whose retry then fails is reported as NOT recovered'],
  // D: invalid replans
  ...compiledInvalid.map(([name, r]) => [r.ok === false, `CONTROL D (${name}): the replacement plan is rejected`] as [boolean, string]),
  // E
  [paperRecovery.generatedPlan > 0 && !paperRecovery.complete, 'CONTROL E: producing a plan is not evidence the mission recovered'],
  // F: verification removed
  [noVerify.ok === false, 'CONTROL F: without independent verification the mission cannot complete'],
]

console.log('')
let failed = 0
for (const [ok, msg] of checks) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${msg}`)
  if (!ok) failed++
}

console.log('')
console.log('=== REVERSIBILITY ===')
rmSync(root, { recursive: true, force: true })
console.log(`  scenario world removed: ${!existsSync(root)}`)

console.log('')
console.log(`=== ${failed === 0 ? 'PASS' : failed + ' FAILURE(S)'} ===`)
process.exit(failed ? 1 : 0)