import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error Node test runner loads the TypeScript source directly.
import { attribute, auditAction, isProofOfAction, readHookDiagnostics, readRecord, type ControlRecord, type RecordSource } from '../live/injection-audit.ts'
// @ts-expect-error Node test runner loads the TypeScript source directly.
import { falsifyingRecordGuiTool, guiTool, guiVerifier, lyingGuiTool } from '../live/gui-mode.ts'
// @ts-expect-error Node test runner loads the TypeScript source directly.
import type { ToolContext } from '../executor.ts'

/**
 * The audit contract, tested against a synthetic control layer.
 *
 * The contract exists to keep four claims apart:
 *
 *   A  did input occur?   B  was it operator-generated?   C  was it human-generated?
 *   D  can attribution be proven?
 *
 * The failure this file exists to prevent is any of those being silently converted into
 * another - most dangerously A being read as success, and an unknown actor being rounded to
 * "human" because that is the safe-sounding answer.
 */

/** A complete record with everything at zero, so each test changes only what it is testing. */
const rec = (over: Partial<ControlRecord> = {}): ControlRecord => ({
  state: 'ARMED', mayInject: true, inputPermission: 'PERMITTED', blockingReason: null,
  emergencyLatched: false, takeoverPending: false,
  humanEvents: 100, operatorEvents: 10, otherInjected: 0,
  keyboardHookInstalled: true, mouseHookInstalled: true, hookThreadAlive: true,
  mouseEventsSeen: 500, mouseTaggedSeen: 5, mouseUntaggedSeen: 495,
  panelInjectedSeen: 0, panelTaggedSeen: 0,
  livenessProbes: 3, livenessProbeHits: 3, livenessFailures: 0,
  ...over,
})

/** A control layer that hands back a scripted sequence of records. */
function source(...snapshots: ControlRecord[]): RecordSource & { calls: number } {
  let i = 0
  return {
    calls: 0,
    async guard() { return snapshots[Math.min(i, snapshots.length - 1)] as unknown as Record<string, unknown> },
    async raw(_p: string) {
      const s = snapshots[Math.min(i, snapshots.length - 1)]
      i++
      return { status: 200, body: s as unknown as Record<string, unknown> }
    },
  }
}

// ==================================================== A: did input occur?

test('an operator event is recorded as input that occurred', () => {
  const a = attribute(rec({ operatorEvents: 10 }), rec({ operatorEvents: 11 }), 'keyboard')
  assert.equal(a.inputOccurred, true)
  assert.equal(a.operatorGenerated, true)
  assert.equal(a.verdict, 'operator-proven')
  assert.equal(isProofOfAction(a), true)
})

test('nothing moving is recorded as NO input - a true negative, not a failure', () => {
  const a = attribute(rec(), rec(), 'keyboard')
  assert.equal(a.inputOccurred, false)
  assert.equal(a.verdict, 'no-input')
  assert.equal(isProofOfAction(a), false, 'no input is never proof of an action')
})

test('a mouse event seen by the hook counts as input even when no attribution counter moved', () => {
  // The regression this exists for. Claim A originally consulted only the three attribution
  // counters, so a below-jitter mouse move - which increments `mouseUntaggedSeen` alone -
  // was reported as `no-input`. That is a false negative on the claim that authorises acting.
  const a = attribute(rec(), rec({ mouseEventsSeen: 501, mouseUntaggedSeen: 496 }), 'mouse')
  assert.equal(a.inputOccurred, true, 'the hook saw a real event; the audit must not deny it')
  assert.notEqual(a.verdict, 'no-input')
})

// ==================================================== B, C, D: who, and can we prove it

test('a human event is recorded as human, and is never proof of the operator\'s action', () => {
  const a = attribute(rec({ humanEvents: 100 }), rec({ humanEvents: 101 }), 'keyboard')
  assert.equal(a.humanGenerated, true)
  assert.equal(a.operatorGenerated, false)
  assert.equal(a.verdict, 'human-proven')
  assert.equal(isProofOfAction(a), false, 'a human event is not the operator acting')
})

test('operator and human together is its own state, not a contradiction to tidy up', () => {
  const a = attribute(
    rec({ operatorEvents: 10, humanEvents: 100 }),
    rec({ operatorEvents: 11, humanEvents: 103 }),
    'keyboard',
  )
  assert.equal(a.verdict, 'human-and-operator')
  assert.equal(a.operatorGenerated, true)
  assert.equal(a.humanGenerated, true)
  assert.match(a.basis, /genuinely active/, 'the basis must say why it cannot be reduced to one actor')
})

