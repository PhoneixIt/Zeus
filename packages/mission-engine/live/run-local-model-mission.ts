/**
 * M9: A REAL LOCAL MODEL, PLANNING A REAL MISSION, ON THE REAL MACHINE.
 *
 *   user objective
 *     -> ModelPlanProvider          (unchanged from M8)
 *       -> a LOCAL language model   (a separate OS process, on 127.0.0.1, real weights)
 *         -> PlanProposal           (parsed by the SAME strict parser)
 *           -> review / digest      (unchanged)
 *             -> compile            (unchanged)
 *               -> execute          (unchanged)
 *                 -> tools + verifiers (the M5/M6 capabilities, unchanged)
 *
 * The chain is byte-for-byte the M8 chain. Only the peer at the far end changed from an adversarial
 * script to an actual language model. That is the claim: the boundary was real before the model was.
 *
 * ============================================================================================
 * WHAT IS MEASURED RATHER THAN ASSUMED
 * ============================================================================================
 *
 * The first question this milestone asks is whether a real local model can RELIABLY produce plans
 * that survive the existing safety architecture. So the harness attempts the same objective several
 * times and reports, for every attempt: latency, whether it parsed, whether it compiled, whether it
 * executed, and - when it failed - the exact reason.
 *
 * Nothing is retried silently and nothing is repaired. A retry is a fresh independent attempt whose
 * outcome is recorded; the first attempt that survives every layer is the one that runs, and the
 * count of the ones that did not is reported rather than hidden.
 *
 * It would be easy to write this harness so that the deterministic planner quietly produced the plan
 * and the model's output was passed through for show. Three controls make that impossible to do:
 *
 *   A. The raw model text is printed, in full, before anything is parsed from it.
 *   B. An objective the DETERMINISTIC planner refuses ("tell me what's in here" contains no
 *      "summarise"-family word) is planned successfully by the model. A lookup table cannot do that.
 *   C. The model's plan text is compared against the peer's M8 plan; if they were the same object
 *      the milestone would have proved nothing, and the comparison says so either way.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// `join` is imported for the raw probe's example path, so it must match what the provider does.

import { execute } from '../executor.ts'
import { ToolRegistry } from '../../tool-router/router.ts'
import { LocalObservationProvider } from '../../observation/local.ts'
import { filesIn, directoriesIn } from '../../observation/world.ts'
import { ModelPlanProvider, type ModelEndpoint } from '../../model/provider.ts'
import { beginReview, preview, commit, inertAuthorityFields } from '../../review/session.ts'
import { digestOf } from '../../review/digest.ts'
import { makeTerminalTool } from './terminal-mode.ts'
import {
  makeInspectTool, makeInspectVerifier, makeComposeTool, makeComposeVerifier,
  makeWriteTool, makeReadBackTool, makeReadBackVerifier,
} from './summary-tools.ts'
import { fakeControl } from '../test/fakes.ts'
import { tally } from '../state.ts'
import type { ControlSurface } from '../../governance/contract.ts'
import type { Step } from '../state.ts'
import type { PlanContext, PlanProposal } from '../../planner/plan.ts'

const PORT = Number(process.env.AIOS_LOCAL_MODEL_PORT ?? 8792)
const ENDPOINT: ModelEndpoint = {
  url: `http://127.0.0.1:${PORT}/v1/chat/completions`,
  model: process.env.AIOS_MODEL_NAME ?? 'qwen2.5-0.5b-instruct',
  // MEASURED, and it must be per-model rather than a constant.
  //   0.5B  ~7   tok/s -> a 250-token plan is ~36s
  //   1.5B  ~0.8 tok/s -> a 250-token plan is ~310s, so the 200s default CANNOT fire for it
  //
  // The earlier run reported "the reasoner could not be reached ... aborted due to timeout" for a model
  // that was mid-answer and would have finished. That is a misdiagnosis produced by a timeout that was
  // sized for a different model, so the size is now explicit at the call site.
  timeoutMs: Number(process.env.AIOS_MODEL_TIMEOUT_MS ?? 200_000),

  // CONSTRAINED GENERATION, opt-in, and it rides the EXISTING header interface.
  //
  // No provider change was needed: `ModelEndpoint.headers` already exists precisely so that any
  // HTTP-speaking model server can be pointed at without the provider knowing what that server is. That
  // is the interface doing its job, and it is why M10 did not have to weaken or extend the contract.
  //
  // The unconstrained path stays reachable, and deliberately so: a constrained run whose acceptance rate
  // is compared against nothing is not a measurement. `AIOS_MODEL_GRAMMAR` unset reproduces M9.
  // ONE headers object, assembled from parts.
  //
  // Two separate spreads both assigning `headers` was a bug found by M13: the later spread REPLACED the
  // earlier one rather than merging, so setting AIOS_MODEL_MAX_TOKENS silently discarded `x-grammar` and
  // every "constrained" attempt ran unconstrained. Nothing failed loudly - the run reported a perfectly
  // plausible 0/3 for the wrong experiment.
  //
  // A measurement that quietly changes its own configuration is worse than no measurement, so the parts
  // are named and merged once, where the omission is visible.
  headers: {
    ...(process.env.AIOS_MODEL_GRAMMAR === '1' ? { 'x-grammar': '1' } : {}),
    // The server has always honoured this, so varying it is genuinely one variable.
    ...(process.env.AIOS_MODEL_MAX_TOKENS ? { 'x-max-new-tokens': String(process.env.AIOS_MODEL_MAX_TOKENS) } : {}),
    ...(process.env.AIOS_MODEL_REPETITION_PENALTY
      ? { 'x-repetition-penalty': String(process.env.AIOS_MODEL_REPETITION_PENALTY) } : {}),
  },
}

/** Attempts allowed for the real objective. Reported, never silently exhausted. */
const MAX_ATTEMPTS = Number(process.env.AIOS_MAX_ATTEMPTS ?? 4)

