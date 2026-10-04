/**
 * The real vertical slice.
 *
 * Proves the loop closes against the actual Windows control host:
 *
 *   MISSION -> EXECUTOR -> TOOL -> REAL ControlSurface -> REAL HOST -> RESULT
 *          -> INDEPENDENT EVIDENCE -> STATE TRANSITION -> COMPLETION
 *
 * OBSERVATION ONLY. No mouse, no keyboard, no release, no resume. The mission has one step
 * that reads state; the executor is general, but this mission is deliberately the most
 * conservative one available.
 *
 * The assertion that matters most is the last one: that no injection method was called. A
 * mission that completes correctly while quietly reaching for input capability would be worse
 * than one that fails.
 *
 * Re-runnable. Every run is a fresh observation of the real machine.
 */

import { execute } from '../executor.ts'
import { summarize } from '../events.ts'
import { liveControl, livePermission, observeDesktopTool, liveVerifier } from './live-control.ts'
import type { ControlSurface } from '../../governance/contract.ts'

const INJECTION = ['type', 'click', 'doubleClick', 'move', 'key', 'pressKey', 'drag', 'scroll']

// Wrap the surface so every call is recorded. Wrapping rather than trusting: the point is to
// observe what the executor actually did, not what it was supposed to do.
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

const mission = {
  id: 'live-observe-1',
  objective: 'Observe the real desktop and capture authoritative current state',
  constraints: ['observation only', 'no input of any kind'],
  state: 'executing' as const,
  plan: [
    {
      id: 'observe',
      intent: 'capture the real current desktop state',
      mode: 'cli' as const,
      rationale: 'the mission requires ground truth from the real machine, not an assumption',
      status: 'pending' as const,
      tool: 'observe-desktop',
    },
  ],
  history: [],
  pendingApprovals: [],
  startedAt: 0,
}

const perm = await livePermission()

const result = await execute(
  mission,
  {
    tools: {
      resolve: (s) =>
        s.tool === 'observe-desktop'
          ? { tool: observeDesktopTool, fellBack: false, reason: 'exact tool match' }
          : { unavailable: `no tool for ${s.tool}`, candidates: [] },
    },
    verifier: liveVerifier(),
    control: wrapped,
    config: {
      maxAttempts: 2,
      permission: livePermission,
      emergencyStop: async () => (await livePermission()).blockedBy?.includes('EMERGENCY_STOP') ?? false,
    },
  },
)

const outcome = result.mission.plan[0].result!.outcome
const summary = summarize(result.record)
const injected = calls.filter((c) => INJECTION.includes(c))

console.log('')
console.log('=== REAL OBSERVATION-ONLY MISSION ===')
console.log(`  mission         ${result.mission.id}`)
console.log(`  objective       ${mission.objective}`)
console.log(`  final state     ${result.mission.state}`)
console.log(`  step outcome    ${outcome.kind}`)
console.log(`  complete        ${result.record.complete}`)
console.log('')
console.log('  live host state at start:')
console.log(`    control       ${perm.control}`)
console.log(`    input         ${perm.input}${perm.blockedBy ? ` (${perm.blockedBy})` : ''}`)
console.log('')
console.log('  evidence produced by the INDEPENDENT verifier:')
console.log(`    ${JSON.stringify(result.record.verified.observe)}`)
console.log('')
console.log('  event trail:')
for (const e of result.events) {
  const step = 'stepId' in e && e.stepId ? ` [${e.stepId}]` : ''
  console.log(`    ${String(e.seq).padStart(2)} ${e.type}${step}`)
}
console.log('')
console.log('  audit summary:')
console.log(`    tools used     ${JSON.stringify(summary.toolsUsed)}`)
console.log(`    transitions    ${summary.transitions.length}`)
console.log(`    retries        ${summary.retries.length}`)
console.log(`    failures       ${summary.failures.length}`)
console.log(`    finish reason  ${summary.finishReason}`)
console.log(`    integrity      ${summary.integrityViolations.length === 0 ? 'no violations' : summary.integrityViolations.join('; ')}`)
console.log('')
console.log('  control-surface calls made:')
console.log(`    ${JSON.stringify([...new Set(calls)])}`)
console.log(`    INJECTION CALLS: ${JSON.stringify(injected)}`)
console.log('')

// ---- the assertions. A green printout is not evidence; these are.
const checks: Array<[boolean, string]> = [
  [outcome.kind === 'verified', `step verified (got ${outcome.kind})`],
  [result.record.complete === true, 'mission completed under the contract'],
  [injected.length === 0, 'NO injection method was called'],
  [calls.includes('observe'), 'a real observation went through the real control surface'],
  [summary.integrityViolations.length === 0, 'executor belief agreed with the completion contract'],
  [Boolean(result.record.verified.observe), 'independent evidence exists'],
]

let failed = 0
console.log('=== ASSERTIONS ===')
for (const [ok, msg] of checks) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${msg}`)
  if (!ok) failed++
}
console.log('')
console.log(`=== ${failed === 0 ? 'PASS' : failed + ' FAILURE(S)'} ===`)
process.exit(failed ? 1 : 0)