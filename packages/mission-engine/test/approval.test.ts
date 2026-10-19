import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ApprovalStore, effectKey, keyFor, type DeclaredEffect } from '../../governance/approval.ts'
import { execute } from '../executor.ts'
import { ToolRegistry } from '../../tool-router/router.ts'
import { createJournal, consequentialCapability, seedProbes } from '../live/consequential-tools.ts'
import { fakeControl } from './fakes.ts'
import type { Mission, Step } from '../state.ts'
import type { ControlSurface } from '../../governance/contract.ts'

/**
 * The approval contract, and the executor's enforcement of it.
 *
 * The invariant under test: A CONSEQUENTIAL STEP MUST NEVER EXECUTE WITHOUT AN EXPLICIT
 * AUTHORISATION FOR THAT SPECIFIC ACTION.
 *
 * Every test that exercises the executor uses its OWN disposable world and its OWN journal, and
 * reads the journal rather than counting method calls - because a Proxy measures intent and this
 * project has already been caught by that once.
 */

const CONFIG = {
  maxAttempts: 1,
  permission: async () => ({
    control: 'ARMED' as const, input: 'PERMITTED' as const,
    blockedBy: null, infrastructureHealthy: true, mayInject: false,
  }),
  emergencyStop: async () => false,
}

function world() {
  const root = mkdtempSync(join(tmpdir(), 'aios-approval-test-'))
  const ws = join(root, 'ws')
  const journal = createJournal(join(root, 'journal.log'))
  const probe = seedProbes(ws, ['p.txt'])[0]
  const cap = consequentialCapability(ws, journal)
  // Registered as CONSEQUENTIAL so the gate can require a declaration. A consequence of the
  // IMPLEMENTATION, not of the plan - which is the whole point.
  const registry = new ToolRegistry({ registrations: [{ tool: cap.tool, consequential: true }] })
  const effect: DeclaredEffect = { kind: 'delete', target: probe, reason: 'test', irreversible: true }
  const mission = (e: DeclaredEffect | undefined): Mission => ({
    id: 'm1', objective: 'delete the probe', constraints: [], state: 'executing',
    plan: [{
      id: 'remove', intent: 'delete the probe', mode: 'filesystem',
      rationale: 'consequential', tool: 'delete-probe', dependsOn: [], status: 'pending',
      args: { path: probe }, ...(e ? { effect: e } : {}),
    }] as Step[],
    history: [], pendingApprovals: [], startedAt: 0,
    // The objective IS "delete the probe", so the check is that the probe is gone - corroborated from
    // outside the tool that deleted it, which is the only version of this claim worth making about an
    // irreversible action. Declared here rather than left implicit, because an approval test that
    // passed on an unverified objective would be testing the gate and not the action.
    objectivePostconditions: [{ kind: 'consequential-deleted', path: probe }],
  })
  return { root, ws, journal, probe, cap, registry, effect, mission }
}

const cleanup = (w: ReturnType<typeof world>) => rmSync(w.root, { recursive: true, force: true })

// ==================================================== the key

test('an approval key distinguishes every component that matters', () => {
  const base = keyFor('m1', 's1', { kind: 'delete', target: '/a', reason: '', irreversible: true }, 0)
  const variants = [
    keyFor('m2', 's1', { kind: 'delete', target: '/a', reason: '', irreversible: true }, 0),
    keyFor('m1', 's2', { kind: 'delete', target: '/a', reason: '', irreversible: true }, 0),
    keyFor('m1', 's1', { kind: 'purchase', target: '/a', reason: '', irreversible: true }, 0),
    keyFor('m1', 's1', { kind: 'delete', target: '/b', reason: '', irreversible: true }, 0),
    keyFor('m1', 's1', { kind: 'delete', target: '/a', reason: '', irreversible: true }, 1),
  ]
  const keys = new Set(variants.map(effectKey))
  assert.equal(keys.size, variants.length, 'every component must change the key')
  assert.equal(keys.has(effectKey(base)), false)
})

