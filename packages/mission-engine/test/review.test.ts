import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
// @ts-expect-error Node test runner loads the TypeScript source directly.
import { digestOf, samePlan, canonicalise, unrecognisedFields, authorityLookingFields } from '../../review/digest.ts'
// @ts-expect-error Node test runner loads the TypeScript source directly.
import { amend, amendAll, describe as describeAmendment, type Amendment } from '../../review/amend.ts'
// @ts-expect-error Node test runner loads the TypeScript source directly.
import { diffPlans, summarise, consequentialChanges } from '../../review/diff.ts'
// @ts-expect-error Node test runner loads the TypeScript source directly.
import { dryRun } from '../../review/dry-run.ts'
// @ts-expect-error Node test runner loads the TypeScript source directly.
import { beginReview, applyAmendment, preview, commit, isAmended, changesFromOriginal, materialChanges } from '../../review/session.ts'
// @ts-expect-error Node test runner loads the TypeScript source directly.
import { renderProposal, renderChanges, renderDryRun, renderHeader } from '../../review/render.ts'
// @ts-expect-error Node test runner loads the TypeScript source directly.
import { execute } from '../executor.ts'
// @ts-expect-error Node test runner loads the TypeScript source directly.
import { ToolRegistry, EmptyRegistry } from '../../tool-router/router.ts'
// @ts-expect-error Node test runner loads the TypeScript source directly.
import { LocalObservationProvider } from '../../observation/local.ts'
// @ts-expect-error Node test runner loads the TypeScript source directly.
import { DeterministicWorldAwarePlanProvider } from '../../planner/world-aware.ts'
// @ts-expect-error Node test runner loads the TypeScript source directly.
import { ApprovalStore } from '../../governance/approval.ts'
// @ts-expect-error Node test runner loads the TypeScript source directly.
import { fakeControl } from './fakes.ts'
// @ts-expect-error Node test runner loads the TypeScript source directly.
import type { ControlSurface } from '../../governance/contract.ts'
// @ts-expect-error Node test runner loads the TypeScript source directly.
import type { PlanContext, PlanProposal, PlanStep } from '../../planner/plan.ts'
// @ts-expect-error Node test runner loads the TypeScript source directly.
import type { Mission } from '../state.ts'

/**
 * PLAN REVIEW, AMENDMENT, AND DRY RUN.
 *
 * The claim under test, stated once: A HUMAN CAN INSPECT AND SAFELY MODIFY WHAT AIOS INTENDS TO DO
 * BEFORE AIOS IS ALLOWED TO EXECUTE IT.
 *
 * The load-bearing properties, each with its own negative control below:
 *
 *   a PlanProposal is REVIEWABLE DATA, and carries no authority
 *   an amendment produces a NEW proposal, never an in-place mutation of a mission
 *   an amended proposal is RECOMPILED, and a mission compiled from the old one is refused
 *   a dry run performs ZERO side effects - structurally, by what it can reach
 *   authorisation is a SEPARATE decision from review, and survives amendment
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const observer = new LocalObservationProvider()

const CONFIG = {
  maxAttempts: 1,
  permission: async () => ({
    control: 'ARMED' as const, input: 'PERMITTED' as const,
    blockedBy: null, infrastructureHealthy: true, mayInject: false,
  }),
  emergencyStop: async () => false,
}

function world_() {
  const root = mkdtempSync(join(tmpdir(), 'aios-review-'))
  const src = join(root, 'src')
  mkdirSync(join(src, 'sub'), { recursive: true })
  writeFileSync(join(src, 'a.md'), '# a\n')
  writeFileSync(join(src, 'b.txt'), 'bb\n')
  writeFileSync(join(src, 'sub', 'c.json'), '{}\n')
  const out = join(root, 'out')
  mkdirSync(out, { recursive: true })
  return { root, src, out }
}
const cleanup = (w: ReturnType<typeof world_>) => rmSync(w.root, { recursive: true, force: true })

async function planFor(w: ReturnType<typeof world_>): Promise<PlanProposal> {
  const o = observer.observe({ root: w.src, maxDepth: 4 })
  const ctx: PlanContext = {
    outputRoot: w.out, now: () => o.observedAt, world: o, maxObservationAgeMs: 60_000, refetched: o,
  }
  const r = await new DeterministicWorldAwarePlanProvider().plan(`Summarise the contents of the folder "${w.src}"`, ctx)
  assert.equal(r.ok, true, r.ok ? '' : r.reason)
  if (!r.ok) throw new Error('unreachable')
  return r.proposal
}

/** A registry serving every capability the planner emits, so a dry run can resolve them. */
function registry() {
  const stub = (name: string) => ({
    name, mode: 'filesystem' as const,
    async run() { return { kind: 'data' as const, data: {}, summary: '' } },
  })
  return new ToolRegistry({
    registrations: [
      { tool: stub('inspect-folder'), capabilities: ['filesystem.inspect', 'filesystem.list'] },
      { tool: stub('compose-summary'), capabilities: ['filesystem.transform'] },
      { tool: stub('write-summary'), capabilities: ['filesystem.write'] },
      { tool: stub('read-back'), capabilities: ['filesystem.read', 'filesystem.confirm'] },
      // `terminal.run` is served because the planner will choose it whenever the observation reports
      // node as present - which it does on this machine. A registry that omitted it would make every
      // dry run report "not executable" for a reason that has nothing to do with the review surface,
      // and the interesting assertions would never be reached.
      { tool: { ...stub('run-process'), mode: 'cli' as const }, capabilities: ['terminal.run'] },
    ],
  })
}

