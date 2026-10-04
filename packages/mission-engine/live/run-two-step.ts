/**
 * The two-step real mission, with dependency gating proven both ways.
 *
 *   Step 1  cli  - observe the real desktop via the host's guard/window endpoints
 *     -> independent verification (re-observes, does not trust the tool)
 *     -> Step 1 complete
 *   Step 2  uia  - survey the accessibility tree of a real window, a STRUCTURALLY DIFFERENT
 *                  mechanism (IUIAutomation COM, not HTTP polling)
 *     dependsOn: [step 1]
 *     -> independent verification (re-surveys UIA itself)
 *     -> mission complete
 *
 * And the negative case, which is the point:
 *
 *   Step 1 fails  ->  Step 2 is NEVER EXECUTED  ->  recorded as dependency-blocked
 *                ->  the mission does NOT complete
 *
 * WHY THE DEPENDENCY IS MEANINGFUL
 *
 * Step 2 inspects a window that Step 1 established exists. If Step 1's observation were
 * wrong or absent, Step 2 would be surveying a window nobody has confirmed is there - so the
 * gate is not sequencing for its own sake, it is a precondition on the work.
 *
 * OBSERVATION ONLY. Neither step can inject. `INJECTION CALLS` is asserted empty.
 */

import { execute } from '../executor.ts'
import { summarize } from '../events.ts'
import {
  liveControl, livePermission, liveUiaVerifier, liveVerifier,
  observeDesktopTool, surveyAccessibilityTool,
} from './live-control.ts'
import type { ControlSurface } from '../../governance/contract.ts'

const INJECTION = ['type', 'click', 'doubleClick', 'move', 'key', 'pressKey', 'drag', 'scroll']

// ---- record every control-surface call, because "it did not inject" must be measured
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

const TOOLS = {
  resolve: (s: { tool?: string }) => {
    if (s.tool === 'observe-desktop') {
      return { tool: observeDesktopTool, fellBack: false, reason: 'exact tool match' }
    }
    if (s.tool === 'survey-accessibility') {
      return { tool: surveyAccessibilityTool, fellBack: false, reason: 'exact tool match' }
    }
    return { unavailable: `no tool for "${s.tool}"`, candidates: [] }
  },
}

const CONFIG = {
  maxAttempts: 2,
  permission: livePermission,
  emergencyStop: async () => (await livePermission()).blockedBy?.includes('EMERGENCY_STOP') ?? false,
}

/**
 * Compose the verifiers so each MODE gets its own independent check.
 *
 * The first version of this harness spread `liveVerifier()` with a `verifies` predicate of
 * `s.mode !== 'uia'`. The executor fell back to its "no verifier" branch for uia steps - which
 * rejects - but the object still carried a working `verify`, so uia steps were verified by the
 * CLI verifier and produced window evidence instead of accessibility evidence.
 *
 * Both steps read as `verified`, which looked correct. The giveaway was that the two evidence
 * values were IDENTICAL for two different modes. That is the same failure class as the silent
 * empty observation: a plausible-looking result that was never actually checked.
 */
function routedVerifier() {
  const cli = liveVerifier()
  const uia = liveUiaVerifier()
  return {
    verifies: (s: { mode?: string }) => (s.mode === 'uia' ? uia.verifies(s) : cli.verifies(s)),
    async verify(step: { mode?: string }, ctx: Parameters<typeof cli.verify>[1], data: unknown) {
      return step.mode === 'uia' ? uia.verify(step, ctx, data) : cli.verify(step, ctx, data)
    },
  }
}

/** The real two-step mission. `breakStep1` swaps in a verifier that cannot corroborate step 1. */
function buildMission(breakStep1: boolean) {
  return {
    id: 'live-two-step',
    objective: 'Observe the real desktop, then survey a real window through the accessibility tree',
    constraints: ['observation only', 'no input of any kind'],
    state: 'executing' as const,
    plan: [
      {
        id: 'observe-desktop',
        intent: 'capture authoritative current desktop state',
        mode: 'cli' as const,
        rationale: 'establishes which windows actually exist; step 2 depends on this',
        status: 'pending' as const,
        tool: 'observe-desktop',
      },
      {
        id: 'survey-window',
        intent: 'survey the accessibility tree of a confirmed real window',
        mode: 'uia' as const,
        rationale: 'a structurally different observation mechanism than the HTTP endpoints',
        status: 'pending' as const,
        tool: 'survey-accessibility',
        dependsOn: ['observe-desktop'],
      },
    ],
    history: [],
    pendingApprovals: [],
    startedAt: 0,
  }
}

/** A tool that reports data but cannot be verified - so step 1 cannot legitimately complete. */
const untrustworthyTool = {
  name: 'observe-desktop',
  mode: 'cli' as const,
  async run() {
    return { kind: 'data' as const, data: { windowCount: 999 }, summary: 'claims 999 windows' }
  },
}

async function run(label: string, breakStep1: boolean) {
  calls.length = 0
  const mission = buildMission(breakStep1)
  const result = await execute(mission, {
    tools: breakStep1 ? { resolve: TOOLS.resolve } : TOOLS,
    // Step 1 is verified by a verifier that REJECTS, so the claim cannot be corroborated.
    verifier: breakStep1
      ? { verifies: () => true, async verify() { return { rejected: 'nothing corroborated this claim' } } }
      : routedVerifier(),
    control: wrapped,
    config: CONFIG,
  })
  return { label, result, injected: calls.filter((c) => INJECTION.includes(c)) }
}