test('input from an unidentifiable source is NOT rounded to human or to the operator', () => {
  const a = attribute(rec(), rec({ otherInjected: 1 }), 'keyboard')
  assert.equal(a.inputOccurred, true)
  assert.equal(a.operatorGenerated, false)
  assert.equal(a.humanGenerated, false)
  assert.equal(a.attributionProven, false)
  assert.equal(a.verdict, 'attribution-unproven', 'unknown must stay unknown')
  assert.equal(isProofOfAction(a), false)
})

test('the mouse tagging failure is reported as a DEFECT, not merely as unproven', () => {
  // Distinct because this is measured broken, not missing information. Collapsing the two would
  // understate a known-broken control.
  const a = attribute(
    rec({ mouseTaggedSeen: 0, mouseUntaggedSeen: 5476 }),
    rec({ mouseEventsSeen: 501, mouseTaggedSeen: 0, mouseUntaggedSeen: 5477 }),
    'mouse',
  )
  assert.equal(a.verdict, 'attribution-defective')
  assert.equal(a.attributionProven, false)
  assert.match(a.basis, /dwExtraInfo does not survive/, 'the basis must name the measured cause')
})

test('every verdict states a basis a human can audit', () => {
  const cases: Array<[ControlRecord, ControlRecord, 'keyboard' | 'mouse']> = [
    [rec(), rec(), 'keyboard'],
    [rec({ operatorEvents: 1 }), rec({ operatorEvents: 2 }), 'keyboard'],
    [rec({ humanEvents: 1 }), rec({ humanEvents: 2 }), 'keyboard'],
    [rec(), rec({ otherInjected: 1 }), 'keyboard'],
    [rec({ mouseTaggedSeen: 0 }), rec({ mouseEventsSeen: 9 }), 'mouse'],
  ]
  for (const [a, b, p] of cases) {
    const v = attribute(a, b, p)
    assert.ok(v.basis.length > 10, `verdict ${v.verdict} must carry an auditable basis`)
  }
})

// ==================================================== the takeover is its own state

test('human takeover is represented distinctly and stops the action before it is attempted', async () => {
  const held = rec({
    state: 'HUMAN_TAKEOVER', mayInject: false, inputPermission: 'BLOCKED',
    blockingReason: 'human takeover detected; input suspended', takeoverPending: true,
  })
  let performed = false
  const audit = await auditAction(
    source(held),
    { missionId: 'm1', stepId: 's1', executionMode: 'gui', actionType: 'click-absolute', target: 'screen(4,4)', path: 'mouse' },
    async () => { performed = true; return { ok: true } },
  )
  assert.equal(performed, false, 'a takeover must stop the action, not follow it')
  assert.equal(audit.result, 'refused-by-guard')
  assert.equal(audit.halted, true)
  assert.equal(audit.takeoverActive, true)
  assert.equal(audit.injected, 'no')
  assert.equal(audit.attribution.verdict, 'no-input')
  assert.match(audit.blockingReason ?? '', /human takeover/)
})

test('an emergency latch is recorded separately from a takeover', async () => {
  const latched = rec({
    state: 'EMERGENCY_STOP', mayInject: false, inputPermission: 'BLOCKED',
    emergencyLatched: true, blockingReason: 'emergency stop latched',
  })
  const audit = await auditAction(
    source(latched),
    { missionId: 'm', stepId: 's', executionMode: 'gui', actionType: 'click-absolute', target: 't', path: 'mouse' },
    async () => ({ ok: true }),
  )
  assert.equal(audit.emergencyLatched, true)
  assert.equal(audit.takeoverActive, false, 'a latch is not a takeover and must not be reported as one')
})

// ==================================================== the verifier rejects bad claims

const ctx = { missionId: 'm', stepId: 's', attempt: 1 } as unknown as ToolContext
const goodAudit = (over: Record<string, unknown> = {}) => ({
  missionId: 'm', stepId: 's', executionMode: 'gui', actionType: 'click-absolute',
  target: 'screen(4,4)', at: 'now', controlResponse: { ok: true },
  injected: 'no', controlState: 'ARMED', takeoverActive: false, emergencyLatched: false,
  halted: false, blockingReason: null, result: 'accepted',
  attribution: {
    inputOccurred: false, operatorGenerated: false, humanGenerated: false,
    attributionProven: true, verdict: 'no-input', basis: 'nothing moved',
  },
  ...over,
})

