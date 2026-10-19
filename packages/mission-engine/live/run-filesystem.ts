/**
 * The filesystem mission, with three negative controls.
 *
 *   step 1  cli         observe the real desktop, establishing that the machine is real
 *   step 2  filesystem  write one probe file into a dedicated disposable workspace
 *            dependsOn [step 1]
 *
 * Controls:
 *   A  no verifier            -> the step cannot complete
 *   B  the tool LIES           -> claims a write that did not happen; the verifier rejects it
 *   C  step 1 fails           -> step 2 is never selected, recorded skipped
 *
 * Nothing here can inject. The `filesystem` mode has no host round-trip at all, so there is no
 * input path to reach - and INJECTION CALLS is asserted empty anyway.
 */

import type { Evidence } from '../state.ts'
import { execute, type Tool } from '../executor.ts'
import { summarize } from '../events.ts'
import {
  liveControl, livePermission, liveVerifier, observeDesktopTool,
} from './live-control.ts'
import {
  WORKSPACE, ensureWorkspace, filesystemVerifier, lyingFilesystemTool,
  teardownWorkspace, writeProbeTool,
} from './filesystem-mode.ts'
import { blockOnHost, hostAvailability } from './live-control.ts'
import type { ControlSurface } from '../../governance/contract.ts'

const INJECTION = ['type', 'click', 'doubleClick', 'move', 'key', 'pressKey', 'drag', 'scroll']

const calls: string[] = []
const wrapped = new Proxy(liveControl, {
  get(target, prop: string) {
    const orig = (target as unknown as Record<string, unknown>)[prop]
    if (typeof orig !== 'function') return orig
    return async (...args: unknown[]) => {
      calls.push(prop)
      return (orig as (...a: unknown[]) => unknown)(...args)
    }
  },
}) as ControlSurface

const CONFIG = {
  maxAttempts: 1, // no retries: these controls must be deterministic
  permission: livePermission,
  emergencyStop: async () => (await livePermission()).blockedBy?.includes('EMERGENCY_STOP') ?? false,
}

/** A fresh probe filename per run, so nothing is ever overwritten and every run is checkable. */
const stamp = new Date().toISOString().replace(/[:.]/g, '-')

function mission() {
  return {
    id: 'live-filesystem-1',
    objective: 'Confirm the real machine is observable, then write one probe file and prove it landed',
    constraints: ['one disposable workspace', 'nothing outside it', 'no input of any kind'],
    state: 'executing' as const,
    plan: [
      {
        id: 'observe-desktop',
        intent: 'establish that the real desktop is observable',
        mode: 'cli' as const,
        rationale: 'the write must be attributed to a real, confirmed machine',
        status: 'pending' as const,
        tool: 'observe-desktop',
      },
      {
        id: 'write-probe',
        intent: `write probe-${stamp}.txt into the dedicated workspace`,
        mode: 'filesystem' as const,
        rationale: 'a third mechanism: node fs, no host round-trip and no input path',
        status: 'pending' as const,
        tool: 'write-probe-file',
        // The operand, carried by the plan. Previously unreachable: the executor handed every
        // tool an empty object, so the stamp below was decorative and this step could only ever
        // write the one filename hardcoded inside the tool.
        args: { rel: `probe-${stamp}.txt`, body: `aios filesystem probe ${stamp}` },
        dependsOn: ['observe-desktop'],
      },
    ],
    history: [],
    pendingApprovals: [],
    startedAt: 0,
  }
}

const TOOLS = {
  resolve: (s: { tool?: string }) => {
    if (s.tool === 'observe-desktop') return { tool: observeDesktopTool, fellBack: false, reason: 'exact tool match' }
    if (s.tool === 'write-probe-file') return { tool: writeProbeTool, fellBack: false, reason: 'exact tool match' }
    return { unavailable: `no tool for "${s.tool}"`, candidates: [] }
  },
}

const cliVerifier = liveVerifier()
const fsVerifier = filesystemVerifier()

/** Routes by mode, so the filesystem step is checked by the filesystem verifier. */
const routed = {
  verifies: (s: { mode?: string }) => (s.mode === 'filesystem' ? fsVerifier.verifies(s as never) : cliVerifier.verifies()),
  async verify(step: { mode?: string }, ctx: Parameters<typeof cliVerifier.verify>[1], data: unknown): Promise<{ evidence: Evidence } | { rejected: string }> {
    return step.mode === 'filesystem' ? fsVerifier.verify(step as never, ctx, data) : cliVerifier.verify(step as never, ctx, data)
  },
}

type Outcome = typeof writeProbeTool extends Tool ? never : never

async function run(label: string, opts: {
  verifier?: typeof routed
  lying?: boolean
  breakStep1?: boolean
}) {
  calls.length = 0
  const tools = opts.lying
    ? { resolve: (s: { tool?: string }) => (s.tool === 'write-probe-file' ? { tool: lyingFilesystemTool, fellBack: false, reason: 'exact match' } : TOOLS.resolve(s)) }
    : TOOLS
  const result = await execute(mission(), {
    tools,
    verifier: opts.breakStep1
      ? { verifies: () => true, async verify() { return { rejected: 'nothing corroborated this claim' } } }
      : (opts.verifier ?? routed),
    control: wrapped,
    config: CONFIG,
  })
  return { label, result, injected: calls.filter((c) => INJECTION.includes(c)) }
}

// ---------------------------------------------------------------- runs

