/**
 * Controls for `checkPlanInvariants`.
 *
 * Every case below is a REAL defect the 0.5B model actually produced, except where marked. The point
 * is that each is refused BEFORE compilation and execution, and that the rules are narrow: the
 * legitimate shapes around them are asserted too, because a rule that rejects everything is not a
 * rule, it is an outage.
 *
 * Nothing here mocks a model. These test the validator directly with hand-built proposals, and the
 * real model is exercised end to end separately, where its failures are reported as failures.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { checkPlanInvariants } from '../plan-invariants.ts'
import type { PlanProposal, PlanStep } from '../../planner/plan.ts'
import { FOLDER_TOOLS } from '../../mission-engine/live/folder-tools.ts'

const ROOT = mkdtempSync(join(tmpdir(), 'aios-invariants-'))
process.on('exit', () => { try { rmSync(ROOT, { recursive: true, force: true }) } catch { /* held */ } })

const OUT = join(ROOT, 'project-notes.txt')
const SRC = join(ROOT, 'source')

// The real registry and the real capability mapping, not a convenient fiction.
const REGISTERED = FOLDER_TOOLS.map((t) => t.name)
const CAP_OF: Record<string, string> = {
  'read-folder': 'filesystem.inspect',
  'inspect-folder': 'filesystem.list',
  'compose-summary': 'filesystem.transform',
  'write-report': 'filesystem.write',
  'read-report': 'filesystem.confirm',
}
const OPTS = {
  registeredTools: REGISTERED,
  capabilityOfTool: CAP_OF,
  requiredCapabilities: ['filesystem.inspect', 'filesystem.write'],
  expectedOutputPath: OUT,
}

function step(over: Partial<PlanStep> = {}): PlanStep {
  return {
    id: 'inspect', capability: 'filesystem.inspect', intent: 'i', mode: 'filesystem',
    tool: 'read-folder', args: { path: SRC }, dependsOn: [], rationale: 'r',
    verification: { kind: 'must-exist', description: 'd' }, onFailure: 'replan',
    ...over,
  } as PlanStep
}

function writeStep(over: Partial<PlanStep> = {}): PlanStep {
  return step({
    id: 'write', capability: 'filesystem.write', tool: 'write-report',
    args: { path: OUT, name: 'project-notes.txt', outputRoot: ROOT, from: 'compose' },
    dependsOn: ['inspect'], ...over,
  } as Partial<PlanStep>)
}

function plan(steps: PlanStep[]): PlanProposal {
  return {
    objective: 'summarise the folder and write a summary',
    constraints: [],
    steps,
    expectedResult: 'a summary exists',
    basis: { observationId: 'o', observedAt: 1, root: ROOT, fingerprint: 'f', usedFacts: [], complete: true },
  }
}

const TWO_STEPS = [step(), step({
  id: 'compose', capability: 'filesystem.transform', tool: 'compose-summary',
  args: { from: 'inspect', folderLabel: SRC }, dependsOn: ['inspect'],
}), writeStep()]

// ============================================================================================

test('the CONTROL plan passes: a real inspect + write plan is not over-constrained', () => {
  const r = checkPlanInvariants(plan(TWO_STEPS), OPTS)
  assert.equal(r.ok, true, r.ok ? '' : r.reason)
})

test('CONTROL: duplicate step ids are REFUSED', () => {
  const r = checkPlanInvariants(plan([step({ id: 'a' }), step({ id: 'a' })]), OPTS)
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.match(r.reason, /share the id/)
})

test('CONTROL: an unregistered tool is REFUSED (the write-summary defect)', () => {
  const r = checkPlanInvariants(plan([step({ tool: 'write-summary' as never })]), OPTS)
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.match(r.reason, /not registered/)
  assert.match(r.reason, /write-report/, 'the refusal should name what IS registered')
})

test('CONTROL: a tool paired with the wrong capability is REFUSED', () => {
  const r = checkPlanInvariants(plan([step({ tool: 'write-report' })]), OPTS)
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.match(r.reason, /serves "filesystem.write"/)
})