// ==================================================== the store

test('a decision for a key that was never requested is REFUSED', () => {
  // This is what makes "the planner grants itself approval" impossible: the planner has no
  // reference to the store, and even if it could, nothing was ever asked for.
  const s = new ApprovalStore()
  assert.throws(
    () => s.decide(keyFor('m1', 's', { kind: 'delete', target: '/a', reason: '', irreversible: true }, 0), 'approved', 'the-planner', 1),
    /was ever requested|never requested/,
  )
})

test('an approval does not carry to a different step, effect, target, mission or epoch', () => {
  const s = new ApprovalStore()
  const e = { kind: 'delete', target: '/a', reason: '', irreversible: true } as const
  const granted = keyFor('m1', 's1', e, 0)
  s.request(granted, 'delete /a')
  s.decide(granted, 'approved', 'human', 1)

  assert.equal(s.permits(granted), true, 'the exact key is permitted')
  for (const [what, other] of [
    ['mission', keyFor('m2', 's1', e, 0)],
    ['step', keyFor('m1', 's2', e, 0)],
    ['effect', keyFor('m1', 's1', { ...e, kind: 'purchase' }, 0)],
    ['target', keyFor('m1', 's1', { ...e, target: '/b' }, 0)],
    ['epoch', keyFor('m1', 's1', e, 1)],
  ] as const) {
    assert.equal(s.permits(other), false, `an approval must not carry to a different ${what}`)
  }
})

test('there is no "similar" or "previously approved" fallback', () => {
  const s = new ApprovalStore()
  const e = { kind: 'delete', target: '/a', reason: '', irreversible: true } as const
  const k = keyFor('m1', 's1', e, 0)
  s.request(k, 'x')
  s.decide(k, 'approved', 'human', 1)
  // A target that merely shares a prefix, and one that merely shares a stem.
  for (const t of ['/a/sub', '/ab', '/a.txt']) {
    assert.equal(s.permits(keyFor('m1', 's1', { ...e, target: t }, 0)), false,
      `"${t}" must not be treated as similar to "/a"`)
  }
})

test('a rejection is not an approval', () => {
  const s = new ApprovalStore()
  const k = keyFor('m1', 's', { kind: 'delete', target: '/a', reason: '', irreversible: true }, 0)
  s.request(k, 'x')
  s.decide(k, 'rejected', 'human', 1)
  assert.equal(s.permits(k), false)
  assert.equal(s.lookup(k)?.state, 'rejected')
})

test('invalidating an epoch revokes only that epoch', () => {
  const s = new ApprovalStore()
  const e = { kind: 'delete', target: '/a', reason: '', irreversible: true } as const
  const k0 = keyFor('m1', 's', e, 0)
  s.request(k0, 'x'); s.decide(k0, 'approved', 'human', 1)
  const n = s.invalidateEpoch('m1', 0, 'replanned')
  assert.equal(n, 1)
  assert.equal(s.permits(k0), false, 'the epoch-0 approval must no longer permit')
  assert.match(s.lookup(k0)!.decidedBy, /invalidated/, 'the revocation must be recorded in the decision')
})

test('outstanding approvals are listed so a human can see what is being asked', () => {
  const s = new ApprovalStore()
  const k = keyFor('m1', 's', { kind: 'delete', target: '/a', reason: 'because', irreversible: true }, 0)
  s.request(k, 'delete /a: because')
  assert.equal(s.outstanding().length, 1)
  assert.match(s.outstanding()[0].description, /because/)
  s.decide(k, 'approved', 'human', 1)
  assert.equal(s.outstanding().length, 0)
  assert.equal(s.decisions().length, 1, 'but the decision is retained for audit')
})

// ==================================================== the executor gate

