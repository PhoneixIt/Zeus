/**
 * Closing the gui verifier's ACCEPT path with an already-existing control-layer mechanism.
 *
 * THE GAP THIS EXISTS TO CLOSE
 *
 * The previous milestone proved every reject path against real hardware and could not reach the
 * accept path, because producing a real operator event required `mayInject`, which is false
 * while a human holds control. The suggested fix - a "non-takeover arming mode" - was rejected,
 * and correctly: it would have been a second permission path around the boundary that was just
 * made authoritative.
 *
 * THE MECHANISM, AND WHY IT IS NOT A BYPASS
 *
 * The control core ALREADY contains a deliberate, safe, operator self-test: the hook's F24
 * liveness probe. `GET /hooks` calls `Hooks.Report()`, which signals the hook thread to send one
 * real F24 keystroke through `SendInput` carrying `Guard.Sentinel`, then waits up to 400ms for
 * the hook to see it come back.
 *
 *   - control-core is NOT modified
 *   - no permission is bypassed, no arming state invented
 *   - the sentinel is never read by this mission
 *   - F24 is bound by no application and is not a reserved chord: it cannot type, activate,
 *     submit, or send anything, and it carries no application target
 *   - it is not gated by `mayInject`, which is the watchdog working as designed: a hook Windows
 *     has silently detached can only be detected by sending it something, and a dead hook would
 *     otherwise hide by refusing everything
 *
 * So this closes the accept path using the existing contract. It exercises the KEYBOARD
 * ownership path only, and proves nothing about the mouse path - which stays measured-broken.
 */

import { connect } from '../../control-core/operator-client.mjs'
import type { Evidence } from '../state.ts'
import { execute } from '../executor.ts'
import { summarize } from '../events.ts'
import { liveControl, livePermission, liveVerifier, observeDesktopTool } from './live-control.ts'
import {
  CONTROLLED_TARGET, fabricatingSelfTestTool, falsifyingRecordGuiTool, guiTool, guiVerifier,
  lyingGuiTool, misattributingSelfTestTool, operatorSelfTestTool,
} from './gui-mode.ts'
import { readHookDiagnostics, readRecord, type RecordSource } from './injection-audit.ts'
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