test('CONTROL: a mode that disagrees with the capability is REFUSED', () => {
  const r = checkPlanInvariants(plan([step({ mode: 'cli' })]), OPTS)
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.match(r.reason, /requires mode "filesystem"/)
})

test('CONTROL: an unknown capability is REFUSED', () => {
  const r = checkPlanInvariants(plan([step({ capability: 'filesystem.launch' as never })]), OPTS)
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.match(r.reason, /does not exist/)
})

test('CONTROL: a self-dependency is REFUSED', () => {
  const r = checkPlanInvariants(plan([step({ dependsOn: ['inspect'] })]), OPTS)
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.match(r.reason, /depends on itself/)
})

test('CONTROL: a dependency on a CAPABILITY name is REFUSED', () => {
  // MEASURED: the model emitted dependsOn:["filesystem.read"].
  const r = checkPlanInvariants(plan([step({ dependsOn: ['filesystem.read'] })]), OPTS)
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.match(r.reason, /CAPABILITY name, not a step id/)
})

test('CONTROL: a dangling dependency is REFUSED', () => {
  const r = checkPlanInvariants(plan([step({ dependsOn: ['ghost'] })]), OPTS)
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.match(r.reason, /not a step in this plan/)
})

test('CONTROL: a FORWARD dependency is REFUSED', () => {
  const r = checkPlanInvariants(plan([step({ dependsOn: ['later'] }), step({ id: 'later' })]), OPTS)
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.match(r.reason, /not an EARLIER step/)
})

test('CONTROL: a dependency cycle is REFUSED', () => {
  const r = checkPlanInvariants(
    plan([step({ id: 'a', dependsOn: ['b'] }), step({ id: 'b', dependsOn: ['a'] })]), OPTS)
  assert.equal(r.ok, false)
})

test('CONTROL: a read-only step may NOT declare an effect (the install defect)', () => {
  // MEASURED: {"kind":"install","target":"filesystem.read","irreversible":true} on an inspect step.
  const r = checkPlanInvariants(plan([step({
    effect: { kind: 'install', target: 'filesystem.read', reason: 'because', irreversible: true } as never,
  })]), OPTS)
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.match(r.reason, /read-only capability/)
})

test('REGRESSION: effects are NOT globally forbidden - an edit step may still declare delete', () => {
  // `filesystem.edit` declaring `delete` is correct and asserted elsewhere in this repository. The
  // rule is narrow on purpose, and this is the test that keeps it narrow.
  const r = checkPlanInvariants(
    plan([step({
      id: 'e', capability: 'filesystem.edit', tool: 'edit-file' as never, mode: 'filesystem',
      effect: { kind: 'delete', target: 'C:\\x', reason: 'r', irreversible: false } as never,
    })]),
    { registeredTools: [...REGISTERED, 'edit-file'], capabilityOfTool: CAP_OF },
  )
  assert.equal(r.ok, true, r.ok ? '' : r.reason)
})

test('CONTROL: a plan with NO write step is REFUSED (the inspect-only defect)', () => {
  // MEASURED: the model produced an inspect step and never reached filesystem.write.
  const r = checkPlanInvariants(plan([step()]), OPTS)
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.match(r.reason, /no "filesystem.write" step/)
})

test('CONTROL: a write targeting the WRONG filename is REFUSED', () => {
  // MEASURED: the model wrote summary.txt when project-notes.txt was requested.
  const r = checkPlanInvariants(
    plan([step(), writeStep({ args: { path: join(ROOT, 'summary.txt'), name: 'summary.txt', outputRoot: ROOT, from: 'inspect' } })]),
    OPTS)
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.match(r.reason, /no write step targets/)
  assert.match(r.reason, /summary\.txt/, 'the refusal should say what the plan wanted instead')
})

test('REGRESSION: a case-different but identical destination is accepted', () => {
  const r = checkPlanInvariants(plan(TWO_STEPS), { ...OPTS, expectedOutputPath: OUT.toUpperCase() })
  assert.equal(r.ok, true, r.ok ? '' : r.reason)
})

test('CONTROL: an empty plan is REFUSED', () => {
  const r = checkPlanInvariants(plan([]), OPTS)
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.match(r.reason, /no steps/)
})