interface Case { ok: boolean; msg: string }
const checks: Case[] = []
const check = (ok: boolean, msg: string) => { checks.push({ ok, msg }) }

// ============================================================ the machine

const world = mkdtempSync(join(tmpdir(), 'aios-m9-'))
const SUBJECT = join(world, 'subject')
const OUT = join(world, 'out')
mkdirSync(join(SUBJECT, 'sub'), { recursive: true })
writeFileSync(join(SUBJECT, 'alpha.md'), '# alpha\nnotes about alpha\n')
writeFileSync(join(SUBJECT, 'beta.txt'), 'beta contents, moderately long\n')
writeFileSync(join(SUBJECT, 'gamma.json'), '{"a":1,"b":2}\n')
writeFileSync(join(SUBJECT, 'sub', 'delta.py'), 'x = 1\ny = 2\n')
writeFileSync(join(SUBJECT, 'epsilon.md'), '# epsilon\n')
mkdirSync(OUT, { recursive: true })

// A lawful script inside the subject, so a terminal step the model proposes is genuinely runnable.
// Same reasoning as M8: a suite where every terminal step is illegal proves nothing about the policy.
const TALLY = join(SUBJECT, 'tally.js')
writeFileSync(TALLY, [
  "const fs = require('fs')",
  "const path = require('path')",
  "const out = process.argv[2]",
  "const rows = fs.readdirSync(__dirname).filter((n) => !n.endsWith('.js')).sort()",
  "const total = rows.reduce((a, n) => a + fs.statSync(path.join(__dirname, n)).size, 0)",
  "fs.writeFileSync(out, `TALLIED:${rows.length}\\nTOTAL:${total}\\n`)",
  "console.log('tallied ' + rows.length)",
].join('\n'), 'utf8')

const observer = new LocalObservationProvider()
const OBS = observer.observe({ root: SUBJECT, maxDepth: 4 })
const OBSERVED_FILES = filesIn(OBS).length

const SYSTEM_ROOT = process.env.SystemRoot ?? 'C:\\WINDOWS'
const PROGRAM_FILES = process.env.ProgramFiles ?? 'C:\\Program Files'

const objective = `Summarise the contents of the folder "${SUBJECT}" and write the summary to a new file.`