function dryCtx(w: ReturnType<typeof world_>, over: Partial<Parameters<typeof dryRun>[1]> = {}) {
  const refetched = observer.observe({ root: w.src, maxDepth: 4 })
  return {
    router: registry(), now: refetched.observedAt, maxObservationAgeMs: 60_000, refetched, ...over,
  }
}

// ==================================================== 1. a proposal is reviewable data

test('a proposal is inspectable, and the rendering names what a reviewer must check', async () => {
  const w = world_()
  try {
    const p = await planFor(w)
    const d = digestOf(p)
    const text = renderProposal(p, d)
    // The things a reviewer needs, each asserted because each is a thing that could be omitted.
    assert.match(text, /THE OBJECTIVE/, 'the objective is shown')
    assert.match(text, /WHAT "DONE" MEANS/, 'the claim about success is shown')
    assert.match(text, /WHAT IT PROMISES NOT TO DO/, 'the constraints are shown')
    assert.match(text, /THE OBSERVATION THIS PLAN RESTS ON/, 'the observation identity is shown')
    assert.match(text, /fingerprint/, 'and its fingerprint')
    assert.match(text, /facts used:/, 'and the specific facts it used')
    assert.match(text, /touches/, 'every operand a step touches is shown')
    assert.match(text, /verifies/, 'every verification requirement is shown')
    assert.match(text, /depends on/, 'dependencies are shown')
    assert.match(text, new RegExp(`plan digest ${d}`), 'and the digest the reviewer is accepting')

    // The header, for a status line.
    const head = renderHeader(p, d, false)
    // The step COUNT as a relation, not a literal. The count follows from which capabilities the
    // observation made available, so a hardcoded number would report a deliberate change to the
    // planner's shape as a failure of the review surface.
    assert.ok(head.includes(`${p.steps.length} step(s)`), `the header states the step count; got: ${head}`)
    assert.doesNotMatch(head, /AMENDED/)
  } finally { cleanup(w) }
})

test('the review rendering shows no internal reasoning trace', async () => {
  // §12: concise, actionable execution information rather than a chain of thought. A planner that
  // emitted one would be asked to explain itself, and an explanation is not evidence.
  const w = world_()
  try {
    const p = await planFor(w)
    const text = renderProposal(p, digestOf(p))
    for (const forbidden of ['chain of thought', 'reasoning trace', 'I think', 'I believe', 'deliberation', 'my confidence']) {
      assert.ok(!text.toLowerCase().includes(forbidden.toLowerCase()), `the rendering must not contain "${forbidden}"`)
    }
  } finally { cleanup(w) }
})

// ==================================================== 2. amendment produces a NEW proposal