test('a GUI claim with no audit attached is rejected - there is nothing to verify', async () => {
  const v = guiVerifier(source(rec()), { expectInjection: true, baselineOperatorEvents: 0 })
  const out = await v.verify({ mode: 'gui' } as never, ctx, { ok: true, claimed: 'clicked' })
  assert.ok('rejected' in out)
  assert.match((out as { rejected: string }).rejected, /no audit attached/i)
})

test('a tool-reported success alone is insufficient, even with a well-formed audit', async () => {
  // expectInjection true, but the audit says no input occurred. The tool's "ok" is not a claim
  // the verifier accepts on its own.
  const v = guiVerifier(source(rec()), { expectInjection: true, baselineOperatorEvents: 0 })
  const out = await v.verify({ mode: 'gui' } as never, ctx, { ok: true, audit: goodAudit() })
  assert.ok('rejected' in out)
  assert.match((out as { rejected: string }).rejected, /required a real injection/i)
})

test('an UNEXPECTED injection is rejected, not accepted as good news', async () => {
  const v = guiVerifier(source(rec()), { expectInjection: false, baselineOperatorEvents: 0 })
  const out = await v.verify({ mode: 'gui' } as never, ctx, {
    ok: true,
    audit: goodAudit({
      injected: 'yes',
      attribution: {
        inputOccurred: true, operatorGenerated: true, humanGenerated: false,
        attributionProven: true, verdict: 'operator-proven', basis: 'operator +1',
      },
    }),
  })
  assert.ok('rejected' in out)
  assert.match((out as { rejected: string }).rejected, /no injection was expected/i)
})

test('an incorrect actor attribution is rejected against the control layer record', async () => {
  const v = guiVerifier(source(rec()), { expectInjection: true, claimedActor: 'human', baselineOperatorEvents: 0 })
  const out = await v.verify({ mode: 'gui' } as never, ctx, {
    ok: true,
    claimedActor: 'human',
    audit: goodAudit({
      injected: 'yes',
      attribution: {
        inputOccurred: true, operatorGenerated: true, humanGenerated: false,
        attributionProven: true, verdict: 'operator-proven', basis: 'operator +1',
      },
    }),
  })
  assert.ok('rejected' in out)
  assert.match((out as { rejected: string }).rejected, /attributed the action to "human".*says "operator-proven"/s)
})

test('a claim of acceptance while injection is forbidden is rejected as impossible', async () => {
  const forbidden = rec({ state: 'HUMAN_TAKEOVER', mayInject: false, inputPermission: 'BLOCKED', takeoverPending: true })
  const v = guiVerifier(source(forbidden), { expectInjection: true, baselineOperatorEvents: 0 })
  const out = await v.verify({ mode: 'gui' } as never, ctx, {
    ok: true,
    audit: goodAudit({
      injected: 'yes',
      attribution: {
        inputOccurred: true, operatorGenerated: true, humanGenerated: false,
        attributionProven: true, verdict: 'operator-proven', basis: 'operator +1',
      },
    }),
  })
  assert.ok('rejected' in out)
  assert.match((out as { rejected: string }).rejected, /cannot be accepted while injection is forbidden/i)
})

test('an unhealthy hook blocks a self-test attribution, from a real diagnostics read', async () => {
  // Hook health lives only on `/hooks`, which injects. It is therefore checked in the
  // instrumentation branch, where that read's cost is already paid by the action itself.
  // It is deliberately NOT checked from the pure `/guard` record: that path never carries hook
  // fields, so such a check could never fire - and a check that cannot fire is worse than none.
  // Probe counts above the tool's claim, so the probe-hits check passes and the hook-health
// check is genuinely what rejects.
const dying: ControlRecord = { ...rec(), hookThreadAlive: false, livenessProbes: 9, livenessProbeHits: 9 }
  const src: RecordSource = {
    // Always one ahead of the baseline, so the anchored check passes and the health check is
    // genuinely the thing under test.
    async guard() { return rec({ operatorEvents: 11 }) as unknown as Record<string, unknown> },
    async raw() { return { status: 200, body: dying as unknown as Record<string, unknown> } },
  }
  const v = guiVerifier(src, { expectInjection: true, baselineOperatorEvents: 10 })
  const out = await v.verify({ mode: 'gui' } as never, ctx, {
    ok: true,
    audit: goodAudit({
      actionClass: 'instrumentation',
      controlResponse: { ok: true, livenessProbeHits: 5 },
      injected: 'yes',
      attribution: {
        inputOccurred: true, operatorGenerated: true, humanGenerated: false,
        attributionProven: true, verdict: 'operator-proven', basis: 'operator +1',
      },
    }),
  })
  assert.ok('rejected' in out, `expected a rejection, got: ${JSON.stringify(out)}`)
  assert.match((out as { rejected: string }).rejected, /hook is unhealthy|hook is not trustworthy/i)
})