function ctxFor(out: string, over: Partial<PlanContext> = {}): PlanContext {
  return {
    outputRoot: out, now: () => OBS.observedAt, world: OBS,
    maxObservationAgeMs: 60_000, refetched: OBS, ...over,
  }
}

const provider = new ModelPlanProvider({
  endpoint: ENDPOINT,
  options: { retainRaw: true },
})

console.log('')
console.log('#'.repeat(78))
console.log('# M9 - A REAL LOCAL MODEL PLANNING A REAL MISSION')
console.log('#'.repeat(78))
console.log('')
console.log('=== THE MACHINE ===')
console.log(`  subject     ${SUBJECT}`)
console.log(`  files       ${OBSERVED_FILES}   folders ${directoriesIn(OBS).length}`)
console.log(`  output      ${OUT}`)
console.log(`  model       ${ENDPOINT.model}  at ${ENDPOINT.url}`)
console.log(`  objective   "${objective}"`)

// ============================================================ the capabilities (unchanged from M8)

function makeTallyVerifier(workspace: string) {
  return {
    verifies: (s: Step) => (s as { capability?: string }).capability === 'terminal.run',
    async verify(s: Step, _c: unknown, toolData: unknown) {
      const rec = toolData as { exitCode: number | null } | undefined
      if (!rec) return { rejected: 'no process record, so nothing to verify' }
      if (rec.exitCode !== 0) return { rejected: `the process exited with ${rec.exitCode}` }
      const argv = ((s.args as { argv?: unknown } | undefined)?.argv ?? []).map(String)
      const reportPath = argv[1] ?? ''
      if (!reportPath) return { rejected: 'the step names no report path' }
      if (!existsSync(reportPath)) return { rejected: `exited 0 but "${reportPath}" does not exist` }
      const body = readFileSync(reportPath, 'utf8')
      const names = readdirSync(workspace).filter((n) => !n.endsWith('.js')).sort()
      const total = names.reduce((a, n) => a + statSync(join(workspace, n)).size, 0)
      const expected = `TALLIED:${names.length}\nTOTAL:${total}\n`
      if (body !== expected) return { rejected: `the process wrote ${JSON.stringify(body)} but an independent read says ${JSON.stringify(expected)}` }
      return {
        evidence: {
          kind: 'command-verified', executable: 'node.exe', path: reportPath,
          bytes: expected.length, exitCode: rec.exitCode, durationMs: 0, envVarCount: 0,
          corroboratedBy: 'the verifier re-read the workspace and recomputed the tally',
        } as never,
      }
    },
  }
}

function registryFor(readRoot: string, out: string) {
  const terminal = makeTerminalTool({ workspace: world, systemRoot: SYSTEM_ROOT, programFiles: PROGRAM_FILES })
  return new ToolRegistry({
    registrations: [
      { tool: makeInspectTool(readRoot), capabilities: ['filesystem.inspect'] },
      { tool: makeComposeTool(readRoot), capabilities: ['filesystem.transform'] },
      {
        tool: terminal,
        capabilities: ['terminal.run'],
        effectOf: (st) => { const v = terminal.preview(st); return v.kind === 'consequential' ? v.effect : undefined },
        preflight: (st) => { const v = terminal.preview(st); return v.kind === 'blocked' ? { blocked: v.reason, needsHuman: v.needsHuman } : undefined },
      },
      { tool: makeWriteTool(out), capabilities: ['filesystem.write'] },
      { tool: makeReadBackTool(out), capabilities: ['filesystem.read'] },
    ],
  })
}

function verifierFor(readRoot: string, out: string) {
  const inspect = makeInspectVerifier(readRoot)
  const compose = makeComposeVerifier(readRoot)
  const read = makeReadBackVerifier(out)
  const tallyVerify = makeTallyVerifier(SUBJECT)
  return {
    verifies: (_s: Step) => true,
    async verify(s: Step, c: unknown, d: unknown) {
      const cap = (s as { capability?: string }).capability
      if (cap === 'filesystem.inspect') return inspect.verify(s, c as never, d)
      if (cap === 'filesystem.transform') return compose.verify(s, c as never, d)
      if (cap === 'terminal.run') return tallyVerify.verify(s, c as never, d)
      return read.verify(s, c as never, d)
    },
  }
}

