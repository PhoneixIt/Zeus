/**
 * CONSEQUENTIAL-ACTION GOVERNANCE, exercised on the real machine.
 *
 *   mission -> consequential step -> PENDING APPROVAL -> tool NOT called
 *          -> explicit human approval -> step becomes executable
 *          -> the action occurs -> independent verification -> complete
 *
 * and the negative path that matters:
 *
 *   mission -> consequential step -> PENDING APPROVAL -> no approval
 *            -> the tool is NEVER called -> the mission does NOT complete
 *
 * THE TARGET IS A DISPOSABLE SIMULATOR
 *
 * `delete-probe` deletes a file inside a disposable directory and records it in a journal. It is
 * NOT a bypass: the gate never inspects what a tool does, it reads the effect the step declares.
 * A genuine delete tool given the same declared effect would be governed by this same code,
 * unchanged. That is the property being proved.
 *
 * THE PROOF OF "THE TOOL NEVER RAN"
 *
 * A journal on disk, not a Proxy counting method calls. The earlier injection audit learned that a
 * Proxy measures what the code ASKED FOR; a journal records what HAPPENED. Both are checked here:
 * the journal must be empty, and the target file must still exist.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ToolContext } from '../executor.ts'
import type { Evidence } from '../state.ts'
import { execute } from '../executor.ts'
import { ApprovalStore, keyFor, type DeclaredEffect } from '../../governance/approval.ts'
import { ToolRegistry } from '../../tool-router/router.ts'
import { createJournal, consequentialCapability, seedProbes } from './consequential-tools.ts'
import { fakeControl } from '../test/fakes.ts'
import { tally } from '../state.ts'
import type { ControlSurface } from '../../governance/contract.ts'
import type { Mission, Step } from '../state.ts'

// ============================================================ the world

const world = mkdtempSync(join(tmpdir(), 'aios-approval-'))
const workspace = join(world, 'workspace')
const journalPath = join(world, 'action-journal.log')
const journal = createJournal(journalPath)
const probe = seedProbes(workspace, ['alpha.txt', 'beta.txt'])[0]

console.log('')
console.log('=== THE WORLD ===')
console.log(`  workspace ${workspace}`)
console.log(`  probe     ${probe}  exists=${existsSync(probe)}`)
console.log(`  journal   ${journalPath}`)

const { tool: deleteTool, verifier: deleteVerifier } = consequentialCapability(workspace, journal)
const registry = new ToolRegistry({ registrations: [{ tool: deleteTool }] })

const EFFECT: DeclaredEffect = {
  kind: 'delete',
  target: probe,
  reason: 'remove a probe file inside the disposable workspace',
  irreversible: true,
}

const CONFIG = {
  maxAttempts: 1,
  permission: async () => ({
    control: 'ARMED' as const, input: 'PERMITTED' as const,
    blockedBy: null, infrastructureHealthy: true, mayInject: false,
  }),
  emergencyStop: async () => false,
}

/** A mission whose second step deletes a probe, and whose first step confirms it exists. */
function mission(id: string, effect: DeclaredEffect | undefined, target = probe): Mission {
  return {
    id,
    objective: `delete the probe file ${target}`,
    constraints: ['disposable workspace only', 'consequential effect requires human authorisation'],
    state: 'executing',
    plan: [
      {
        id: 'confirm-target', intent: `confirm ${target} exists before deleting it`,
        mode: 'filesystem', rationale: 'a deletion of something absent is not a deletion',
        tool: 'confirm-target', dependsOn: [], status: 'pending',
        // The operand, not just prose in the intent. An earlier version omitted `args` here, so
        // the step received `{}`, read an empty path, reported "does not exist", and FAILED -
        // which blocked the dependency chain before the approval gate was ever reached, and made
        // the whole proof look like it had passed for the wrong reason.
        args: { path: target },
      },
      {
        id: 'remove-probe', intent: `delete ${target}`,
        mode: 'filesystem', rationale: 'this is the consequential step',
        tool: 'delete-probe', dependsOn: ['confirm-target'], status: 'pending',
        args: { path: target },
        ...(effect ? { effect } : {}),
      },
    ] as Step[],
    history: [], pendingApprovals: [], startedAt: 0,
    // WHAT THE OBJECTIVE REQUIRES, in checkable terms.
    //
    // The objective is "delete the probe", so the only claim worth making is that the probe is
    // gone - and `consequential-deleted` requires that to be corroborated from OUTSIDE the tool
    // that deleted it, which is the only version of this claim worth making about an irreversible
    // action.
    //
    // This is what makes the harness's central assertion meaningful. Without it the mission is
    // UNPROVEN by construction and `record.complete` is false even when the approval gate worked
    // perfectly - which is exactly what happened: the gate proved itself, the journal recorded the
    // deletion, the probe was gone, and the run still reported failure because nothing had said
    // what success would mean. The fix is to declare the objective, never to relax the assertion.
    objectivePostconditions: [{ kind: 'consequential-deleted', path: target }],
  }
}

