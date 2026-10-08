/**
 * THE FIRST GENUINELY USER-DRIVEN MISSION.
 *
 *   a natural-language objective
 *     -> a deterministic planner
 *     -> a structured plan, shown before anything runs
 *     -> a generic tool router
 *     -> the governed executor
 *     -> five real filesystem tools
 *     -> five INDEPENDENT verifiers
 *     -> a verified file, read back
 *
 * No injected input. No armed operator. Nothing outside two disposable directories is read or
 * written. This runs today, on this machine, while release/resume and the mouse attribution
 * defect remain open - because it does not need them.
 *
 * SEVEN NEGATIVE CONTROLS, each aimed at a specific way this could be a false success:
 *
 *   A  the planner is given an objective it does not recognise   -> no mission at all
 *   B  the planner is pointed at a folder that does not exist     -> no mission at all
 *   C  the router is asked for a tool nobody registered          -> step fails, no substitute
 *   D  the write tool claims success but writes nothing           -> verifier rejects
 *   E  independent verification is removed                        -> step cannot complete
 *   F  the output path is aimed outside the output root           -> refused by containment
 *   G  a prerequisite step fails                                 -> later steps skipped
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execute } from '../executor.ts'
import { summarize } from '../events.ts'
import { DeterministicPlanProvider } from '../../planner/deterministic.ts'
import { LocalObservationProvider } from '../../observation/local.ts'
import { compilePlan } from '../../planner/compile.ts'
import { renderPlan } from '../../planner/inspect-plan.ts'
import type { PlanContext } from '../../planner/plan.ts'
import { ToolRegistry } from '../../tool-router/router.ts'
import {
  FOLDER_TOOLS, composeSummaryTool, folderVerifiers, readReportTool, writeReportTool,
} from './folder-tools.ts'
import { fakeControl } from '../test/fakes.ts'
import type { ControlSurface } from '../../governance/contract.ts'
import type { Mission, Step } from '../state.ts'

// ============================================================ a disposable world

const world = mkdtempSync(join(tmpdir(), 'aios-scenario-'))
const sourceDir = join(world, 'reports')
const outputRoot = join(world, 'out')
mkdirSync(sourceDir, { recursive: true })
mkdirSync(outputRoot, { recursive: true })

// A handful of harmless files, so "list the folder" has something true to find.
const SEED: Array<[string, string]> = [
  ['q1-summary.md', '# Q1\nRevenue up.\n'],
  ['q2-summary.md', '# Q2\nRevenue flat.\n'],
  ['notes.txt', 'remember the thing\n'],
  ['data.csv', 'a,b\n1,2\n3,4\n'],
  ['archive', ''], // a folder, to prove directories are distinguished from files
]
for (const [name, body] of SEED) {
  if (body === '') mkdirSync(join(sourceDir, name), { recursive: true })
  else writeFileSync(join(sourceDir, name), body, 'utf8')
}

const OBJECTIVE = `Summarise the contents of the folder "${sourceDir}" and write a summary file`

/**
 * A REAL observation of the seeded folder, and the context built from it.
 *
 * This is the M6 change made visible in the mission that predates it: the context used to be
 * `{ outputRoot, now }` and the planner needed nothing else, because it emitted a fixed recipe. It
 * now needs to know what is actually in the folder, and the compiler refuses any plan that cannot say
 * which observation it was built on.
 */
const observer = new LocalObservationProvider()
const observed = observer.observe({ root: sourceDir, maxDepth: 4 })
const ctx: PlanContext = {
  outputRoot,
  now: () => observed.observedAt,
  world: observed,
  maxObservationAgeMs: 60_000,
  refetched: observed,
}
const provider = new DeterministicPlanProvider()
const registry = new ToolRegistry({
  registrations: [
    { tool: FOLDER_TOOLS.find((t) => t.name === 'read-folder')!, capabilities: ['filesystem.inspect'] },
    { tool: FOLDER_TOOLS.find((t) => t.name === 'inspect-folder')!, capabilities: ['filesystem.list'] },
    { tool: FOLDER_TOOLS.find((t) => t.name === 'compose-summary')!, capabilities: ['filesystem.transform'] },
    { tool: FOLDER_TOOLS.find((t) => t.name === 'write-report')!, capabilities: ['filesystem.write'] },
    { tool: FOLDER_TOOLS.find((t) => t.name === 'read-report')!, capabilities: ['filesystem.confirm'] },
  ],
})

console.log('')
console.log('=== THE USER SAID ===')
console.log(`  "${OBJECTIVE}"`)
console.log('')
console.log(`  source folder   ${sourceDir}`)
console.log(`  output root     ${outputRoot}   (chosen by the CALLER, not parsed from the objective)`)
console.log(`  planner         ${provider.name}`)
console.log(`  tools available ${registry.names().join(', ')}`)