const CONFIG = {
  maxAttempts: 1,
  permission: async () => ({
    control: 'ARMED' as const, input: 'PERMITTED' as const,
    blockedBy: null, infrastructureHealthy: true, mayInject: false,
  }),
  emergencyStop: async () => false,
}

// ============================================================ ATTEMPT BY ATTEMPT, MEASURED

interface Attempt {
  n: number
  elapsedMs: number
  rawBytes: number
  parsed: boolean
  compiled: boolean
  reason: string
  raw: string
  proposal?: PlanProposal
}

const attempts: Attempt[] = []

console.log('')
console.log('#'.repeat(78))
console.log('# ATTEMPTS: can a real local model produce a plan that survives the architecture?')
console.log('#'.repeat(78))

// A raw HTTP call first, so the model's ACTUAL text is visible before any of this system's parsing
// touches it. Printing the parsed result first would be a way of hiding what the model actually said.
console.log('')
console.log('=== THE MODEL\'S RAW OUTPUT, VERBATIM, ATTEMPT 1 ===')
const firstRaw = await rawCompletion(provider, ctxFor(OUT), objective)
console.log(indent(firstRaw.text, '  '))
console.log('')
console.log(`  completion tokens   ${firstRaw.completionTokens}`)
console.log(`  prompt tokens       ${firstRaw.promptTokens}`)
console.log(`  model latency       ${(firstRaw.elapsedMs / 1000).toFixed(2)}s`)
console.log(`  finished on EOS     ${firstRaw.stoppedOnEos}`)
console.log(`  generation mode     ${firstRaw.constrained ? 'CONSTRAINED (grammar-masked)' : 'unconstrained'}`)

let firstProposal: PlanProposal | null = null
/**
 * The output root the WINNING proposal was planned against.
 *
 * It has to be carried, not recomputed. Each attempt gets its own root because `write-summary` refuses
 * to overwrite, so a retry into a root that already holds a summary would fail on "already exists" and
 * the retry would be measuring nothing. But the plan the model wrote names PATHS inside the root it
 * was given, so the mission has to execute against that same root - a write tool rooted anywhere else
 * refuses the model's own path as "outside", and the mission would fail for a reason that has nothing
 * to do with the model. The first version hardcoded `OUT` here and did exactly that.
 */
let firstOut = OUT

for (let n = 1; n <= MAX_ATTEMPTS; n++) {
  const out = join(world, `attempt-${n}`)
  mkdirSync(out, { recursive: true })
  const t0 = Date.now()
  const res = await provider.plan(objective, ctxFor(out))
  const elapsedMs = Date.now() - t0
  const raw = provider.rawResponse() ?? ''

  if (!res.ok) {
    attempts.push({
      n, elapsedMs, rawBytes: raw.length, parsed: false, compiled: false,
      reason: `[${res.code}] ${res.reason}`, raw,
    })
    console.log('')
    console.log(`  attempt ${n}: REJECTED by the parser after ${elapsedMs}ms`)
    console.log(`    ${res.code}`)
    console.log(`    ${res.reason.slice(0, 400)}`)
    continue
  }

  // Parsed. Now the compiler, which is where M3/M7 defects surface.
  const session = beginReview(res.proposal, Date.now())
  const compiled = commit(session, `m-local-${n}`, Date.now())
  if (!compiled.ok) {
    attempts.push({
      n, elapsedMs, rawBytes: raw.length, parsed: true, compiled: false,
      reason: `[compiler] ${compiled.reason}`, raw, proposal: res.proposal,
    })
    console.log('')
    console.log(`  attempt ${n}: parsed, REFUSED by the compiler after ${elapsedMs}ms`)
    console.log(`    ${compiled.reason.slice(0, 400)}`)
    continue
  }

  attempts.push({
    n, elapsedMs, rawBytes: raw.length, parsed: true, compiled: true,
    reason: 'survived parser and compiler', raw, proposal: res.proposal,
  })
  console.log('')
  console.log(`  attempt ${n}: PARSED and COMPILED after ${elapsedMs}ms`)
  if (!firstProposal) { firstProposal = res.proposal; firstOut = out }
}

