/**
 * The GUI mission: an audited control action, and four negative controls.
 *
 *   step 1  cli  observe-desktop        establish the machine is real
 *   step 2  gui  controlled-click       perform ONE audited action on a controlled target
 *            dependsOn [step 1]
 *
 * The action is `/click-absolute`: an operator-TAGGED click at screen(4,4), with NO
 * application target. It aims at a region watched by the hook, so it cannot land in anything
 * the human is using, and the hook refuses it by design because the sentinel marks it as
 * automation. Nothing is typed, submitted, deleted, purchased, or sent.
 *
 * Controls:
 *   A  the tool claims success without acting
 *   B  the action happens but the authoritative record is suppressed
 *   C  the action happens but the tool attributes it to the wrong actor
 *   D  human takeover - the real, already-active takeover, not a simulated one
 *
 * A separate measurement (§5) records what the control layer and the hook each conclude about
 * a REAL injected event, without forging anything: the host's own F24 liveness probe fires on
 * a timer through the real input stack, and the audit simply watches the authoritative deltas.
 */

import { connect } from '../../control-core/operator-client.mjs'
import { execute } from '../executor.ts'
import { summarize } from '../events.ts'
import {
  liveControl, livePermission, liveVerifier, observeDesktopTool,
} from './live-control.ts'
import {
  CONTROLLED_TARGET, falsifyingRecordGuiTool, guiTool, guiVerifier,
  lyingGuiTool, misattributingGuiTool,
} from './gui-mode.ts'
import { attribute, readHookDiagnostics, readRecord, type RecordSource } from './injection-audit.ts'
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

function mission() {
  return {
    id: 'live-gui-audit-1',
    objective: 'Perform one audited control action on a controlled target and record what the control layer can prove',
    constraints: ['one controlled target', 'no application target', 'no data at risk'],
    state: 'executing' as const,
    plan: [
      {
        id: 'observe-desktop',
        intent: 'establish that the real machine is observable',
        mode: 'cli' as const,
        rationale: 'the action must be attributed to a real, confirmed machine',
        status: 'pending' as const,
        tool: 'observe-desktop',
      },
      {
        id: 'controlled-click',
        intent: `perform one audited click at screen(${CONTROLLED_TARGET.x},${CONTROLLED_TARGET.y})`,
        mode: 'gui' as const,
        rationale: 'the only route that exercises a real input path with no application target',
        status: 'pending' as const,
        tool: 'controlled-click',
        args: { x: CONTROLLED_TARGET.x, y: CONTROLLED_TARGET.y },
        dependsOn: ['observe-desktop'],
      },
    ],
    history: [],
    pendingApprovals: [],
    startedAt: 0,
  }
}

const cliVerifier = liveVerifier()

/** Routes by mode, and passes the gui verifier the expectation for THIS mission. */
function routed(expectInjection: boolean, claimedActor?: string) {
  const gui = guiVerifier(client, { expectInjection, claimedActor })
  return {
    verifies: (s: { mode?: string }) => (s.mode === 'gui' ? gui.verifies(s as never) : cliVerifier.verifies(s as never)),
    async verify(step: { mode?: string }, ctx: Parameters<typeof cliVerifier.verify>[1], data: unknown) {
      return step.mode === 'gui'
        ? gui.verify(step as never, ctx, data)
        : cliVerifier.verify(step as never, ctx, data)
    },
  }
}

async function run(label: string, opts: {
  gui?: ReturnType<typeof guiTool>
  expectInjection?: boolean
  claimedActor?: string
}) {
  calls.length = 0
  const tool = opts.gui ?? guiTool(client)
  const result = await execute(mission(), {
    tools: {
      resolve: (s: { tool?: string }) => {
        if (s.tool === 'observe-desktop') return { tool: observeDesktopTool, fellBack: false, reason: 'exact match' }
        if (s.tool === 'controlled-click') return { tool, fellBack: false, reason: 'exact match' }
        return { unavailable: `no tool for "${s.tool}"`, candidates: [] }
      },
    },
    verifier: routed(opts.expectInjection ?? false, opts.claimedActor),
    control: wrapped,
    config: CONFIG,
  })
  return { label, result, injected: calls.filter((c) => INJECTION.includes(c)) }
}

const describe = (label: string, r: Awaited<ReturnType<typeof run>>) => {
  const s2 = r.result.mission.plan[1]
  const sum = summarize(r.result.record)
  console.log('')
  console.log(`=== ${label} ===`)
  console.log(`  final state        ${r.result.mission.state}   complete=${r.result.record.complete}`)
  console.log(`  step 1 cli         ${r.result.mission.plan[0].result?.outcome.kind}`)
  console.log(`  step 2 gui         ${s2.result?.outcome.kind ?? 'DID NOT RUN'}`)
  const o = s2.result?.outcome as { evidence?: { detail?: string }; reason?: string } | undefined
  if (o?.evidence) console.log(`  evidence           ${o.evidence.detail}`)
  else if (o?.reason) console.log(`  reason             ${o.reason}`)
  console.log(`  human-required evt ${r.result.events.filter((e) => e.type === 'human-required').length}`)
  console.log(`  injection calls    ${JSON.stringify(r.injected)}`)
  console.log(`  finish reason      ${sum.finishReason}`)
}