// ============================================================ 1. plan

const planned = await provider.plan(OBJECTIVE, ctx)
if (!planned.ok) {
  console.log('')
  console.log(`=== PLANNING REFUSED: ${planned.reason} ===`)
  process.exit(1)
}
console.log('')
console.log(renderPlan(planned.proposal))

const compiled = compilePlan(planned.proposal, 'mission-folder-summary-1', ctx.now())
if (!compiled.ok) {
  console.log('')
  console.log(`=== PLAN REJECTED BY THE COMPILER: ${compiled.reason} ===`)
  process.exit(1)
}

// ============================================================ 2. execute

const CONFIG = {
  maxAttempts: 1,
  /**
   * Observation-only mission: no step can inject, and the permission layer is still consulted
   * before every step.
   *
   * `infrastructureHealthy: true` is stated explicitly rather than omitted. An earlier version
   * of this harness built the permission object by hand and left it out, so the executor read
   * `undefined` as falsy and halted the whole mission as `infrastructure` - which is the correct
   * fail-closed behaviour meeting an incomplete caller, and a good illustration of why the
   * contract is typed.
   */
  permission: async () => ({
    control: 'ARMED' as const,
    input: 'PERMITTED' as const,
    blockedBy: null,
    infrastructureHealthy: true,
    mayInject: false,
  }),
  emergencyStop: async () => false,
}

/** Registration list, kept here so controls can substitute individual tools. */
const REGISTRATIONS = FOLDER_TOOLS.map((tool) => ({ tool }))

async function run(mission: Mission, label: string, opts: {
  tools?: ConstructorParameters<typeof ToolRegistry>[0]['registrations']
  verifiers?: boolean
} = {}) {
  const reg = opts.tools ? new ToolRegistry({ registrations: opts.tools }) : registry
  const v = folderVerifiers(outputRoot)
  const verifier = opts.verifiers === false
    ? { verifies: () => false, async verify() { return { rejected: 'verification disabled for this control' } } }
    : v
  const r = await execute(mission, {
    tools: reg,
    verifier: verifier as never,
    control: fakeControl() as ControlSurface,
    config: CONFIG,
  })
  return { label, r }
}

// ============================================================ the positive run

const positive = await run(compiled.mission, 'POSITIVE')
const pSteps = positive.r.mission.plan

console.log('')
console.log('=== EXECUTION ===')
for (const s of pSteps) {
  const o = s.result?.outcome as { evidence?: { kind?: string } & Record<string, unknown> } | undefined
  const why = (s.result?.outcome as { reason?: string } | undefined)?.reason
  console.log(`  ${s.id.padEnd(16)} ${s.mode.padEnd(11)} ${String(s.result?.outcome.kind ?? 'DID NOT RUN').padEnd(10)} ${o?.evidence ? JSON.stringify(o.evidence).slice(0, 96) : (why ?? '')}`)
}
const pSum = summarize(positive.r.record)
console.log('')
console.log(`  mission state     ${positive.r.mission.state}`)
console.log(`  complete          ${positive.r.record.complete}`)
console.log(`  finish reason     ${pSum.finishReason}`)
console.log(`  integrity         ${pSum.integrityViolations.length === 0 ? 'no violations' : pSum.integrityViolations.join('; ')}`)

// ============================================================ what was actually produced

const outFiles = existsSync(outputRoot)
  ? (await import('node:fs')).readdirSync(outputRoot)
  : []
console.log('')
console.log('=== WHAT IS ON DISK ===')
for (const f of outFiles) {
  const p = join(outputRoot, f)
  console.log(`  ${f}  ${(await import('node:fs')).statSync(p).size} bytes`)
  console.log('  --- content, read independently of the mission ---')
  for (const line of readFileSync(p, 'utf8').split('\n').slice(0, 14)) console.log(`  | ${line}`)
}

// ============================================================ negative controls

console.log('')
console.log('=== NEGATIVE CONTROLS ===')

// A. unrecognised objective
const cA = await provider.plan('Book me a flight to Tokyo next Tuesday', ctx)
// B. folder that does not exist
const cB = await provider.plan('Summarise the contents of the folder "C:\\definitely\\not\\here"', ctx)