test('a truthful refusal is ACCEPTED, with the record that proves it', async () => {
  const held = rec({ state: 'HUMAN_TAKEOVER', mayInject: false, inputPermission: 'BLOCKED', takeoverPending: true, blockingReason: 'human takeover detected; input suspended' })
  const v = guiVerifier(source(held), { expectInjection: false, baselineOperatorEvents: 0 })
  const out = await v.verify({ mode: 'gui' } as never, ctx, {
    ok: true,
    audit: goodAudit({
      result: 'refused-by-guard', controlState: 'HUMAN_TAKEOVER',
      halted: true, blockingReason: 'human takeover detected; input suspended',
    }),
  })
  assert.ok('evidence' in out, `expected acceptance, got: ${JSON.stringify(out)}`)
  const e = (out as { evidence: { kind: string; detail: string } }).evidence
  assert.equal(e.kind, 'input-attributed')
  assert.match(e.detail, /refused-by-guard/)
  assert.match(e.detail, /HUMAN_TAKEOVER/)
})

test('an unverifiable attribution is accepted only as its OWN evidence kind, never as a pass', async () => {
  // expectInjection TRUE, because the audit does claim input occurred - so the
  // "no injection was expected" guard passes and the attribution branch is what is under test.
  // With expectInjection false this test would be caught by that earlier guard instead, which
  // is correct behaviour but would prove nothing about the evidence kind.
  const v = guiVerifier(source(rec()), { expectInjection: true, baselineOperatorEvents: 0 })
  const out = await v.verify({ mode: 'gui' } as never, ctx, {
    ok: true,
    audit: goodAudit({
      injected: 'yes',
      attribution: {
        inputOccurred: true, operatorGenerated: false, humanGenerated: false,
        attributionProven: false, verdict: 'attribution-unproven', basis: 'other injected +1',
      },
    }),
  })
  assert.ok('evidence' in out, `expected acceptance, got: ${JSON.stringify(out)}`)
  const e = (out as { evidence: { kind: string; verdict?: string } }).evidence
  assert.equal(e.kind, 'input-unattributed', 'unproven attribution must be visibly unproven')
  assert.equal(e.verdict, 'attribution-unproven')
})

// ==================================================== the anchored baseline

test('a tool cannot open the accept path by asserting an operator event', async () => {
  // THE DEFECT THIS MILESTONE FOUND.
  //
  // The first version of the accept path verified a tool that fabricated `injected: yes` and
  // `verdict: operator-proven` without requesting any probe. Every check compared the tool's
  // audit against itself - `audit.injected` against `audit.attribution.inputOccurred`, both
  // from the same forged object - so nothing in-process could catch it.
  //
  // The fix is that the verifier holds an operator-event baseline captured by the HARNESS,
  // outside the tool's reach, and requires the control layer to have recorded more than that.
  const src = source(rec({ operatorEvents: 10 }))   // nothing happened: still exactly 10
  const v = guiVerifier(src, { expectInjection: true, baselineOperatorEvents: 10 })
  const out = await v.verify({ mode: 'gui' } as never, ctx, {
    ok: true,
    actionClass: 'instrumentation',
    audit: goodAudit({
      actionClass: 'instrumentation',
      result: 'accepted',
      injected: 'yes',
      controlResponse: { ok: true, livenessProbeHits: 1 },
      attribution: {
        inputOccurred: true, operatorGenerated: true, humanGenerated: false,
        attributionProven: true, verdict: 'operator-proven', basis: 'operator +1',
      },
    }),
  })
  assert.ok('rejected' in out, 'a fabricated operator event must not verify')
  assert.match((out as { rejected: string }).rejected, /pre-step baseline/i)
})