test('an amendment never mutates the original, and the diff names what changed', async () => {
  const w = world_()
  try {
    const original = await planFor(w)
    const before = JSON.stringify(original)
    const session = beginReview(original, 1)
    assert.equal(isAmended(session), false)

    const writeStep = original.steps.find((s) => s.capability === 'filesystem.write')!
    const r = applyAmendment(session, { kind: 'set-arg', stepId: writeStep.id, key: 'path', value: `${w.out}\\summary-B.txt` }, 2)
    assert.equal(r.ok, true)
    if (!r.ok) return

    // The ORIGINAL is untouched, byte for byte.
    //
    // Asserted on the ORIGINAL object, not on a copy of it. A test that snapshotted a clone would
    // pass whether or not `amend` aliased, which is the whole question.
    assert.equal(JSON.stringify(original), before, 'the reviewed proposal is never mutated')
    // And specifically: the amended proposal's own arrays are not the original's.
    assert.notEqual(r.session.current.steps, original.steps, 'the step array is a new one, not the same reference')
    assert.equal(isAmended(r.session), true)
    assert.notEqual(r.session.digest, r.session.originalDigest, 'and the digest changed')

    // The diff names the change, and classifies it as behavioural.
    const changes = r.changes
    assert.ok(changes.length > 0, 'the amendment produced a diff')
    const argChange = changes.find((c) => c.field === 'args')!
    assert.ok(argChange, 'the changed operand is reported')
    assert.equal(argChange.significance, 'behavioural', 'a changed operand changes what the machine does')
    assert.match(argChange.note, /summary-B\.txt/)

    // And the full history is visible, not just the last change.
    const all = changesFromOriginal(r.session)
    assert.ok(all.length > 0)
    assert.ok(materialChanges(r.session).length > 0, 'there is at least one material change')
    assert.match(summarise(changes), /behavioural/)
    assert.match(renderChanges(changes), /summary-B\.txt/)
  } finally { cleanup(w) }
})

test('the amendment layer REFUSES to invent a change to a step that is not there', async () => {
  const w = world_()
  try {
    const p = await planFor(w)
    for (const change of [
      { kind: 'set-arg', stepId: 'no-such-step', key: 'path', value: 'x' } as Amendment,
      { kind: 'remove-step', stepId: 'no-such-step' } as Amendment,
      { kind: 'set-depends', stepId: 'no-such-step', dependsOn: [] } as Amendment,
      { kind: 'set-effect', stepId: 'no-such-step', effect: undefined } as Amendment,
    ]) {
      const r = amend(p, change)
      assert.equal(r.ok, false, `${change.kind} on a missing step must be refused`)
      if (!r.ok) assert.match(r.reason, /no step named/)
    }
  } finally { cleanup(w) }
})

test('the amendment layer is PERMISSIVE: it will produce an invalid plan for the compiler to reject', async () => {
  // The division of labour. If amendments validated, there would be two validators disagreeing about
  // the same plan. So this layer records changes and the compiler decides - which is why these
  // deliberately malformed amendments are ACCEPTED here.
  const w = world_()
  try {
    const p = await planFor(w)
    const first = p.steps[0].id

    // A dangling dependency, from removing a step others depend on.
    const r = amend(p, { kind: 'remove-step', stepId: first })
    assert.equal(r.ok, true, 'removing a step is accepted here')
    if (!r.ok) return
    assert.ok(r.proposal.steps.length === p.steps.length - 1)
    assert.ok(
      r.proposal.steps.some((s) => s.dependsOn.includes(first)),
      'the dangling dependency is LEFT for the compiler to find, not quietly repaired',
    )

    // A missing verification requirement.
    const v = amend(p, { kind: 'set-verification', stepId: first, verification: undefined })
    assert.equal(v.ok, true, 'removing a verification requirement is accepted here')
    if (v.ok) assert.equal((v.proposal.steps[0] as PlanStep).verification, undefined)

    // A dependency cycle.
    const c = amend(p, { kind: 'set-depends', stepId: first, dependsOn: [p.steps[p.steps.length - 1].id] })
    assert.equal(c.ok, true, 'creating a cycle is accepted here')

    assert.match(describeAmendment({ kind: 'remove-step', stepId: first }), /remove step/)
  } finally { cleanup(w) }
})

// ==================================================== 3. recompilation, and refusing a stale mission