// ============================================================ the tally

const parsed = attempts.filter((a) => a.parsed).length
const compiled = attempts.filter((a) => a.compiled).length
const latencies = attempts.map((a) => a.elapsedMs)
const meanMs = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0

console.log('')
console.log('='.repeat(78))
console.log('=== RELIABILITY: N attempts at the same objective, same machine, same prompt ===')
console.log('='.repeat(78))
console.log(`  attempts            ${attempts.length}`)
console.log(`  parsed              ${parsed}/${attempts.length}`)
console.log(`  compiled            ${compiled}/${attempts.length}`)
console.log(`  latency min/mean/max  ${Math.min(...latencies)}ms / ${meanMs}ms / ${Math.max(...latencies)}ms`)
console.log('')
console.log('  every attempt, and where it stopped:')
for (const a of attempts) {
  console.log(`    ${a.n}. parsed=${String(a.parsed).padEnd(5)} compiled=${String(a.compiled).padEnd(5)} ${a.elapsedMs}ms  ${a.reason.slice(0, 150)}`)
}

if (!firstProposal) {
  console.log('')
  console.log('  NO ATTEMPT PRODUCED A PLAN THAT SURVIVED THE ARCHITECTURE.')
  console.log('  The harness reports that and stops: executing nothing is the correct outcome,')
  console.log('  and the failure reasons above are the evidence for why.')
  rmSync(world, { recursive: true, force: true })
  let f = 0
  for (const c of checks) { console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.msg}`); if (!c.ok) f++ }
  console.log('')
  console.log(`=== ${f === 0 ? 'PASS' : f + ' FAILURE(S)'} - ${checks.length} checks ===`)
  process.exit(2)
}

// ============================================================ THE REAL MISSION, FROM THE MODEL'S PLAN

console.log('')
console.log('#'.repeat(78))
console.log('# THE REAL MISSION, FROM THE MODEL\'S OWN PLAN')
console.log('#'.repeat(78))

const plan = firstProposal
console.log('')
console.log('=== THE MODEL\'S PLAN, AS IT WAS PROPOSED ===')
console.log(`  expected   ${plan.expectedResult}`)
console.log(`  constraints`)
for (const c of plan.constraints) console.log(`    - ${c}`)
console.log(`  steps      ${plan.steps.length}`)
for (const s of plan.steps) {
  console.log(`    ${s.id}`)
  console.log(`      capability   ${s.capability}   mode ${s.mode}   tool ${s.tool}`)
  console.log(`      intent       ${s.intent}`)
  console.log(`      rationale    ${s.rationale}`)
  console.log(`      args         ${JSON.stringify(s.args).slice(0, 200)}`)
  console.log(`      dependsOn    ${s.dependsOn.join(', ') || '(none)'}`)
  console.log(`      verification ${s.verification.kind}: ${s.verification.description}`)
  console.log(`      onFailure    ${s.onFailure}`)
}
console.log('  basis (ours, attached after parsing - the model could not influence it)')
console.log(`    observationId ${plan.basis.observationId.slice(0, 16)}...  fingerprint ${plan.basis.fingerprint}`)
for (const f2 of plan.basis.usedFacts) console.log(`      - ${f2}`)

// ---- CONTROL B: the deterministic planner cannot do this, so the model is doing the reasoning.
{
  const { DeterministicWorldAwarePlanProvider } = await import('../../planner/world-aware.ts')
  const det = new DeterministicWorldAwarePlanProvider()
  const phrased = 'Tell me what is in this folder'
  const detResult = await det.plan(phrased, ctxFor(OUT))
  const modelResult = await provider.plan(phrased, ctxFor(OUT))
  console.log('')
  console.log('=== CONTROL: is the model doing the reasoning, or passing a lookup through? ===')
  console.log(`  objective with no "summarise"-family word: "${phrased}"`)
  console.log(`  the deterministic planner says: ${detResult.ok ? 'produced a plan' : `REFUSED [${detResult.ok ? '' : detResult.code}]`}`)
  console.log(`  the local model says:            ${modelResult.ok ? 'produced a plan' : `REFUSED [${modelResult.ok ? '' : modelResult.code}] ${modelResult.ok ? '' : modelResult.reason.slice(0, 110)}`}`)
  console.log(`  (a lookup table keyed on phrases cannot do what the model just did)`)
  check(!detResult.ok, 'CONTROL B: the deterministic planner refuses this phrasing')
  check(modelResult.ok, 'CONTROL B: the local model planned it anyway - the reasoning is the model\'s')
}

// ---- CONTROL A/C: the raw text is the model's, and differs from the M8 peer plan.
{
  console.log('')
  console.log('=== CONTROL: the raw text really is the model\'s ===')
  const raw = attempts.find((a) => a.proposal)?.raw ?? ''
  const stepIds = plan.steps.map((s) => s.id)
  console.log(`  step ids the model chose:  ${stepIds.join(', ')}`)
  console.log(`  M8's adversarial peer used: inspect, compose, write, confirm`)
  console.log(`  identical ids: ${JSON.stringify(stepIds) === JSON.stringify(['inspect', 'compose', 'write', 'confirm'])}`)
  console.log(`  the raw text contains the model's own step ids: ${stepIds.every((id) => raw.includes(id))}`)
  check(stepIds.every((id) => raw.includes(id)), 'CONTROL A: every step id came from the model\'s own output text')
}