const client = (await connect({
  statePath: new URL('../../control-core/host.json', import.meta.url).pathname.replace(/^\//, ''),
})) as unknown as RecordSource

const CONFIG = {
  maxAttempts: 1,
  permission: livePermission,
  emergencyStop: async () => (await livePermission()).blockedBy?.includes('EMERGENCY_STOP') ?? false,
}

function mission(selfTest: boolean) {
  return {
    id: 'live-gui-accept-1',
    objective: selfTest
      ? 'Drive the control layer\'s existing operator self-test and have the audit certify the real event'
      : 'Attempt a real user action on a controlled target',
    constraints: ['no application target', 'no user data at risk', 'no control-core change'],
    state: 'executing' as const,
    plan: [
      {
        id: 'observe-desktop',
        intent: 'establish that the real machine is observable',
        mode: 'cli' as const,
        rationale: 'the event must be attributed to a real, confirmed machine',
        status: 'pending' as const,
        tool: 'observe-desktop',
      },
      {
        id: selfTest ? 'operator-self-test' : 'controlled-click',
        intent: selfTest
          ? 'request the control layer\'s own F24 liveness probe and certify the resulting operator event'
          : `perform one audited click at screen(${CONTROLLED_TARGET.x},${CONTROLLED_TARGET.y})`,
        mode: 'gui' as const,
        rationale: 'the only route that produces a real authoritative operator event on demand',
        status: 'pending' as const,
        tool: selfTest ? 'operator-self-test' : 'controlled-click',
        dependsOn: ['observe-desktop'],
      },
    ],
    history: [],
    pendingApprovals: [],
    startedAt: 0,
  }
}

const cliVerifier = liveVerifier()

/**
 * Builds the verifier with a baseline the tool cannot influence.
 *
 * The baseline is read from the control layer HERE, in the harness, immediately before the step
 * runs. It is not derived from anything the tool returns, which is the entire point: a tool
 * that fabricates its audit cannot move a counter in another process.
 */
function routed(expectInjection: boolean, baselineOperatorEvents: number, claimedActor?: string) {
  const gui = guiVerifier(client, { expectInjection, claimedActor, baselineOperatorEvents })
  return {
    verifies: (s: { mode?: string }) => (s.mode === 'gui' ? gui.verifies(s as never) : cliVerifier.verifies()),
    async verify(step: { mode?: string }, ctx: Parameters<typeof cliVerifier.verify>[1], data: unknown): Promise<{ evidence: Evidence } | { rejected: string }> {
      return step.mode === 'gui'
        ? gui.verify(step as never, ctx, data)
        : cliVerifier.verify(step as never, ctx, data)
    },
  }
}

async function run(label: string, opts: {
  selfTest: boolean
  tool?: ReturnType<typeof guiTool>
  expectInjection?: boolean
  claimedActor?: string
}) {
  calls.length = 0
  const tool = opts.tool ?? (opts.selfTest ? operatorSelfTestTool(client) : guiTool(client))

  // The pre-step baseline, captured HERE. Pure `/guard`, so capturing it changes nothing.
  const baseline = await readRecord(client)

  const result = await execute(mission(opts.selfTest), {
    tools: {
      resolve: (s: { tool?: string }) => {
        if (s.tool === 'observe-desktop') return { tool: observeDesktopTool, fellBack: false, reason: 'exact match' }
        if (s.tool === 'controlled-click' || s.tool === 'operator-self-test') {
          return { tool, fellBack: false, reason: 'exact match' }
        }
        return { unavailable: `no tool for "${s.tool}"`, candidates: [] }
      },
    },
    verifier: routed(opts.expectInjection ?? opts.selfTest, baseline.operatorEvents, opts.claimedActor),
    control: wrapped,
    config: CONFIG,
  })
  return { label, result, baseline, injected: calls.filter((c) => INJECTION.includes(c)) }
}

const show = (label: string, r: Awaited<ReturnType<typeof run>>) => {
  const s2 = r.result.mission.plan[1]
  const o = s2.result?.outcome as { evidence?: { kind?: string; detail?: string }; reason?: string } | undefined
  console.log('')
  console.log(`=== ${label} ===`)
  console.log(`  mission state     ${r.result.mission.state}   complete=${r.result.record.complete}`)
  console.log(`  step 2 outcome    ${s2.result?.outcome.kind ?? 'DID NOT RUN'}`)
  console.log(`  evidence kind     ${o?.evidence?.kind ?? '(none)'}`)
  if (o?.evidence?.detail) console.log(`  detail            ${o.evidence.detail}`)
  if (o?.reason) console.log(`  reason            ${o.reason}`)
  console.log(`  finish reason     ${summarize(r.result.record).finishReason}`)
}

// ============================================================ the real state

console.log('')
console.log('=== THE REAL CONTROL STATE ===')
const pre = await readRecord(client)
console.log(`  state             ${pre.state}`)
console.log(`  mayInject         ${pre.mayInject}`)
console.log(`  takeoverPending   ${pre.takeoverPending}`)
console.log(`  operatorEvents    ${pre.operatorEvents}`)
console.log(`  humanEvents       ${pre.humanEvents}`)
console.log('')
console.log('  The operator is in human takeover, so a USER ACTION cannot inject. The self-test')
console.log('  is the one existing mechanism that produces a real operator event regardless,')
console.log('  because it is the watchdog checking itself rather than acting on the world.')

// ============================================================ the accept path

const accept = await run('ACCEPT PATH: the existing operator self-test', { selfTest: true })
show('ACCEPT PATH: the existing operator self-test', accept)

// ============================================================ the user-action path, still refused

const userAction = await run('USER ACTION: still correctly refused', { selfTest: false })
show('USER ACTION: still correctly refused', userAction)

// ============================================================ controls on the accept path

const ctrlFabricated = await run('CONTROL E: claims a self-test event without requesting one', {
  selfTest: true, tool: fabricatingSelfTestTool(client),
})
show('CONTROL E - claims a self-test event without requesting one', ctrlFabricated)

const ctrlNoAudit = await run('CONTROL A: claims success with no audit', { selfTest: true, tool: lyingGuiTool })
show('CONTROL A - claims success with no audit', ctrlNoAudit)

const ctrlFalsified = await run('CONTROL B: falsifies the authoritative record', {
  selfTest: true, tool: falsifyingRecordGuiTool(client),
})
show('CONTROL B - falsifies the authoritative record', ctrlFalsified)

const ctrlWrongActor = await run('CONTROL C: wrong actor attribution', {
  selfTest: true, tool: misattributingSelfTestTool(client), claimedActor: 'human',
})
show('CONTROL C - wrong actor attribution', ctrlWrongActor)

// ============================================================ the authoritative evidence

console.log('')
console.log('=== THE AUTHORITATIVE RECORD, AFTER THE SELF-TEST ===')
const { diagnostics, probesAdvanced } = await readHookDiagnostics(client)
const post = await readRecord(client)
console.log(`  operatorEvents      ${pre.operatorEvents} -> ${post.operatorEvents}   (delta ${post.operatorEvents - pre.operatorEvents})`)
console.log(`  humanEvents         ${pre.humanEvents} -> ${post.humanEvents}   (delta ${post.humanEvents - pre.humanEvents})`)
console.log(`  livenessProbes      ${diagnostics.livenessProbes}`)
console.log(`  livenessProbeHits   ${diagnostics.livenessProbeHits}`)
console.log(`  livenessFailures    ${diagnostics.livenessFailures}`)
console.log(`  keyboardHook        ${diagnostics.keyboardHookInstalled}   mouseHook ${diagnostics.mouseHookInstalled}   thread ${diagnostics.hookThreadAlive}`)
console.log(`  mouseTaggedSeen     ${diagnostics.mouseTaggedSeen}   <- still 0; the mouse defect is untouched`)
console.log(`  mouseUntaggedSeen   ${diagnostics.mouseUntaggedSeen}`)
console.log(`  probes caused by this last diagnostic read: ${probesAdvanced}  (a /hooks read injects)`)

// ============================================================ assertions

const o2 = accept.result.mission.plan[1].result!.outcome
const acceptEv = (o2 as { evidence: { kind?: string; detail?: string; actor?: string; proven?: boolean } }).evidence
const u2 = userAction.result.mission.plan[1].result!.outcome
const e2 = ctrlFabricated.result.mission.plan[1].result!.outcome
const a2 = ctrlNoAudit.result.mission.plan[1].result!.outcome
const b2 = ctrlFalsified.result.mission.plan[1].result!.outcome
const c2 = ctrlWrongActor.result.mission.plan[1].result!.outcome

const checks: Array<[boolean, string]> = [
  // --- the accept path, on real hardware
  [o2.kind === 'verified', `ACCEPT: the verifier ACCEPTED on a real authoritative event (got ${o2.kind})`],
  [accept.result.record.complete === true, 'ACCEPT: the mission completed'],
  [acceptEv?.kind === 'input-attributed', 'ACCEPT: the evidence is an attribution claim, not an observation'],
  [acceptEv?.actor === 'operator', `ACCEPT: the actor is the operator (got ${acceptEv?.actor})`],
  [acceptEv?.proven === true, 'ACCEPT: the attribution is marked proven'],
  [/operator-proven/.test(acceptEv?.detail ?? ''), 'ACCEPT: the verdict is operator-proven'],
  [/humanEvents \+0|human \+0/.test(acceptEv?.detail ?? ''), 'ACCEPT: the human counter did not move, so the two are exclusive'],
  [post.operatorEvents > pre.operatorEvents, `ACCEPT: the control layer's own operatorEvents rose by ${post.operatorEvents - pre.operatorEvents}`],
  [post.humanEvents === pre.humanEvents, 'ACCEPT: humanEvents did not move'],
  [accept.injected.length === 0, `ACCEPT: no ControlSurface input method was invoked (${JSON.stringify(accept.injected)})`],
  [/class instrumentation/.test(acceptEv?.detail ?? ''), 'ACCEPT: the evidence names the action class, so the relaxed rule is visible'],

  // --- the user-action path is still refused
  [u2.kind === 'needs-human', `USER ACTION: still parked (got ${u2.kind})`],
  [userAction.result.record.complete === false, 'USER ACTION: the mission did NOT complete'],
  [/This step did not perform its action/.test(JSON.stringify(u2)), 'USER ACTION: recorded as not done'],

  // --- controls on the accept path
  [e2.kind !== 'verified', `CONTROL E: a fabricated self-test claim did NOT verify (got ${e2.kind})`],
  [/against a pre-step baseline/i.test(JSON.stringify(e2)), 'CONTROL E: rejected by the baseline the tool could not influence'],
  [a2.kind !== 'verified', `CONTROL A: a claim with no audit did NOT verify (got ${a2.kind})`],
  [b2.kind !== 'verified', `CONTROL B: a falsified record did NOT verify (got ${b2.kind})`],
  [c2.kind !== 'verified', `CONTROL C: a wrong actor did NOT verify (got ${c2.kind})`],
  [/attributed the action to/i.test(JSON.stringify(c2)), 'CONTROL C: rejected on the attribution mismatch, after a REAL injection passed the baseline check'],

  // --- the safety boundary is unchanged
  // The invariant, not a particular state. Requiring HUMAN_TAKEOVER made this fail after an
  // ordinary restart left the operator in OBSERVING - which is still a perfectly safe state,
  // and refusing injection in it is the correct behaviour.
  [pre.mayInject === false, `SAFETY: injection was forbidden throughout (state=${pre.state})`],
  [/the operator must be ARMED|human takeover/i.test(pre.blockingReason ?? ''), 'SAFETY: the refusal came from the guard'],
  [diagnostics.mouseTaggedSeen === 0, 'SAFETY: the mouse sentinel behaviour is exactly as measured before'],
  [diagnostics.livenessFailures === 0, 'SAFETY: no liveness failures were produced'],
]

console.log('')
console.log('=== ASSERTIONS ===')
let failed = 0
for (const [ok, msg] of checks) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${msg}`)
  if (!ok) failed++
}

console.log('')
console.log(`=== ${failed === 0 ? 'PASS' : failed + ' FAILURE(S)'} ===`)
process.exit(failed ? 1 : 0)