// ---------------------------------------------------------------- run both

const positive = await run('POSITIVE', false)
const negative = await run('NEGATIVE (step 1 cannot legitimately complete)', true)

const describe = (label: string, result: typeof positive.result, injected: string[]) => {
  const s1 = result.mission.plan[0]
  const s2 = result.mission.plan[1]
  const sum = summarize(result.record)
  console.log('')
  console.log(`=== ${label} ===`)
  console.log(`  mission id          ${result.mission.id}`)
  console.log(`  final state         ${result.mission.state}`)
  console.log(`  complete            ${result.record.complete}`)
  console.log('')
  console.log(`  step 1  ${s1.id}`)
  console.log(`    mode               ${s1.mode}`)
  console.log(`    outcome            ${s1.result?.outcome.kind}`)
  console.log(`    evidence           ${JSON.stringify((s1.result?.outcome as { evidence?: unknown }).evidence)}`)
  console.log('')
  console.log(`  step 2  ${s2.id}   dependsOn=${JSON.stringify(s2.dependsOn)}`)
  console.log(`    mode               ${s2.mode}`)
  console.log(`    outcome            ${s2.result?.outcome.kind ?? 'DID NOT RUN'}`)
  console.log(`    evidence           ${JSON.stringify((s2.result?.outcome as { evidence?: unknown } | undefined)?.evidence)}`)
  console.log('')
  const tools = new Set(sum.toolsUsed)
  console.log(`  tools selected      ${JSON.stringify([...tools])}`)
  console.log(`  state transitions   ${sum.transitions.map((t) => `${t.from}->${t.to}`).join('  ')}`)
  console.log(`  dependency-blocked  ${result.events.filter((e) => e.type === 'dependency-blocked').length}`)
  console.log(`  finish reason       ${sum.finishReason}`)
  console.log(`  integrity           ${sum.integrityViolations.length === 0 ? 'no violations' : sum.integrityViolations.join('; ')}`)
  console.log(`  INJECTION CALLS     ${JSON.stringify(injected)}`)
  console.log('')
  console.log('  event trail:')
  for (const e of result.events) {
    const st = 'stepId' in e && e.stepId ? ` [${e.stepId}]` : ''
    console.log(`    ${String(e.seq).padStart(2)} ${e.type}${st}`)
  }
}

describe('POSITIVE: dependency unlocks', positive.result, positive.injected)
describe('NEGATIVE: step 2 must NOT execute', negative.result, negative.injected)

// ---------------------------------------------------------------- assertions

const p = positive.result
const n = negative.result
const pS1 = p.mission.plan[0].result!.outcome
const pS2 = p.mission.plan[1].result!
const nS1 = n.mission.plan[0].result!.outcome
const nS2 = n.mission.plan[1].result

const checks: Array<[boolean, string]> = [
  // positive path
  [pS1.kind === 'verified', `POSITIVE step 1 verified (got ${pS1.kind})`],
  [pS2.outcome.kind === 'verified', `POSITIVE step 2 executed and verified (got ${pS2.outcome.kind})`],
  [p.mission.plan[1].mode === 'uia', 'step 2 really used the uia mode'],
  [p.record.complete === true, 'POSITIVE mission completed'],
  [p.mission.plan[1].dependsOn?.includes('observe-desktop') === true, 'the dependency was declared'],
  [Boolean(p.record.verified['observe-desktop']), 'step 1 has independent evidence'],
  [Boolean(p.record.verified['survey-window']), 'step 2 has independent evidence'],
  [positive.injected.length === 0, `POSITIVE injected nothing (${JSON.stringify(positive.injected)})`],

  // negative path - the gate is load-bearing
  [nS1.kind !== 'verified', `NEGATIVE step 1 did NOT complete (got ${nS1.kind})`],
  [nS2?.outcome.kind === 'skipped',
    'NEGATIVE step 2 was never executed and is recorded as SKIPPED, not failed',
  ],
  [nS2?.outcome.blockedBy === 'observe-desktop',
    'NEGATIVE the skip names the dependency that blocked it',
  ],
  [n.record.complete === false, 'NEGATIVE mission did NOT complete'],
  [n.events.some((e) => e.type === 'dependency-blocked'),
    'NEGATIVE step 2 was recorded as dependency-blocked'],
  [n.events.every((e) => !('stepId' in e) || e.stepId !== 'survey-window' || e.type !== 'step-started'),
    'NEGATIVE no step-started event exists for step 2 - the tool was never called'],
  [n.events.every((e) => !('stepId' in e) || e.stepId !== 'survey-window' || e.type !== 'tool-selected'),
    'NEGATIVE no tool was even selected for step 2'],
  [negative.injected.length === 0, `NEGATIVE injected nothing (${JSON.stringify(negative.injected)})`],
]

console.log('=== ASSERTIONS ===')
let failed = 0
for (const [ok, msg] of checks) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${msg}`)
  if (!ok) failed++
}
console.log('')
console.log(`=== ${failed === 0 ? 'PASS' : failed + ' FAILURE(S)'} ===`)
process.exit(failed ? 1 : 0)