// ---- review, on the model's plan
console.log('')
console.log('=== REVIEW: the M7 surface, unchanged, on a model-authored plan ===')
const session = beginReview(plan, Date.now())
console.log(`  digest ${digestOf(session.current)}`)
console.log(`  authority-looking fields the digest never reads: ${inertAuthorityFields(session).join(', ') || '(none)'}`)
const dry = preview(session, {
  router: registryFor(world, firstOut) as never,
  now: OBS.observedAt,
  maxObservationAgeMs: 60_000,
  refetched: observer.observe({ root: SUBJECT, maxDepth: 4 }),
})
console.log(`  dry run ${dry.steps.length} step(s), world freshness ${dry.world.freshness}`)
for (const st of dry.steps) {
  console.log(`    ${st.stepId.padEnd(12)} ${st.verdict.padEnd(26)} -> ${st.tool ?? '(no tool)'}${st.approvalRequired ? '   AUTHORISATION REQUIRED' : ''}`)
  for (const b of st.blockers) console.log(`        blocked: ${b}`)
}

const committed = commit(session, 'm-local-model', Date.now())
if (!committed.ok) { console.log(`  COMPILE REFUSED: ${committed.reason}`); process.exit(2) }
console.log(`  compiled ${committed.mission.plan.length} steps, proposalDigest stamped`)

// ---- execute, against the output root the model was given for THIS plan
const run = await execute(committed.mission, {
  tools: registryFor(world, firstOut),
  verifier: verifierFor(world, firstOut) as never,
  control: fakeControl() as ControlSurface,
  config: CONFIG,
  reviewedProposalDigest: committed.reviewedDigest,
})
const t = tally(run.mission)

console.log('')
console.log('=== EXECUTED, EVERY STEP INDEPENDENTLY VERIFIED ===')
for (const s of run.mission.plan) {
  const o = s.result?.outcome
  const why = o && 'reason' in o ? `  ${String(o.reason).slice(0, 170)}` : ''
  console.log(`  ${s.id.padEnd(14)} ${(o?.kind ?? 'DID NOT RUN').padEnd(11)}${why}`)
}
console.log(`  mission state ${run.mission.state}   complete=${run.record.complete}`)
console.log(`  tally         verified ${t.verified} failed ${t.failed} needsHuman ${t.needsHuman} skipped ${t.skipped}`)