test('an unapproved consequential step does not run, and the tool is never selected', async () => {
  const w = world()
  try {
    const s = new ApprovalStore()
    const r = await execute(w.mission(w.effect), {
      tools: w.registry, verifier: w.cap.verifier,
      control: fakeControl() as ControlSurface, approvals: s, config: CONFIG,
    })
    assert.equal(r.mission.plan[0].result!.outcome.kind, 'needs-human')
    assert.equal(r.record.complete, false, 'a pending approval must prevent completion')
    assert.equal(r.events.filter((e) => e.type === 'tool-selected').length, 0, 'the tool must not even be selected')
    assert.equal(r.events.filter((e) => e.type === 'approval-required').length, 1)
    // The world, not an intent count.
    assert.equal(w.journal.read().length, 0, 'no action may have been performed')
    assert.equal(existsSync(w.probe), true, 'the target must be untouched')
  } finally { cleanup(w) }
})

test('an approved consequential step runs and is independently verified', async () => {
  const w = world()
  try {
    const s = new ApprovalStore()
    const k = keyFor('m1', 'remove', w.effect, 0)
    s.request(k, 'delete the probe')
    s.decide(k, 'approved', 'human', 1)
    const r = await execute(w.mission(w.effect), {
      tools: w.registry, verifier: w.cap.verifier,
      control: fakeControl() as ControlSurface, approvals: s, config: CONFIG,
    })
    assert.equal(r.mission.plan[0].result!.outcome.kind, 'verified')
    assert.equal(r.record.complete, true)
    assert.equal(w.journal.read().length, 1, 'the action really happened')
    assert.equal(existsSync(w.probe), false)
    assert.equal(r.events.filter((e) => e.type === 'approval-satisfied').length, 1)
    const sat = r.events.find((e) => e.type === 'approval-satisfied') as unknown as { decidedBy: string }
    assert.equal(sat.decidedBy, 'human', 'who authorised it must be in the audit')
  } finally { cleanup(w) }
})

test('a CONSEQUENTIAL tool with NO declared effect is REFUSED as a plan defect', async () => {
  // Omitting the declaration must not be a way to act. The gate consults the TOOL's
  // registration as well as the plan, so this is a plan defect rather than an unapproved action.
  const w = world()
  try {
    const s = new ApprovalStore()
    const r = await execute(w.mission(undefined), {
      tools: w.registry, verifier: w.cap.verifier,
      control: fakeControl() as ControlSurface, approvals: s, config: CONFIG,
    })
    assert.equal(r.mission.plan[0].result!.outcome.kind, 'failed', 'omitting the declaration must not be a way to act')
    assert.match((r.mission.plan[0].result!.outcome as { reason: string }).reason, /plan defect/)
    assert.equal(r.events.filter((e) => e.type === 'tool-selected').length, 0, 'the tool must not even be selected')
    assert.equal(w.journal.read().length, 0, 'and nothing may have happened')
    assert.equal(existsSync(w.probe), true)
  } finally { cleanup(w) }
})

test('a REFUSED approval blocks the step and says so', async () => {
  const w = world()
  try {
    const s = new ApprovalStore()
    const k = keyFor('m1', 'remove', w.effect, 0)
    s.request(k, 'delete the probe')
    s.decide(k, 'rejected', 'human', 1)
    const r = await execute(w.mission(w.effect), {
      tools: w.registry, verifier: w.cap.verifier,
      control: fakeControl() as ControlSurface, approvals: s, config: CONFIG,
    })
    assert.equal(r.mission.plan[0].result!.outcome.kind, 'needs-human')
    assert.match((r.mission.plan[0].result!.outcome as { reason: string }).reason, /REFUSED/)
    assert.equal(w.journal.read().length, 0)
  } finally { cleanup(w) }
})

test('NO approval store means a consequential step cannot run', async () => {
  // Fail closed. A caller who forgets to supply the authority must not thereby remove it.
  const w = world()
  try {
    const r = await execute(w.mission(w.effect), {
      tools: w.registry, verifier: w.cap.verifier,
      control: fakeControl() as ControlSurface, config: CONFIG,
    })
    assert.equal(r.mission.plan[0].result!.outcome.kind, 'needs-human')
    assert.equal(w.journal.read().length, 0)
    assert.equal(existsSync(w.probe), true)
  } finally { cleanup(w) }
})