// A missing prerequisite is not a failing control, and has to be said before anything runs. Without
// this, an absent host fails the `observe-desktop` step, step 2 is never attempted, and the
// assertions below throw a TypeError on a step with no result - which reads as a defect in the
// filesystem path when nothing of the sort has happened.
blockOnHost(await hostAvailability())

const positive = await run('POSITIVE', {})
const controlA = await run('CONTROL A: no verifier', { verifier: { verifies: () => false, async verify() { return { rejected: 'x' } } } as never })
const controlB = await run('CONTROL B: the tool lies', { lying: true })
const controlC = await run('CONTROL C: step 1 fails', { breakStep1: true })

const describe = (label: string, r: typeof positive.result, injected: string[]) => {
  const s1 = r.mission.plan[0]
  const s2 = r.mission.plan[1]
  const sum = summarize(r.record)
  console.log('')
  console.log(`=== ${label} ===`)
  console.log(`  final state       ${r.mission.state}   complete=${r.record.complete}`)
  console.log(`  step 1 ${s1.mode.padEnd(11)} ${s1.result?.outcome.kind}`)
  console.log(`  step 2 ${s2.mode.padEnd(11)} ${s2.result?.outcome.kind ?? 'DID NOT RUN'}`)
  if (s2.result?.outcome.kind === 'verified') {
    console.log(`     evidence        ${JSON.stringify((s2.result.outcome as { evidence: unknown }).evidence)}`)
  }
  if (s2.result?.outcome.kind === 'failed') {
    console.log(`     reason          ${(s2.result.outcome as { reason: string }).reason}`)
  }
  if (s2.result?.outcome.kind === 'skipped') {
    console.log(`     blocked by      ${(s2.result.outcome as { blockedBy?: string }).blockedBy}`)
  }
  console.log(`  dependency-blocked ${r.events.filter((e) => e.type === 'dependency-blocked').length}`)
  console.log(`  finish reason     ${sum.finishReason}`)
  console.log(`  INJECTION CALLS   ${JSON.stringify(injected)}`)
}

console.log('')
console.log(`  workspace: ${WORKSPACE}`)
console.log(`  probe file: probe-${stamp}.txt`)
describe('POSITIVE: verified filesystem change', positive.result, positive.injected)
describe('CONTROL A - no independent verification', controlA.result, controlA.injected)
describe('CONTROL B - the tool claims a write that did not happen', controlB.result, controlB.injected)
describe('CONTROL C - the prerequisite step fails', controlC.result, controlC.injected)

// ---------------------------------------------------------------- assertions

const o1 = positive.result.mission.plan[1].result!.outcome
const a1 = controlA.result.mission.plan[1].result!.outcome
const b1 = controlB.result.mission.plan[1].result!.outcome
const c2 = controlC.result.mission.plan[1].result!.outcome
const cEvents = controlC.result.events

const checks: Array<[boolean, string]> = [
  // positive
  [o1.kind === 'verified', `POSITIVE filesystem step verified (got ${o1.kind})`],
  [positive.result.record.complete === true, 'POSITIVE mission completed'],
  [positive.result.mission.plan[1].mode === 'filesystem', 'step 2 really used the filesystem mode'],
  [Boolean(positive.result.record.verified['write-probe']), 'POSITIVE has independent evidence'],
  [positive.injected.length === 0, `POSITIVE injected nothing (${JSON.stringify(positive.injected)})`],

  // Control A - no verification
  [a1.kind !== 'verified', `CONTROL A: without a verifier the step did NOT complete (got ${a1.kind})`],
  [controlA.result.record.complete === false, 'CONTROL A: mission did NOT complete'],
  [controlA.injected.length === 0, 'CONTROL A: injected nothing'],

  // Control B - the tool lies
  [b1.kind !== 'verified', `CONTROL B: a lying tool was rejected (got ${b1.kind})`],
  [controlB.result.record.complete === false, 'CONTROL B: mission did NOT complete'],
  [/not there|rejected|refused/i.test(JSON.stringify(b1)), 'CONTROL B: the verifier said why'],
  [controlB.injected.length === 0, 'CONTROL B: injected nothing'],

  // Control C - dependency gate
  [c2.kind === 'skipped', `CONTROL C: step 2 was skipped (got ${c2.kind})`],
  [(c2 as { blockedBy?: string }).blockedBy === 'observe-desktop', 'CONTROL C: named the blocker'],
  [cEvents.every((e) => !('stepId' in e) || e.stepId !== 'write-probe' || e.type !== 'step-started'),
    'CONTROL C: the filesystem tool was never called'],
  [cEvents.every((e) => !('stepId' in e) || e.stepId !== 'write-probe' || e.type !== 'tool-selected'),
    'CONTROL C: no tool was even selected for step 2'],
  [controlC.result.record.complete === false, 'CONTROL C: mission did NOT complete'],
  [controlC.injected.length === 0, 'CONTROL C: injected nothing'],
]

console.log('')
console.log('=== ASSERTIONS ===')
let failed = 0
for (const [ok, msg] of checks) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${msg}`)
  if (!ok) failed++
}

console.log('')
console.log(`=== WORKSPACE AFTER ALL RUNS ===`)
console.log(`  ${WORKSPACE}`)
const { readdirSync, statSync: st2 } = await import('node:fs')
const { join } = await import('node:path')
try {
  for (const f of readdirSync(WORKSPACE)) {
    const s = st2(join(WORKSPACE, f))
    console.log(`  ${f}  ${s.size} bytes`)
  }
} catch { console.log('  (workspace absent)') }

console.log('')
console.log(`=== ${failed === 0 ? 'PASS' : failed + ' FAILURE(S)'} ===`)
process.exit(failed ? 1 : 0)