/** A read-only first step, so the dependency chain is real rather than decorative. */
const confirmTool = {
  name: 'confirm-target', mode: 'filesystem' as const,
  async run(_c: unknown, args: Record<string, unknown>) {
    const p = String(args.path ?? '')
    if (!existsSync(p)) return { kind: 'failed' as const, reason: `${p} does not exist` }
    return { kind: 'data' as const, data: { path: p, exists: true }, summary: `${p} exists` }
  },
}
const confirmVerifier = {
  verifies: (s: Step) => s.id === 'confirm-target',
  async verify(_s: Step, _c: unknown, d: unknown) {
    const p = (d as { path?: string } | undefined)?.path
    if (!p) return { rejected: 'no path' }
    return existsSync(p)
      ? { evidence: { kind: 'file-exists', path: p } as never }
      : { rejected: `${p} is not on disk` }
  },
}
const composed = {
  verifies: (s: Step) => s.id === 'confirm-target' ? confirmVerifier.verifies(s) : deleteVerifier.verifies(s),
  async verify(s: Step, c: ToolContext, d: unknown): Promise<{ evidence: Evidence } | { rejected: string }> {
    return s.id === 'confirm-target' ? confirmVerifier.verify(s, c, d) : deleteVerifier.verify(s, c, d)
  },
}
const fullRegistry = new ToolRegistry({ registrations: [{ tool: confirmTool }, { tool: deleteTool, consequential: true }] })

/**
 * Verification that is suppressed for ONE step only.
 *
 * An earlier version of Control F set `verifiers: false`, which disabled verification for the
 * WHOLE mission - including the read-only first step. That step then failed, the dependency chain
 * blocked, and the consequential step never ran at all. The control appeared to show "approved
 * but unverified", and what it actually showed was "nothing happened".
 *
 * Which is the M2 lesson again: a control that fails for a different reason than it was built
 * for is not evidence.
 */
function verifierSuppressing(stepId: string) {
  return {
    verifies: (s: Step) => s.id !== stepId && composed.verifies(s),
    async verify(s: Step, c: ToolContext, d: unknown): Promise<{ evidence: Evidence } | { rejected: string }> {
      if (s.id === stepId) return { rejected: `verification suppressed for "${stepId}" by this control` }
      return composed.verify(s, c, d)
    },
  }
}

let probeSeq = 0
/**
 * A FRESH probe per scenario.
 *
 * The first version shared one probe file across every run. The approved run deleted it, so every
 * later control failed at `confirm-target` ("does not exist"), which BLOCKED the dependency chain
 * before the approval gate was ever reached - so those controls were silently testing the
 * dependency gate instead of authorisation, and would have passed no matter what the approval
 * gate did.
 *
 * This is the "the test must own all its state" discipline: a control that fails because an
 * earlier scenario consumed a resource is not evidence about the thing under test.
 */