console.log('')
console.log(`  record source   the control core's own counters, over /guard and /hooks`)
console.log(`  action          click-absolute at screen(${CONTROLLED_TARGET.x},${CONTROLLED_TARGET.y}), no application target`)
console.log('')

// ============================================================ the real state first

const pre = await readRecord(client)
console.log('=== THE REAL CONTROL STATE, BEFORE ANYTHING ===')
console.log(`  state              ${pre.state}`)
console.log(`  mayInject          ${pre.mayInject}`)
console.log(`  inputPermission    ${pre.inputPermission}`)
console.log(`  blockingReason     ${pre.blockingReason}`)
console.log(`  takeoverPending    ${pre.takeoverPending}`)
console.log(`  emergencyLatched   ${pre.emergencyLatched}`)
console.log(`  hook thread alive  ${pre.hookThreadAlive}`)
console.log(`  operatorEvents     ${pre.operatorEvents}`)
console.log(`  humanEvents        ${pre.humanEvents}`)
console.log(`  otherInjected      ${pre.otherInjected}`)
console.log(`  mouseTaggedSeen    ${pre.mouseTaggedSeen}`)
console.log(`  mouseUntaggedSeen  ${pre.mouseUntaggedSeen}`)

// ============================================================ runs

const positive = await run('REAL: the mission attempts the audited action', {})
const controlA = await run('CONTROL A: the tool claims success without acting', { gui: lyingGuiTool })
const controlB = await run('CONTROL B: the authoritative record is falsified', {
  gui: falsifyingRecordGuiTool(client), expectInjection: true,
})
const controlC = await run('CONTROL C: the tool attributes it to the wrong actor', {
  gui: misattributingGuiTool(client), claimedActor: 'human',
})

describe('REAL: the mission attempts the audited action', positive)
describe('CONTROL A - claims success without acting', controlA)
describe('CONTROL B - the authoritative record is suppressed', controlB)
describe('CONTROL C - wrong actor attribution', controlC)

// ============================================================ §5 measure, do not pretend

console.log('')
console.log('=== MEASUREMENT: a REAL injected event, observed without forging anything ===')
console.log('  The host sends its own F24 liveness probe through the real input stack, carrying')
console.log('  the real ownership sentinel. This mission does not inject anything, does not read')
console.log('  the sentinel, and does not cause the event by observing: it REQUESTS the existing')
console.log('  self-test via GET /hooks and then watches the authoritative counters.')
console.log('  (An earlier version of this measurement simply waited 13 seconds. That only ever')
console.log('  appeared to work because readRecord() itself called /hooks - and therefore caused')
console.log('  the probe it was about to take credit for observing. There is no background timer.')
const m0 = await readRecord(client)
await client.raw('/hooks')
const m1 = await readRecord(client)
const measured = attribute(m0, m1, 'keyboard')
console.log(`  operatorEvents  ${m0.operatorEvents} -> ${m1.operatorEvents}`)
console.log(`  humanEvents     ${m0.humanEvents} -> ${m1.humanEvents}`)
console.log(`  verdict         ${measured.verdict}`)
console.log(`  basis           ${measured.basis}`)
console.log('')
console.log('  >>> A  input occurred ....... ' + measured.inputOccurred)
console.log('  >>> B  operator-generated ... ' + measured.operatorGenerated)
console.log('  >>> C  human-generated ...... ' + measured.humanGenerated)
console.log('  >>> D  attribution proven ... ' + measured.attributionProven)

const { diagnostics: post } = await readHookDiagnostics(client)
console.log('')
console.log('=== MEASUREMENT: the mouse tagging path, as it stands ===')
console.log(`  mouseEventsSeen     ${post.mouseEventsSeen}`)
console.log(`  mouseTaggedSeen     ${post.mouseTaggedSeen}   <- events that carried the sentinel`)
console.log(`  mouseUntaggedSeen   ${post.mouseUntaggedSeen}   <- events that did not`)
console.log(`  panelInjectedSeen   ${post.panelInjectedSeen}   <- clicks Windows flagged injected`)
console.log(`  panelTaggedSeen     ${post.panelTaggedSeen}   <- clicks that ALSO carried the sentinel`)
const mouseVerdict = attribute(
  { ...post, mouseEventsSeen: post.mouseEventsSeen - 1, mouseTaggedSeen: post.mouseTaggedSeen },
  post,
  'mouse',
)
console.log(`  attribution verdict ${mouseVerdict.verdict}`)
console.log(`  basis               ${mouseVerdict.basis}`)
console.log('')
console.log('  RESULT: KNOWN DEFECT, reproduced and measured. dwExtraInfo does not survive the')
console.log('  Windows mouse path, so mouseTaggedSeen is 0 while untagged events accumulate.')
console.log('  The control layer classifies an operator mouse click as HUMAN. That is')
console.log('  conservative - it fails toward halting rather than toward acting - but it is wrong,')
console.log('  and it is NOT fixed by this milestone. No heuristic guesses the true actor.')