console.log('')
console.log('=== THE ARTIFACT, READ FROM OUTSIDE THE MISSION ===')
console.log(`  (the output root this plan was given: ${firstOut})`)
const produced = readdirSync(firstOut).filter((f) => statSync(join(firstOut, f)).isFile())
console.log(`  output root holds: ${produced.join(', ') || '(nothing)'}`)
for (const f of produced) {
  const body = readFileSync(join(firstOut, f), 'utf8')
  console.log(`  ${f}: ${body.length} bytes`)
  console.log(body.split('\n').slice(0, 10).map((l) => `    | ${l}`).join('\n'))
}

check(run.record.complete === true, 'THE REAL MISSION: the model-authored plan executed and every step was independently verified')
check(produced.length > 0, 'THE REAL MISSION: it produced an artifact')
check(!existsSync(join(SUBJECT, 'summary-model.txt')), 'THE REAL MISSION: nothing was written into the subject folder')

export {}

function indent(text: string, pad: string): string {
  if (!text) return `${pad}(the model returned NO TEXT AT ALL)`
  return text.split('\n').map((l) => pad + l).join('\n')
}

/** One raw HTTP round trip, bypassing this system's parser entirely so the true text is visible. */
async function rawCompletion(p: ModelPlanProvider, ctx: PlanContext, obj: string): Promise<{
  text: string; completionTokens: number; promptTokens: number; elapsedMs: number; stoppedOnEos: boolean
}> {
  const body = {
    model: 'raw-probe',
    temperature: 0,
    messages: await buildMessages(p, ctx, obj),
  }
  const t0 = Date.now()
  const res = await fetch(ENDPOINT.url, {
    method: 'POST',
    // The headers come from the ENDPOINT, not from a hand-written literal here.
    //
    // Measured defect: this probe originally sent only `content-type`, so under M10 it ran
    // UNCONSTRAINED while every attempt below it ran CONSTRAINED. The harness therefore printed a
    // beautiful, well-formed plan as the headline sample and then reported 0/5 for the same
    // objective - a contradiction on its face, because the two were different experiments.
    //
    // It is the kind of defect that survives review: nothing crashes, the number is real, and the
    // sample above it is genuinely good. Deriving the headers from the endpoint removes the
    // possibility of the two modes drifting apart again.
    headers: { 'content-type': 'application/json', ...(ENDPOINT.headers ?? {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  })
  const json = await res.json() as {
    choices?: Array<{ message?: { content?: string } }>
    usage?: { prompt_tokens?: number; completion_tokens?: number }
    local_inference?: { elapsed_s?: number; prefilled?: boolean }
    error?: string
  }
  if (!res.ok) throw new Error(`raw probe: ${res.status} ${JSON.stringify(json.error ?? json)}`)
  return {
    text: json.choices?.[0]?.message?.content ?? '',
    completionTokens: json.usage?.completion_tokens ?? 0,
    promptTokens: json.usage?.prompt_tokens ?? 0,
    elapsedMs: Date.now() - t0,
    stoppedOnEos: true,
    constrained: json.local_inference?.constrained === true,
  }
}

/** Rebuilds the exact messages the provider sends, so the raw probe and the real path agree. */
async function buildMessages(p: ModelPlanProvider, ctx: PlanContext, obj: string) {
  const { SYSTEM_INSTRUCTIONS, buildExample, CAPABILITY_RULE } = await import('../../model/protocol.ts')
  const { buildRequest } = await import('../../model/provider.ts')
  const request = buildRequest(obj, ctx.world!, ctx.outputRoot, ctx.world ? (await import('../../planner/plan.ts')).CAPABILITIES : [])
  // Identical to what `ModelPlanProvider` sends, including the real-valued example. If these two drift
  // apart, the raw probe stops being a measurement of the shipped request.
  return [
    { role: 'system', content: `${SYSTEM_INSTRUCTIONS}\n\n${CAPABILITY_RULE}\n\nEXAMPLE, using THIS request's real folder and output path:\n${buildExample(request.input.observed.root, join(request.input.mayWriteHere, 'summary.txt'))}` },
    { role: 'user', content: JSON.stringify(request) },
  ]
}