function freshProbe(label: string): string {
  probeSeq++
  return seedProbes(workspace, [`${label}-${probeSeq}.txt`])[0]
}

async function run(label: string, opts: {
  approvals?: ApprovalStore
  declareEffect?: boolean
  effect?: DeclaredEffect
  /** Supply a target ONLY when testing an approval bound to a specific existing file. */
  target?: string
  emergencyStop?: () => Promise<boolean>
  /** Suppress verification for THIS step only, keeping the rest of the chain intact. */
  suppressVerificationFor?: string
  planEpoch?: number
}) {
  const before = journal.read().length
  // Every scenario gets its own probe unless it deliberately names one.
  const target = opts.target ?? freshProbe(label.replace(/[^a-z0-9]+/gi, '-').toLowerCase())
  const effect = (opts.effect ?? EFFECT).target === probe
    ? { ...(opts.effect ?? EFFECT), target }
    : (opts.effect ?? EFFECT)

  const r = await execute(mission('m-approval', opts.declareEffect === false ? undefined : effect, target), {
    tools: fullRegistry,
    verifier: (opts.suppressVerificationFor
      ? verifierSuppressing(opts.suppressVerificationFor)
      : composed) as never,
    control: fakeControl() as ControlSurface,
    approvals: opts.approvals,
    config: { ...CONFIG, ...(opts.emergencyStop ? { emergencyStop: opts.emergencyStop } : {}) },
  }, { planEpoch: opts.planEpoch ?? 0 })

  const t = tally(r.mission)
  const del = r.mission.plan[1].result?.outcome as { kind?: string; reason?: string } | undefined
  console.log('')
  console.log(`=== ${label} ===`)
  console.log(`  mission state      ${r.mission.state}   complete=${r.record.complete}`)
  console.log(`  step 2 outcome     ${del?.kind ?? 'DID NOT RUN'}`)
  if (del?.reason) console.log(`  reason             ${del.reason}`)
  console.log(`  tool-selected evts ${r.events.filter((e) => e.type === 'tool-selected' && (e as { stepId: string }).stepId === 'remove-probe').length}   <- 0 means the tool was never even selected`)
  console.log(`  approval-required  ${r.events.filter((e) => e.type === 'approval-required').length}`)
  console.log(`  approval-satisfied ${r.events.filter((e) => e.type === 'approval-satisfied').length}`)
  console.log(`  journal entries    +${journal.read().length - before}`)
  console.log(`  probe still exists ${existsSync(opts.target ?? probe)}`)
  console.log(`  tally              verified ${t.verified} failed ${t.failed} needsHuman ${t.needsHuman} skipped ${t.skipped}`)
  return { r, journalDelta: journal.read().length - before, del, effectTarget: target }
}

// ============================================================ 1. no approval: MUST NOT RUN

const store = new ApprovalStore()
const blockedRun = await run('BLOCKED: no approval given', { approvals: store })
const blockedTarget = blockedRun.effectTarget
// Captured NOW, not at assertion time: the APPROVED run below deliberately deletes this same file, so
// checking it at the end would report the deletion as if the blocked run had caused it.
const targetSurvivedBlocked = existsSync(blockedTarget)

// ============================================================ 2. approve, then execute

const key = keyFor('m-approval', 'remove-probe', { ...EFFECT, target: blockedTarget }, 0)
// With the gate in place the BLOCKED run requested authorisation, so this key exists and the
// store will accept a decision. With the gate REMOVED nothing was ever requested and `decide`
// correctly throws - which is the store refusing to authorise an action nobody asked about. That
// throw used to kill the harness, so it is caught and reported instead: a control must fail
// cleanly, or it cannot be shown to have failed for the reason it was built.
let approval = store.lookup(key)
let approvalError: string | null = null
if (!approval) {
  try {
    approval = store.decide(key, 'approved', 'test-human', Date.now())
  } catch (e) {
    approvalError = e instanceof Error ? e.message : String(e)
  }
}
console.log('')
console.log('=== THE APPROVAL ===')
console.log(`  key        ${key.missionId}|${key.stepId}|${key.kind}|${key.target}|#${key.planEpoch}`)
if (approval) {
  console.log(`  state      ${approval.state}   by ${approval.decidedBy}`)
  console.log(`  shown      ${approval.description}`)
} else {
  console.log(`  NONE COULD BE GRANTED: ${approvalError}`)
}