test('the baseline admits a genuine advance and nothing more', async () => {
  const forged = goodAudit({
    actionClass: 'instrumentation', result: 'accepted', injected: 'yes',
    controlResponse: { ok: true, livenessProbeHits: 1 },
    attribution: {
      inputOccurred: true, operatorGenerated: true, humanGenerated: false,
      attributionProven: true, verdict: 'operator-proven', basis: 'operator +1',
    },
  })
  // Exactly at the baseline: no advance, so no proof.
  const same = guiVerifier(source(rec({ operatorEvents: 10 })), { expectInjection: true, baselineOperatorEvents: 10 })
  assert.ok('rejected' in await same.verify({ mode: 'gui' } as never, ctx, { audit: forged }))
  // One past it: the control layer really did record a new operator event.
  const advanced = guiVerifier(source(rec({ operatorEvents: 11, hookThreadAlive: true, keyboardHookInstalled: true, livenessProbes: 9, livenessProbeHits: 9 })), { expectInjection: true, baselineOperatorEvents: 10 })
  const out = await advanced.verify({ mode: 'gui' } as never, ctx, { audit: forged })
  assert.ok('evidence' in out, `a genuine advance must verify, got: ${JSON.stringify(out)}`)
})

test('claiming MORE probes than the control layer ever recorded is rejected', async () => {
  // The comparison was INVERTED in the first version: it rejected claims for being behind and
  // passed claims for being ahead, so a fabricated 999 sailed through while the genuine
  // self-test was rejected for being one behind.
  const src = source(rec({ operatorEvents: 11, livenessProbes: 9, livenessProbeHits: 9 }))
  const v = guiVerifier(src, { expectInjection: true, baselineOperatorEvents: 10 })
  const out = await v.verify({ mode: 'gui' } as never, ctx, {
    audit: goodAudit({
      actionClass: 'instrumentation', result: 'accepted', injected: 'yes',
      controlResponse: { ok: true, livenessProbeHits: 999 },
      attribution: {
        inputOccurred: true, operatorGenerated: true, humanGenerated: false,
        attributionProven: true, verdict: 'operator-proven', basis: 'operator +1',
      },
    }),
  })
  assert.ok('rejected' in out, 'claiming an event the control layer never saw must not verify')
  assert.match((out as { rejected: string }).rejected, /only ever recorded 9/)
})

test('a claim legitimately behind the verifier read is accepted, not penalised', async () => {
  // The verifier's own diagnostics read injects a probe, so the control layer's count is
  // normally AHEAD of what the tool saw. Treating that as an error would reject every genuine
  // self-test - which is exactly what the inverted check did.
  const src = source(rec({ operatorEvents: 11, livenessProbes: 40, livenessProbeHits: 40 }))
  const v = guiVerifier(src, { expectInjection: true, baselineOperatorEvents: 10 })
  const out = await v.verify({ mode: 'gui' } as never, ctx, {
    audit: goodAudit({
      actionClass: 'instrumentation', result: 'accepted', injected: 'yes',
      controlResponse: { ok: true, livenessProbeHits: 39 },
      attribution: {
        inputOccurred: true, operatorGenerated: true, humanGenerated: false,
        attributionProven: true, verdict: 'operator-proven', basis: 'operator +1',
      },
    }),
  })
  assert.ok('evidence' in out, `a legitimate one-behind claim must verify, got: ${JSON.stringify(out)}`)
})

// ==================================================== the action class

test('a user action is refused while injection is forbidden, even when classed as one', async () => {
  const held = rec({ state: 'HUMAN_TAKEOVER', mayInject: false, takeoverPending: true })
  const audit = await auditAction(
    source(held),
    { missionId: 'm', stepId: 's', executionMode: 'gui', actionType: 'click-absolute', target: 't', path: 'mouse' },
    async () => ({ ok: true }),
  )
  assert.equal(audit.actionClass, 'user-action', 'the default must be the strict class')
  assert.equal(audit.result, 'refused-by-guard')
})

test('instrumentation is NOT gated by mayInject, and must name itself to get that treatment', async () => {
  const held = rec({ state: 'HUMAN_TAKEOVER', mayInject: false, takeoverPending: true })
  let ran = false
  const audit = await auditAction(
    source(held, rec({ operatorEvents: 11 })),
    {
      missionId: 'm', stepId: 's', executionMode: 'gui',
      actionType: 'hook-liveness-probe', target: 'none', path: 'keyboard',
      actionClass: 'instrumentation', settleMs: 0,
    },
    async () => { ran = true; return { ok: true } },
  )
  assert.equal(ran, true, 'the watchdog must still be able to check itself')
  assert.equal(audit.actionClass, 'instrumentation')
})