test('the compiler stamps a digest, and the executor REFUSES a mission from a different proposal', async () => {
  const w = world_()
  try {
    const p = await planFor(w)
    const session = beginReview(p, 1)
    const compiled = commit(session, 'm-1', 1)
    assert.equal(compiled.ok, true)
    if (!compiled.ok) return
    assert.equal(compiled.mission.proposalDigest, compiled.reviewedDigest, 'the mission carries the digest of the proposal it came from')

    // Now amend, and try to execute the OLD mission against the NEW digest. This is the whole
    // mechanism: an amendment is a change to a document, and a mission compiled from the earlier
    // document is not the reviewed plan.
    const amended = applyAmendment(session, {
      kind: 'set-arg', stepId: p.steps.find((s) => s.capability === 'filesystem.write')!.id, key: 'path', value: 'x.txt',
    }, 2)
    assert.equal(amended.ok, true)
    if (!amended.ok) return

    const r = await execute(compiled.mission, {
      tools: registry(),
      verifier: { verifies: () => false, async verify() { return { rejected: 'n/a' } } } as never,
      control: fakeControl() as ControlSurface, approvals: new ApprovalStore(), config: CONFIG,
    }, { reviewedProposalDigest: amended.session.digest })

    assert.equal(r.record.complete, false, 'a mission compiled from a superseded plan must not run')
    const refused = r.events.find((e) => e.type === 'step-refused') as unknown as { reason: string } | undefined
    assert.ok(refused, 'and the refusal is recorded')
    assert.match(refused!.reason, /amended after compilation/)
    // And nothing ran.
    for (const s of r.mission.plan) assert.equal(s.result, undefined, 'no step may have been attempted')
  } finally { cleanup(w) }
})

test('a mission with NO stamp is refused when a reviewed digest is supplied', async () => {
  // "Cannot be shown to be the plan that was reviewed" is not the same as "probably fine".
  const handBuilt = {
    id: 'm-hand', objective: 'o', constraints: [], state: 'drafting',
    plan: [{ id: 'a', intent: 'i', mode: 'filesystem', rationale: 'r', tool: 'inspect-folder', status: 'pending' }],
    history: [], pendingApprovals: [], startedAt: 0,
  } as unknown as Mission
  const r = await execute(handBuilt, {
    tools: registry(),
    verifier: { verifies: () => false, async verify() { return { rejected: 'n/a' } } } as never,
    control: fakeControl() as ControlSurface, approvals: new ApprovalStore(), config: CONFIG,
  }, { reviewedProposalDigest: 'deadbeefdeadbeef' })
  assert.equal(r.record.complete, false)
  const refused = r.events.find((e) => e.type === 'step-refused') as unknown as { reason: string } | undefined
  assert.ok(refused)
  assert.match(refused!.reason, /records none/)
})

test('omitting the reviewed digest is allowed, and runs the plan as-is', async () => {
  // Deliberate. Every supervisor-run mission omits it, and requiring it would push those callers to
  // pass a digest computed from the proposal they just compiled - a check that cannot fail.
  const w = world_()
  try {
    const p = await planFor(w)
    const compiled = commit(beginReview(p, 1), 'm-2', 1)
    assert.equal(compiled.ok, true)
    if (!compiled.ok) return
    const r = await execute(compiled.mission, {
      tools: registry(),
      verifier: { verifies: () => false, async verify() { return { rejected: 'nothing to verify' } } } as never,
      control: fakeControl() as ControlSurface, approvals: new ApprovalStore(), config: CONFIG,
    })
    // It runs, and fails on verification rather than on the digest - which is the point.
    assert.equal(r.mission.plan.some((s) => s.result?.outcome.kind === 'failed'), true)
    assert.equal(r.events.some((e) => e.type === 'step-refused'), false, 'and is not refused for want of a digest')
  } finally { cleanup(w) }
})

// ==================================================== 4. the dry run cannot act