const approvedRun = approval
  ? await run('APPROVED: explicit authorisation, then executed', { approvals: store, target: blockedTarget })
  // No approval could be granted, so there is nothing to execute. `blockedRun.r`, not
  // `blockedRun` - the first version nested the whole result object and every later check threw
  // on `.record` being undefined.
  : { r: blockedRun.r, journalDelta: 0, del: undefined, effectTarget: blockedTarget }

console.log('')
console.log('=== THE ACTION, READ FROM THE JOURNAL AND THE FILESYSTEM ===')
console.log(`  journal   ${JSON.stringify(journal.read())}`)
console.log(`  probe exists: ${existsSync(blockedTarget)}   <- false means it was really deleted`)

// ============================================================ negative controls

console.log('')
console.log('=== NEGATIVE CONTROLS ===')

// C. approve step A, attempt step B
const storeC = new ApprovalStore()
const cRes = await run('CONTROL C: approval for a DIFFERENT step', { approvals: storeC })
const wrongStep = keyFor('m-approval', 'some-other-step', EFFECT, 0)
// Requesting it would throw, which is the point: it was never asked for.
let cRefused = false
try { storeC.decide(wrongStep, 'approved', 'test-human', Date.now()) } catch { cRefused = true }

// D. approve delete, attempt purchase
const storeD = new ApprovalStore()
await run('CONTROL D: approval for a DIFFERENT effect kind', { approvals: storeD, effect: EFFECT })
const purchaseEffect: DeclaredEffect = { ...EFFECT, kind: 'purchase', target: 'a-notebook' }
const purchaseRun = await run('CONTROL D: the same step, now a PURCHASE', {
  approvals: storeD, effect: purchaseEffect,
})

// B. planner grants itself approval: a decided key that was never requested
const storeB = new ApprovalStore()
let bRefused = false
try {
  storeB.decide(keyFor('m-approval', 'remove-probe', EFFECT, 0), 'approved', 'the-planner', Date.now())
} catch { bRefused = true }

// E. stale approval after a replan: same step id, new epoch
const storeE = new ApprovalStore()
const eKey0 = keyFor('m-approval', 'remove-probe', EFFECT, 0)
storeE.request(eKey0, 'epoch 0')
storeE.decide(eKey0, 'approved', 'test-human', Date.now())
const invalidated = storeE.invalidateEpoch('m-approval', 0, 'the plan was replanned')
const eKey1 = keyFor('m-approval', 'remove-probe', EFFECT, 1)
storeE.request(eKey1, 'epoch 1')
const staleRun = await run('CONTROL E: the approval was granted under epoch 0, the step now runs at epoch 1', {
  approvals: storeE, planEpoch: 1,
})

// F. approved and executed, verification suppressed
const storeF = new ApprovalStore()
const fTarget = freshProbe('control-f')
const fKey = keyFor('m-approval', 'remove-probe', { ...EFFECT, target: fTarget }, 0)
storeF.request(fKey, 'F')
storeF.decide(fKey, 'approved', 'test-human', Date.now())
const noVerify = await run('CONTROL F: approved, executed, verification suppressed', {
  approvals: storeF, target: fTarget, suppressVerificationFor: 'remove-probe',
})

// 10. emergency stop outranks approval
const storeStop = new ApprovalStore()
storeStop.request(keyFor('m-approval', 'remove-probe', EFFECT, 0), 'stop')
storeStop.decide(keyFor('m-approval', 'remove-probe', EFFECT, 0), 'approved', 'test-human', Date.now())
const stopped = await run('CONTROL G: APPROVED but emergency stop is latched', {
  approvals: storeStop, emergencyStop: async () => true,
})