// ============================================================ assertions

const ev = (r: Awaited<ReturnType<typeof run>>, i: number) =>
  (r.result.mission.plan[i].result?.outcome as { evidence?: { detail?: string; kind?: string }; reason?: string } | undefined)

const p2 = positive.result.mission.plan[1].result!.outcome
const a2 = controlA.result.mission.plan[1].result!.outcome
const b2 = controlB.result.mission.plan[1].result!.outcome
const c2 = controlC.result.mission.plan[1].result!.outcome
const posReason = ev(positive, 1)?.reason ?? ''
const posJson = JSON.stringify(positive.result.mission.plan[1].result!.outcome)

const checks: Array<[boolean, string]> = [
  // --- the real run: a refusal is NOT a completion
  [p2.kind === 'needs-human', `REAL: a refused action parks the step (got ${p2.kind})`],
  [positive.result.record.complete === false, 'REAL: the mission did NOT complete - the click never happened'],
  [positive.result.mission.state === 'blocked-on-human', `REAL: the mission state is blocked-on-human (got ${positive.result.mission.state})`],
  [positive.result.events.some((e) => e.type === 'human-required'), 'REAL: a human-required event was emitted'],
  [/the control layer refused to inject/.test(posReason), 'REAL: the reason names the authoritative refusal'],
  [/human takeover detected/.test(posReason), 'REAL: the human takeover is quoted verbatim from the control layer'],
  [/mayInject=false/.test(posReason), 'REAL: the reason carries the authoritative permission state'],
  [/This step did not perform its action/.test(posReason), 'REAL: the record says plainly that nothing was done'],
  [/No input was attempted, so no injection occurred/.test(posReason), 'REAL: input and attribution are distinguished'],
  [positive.result.mission.plan[1].mode === 'gui', 'REAL: the step really used the gui mode'],
  [positive.injected.length === 0, `REAL: no ControlSurface input method was invoked (${JSON.stringify(positive.injected)})`],

  // --- Control A: fake success
  [a2.kind !== 'verified', `CONTROL A: a tool claiming success without acting did NOT verify (got ${a2.kind})`],
  [controlA.result.record.complete === false, 'CONTROL A: the mission did NOT complete'],
  [/no audit attached/i.test(JSON.stringify(a2)), 'CONTROL A: rejected because there was no audit to verify'],

  // --- Control B: falsified record
  //
  // The rejection fires on the permission contradiction rather than on "no input was
  // recorded", because the verifier checks the authoritative permission state FIRST. That is
  // the stronger of the two grounds: it does not merely note that no input happened, it shows
  // the tool's claim is impossible - an action cannot be accepted while injection is forbidden.
  [b2.kind !== 'verified', `CONTROL B: a falsified record did NOT verify (got ${b2.kind})`],
  [controlB.result.record.complete === false, 'CONTROL B: the mission did NOT complete'],
  [/mayInject=false/.test(JSON.stringify(b2)) && /cannot be accepted while injection is forbidden/.test(JSON.stringify(b2)),
    'CONTROL B: rejected because the control layer\'s live answer contradicts the tool\'s claim'],

  // --- Control C: wrong actor
  [c2.kind !== 'verified', `CONTROL C: a wrong actor claim did NOT verify (got ${c2.kind})`],
  [/attributed the action to/i.test(JSON.stringify(c2)), 'CONTROL C: rejected on the attribution mismatch'],

  // --- Control D: the real takeover
  [pre.state === 'HUMAN_TAKEOVER' && pre.mayInject === false, 'CONTROL D: the real takeover is active on this machine'],
  [pre.takeoverPending === true, 'CONTROL D: the control layer reports takeoverPending'],
  [/halted|mayInject=false/.test(posJson), 'CONTROL D: the audit records the action as halted'],

  // --- the measurement
  [measured.inputOccurred === true, 'MEASURED: a real injected event occurred'],
  [measured.operatorGenerated === true, 'MEASURED: the control layer attributed it to the operator'],
  [measured.humanGenerated === false, 'MEASURED: it was not attributed to the human'],
  [measured.attributionProven === true, 'MEASURED: the attribution is provable, on the keyboard path'],
  [post.mouseTaggedSeen === 0 && post.mouseUntaggedSeen > 0, 'MEASURED: the mouse tagging defect is reproduced'],
  [mouseVerdict.verdict === 'attribution-defective', 'MEASURED: the mouse path reports attribution-defective'],
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