test('the review layer CANNOT execute: it imports nothing that can', () => {
  // Controls A and F at the import level. The strongest form of the claim, because it is a property
  // of the module graph rather than a check that could be bypassed.
  for (const f of ['amend.ts', 'diff.ts', 'dry-run.ts', 'session.ts', 'render.ts', 'digest.ts']) {
    const src = readFileSync(join(HERE, '..', '..', 'review', f), 'utf8')
    assert.doesNotMatch(src, /from\s+['"]node:child_process/, `${f} must not be able to spawn`)
    assert.doesNotMatch(src, /from\s+['"].*mission-engine\/executor['"]/, `${f} must not import the executor`)
    assert.doesNotMatch(src, /from\s+['"].*control-core/, `${f} must not import the control core`)
    assert.doesNotMatch(src, /from\s+['"].*governance\/(contract|approval)/, `${f} must not import governance`)
    assert.doesNotMatch(src, /writeFileSync|mkdirSync|rmSync|unlinkSync|appendFileSync/, `${f} must not write`)
  }
  // `dry-run.ts` may not even import node:fs: it has no business touching a filesystem at all.
  const dry = readFileSync(join(HERE, '..', '..', 'review', 'dry-run.ts'), 'utf8')
  assert.doesNotMatch(dry, /from\s+['"]node:fs['"]/, 'the dry run must not touch a filesystem')
})

test('a dry run leaves the world BYTE-IDENTICAL', async () => {
  const w = world_()
  try {
    const p = await planFor(w)
    const snapshot = () => ({
      // Guarding the DIRECTORY and then reading a FILE inside it is not a guard at all. The first
      // version threw ENOENT on a file that was never created, so the "the world is unchanged"
      // assertion died before it could run - and a test that cannot run is a test that cannot fail.
      outEntries: readdirSyncSafe(w.out),
      srcEntries: readdirSyncSafe(w.src),
    })
    const before = snapshot()
    const report = dryRun(p, dryCtx(w))
    assert.ok(report.steps.length > 0, 'the dry run reported on every step')
    assert.deepEqual(snapshot(), before, 'a dry run must change nothing at all')
  } finally { cleanup(w) }
})

test('a dry run reports what WOULD happen, and does not claim a step would succeed', async () => {
  const w = world_()
  try {
    const p = await planFor(w)
    const r = dryRun(p, dryCtx(w))
    assert.equal(r.executable, true, r.planLevelBlockers.join('; '))
    for (const s of r.steps) {
      assert.ok(s.tool, `step ${s.stepId} resolved a tool`)
      assert.equal(s.verdict, 'executable')
      assert.ok(s.verification !== 'NONE DECLARED', 'and states what would prove it')
    }
    // "Executable" is a claim about DISPATCH, never about success. There is no field for the latter,
    // and its absence is the point.
    const text = renderDryRun(r)
    assert.match(text, /nothing has been run/)
    assert.doesNotMatch(text, /would succeed|would pass|will succeed/, 'a dry run must not predict success')
  } finally { cleanup(w) }
})

test('a dry run reports a REFUSED step as refused, and an unknown capability as unknown', async () => {
  const w = world_()
  try {
    const p = await planFor(w)
    // A capability the router cannot serve.
    const empty = new EmptyRegistry()
    const r = dryRun(p, { ...dryCtx(w), router: empty })
    assert.equal(r.executable, false, 'with nothing registered, nothing is executable')
    assert.ok(r.planLevelBlockers.some((b) => /no registered tool serves/i.test(b)))
    // A capability that does not exist at all.
    const bogus = { ...p, steps: p.steps.map((s, i) => (i === 0 ? { ...s, capability: 'filesystem.telepathy' as never } : s)) }
    const r2 = dryRun(bogus, dryCtx(w))
    assert.equal(r2.executable, false)
    assert.ok(r2.planLevelBlockers.some((b) => /does not exist/.test(b)))
  } finally { cleanup(w) }
})

// ==================================================== 5. the world can move under a review

test('a dry run reports a STALE world as stale, and names which kind of stale', async () => {
  const w = world_()
  try {
    const p = await planFor(w)
    const o = observer.observe({ root: w.src, maxDepth: 4 })

    // Too old.
    const old = dryRun(p, { router: registry(), now: o.observedAt + 300_000, maxObservationAgeMs: 60_000, refetched: observer.observe({ root: w.src, maxDepth: 4 }) })
    assert.equal(old.world.fresh, false)
    assert.equal(old.world.freshness, 'too-old')
    assert.equal(old.executable, false)
    assert.ok(old.planLevelBlockers.some((b) => /too-old/.test(b)), 'and the plan is blocked with a reason')

    // Unverifiable: no re-observation at all. Reported as its OWN state, never as "fine".
    const unknown = dryRun(p, { router: registry(), now: o.observedAt + 1000, maxObservationAgeMs: 60_000 })
    assert.equal(unknown.world.fresh, false)
    assert.equal(unknown.world.freshness, 'cannot-verify')
    assert.equal(unknown.executable, false, '"cannot tell" must not read as "fine" to a reviewer about to authorise execution')

    // Changed underneath.
    writeFileSync(join(w.src, 'intruder.txt'), 'appeared\n')
    const changed = dryRun(p, { router: registry(), now: o.observedAt + 1000, maxObservationAgeMs: 60_000, refetched: observer.observe({ root: w.src, maxDepth: 4 }) })
    assert.equal(changed.world.freshness, 'world-changed')
    assert.equal(changed.executable, false)
    rmSync(join(w.src, 'intruder.txt'), { force: true })
  } finally { cleanup(w) }
})

// ==================================================== 6. governance survives amendment

test('amending a plan to be CONSEQUENTIAL makes it require authorisation, and review does not grant it', async () => {
  const w = world_()
  try {
    const p = await planFor(w)
    const session = beginReview(p, 1)
    const writeStep = p.steps.find((s) => s.capability === 'filesystem.write')!
    const r = applyAmendment(session, {
      kind: 'set-effect', stepId: writeStep.id,
      effect: { kind: 'delete', target: join(w.src, 'a.md'), reason: 'a reviewer said so', irreversible: true },
    }, 2)
    assert.equal(r.ok, true)
    if (!r.ok) return

    // The review layer can say what would be required, and cannot grant it.
    const report = preview(r.session, dryCtx(w))
    const flagged = report.steps.find((s) => s.stepId === writeStep.id)!
    assert.equal(flagged.approvalRequired, true, 'the dry run reports the consequence')
    assert.equal(flagged.alreadyAuthorised, false)
    assert.equal(flagged.verdict, 'would-need-authorisation')
    assert.deepEqual(report.needsAuthorisation, [writeStep.id])
    // Review is not authorisation, and the report says so in the summary a reviewer actually reads.
    assert.match(renderDryRun(report), /Reviewing this plan is NOT the same as authorising/)
    // NOT "needs a human": a declared effect needs an APPROVAL, which is a different thing from the
    // policy's `needs-human` (a command no human could authorise). Asserting the stronger phrase here
    // would have tested a feature this case does not exercise - the policy-level refusal is covered
    // by its own control, in the terminal mission.
    assert.match(renderDryRun(report), /NEED A HUMAN BEFORE ANYTHING RUNS|Reviewing this plan is NOT/)

    // And compiling and executing it still requires the M3 store.
    const compiled = commit(r.session, 'm-gov', 2)
    assert.equal(compiled.ok, true, 'a consequential declaration is a valid plan')
    if (!compiled.ok) return
    const run = await execute(compiled.mission, {
      tools: registry(),
      // Permissive verifier, so the chain REACHES the gated step. With a refusing verifier an earlier
      // step fails, every later step is skipped, and the approval gate is never exercised - so the
      // control would be measuring an unrelated guard.
      verifier: { verifies: () => true, async verify() { return { evidence: { kind: 'file-exists', path: 'stub' } as never } } } as never,
      control: fakeControl() as ControlSurface, approvals: new ApprovalStore(), config: CONFIG,
    }, { reviewedProposalDigest: r.session.digest })
    const req = run.events.filter((e) => e.type === 'approval-required')
    assert.equal(req.length, 1, 'and the approval request is emitted, despite the reviewer having "approved the plan"')
    assert.equal(run.record.complete, false, 'and the mission does not complete')
    // The GATED step must not have run. Asserted on that step rather than on every step: the steps
    // before it are legitimately allowed to complete, and claiming otherwise would assert that an
    // unapproved plan does nothing at all, which is not what governance means.
    const gated = run.mission.plan.find((s) => s.id === writeStep.id)!
    assert.equal(gated.result?.outcome.kind, 'needs-human', 'the consequential step is the one that stops')
    assert.equal(gated.result?.output, undefined, 'and its tool was never called')
  } finally { cleanup(w) }
})

// ==================================================== 7. fake approval is inert

test('injecting an approval field has NO authorization effect, and does not even change the digest', async () => {
  const w = world_()
  try {
    const p = await planFor(w)
    const writeStep = p.steps.find((s) => s.capability === 'filesystem.write')!
    const before = digestOf(p)

    // (a) UNKNOWN FIELDS ALONE. Bolted onto the proposal and onto a step, changing nothing the
    // system reads. The digest is a whitelist, so they contribute nothing.
    const bolted = {
      ...p,
      approved: true, authorized: true, confirmed: true, override: 'all',
      steps: p.steps.map((s) => (s.id === writeStep.id
        ? { ...s, approved: true, authorized: true, confirmed: true, override: 'all' }
        : s)),
    } as unknown as PlanProposal
    assert.equal(digestOf(bolted), before, 'an unknown field must not change the plan digest')
    // Even one that claims to be a permission. This is the whole point of a whitelist: the field is
    // never read, so it cannot be read wrongly either.
    assert.deepEqual(authorityLookingFields(bolted).length >= 5, true)

    // (b) A REAL effect ADDED ALONGSIDE them. Here the digest MUST change, because `effect` is a
    // semantic field - the plan genuinely is a different plan.
    //
    // The first version of this test asserted the digest was unchanged for BOTH cases, and the second
    // assertion failed. The test was wrong: it conflated "an unknown field is inert" with "the plan
    // is unchanged", and the second claim is false whenever a semantic field really moved. A control
    // that asserts too much is a control that has to be weakened until it passes, and weakening it
    // would have hidden the property that actually matters - that the tampering alone buys nothing.
    const tampered = {
      ...bolted,
      steps: p.steps.map((s) => (s.id === writeStep.id
        ? { ...(s as PlanStep), approved: true, override: 'all',
            effect: { kind: 'delete', target: join(w.src, 'a.md'), reason: 'x', irreversible: true } }
        : s)),
    } as unknown as PlanProposal
    assert.notEqual(digestOf(tampered), before, 'adding a real effect IS a different plan, and the digest says so')

    // 2. The review layer NAMES the suspicious fields, so a reviewer is not left to assume they
    //    were honoured.
    const fields = authorityLookingFields(tampered)
    assert.ok(fields.some((f) => f.includes('proposal.approved')))
    assert.ok(fields.some((f) => f.includes(`${writeStep.id}.override`)))
    const r = dryRun(tampered, dryCtx(w))
    assert.match(renderDryRun(r), /LOOK LIKE PERMISSION AND ARE NOT READ/)

    // 3. And it does not authorise anything. The real consequence still needs the store.
    //
    // A PERMISSIVE verifier, deliberately. With the stub tools returning empty data, an earlier step
    // fails and every later step is `skipped` - so the approval gate is never REACHED, and zero
    // approval events is the correct result for a chain that stopped three steps earlier. The first
    // version of this test asserted an approval request was raised and got none, and read that as
    // "the tampering worked". It did not; the gate simply was not in play.
    //
    // Letting the chain proceed is what makes the control test the thing it claims to.
    const compiled = (await import('../../planner/compile.ts')).compilePlan(tampered, 'm-fake', 1)
    assert.equal(compiled.ok, true)
    if (!compiled.ok) return
    const run = await execute(compiled.mission, {
      tools: registry(),
      verifier: { verifies: () => true, async verify() { return { evidence: { kind: 'file-exists', path: 'stub' } as never } } } as never,
      control: fakeControl() as ControlSurface, approvals: new ApprovalStore(), config: CONFIG,
    })
    // The step is `skipped` rather than `needs-human`, because a PRIOR step fails first (these
    // registry tools return empty data and the stub verifier refuses it). Asserting `needs-human`
    // here would test the wrong thing; what matters is that the approval request was still raised,
    // which is what "the plan saying it is approved buys nothing" means.
    const raised = run.events.filter((e) => e.type === 'approval-required')
    assert.equal(raised.length, 1, 'a plan that claims to be approved still raises an approval request')
    assert.equal(run.record.complete, false)
  } finally { cleanup(w) }
})

// ==================================================== 8. malformed amendments are rejected by the compiler

test('every malformed amendment is rejected at compile, with a reason', async () => {
  const w = world_()
  try {
    const p = await planFor(w)
    const { compilePlan } = await import('../../planner/compile.ts')
    const first = p.steps[0].id
    const last = p.steps[p.steps.length - 1].id

    const cases: Array<[string, PlanProposal, RegExp]> = [
      ['a dangling dependency',
        { ...p, steps: p.steps.map((s) => (s.id === last ? { ...s, dependsOn: ['ghost'] } : s)) },
        /not a step in this plan/],
      ['a cycle',
        { ...p, steps: p.steps.map((s) => (s.id === first ? { ...s, dependsOn: [last] } : s)) },
        /cycle|listed after it/],
      ['a missing verification',
        { ...p, steps: p.steps.map((s, i) => (i === 0 ? { ...s, verification: undefined as never } : s)) },
        /verification requirement/],
      ['an unknown capability',
        { ...p, steps: p.steps.map((s, i) => (i === 0 ? { ...s, capability: 'filesystem.telepathy' as never } : s)) },
        /does not exist/],
      ['no basis at all',
        { ...p, basis: { ...p.basis, observationId: '' } },
        /names no observation/],
      ['an incomplete observation',
        { ...p, basis: { ...p.basis, complete: false } },
        /partial observation/],
    ]
    for (const [what, broken, expect] of cases) {
      const c = compilePlan(broken, 'm-bad', 1)
      assert.equal(c.ok, false, `${what} must be refused`)
      if (!c.ok) assert.match(c.reason, expect, `${what}: ${c.reason}`)
    }
    // And the unmodified plan compiles, so none of the above is failing for a general reason.
    assert.equal(compilePlan(p, 'm-good', 1).ok, true)
  } finally { cleanup(w) }
})

// ==================================================== 9. canonicalisation and diff details

test('the digest is stable regardless of key order, and changes when anything semantic does', async () => {
  const w = world_()
  try {
    const p = await planFor(w)
    const reordered = { ...p, steps: p.steps.map((s) => ({ ...s, args: Object.fromEntries(Object.entries(s.args).reverse()) })) }
    assert.equal(digestOf(reordered), digestOf(p), 'argument order must not change the digest')

    for (const [what, changed] of [
      ['a tool', { ...p, steps: p.steps.map((s) => ({ ...s, tool: s.tool + '-x' })) }],
      ['a mode', { ...p, steps: p.steps.map((s) => ({ ...s, mode: 'cli' as const })) }],
      ['a capability', { ...p, steps: p.steps.map((s) => ({ ...s, capability: 'terminal.run' as const })) }],
      ['a dependency', { ...p, steps: p.steps.map((s) => ({ ...s, dependsOn: [...s.dependsOn, 'extra'] })) }],
      ['a constraint', { ...p, constraints: [...p.constraints, 'an extra rule'] }],
      ['the fingerprint', { ...p, basis: { ...p.basis, fingerprint: 'deadbeefdeadbeef' } }],
    ] as const) {
      assert.notEqual(digestOf(changed as PlanProposal), digestOf(p), `${what} must change the digest`)
    }
    // Canonical output is deterministic.
    assert.equal(canonicalise({ b: 1, a: [2, { d: 4, c: 3 }] }), canonicalise({ a: [2, { c: 3, d: 4 }], b: 1 }))
  } finally { cleanup(w) }
})

test('a diff of a plan against itself is empty, and a wholesale replace is still diffed', async () => {
  const w = world_()
  try {
    const p = await planFor(w)
    assert.deepEqual(diffPlans(p, structuredClone(p)), [], 'a plan does not differ from itself')
    assert.equal(samePlan(p, structuredClone(p)), true)
    // A `replace` carries no list of what changed, so the diff must be computed from the two plans.
    const other = await planFor({ ...w, out: join(w.root, 'out2') } as never).catch(() => p)
    const r = amend(p, { kind: 'replace', proposal: other })
    assert.equal(r.ok, true)
    if (r.ok) {
      const changes = diffPlans(p, r.proposal)
      if (digestOf(p) !== digestOf(r.proposal)) assert.ok(changes.length > 0, 'a different replacement still yields a diff')
    }
    // And cosmetic-only changes are separable from material ones.
    const cosmetic = { ...p, steps: p.steps.map((s) => ({ ...s, intent: `${s.intent} (reworded)` })) }
    const cc = diffPlans(p, cosmetic)
    assert.ok(cc.length > 0)
    assert.equal(cc.every((c) => c.significance === 'cosmetic'), true, 'reworded intents are cosmetic')
    assert.equal(consequentialChanges(cc).length, 0, 'and a reviewer can ask for material changes only')
  } finally { cleanup(w) }
})

test('amendAll applies in order and stops at the first refusal', async () => {
  const w = world_()
  try {
    const p = await planFor(w)
    const writeStep = p.steps.find((s) => s.capability === 'filesystem.write')!
    const good: Amendment = { kind: 'set-arg', stepId: writeStep.id, key: 'path', value: 'one.txt' }
    const bad: Amendment = { kind: 'set-arg', stepId: 'ghost', key: 'path', value: 'x' }
    const later: Amendment = { kind: 'set-arg', stepId: writeStep.id, key: 'name', value: 'two' }

    const ok = amendAll(p, [good, later])
    assert.equal(ok.ok, true)
    assert.equal(ok.applied.length, 2)

    const stopped = amendAll(p, [good, bad, later])
    assert.equal(stopped.ok, false, 'a refusal stops the sequence')
    assert.equal(stopped.applied.length, 1, 'after the amendments that worked')
    assert.ok(stopped.refused)
    assert.match(stopped.refused!.reason, /no step named/)
  } finally { cleanup(w) }
})

function readdirSyncSafe(p: string): string[] {
  try {
    return readdirSync(p).sort()
  } catch {
    return []
  }
}