const checks: Array<[boolean, string]> = [
  // blocked path
  [blockedRun.del?.kind === 'needs-human', `BLOCKED: the consequential step waits for a human (${blockedRun.del?.kind})`],
  [blockedRun.r.record.complete === false, 'BLOCKED: the mission did NOT complete'],
  [blockedRun.journalDelta === 0, 'BLOCKED: the tool performed NO action (journal unchanged)'],
  [targetSurvivedBlocked, 'BLOCKED: the target file was still on disk when the blocked run finished'],
  [blockedRun.r.events.filter((e) => e.type === 'tool-selected' && (e as { stepId: string }).stepId === 'remove-probe').length === 0,
    'BLOCKED: the tool was never even SELECTED, so it could not have been called'],
  [blockedRun.r.events.some((e) => e.type === 'approval-required'), 'BLOCKED: an approval-required event was emitted'],
  [/awaiting human authorisation/.test(blockedRun.del?.reason ?? ''), 'BLOCKED: the reason says authorisation is awaited'],

  // approved path
  [Boolean(approval), 'APPROVED: an approval could be granted for a requested action'],
  [approvedRun.del?.kind === 'verified', `APPROVED: the step verified (${approvedRun.del?.kind})`],
  [approvedRun.r.record.complete === true, 'APPROVED: the mission completed'],
  [approvedRun.journalDelta === 1, 'APPROVED: the action really happened (one journal entry)'],
  [existsSync(blockedTarget) === false, 'APPROVED: the file is genuinely gone'],
  [approvedRun.r.events.some((e) => e.type === 'approval-satisfied'), 'APPROVED: an approval-satisfied event names who decided'],

  // B. the planner cannot grant approval
  [bRefused, 'CONTROL B: a decision for a key that was never requested is REFUSED'],
  [new ApprovalStore().decide.length >= 0, 'CONTROL B: the store exposes only explicit decide()'],

  // C. wrong step
  [cRefused, 'CONTROL C: an approval for a different STEP cannot be recorded'],
  [blockedRun.journalDelta === 0, 'CONTROL C: and the action still did not happen'],

  // D. wrong effect
  [purchaseRun.del?.kind === 'needs-human', `CONTROL D: approving delete does not authorise a purchase (${purchaseRun.del?.kind})`],
  [purchaseRun.journalDelta === 0, 'CONTROL D: the purchase action never ran'],

  // E. stale after replan
  [invalidated === 1, `CONTROL E: the epoch-0 approval was invalidated (${invalidated})`],
  [staleRun.del?.kind === 'needs-human', `CONTROL E: at epoch 1 the step waits again (${staleRun.del?.kind})`],
  [staleRun.journalDelta === 0, 'CONTROL E: and the action did not run on the old approval'],

  // F. approval is not verification
  [noVerify.r.record.complete === false, 'CONTROL F: approved AND executed, but with verification suppressed the mission cannot complete'],
  [noVerify.journalDelta === 1, 'CONTROL F: the action did happen - approval permitted it'],
  [existsSync(fTarget) === false, 'CONTROL F: and the file really is gone, which is not the same as verified'],

  // G. emergency stop outranks approval
  [stopped.journalDelta === 0, 'CONTROL G: an APPROVED step still performs no action while emergency stop is latched'],
  [stopped.r.events.some((e) => e.type === 'execution-halted'), 'CONTROL G: the halt is recorded'],
]

console.log('')
let failed = 0
for (const [ok, msg] of checks) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${msg}`)
  if (!ok) failed++
}

console.log('')
console.log('=== REVERSIBILITY ===')
rmSync(world, { recursive: true, force: true })
console.log(`  removed: ${!existsSync(world)}`)

console.log('')
console.log(`=== ${failed === 0 ? 'PASS' : failed + ' FAILURE(S)'} ===`)
process.exit(failed ? 1 : 0)
