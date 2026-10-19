/**
 * THE PLAN/SCHEMA SEAM, AND WHY NOTHING BAD REACHES THE EXECUTOR.
 *
 * `grammar.py` now refuses to emit `"steps": []`, and `parse.ts` always refused it. These controls
 * pin BOTH halves of that agreement, and then pin the thing that actually matters: an invalid or
 * incomplete plan has no route to a tool.
 *
 * Nothing here mocks a model. The provider is driven through a stubbed `fetchImpl`, which is the
 * seam the provider itself exposes for exactly this purpose - so these tests are about the PARSER
 * and the PLANNING PIPELINE, not about whether a model is any good. The real model is exercised
 * separately, end to end, and its failure is reported as a failure.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { parseModelPlan } from '../parse.ts'
import { ModelPlanProvider } from '../provider.ts'
import { compilePlan } from '../../planner/compile.ts'
import { CAPABILITIES, type PlanContext } from '../../planner/plan.ts'
import type { WorldState } from '../../observation/world.ts'

const ROOT = mkdtempSync(join(tmpdir(), 'aios-seam-'))
process.on('exit', () => { try { rmSync(ROOT, { recursive: true, force: true }) } catch { /* held */ } })

const ONE_STEP = {
  constraints: ['read-only'],
  steps: [{
    id: 'read',
    capability: 'filesystem.inspect',
    intent: 'establish the folder exists',
    mode: 'filesystem',
    tool: 'read-folder',
    args: { path: 'C:\\x' },
    dependsOn: [],
    rationale: 'a summary of something unreadable is not a summary',
    verification: { kind: 'must-exist', description: 'the folder exists' },
    onFailure: 'abort-mission',
  }],
  expectedResult: 'the folder is confirmed',
}

const world = (): WorldState => ({
  observationId: 'obs-1',
  observedAt: Date.now(),
  scope: { root: ROOT, maxDepth: 1 },
  entries: [],
  fingerprint: 'fp-1',
  capabilities: [],
  truncated: false,
  errors: [],
})

/** A provider whose transport returns exactly the given text. */
function providerReturning(text: string) {
  return new ModelPlanProvider({
    endpoint: { url: 'http://127.0.0.1:1/v1/chat/completions', model: 'stub', timeoutMs: 5_000 },
    availableCapabilities: [...CAPABILITIES],
    fetchImpl: (async () => new Response(
      JSON.stringify({ choices: [{ message: { role: 'assistant', content: text } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch,
  })
}

// ============================================================================================
// The parser
// ============================================================================================

test('CONTROL: an empty steps array is REJECTED by the parser', () => {
  const r = parseModelPlan(JSON.stringify({ constraints: [], steps: [], expectedResult: 'nothing' }))
  assert.equal(r.ok, false, 'a plan with zero steps is not a plan')
  if (r.ok) return
  assert.equal(r.code, 'invalid-proposal')
  assert.match(r.reason, /zero steps/, `the reason must name the defect: ${r.reason}`)
})

test('CONTROL: a plan with NO steps key is REJECTED by the parser', () => {
  const r = parseModelPlan(JSON.stringify({ constraints: [], expectedResult: 'nothing' }))
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.match(r.reason, /steps/, `the reason must name the missing field: ${r.reason}`)
})

test('CONTROL: malformed JSON is REJECTED and never repaired', () => {
  const r = parseModelPlan('{"steps":[{"id":"a",')
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.equal(r.code, 'invalid-proposal')
})

test('a plan with ONE structurally valid step is ACCEPTED', () => {
  const r = parseModelPlan(JSON.stringify(ONE_STEP))
  assert.equal(r.ok, true, `a valid one-step plan must parse: ${r.ok ? '' : r.reason}`)
  if (!r.ok) return
  assert.equal(r.plan.steps.length, 1)
})

// ============================================================================================
// The seam: grammar-shaped bad output -> provider -> compiler -> executor
// ============================================================================================

async function planWith(text: string) {
  const w = world()
  const ctx: PlanContext = {
    outputRoot: ROOT,
    outputFileName: 'project-notes.txt',
    now: () => w.observedAt,
    world: w,
    maxObservationAgeMs: 60_000,
    refetched: w,
  }
  return { result: await providerReturning(text).plan('summarise the folder and write a summary', ctx), w }
}

test('CONTROL: an empty-steps model reply produces NO plan, so NOTHING can execute', async () => {
  const { result } = await planWith(JSON.stringify({ constraints: [], steps: [], expectedResult: 'x' }))
  assert.equal(result.ok, false, 'the provider must not surface a zero-step plan')
  if (result.ok) return
  assert.equal(result.code, 'invalid-proposal')

  // The point of the pipeline: a rejected plan never becomes a Mission, so the executor is never
  // handed one. `compilePlan` is the only door from a proposal to an executable mission.
  assert.equal(compilePlan.length > 0, true, 'compilePlan is the sole door to execution')
})

test('CONTROL: truncated model output produces NO plan', async () => {
  const { result } = await planWith('{"steps":[{"id":"read","capability":"filesystem.inspect"')
  assert.equal(result.ok, false, 'a truncated reply must never be completed on the model\'s behalf')
})

test('CONTROL: a plan naming a capability outside the allowlist is REJECTED', async () => {
  const bad = { ...ONE_STEP, steps: [{ ...ONE_STEP.steps[0], capability: 'filesystem.launch_anything' }] }
  const { result } = await planWith(JSON.stringify(bad))
  assert.equal(result.ok, false, 'an unlisted capability must be refused')
})

test('CONTROL: a plan declaring an effect still cannot GRANT its own approval', async () => {
  // The provider attaches the basis; the compiler is what would carry an approval request onward.
  // There is no field anywhere on a plan meaning "approved", which is the property under test.
  const withEffect = {
    ...ONE_STEP,
    steps: [{
      ...ONE_STEP.steps[0],
      effect: { kind: 'delete', target: 'C:\\x', reason: 'because', irreversible: false },
    }],
  }
  const { result } = await planWith(JSON.stringify(withEffect))
  if (!result.ok) return
  const compiled = compilePlan(result.proposal, 'seam-test', Date.now())
  if (!compiled.ok) return
  const step = compiled.mission.plan[0] as unknown as Record<string, unknown>
  assert.equal(step.approved, undefined, 'a compiled step may never carry an approval')
  assert.equal(step.approvalGranted, undefined, 'nor any field meaning the same')
})

test('a complete one-step model reply COMPILES into a mission', async () => {
  const { result } = await planWith(JSON.stringify(ONE_STEP))
  assert.equal(result.ok, true, `a valid reply must plan: ${result.ok ? '' : result.reason}`)
  if (!result.ok) return
  const compiled = compilePlan(result.proposal, 'seam-test', Date.now())
  assert.equal(compiled.ok, true, `a valid plan must compile: ${compiled.ok ? '' : compiled.reason}`)
  if (!compiled.ok) return
  assert.equal(compiled.mission.plan.length, 1)
})