// ==================================================== approval vs verification vs safety

test('approval is NOT verification: approved and executed but unverified cannot complete', async () => {
  const w = world()
  try {
    const s = new ApprovalStore()
    const k = keyFor('m1', 'remove', w.effect, 0)
    s.request(k, 'x'); s.decide(k, 'approved', 'human', 1)
    const r = await execute(w.mission(w.effect), {
      tools: w.registry,
      verifier: { verifies: () => false, async verify() { return { rejected: 'verification disabled' } } } as never,
      control: fakeControl() as ControlSurface, approvals: s, config: CONFIG,
    })
    assert.equal(r.record.complete, false, 'a human saying yes is not evidence that it worked')
    // ...and the action really did happen, which is the point: permitted is not the same as proven.
    assert.equal(w.journal.read().length, 1)
    assert.equal(existsSync(w.probe), false)
  } finally { cleanup(w) }
})

test('EMERGENCY STOP outranks an existing approval', async () => {
  const w = world()
  try {
    const s = new ApprovalStore()
    const k = keyFor('m1', 'remove', w.effect, 0)
    s.request(k, 'x'); s.decide(k, 'approved', 'human', 1)
    const r = await execute(w.mission(w.effect), {
      tools: w.registry, verifier: w.cap.verifier,
      control: fakeControl() as ControlSurface, approvals: s,
      config: { ...CONFIG, emergencyStop: async () => true },
    })
    assert.equal(w.journal.read().length, 0, 'an approved action must still not run under emergency stop')
    assert.equal(existsSync(w.probe), true)
    assert.equal(r.events.some((e) => e.type === 'execution-halted'), true)
  } finally { cleanup(w) }
})

test('an approval does not survive a replan of the same step', async () => {
  const w = world()
  try {
    const s = new ApprovalStore()
    const k0 = keyFor('m1', 'remove', w.effect, 0)
    s.request(k0, 'epoch 0'); s.decide(k0, 'approved', 'human', 1)
    s.invalidateEpoch('m1', 0, 'the plan was replanned')

    // Same step id, same effect, new epoch: the plan is materially the same here, but the
    // authorisation no longer matches, so the step waits again.
    const k1 = keyFor('m1', 'remove', w.effect, 1)
    const r = await execute(w.mission(w.effect), {
      tools: w.registry, verifier: w.cap.verifier,
      control: fakeControl() as ControlSurface, approvals: s, config: CONFIG,
    }, { planEpoch: 1 })
    assert.equal(r.mission.plan[0].result!.outcome.kind, 'needs-human')
    assert.equal(w.journal.read().length, 0)
    assert.ok(k1)
  } finally { cleanup(w) }
})

// ==================================================== the simulator cannot escape

test('the simulator refuses any target outside its disposable workspace', async () => {
  const w = world()
  try {
    const outside = join(w.root, 'precious.txt')
    writeFileSync(outside, 'ORIGINAL', 'utf8')
    const r = await w.cap.tool.run({} as never, { path: outside })
    assert.equal(r.kind, 'failed')
    assert.match((r as { reason: string }).reason, /outside the disposable workspace/)
    assert.equal(readFileSync(outside, 'utf8'), 'ORIGINAL', 'nothing outside may be touched')
    assert.equal(w.journal.read().length, 0)
  } finally { cleanup(w) }
})

test('the simulator refuses a directory, so it cannot be aimed at anything structural', async () => {
  const w = world()
  try {
    mkdirSync(join(w.ws, 'adir'), { recursive: true })
    const r = await w.cap.tool.run({} as never, { path: join(w.ws, 'adir') })
    assert.equal(r.kind, 'failed')
    assert.match((r as { reason: string }).reason, /directory/)
    assert.equal(existsSync(join(w.ws, 'adir')), true)
  } finally { cleanup(w) }
})