// ==================================================== the pure / the injecting

test('a real GUI tool reports a refusal as needing a human, never as data', async () => {
  // The defect this catches: an earlier version returned `data` on refusal, the verifier
  // correctly found the record truthful, and the step was marked verified - so a mission whose
  // click never happened read as `complete`.
  const held = rec({ state: 'HUMAN_TAKEOVER', mayInject: false, inputPermission: 'BLOCKED', takeoverPending: true, blockingReason: 'human takeover detected; input suspended' })
  const out = await guiTool(source(held)).run(ctx, {})
  assert.equal(out.kind, 'needs-human', 'a refusal is not a completion')
  assert.match((out as { reason: string }).reason, /This step did not perform its action/)
})

test('the lying tool produces a claim with no audit - structurally unverifiable', async () => {
  const out = await lyingGuiTool.run(ctx, {})
  assert.equal(out.kind, 'data')
  const d = (out as { data: { audit?: unknown } }).data
  assert.equal(d.audit, undefined, 'no audit means nothing to verify')
})

test('the falsifying tool forges an audit the verifier must catch', async () => {
  const held = rec({ state: 'HUMAN_TAKEOVER', mayInject: false, inputPermission: 'BLOCKED', takeoverPending: true })
  const out = await falsifyingRecordGuiTool(source(held)).run(ctx, {})
  assert.equal(out.kind, 'data')
  const audit = (out as { data: { audit: { result: string } } }).data.audit
  assert.equal(audit.result, 'accepted', 'the tool claims acceptance')
  const v = guiVerifier(source(held), { expectInjection: true, baselineOperatorEvents: 0 })
  const verdict = await v.verify({ mode: 'gui' } as never, ctx, (out as { data: unknown }).data)
  assert.ok('rejected' in verdict, 'the forgery must not survive verification')
})

// ==================================================== record hygiene

test('every audit is tied to the mission and step it claims', async () => {
  const audit = await auditAction(
    source(rec()),
    { missionId: 'mission-42', stepId: 'step-7', executionMode: 'gui', actionType: 'click-absolute', target: 'screen(1,1)', path: 'mouse' },
    async () => ({ ok: true }),
  )
  assert.equal(audit.missionId, 'mission-42')
  assert.equal(audit.stepId, 'step-7')
  assert.equal(audit.executionMode, 'gui')
  assert.equal(audit.actionType, 'click-absolute')
})

test('the record reader treats an absent counter as zero rather than undefined', async () => {
  const partial: RecordSource = {
    async guard() { return { state: 'ARMED', mayInject: true } },
    async raw() { return { status: 200, body: {} } },
  }
  const r = await readRecord(partial)
  assert.equal(r.operatorEvents, 0)
  assert.equal(r.humanEvents, 0)
  assert.equal(r.mouseTaggedSeen, 0)
  assert.equal(r.mayInject, true)
})

test('readRecord does NOT touch /hooks, because that route injects', async () => {
  // The measurement that forced this split: eight `/hooks` reads advanced `livenessProbes` by
  // 7. An audit that bracketed its actions with that route would have measured its own side
  // effect and reported `operator-proven` for a keystroke it caused itself.
  let hookReads = 0
  const src: RecordSource = {
    async guard() { return rec({ operatorEvents: 10 }) as unknown as Record<string, unknown> },
    async raw() { hookReads++; return { status: 200, body: {} } },
  }
  for (let i = 0; i < 5; i++) await readRecord(src)
  assert.equal(hookReads, 0, 'the pure reader must never call an injecting route')
})

test('readHookDiagnostics reports what its own read cost', async () => {
  let n = 0
  const src: RecordSource = {
    async guard() { n++; return rec({ operatorEvents: 10 + n }) as unknown as Record<string, unknown> },
    async raw() { return { status: 200, body: rec({ livenessProbes: 5, livenessProbeHits: 5 }) as unknown as Record<string, unknown> } },
  }
  const out = await readHookDiagnostics(src)
  assert.equal(out.probesAdvanced, 1, 'the diagnostics read must account for the probe it caused')
  assert.equal(out.diagnostics.livenessProbeHits, 5)
})