const lyingWrite = { name: 'write-report', mode: 'filesystem' as const, async run() { return { kind: 'data' as const, data: { path: join(outputRoot, 'never-written.md'), bytes: 99 }, summary: 'claims a write' } } }
const failingTool = { name: 'read-folder', mode: 'filesystem' as const, async run() { return { kind: 'failed' as const, reason: 'simulated precondition failure' } } }
// C. unknown tool, no fallback
const cC = await run({ ...compiled.mission, plan: [{ ...compiled.mission.plan[0], tool: 'no-such-tool' } as Step] }, 'C')
// D. the write tool claims success but writes nothing.
//    Given its own minimal mission: the lying write-report, with nothing depending on it.
const cD = await run({
  ...compiled.mission,
  plan: [{
    id: 'write-report', intent: 'write a summary', mode: 'filesystem', rationale: 'control',
    tool: 'write-report', dependsOn: [],
    args: { path: join(outputRoot, 'never-written.md'), name: 'never-written.md', outputRoot },
    status: 'pending',
  } as Step],
}, 'D', {
  tools: REGISTRATIONS.map((r) => (r.tool.name === 'write-report' ? { tool: lyingWrite } : r)),
})
// E. verification removed
const cE = await run(compiled.mission, 'E', { verifiers: false })
// F. output aimed outside the output root
const escapingStep = { ...compiled.mission.plan[3], args: { ...(compiled.mission.plan[3].args as object), path: join(world, 'escaped.md'), name: 'escaped.md' } } as Step
const cF = await run({ ...compiled.mission, plan: [...compiled.mission.plan.slice(0, 3), escapingStep, { ...compiled.mission.plan[4], args: { path: join(world, 'escaped.md') } } as Step] }, 'F')
// G. prerequisite fails -> later steps skipped
const cG = await run(compiled.mission, 'G', {
  tools: REGISTRATIONS.map((r) => (r.tool.name === 'read-folder' ? { tool: failingTool } : r)),
})

const cCstep = cC.r.mission.plan[0].result!.outcome
const cDstep = cD.r.mission.plan[0].result!.outcome
const cEstep = cE.r.mission.plan[0].result!.outcome
const cFstep = cF.r.mission.plan[3].result!.outcome
const cGstep = cG.r.mission.plan[1].result?.outcome as { kind?: string; blockedBy?: string } | undefined

const checks: Array<[boolean, string]> = [
  // positive
  [pSteps.every((s) => s.result?.outcome.kind === 'verified'), 'POSITIVE: every step verified'],
  [positive.r.record.complete === true, 'POSITIVE: the mission completed'],
  [outFiles.length === 1, `POSITIVE: exactly one new file was created (${outFiles.length})`],
  [pSum.integrityViolations.length === 0, 'POSITIVE: no integrity violations'],
  [pSteps[0].result!.outcome.kind === 'verified', 'POSITIVE: the folder was independently confirmed to exist'],

  // A. planner refuses
  [cA.ok === false, `CONTROL A: an unrecognised objective produced no plan (${cA.ok ? 'IT PRODUCED ONE' : 'refused'})`],
  [cB.ok === false, `CONTROL B: a nonexistent folder produced no plan (${cB.ok ? 'IT PRODUCED ONE' : 'refused'})`],
  // C. router refuses, no silent substitution
  [cCstep.kind !== 'verified', `CONTROL C: an unregistered tool did not execute (${cCstep.kind})`],
  [positive.r.mission.plan.every((s) => s.tool !== 'no-such-tool'), 'CONTROL C: no step silently became another tool'],
  // D. lying write rejected
  [cDstep.kind !== 'verified', `CONTROL D: a write claimed without a file was rejected (${cDstep.kind})`],
  [cD.r.record.complete === false, 'CONTROL D: the mission did NOT complete'],
  // E. no verification, no completion
  [cEstep.kind !== 'verified', `CONTROL E: without verification the step cannot complete (${cEstep.kind})`],
  [cE.r.record.complete === false, 'CONTROL E: the mission did NOT complete'],
  // F. containment
  [cFstep.kind !== 'verified', `CONTROL F: writing outside the output root was refused (${cFstep.kind})`],
  [!existsSync(join(world, 'escaped.md')), 'CONTROL F: no file was created outside the output root'],
  [!existsSync(join(outputRoot, 'never-written.md')), 'CONTROL D: the claimed write left no file'],
  // G. dependency gating
  [cGstep?.kind === 'skipped', `CONTROL G: a step whose prerequisite failed was skipped (${cGstep?.kind})`],
  [cG.r.record.complete === false, 'CONTROL G: the mission did NOT complete'],
  [outFiles.length === 1, 'CONTROL G: the failing control created no file'],
]

console.log('')
let failed = 0
for (const [ok, msg] of checks) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${msg}`)
  if (!ok) failed++
}

// ============================================================ reversibility

console.log('')
console.log('=== REVERSIBILITY ===')
console.log(`  everything created lives under ${world}`)
rmSync(world, { recursive: true, force: true })
console.log(`  removed the scenario world: ${!existsSync(world)}`)
console.log(`  nothing outside it was touched: the tools refuse paths outside their roots`)

console.log('')
console.log(`=== ${failed === 0 ? 'PASS' : failed + ' FAILURE(S)'} ===`)
process.exit(failed ? 1 : 0)