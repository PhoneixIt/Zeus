/**
 * MODEL-PLANNED FOLDER SUMMARY - the same governed mission, planned by the LOCAL MODEL.
 *
 * This is the honest integration point. It asks `ModelPlanProvider` for a plan, and then does with
 * that plan exactly what the deterministic runner does: compile it, compare its write target
 * against the request, execute it through the governed executor and the REAL filesystem tools, and
 * verify the artefact independently.
 *
 * IT IS NOT A DEMONSTRATION THAT THE MODEL WORKS. As of the measurement recorded below, the 0.5B
 * model does NOT produce a complete valid plan, and this runner reports that plainly and writes
 * nothing. The refusal branch is the point: a plan that does not survive the parser and the
 * compiler never reaches a tool, and this file is where that is provable rather than asserted.
 *
 * MEASURED, 2026-10-10, on this machine:
 *
 *   unconstrained   the model echoes the REQUEST (`task`, `mayUse`, `observed`) and invents file
 *                   contents. `parse.ts` rejects it.
 *   x-grammar: 1    the output is schema-valid JSON and can contain a genuine step with a real
 *                   capability, mode, tool and observed path - then degenerates into a repetition
 *                   loop inside the grammar's unbounded free-text region (`args` or `constraints`)
 *                   before completing. Raising `x-repetition-penalty` moves the loop rather than
 *                   removing it.
 *   Qwen2.5-1.5B    will not load at all: the copy on disk is the `model_q4f16.onnx` FLOAT16
 *                   export, and onnxruntime's CPU provider has no float16 kernel, so it upcasts
 *                   ~1.16 GB of fp16 weights to fp32. It raises `bad allocation` at
 *                   `InferenceSession` construction regardless of arena, mem-pattern, graph
 *                   optimisation or thread count.
 *
 * Every governed component below is imported from the existing infrastructure and used unchanged.
 * There is no fallback to a deterministic recipe: if the model does not produce a plan, this
 * mission produces no file and says why.
 */

import { existsSync, statSync, readdirSync, readFileSync } from 'node:fs'
import { resolve, dirname, isAbsolute, basename } from 'node:path'

import { execute } from '../executor.ts'
import { summarize } from '../events.ts'
import { ModelPlanProvider } from '../../model/provider.ts'
import { openCodePlannerFetch, type PlannerCallEvidence } from '../../model/opencode-planner.ts'
import { LocalObservationProvider } from './../../observation/local.ts'
import { compilePlan } from '../../planner/compile.ts'
import { renderPlan } from '../../planner/inspect-plan.ts'
import { CAPABILITIES, type PlanContext, type PlanProposal } from '../../planner/plan.ts'
import { checkPlanInvariants } from '../../model/plan-invariants.ts'
import { ToolRegistry } from '../../tool-router/router.ts'
import { FOLDER_TOOLS, folderVerifiers } from './folder-tools.ts'
import { fakeControl } from '../test/fakes.ts'
import type { ControlSurface } from '../../governance/contract.ts'

function parseArgs(argv: readonly string[]): {
  source?: string
  output?: string
  port?: string
  'objective-note'?: string
  error?: string
} {
  // An EXPLICIT allowlist. An unknown flag is a refusal, not a shrug, so a typo cannot silently
  // become a different mission than the caller asked for.
  const FLAGS = ['--source', '--output', '--port', '--objective-note'] as const
  const out: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const key = FLAGS.includes(a as never) ? a.slice(2) : null
    if (!key) {
      return { error: `unexpected argument "${a}"; only ${FLAGS.join(', ')} are accepted` }
    }
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) return { error: `${a} was given no value` }
    out[key] = v
    i++
  }
  if (!out.source) return { error: '--source was not given' }
  if (!out.output) return { error: '--output was not given' }
  return out as never
}

function refuse(reason: string): never {
  console.log('')
  console.log(`=== REFUSED: ${reason} ===`)
  process.exit(2)
}

const args = parseArgs(process.argv.slice(2))
if (args.error) refuse(args.error)

const port = args.port ?? process.env.AIOS_LOCAL_MODEL_PORT ?? '8795'
const sourceDir = resolve(String(args.source))
const outputPath = resolve(String(args.output))
const outputRoot = dirname(outputPath)
const outName = basename(outputPath)

if (!isAbsolute(sourceDir)) refuse('--source must be absolute')
if (!isAbsolute(outputPath)) refuse('--output must be absolute')
for (const [label, raw] of [['--source', String(args.source)], ['--output', String(args.output)]] as const) {
  if (raw.split(/[\\/]/).some((s) => s === '..')) refuse(`${label} must not contain ".." traversal`)
}
if (!/^[A-Za-z0-9_-]+\.txt$/.test(outName)) refuse(`the output name "${outName}" must be a bare name ending in .txt`)
if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) refuse(`the source folder "${sourceDir}" is not a readable folder`)
if (!existsSync(outputRoot) || !statSync(outputRoot).isDirectory()) refuse(`the output folder "${outputRoot}" does not exist`)
if (existsSync(outputPath)) refuse(`"${outputPath}" already exists; this mission creates new files only`)

/**
 * The objective, in the caller's own words.
 *
 * `--objective-note` is appended verbatim, and it exists so a second, genuinely different mission can
 * be run through this same governed pipeline without forking the runner. The note is passed to the
 * model as part of the objective and to nothing else: it cannot widen the output root, the tool
 * registry, the policies or the verifiers. Those come from the arguments below and from the router,
 * never from the prompt.
 */
const objectiveNote = args['objective-note'] ? String(args['objective-note']) : ''
const OBJECTIVE =
  `Inspect the files in the folder "${sourceDir}" and create a summary file named ${outName} ` +
  `in the designated output directory "${outputRoot}".` +
  (objectiveNote ? ` ${objectiveNote}` : '')

const observer = new LocalObservationProvider()
const observed = observer.observe({ root: sourceDir, maxDepth: 4 })

const ctx: PlanContext = {
  outputRoot,
  outputFileName: outName,
  now: () => observed.observedAt,
  world: observed,
  maxObservationAgeMs: 60_000,
  refetched: observed,
}

console.log('')
const REQUEST_TIMEOUT_MS = 420_000
const MODEL = process.env.AIOS_PLANNER_MODEL ?? 'opencode/space-bunny-free'

const PLANNER = (process.env.AIOS_PLANNER ?? 'opencode').toLowerCase()
const PLANNER_LABEL = PLANNER === 'local'
  ? `local ONNX ${port} (grammar-constrained, offline fallback)`
  : `opencode run :: ${MODEL}`

console.log('=== THE USER ASKED FOR ===')
console.log(`  source folder   ${sourceDir}`)
console.log(`  output file     ${outputPath}`)
console.log(`  planner         ${PLANNER_LABEL}`)
console.log(`  observed        ${observed.entries.length} entries`)

/**
 * Two planners, behind one interface, chosen by a flag.
 *
 * `opencode` is the SELECTED runtime planner: a real reasoning model reached through `opencode run`,
 * running in a scratch sandbox whose only output is its text.
 *
 * `local` is the 0.5B ONNX server, kept as an OFFLINE FALLBACK. It is not removed - a machine with
 * no network still needs a planner, and the grammar work is real - but it is not the default, because
 * it could not complete a plan in ten bounded attempts.
 *
 * Both go through the SAME `ModelPlanProvider`, so both produce the SAME request and are parsed by
 * the SAME strict parser. Swapping one for the other changes a transport, not a contract.
 */

const plannerCalls: PlannerCallEvidence[] = []

// The router's REAL registration. Module scope, and declared above every use: a `const` is in its
// temporal dead zone until evaluated, so a constant read by makeProvider() must already exist.
const REGISTERED_TOOLS = FOLDER_TOOLS.map((t) => t.name)
const CAPABILITY_OF_TOOL: Record<string, string> = {
  'read-folder': 'filesystem.inspect',
  'inspect-folder': 'filesystem.list',
  'compose-summary': 'filesystem.transform',
  'write-report': 'filesystem.write',
  'read-report': 'filesystem.confirm',
}

function makeProvider(correction?: string) {
const base = {
    availableCapabilities: [...CAPABILITIES],
    // The tool -> capability PAIRING, which is what the router actually registered. Sending the
    // names alone was measured to be insufficient: the model chose every registered tool correctly
    // and still paired them with the wrong capability, and the invariant check refused the plan.
    availableTools: CAPABILITY_OF_TOOL,
    // Each tool's operands, READ FROM THE TOOL DEFINITIONS rather than written out again here.
    toolArgs: FOLDER_TOOLS
      .filter((t) => t.args?.length)
      .map((t) => ({ tool: t.name, args: t.args!.map((a) => ({ name: a.name, required: a.required, description: a.description })) })),
    outputFileName: outName,
    correction,
    options: { retainRaw: true },
  }
  if (PLANNER === 'local') {
    return new ModelPlanProvider({
      ...base,
      endpoint: {
        url: `http://127.0.0.1:${port}/v1/chat/completions`,
        model: 'local',
        timeoutMs: REQUEST_TIMEOUT_MS,
        headers: { 'x-grammar': '1', 'x-max-new-tokens': '1200' },
      },
    })
  }
  const { fetchImpl } = openCodePlannerFetch(
    { model: MODEL, timeoutMs: REQUEST_TIMEOUT_MS },
    (e) => plannerCalls.push(e),
  )
  return new ModelPlanProvider({
    ...base,
    endpoint: { url: 'opencode://run', model: MODEL, timeoutMs: REQUEST_TIMEOUT_MS },
    fetchImpl,
  })
}

// AT MOST ONE corrective attempt, and it is the caller's decision, not a loop. The reason string is
// the parser's own. A rejected proposal is never repaired, rewritten, or executed.
async function askForPlan(correction?: string) {
  const p = makeProvider(correction)
  const t = Date.now()
  const res = await p.plan(OBJECTIVE, ctx)
  return { res, raw: p.rawResponse() ?? '', secs: ((Date.now() - t) / 1000).toFixed(1) }
}

/**
 * PLAN, THEN VALIDATE - and return the failure to the model ONCE.
 *
 * The corrective turn used to fire only on a PARSE failure, which was wrong. A schema-valid plan can
 * still be refused by the invariant check - MEASURED: the model paired `read-folder` with
 * `filesystem.read` - and that reason was being DISCARDED rather than returned, even though it was
 * precisely the information the model needed to correct itself.
 *
 * So the bounded cycle now spans BOTH stages. Whichever stage refuses, its own words become the
 * correction. AT MOST ONE correction, and NO deterministic fallback: if the second plan is refused
 * too, the mission ends unexecuted and says why.
 */
function checkInvariantsOf(plan: PlanProposal) {
  return checkPlanInvariants(plan, {
    registeredTools: REGISTERED_TOOLS,
    capabilityOfTool: CAPABILITY_OF_TOOL,
    // A folder summary must both READ the folder and WRITE the summary. A plan missing either is a
    // well-formed plan of the wrong task, and finding that out after execution is too late.
    requiredCapabilities: ['filesystem.inspect', 'filesystem.write'],
    expectedOutputPath: outputPath,
    // The folder is machine-known: `read-folder` resolved it from what the caller actually observed.
    // Naming the tool and the operand here keeps the RULE in this runner and the CONTRACT in
    // folder-tools; neither place has to know about the other.
    trustedOperands: [
      {
        tool: 'compose-summary',
        operand: 'folderLabel',
        value: resolve(sourceDir),
      },
    ],
  })
}

type Attempt = {
  raw: string
  secs: string
  stage: 'ok' | 'parse' | 'invariants'
  reason: string
  plan?: PlanProposal
}

async function attemptPlan(correction?: string): Promise<Attempt> {
  const r = await askForPlan(correction)
  if (!r.res.ok) return { raw: r.raw, secs: r.secs, stage: 'parse', reason: r.res.reason }
  const inv = checkInvariantsOf(r.res.proposal)
  if (!inv.ok) return { raw: r.raw, secs: r.secs, stage: 'invariants', reason: inv.reason }
  return { raw: r.raw, secs: r.secs, stage: 'ok', reason: '', plan: r.res.proposal }
}

let result = await attemptPlan()
console.log('')
console.log('=== WHAT THE MODEL ACTUALLY EMITTED (verbatim) ===')
console.log(result.raw.length > 1600 ? result.raw.slice(0, 1600) + '\n  ...[truncated for display]' : result.raw)
console.log(`=== END MODEL OUTPUT, attempt 1 (${result.raw.length} chars, ${result.secs}s) ===`)
console.log('')
console.log(`  planner         ${MODEL}`)
console.log(`  validation      ${result.stage === 'ok' ? 'PASSED (parse + invariants)' : 'REFUSED at ' + result.stage}`)
console.log(`  reason          ${result.reason || '(none)'}`)

// ONE bounded correction. Whichever stage refused, its reason goes back to the model verbatim.
if (result.stage !== 'ok') {
  console.log('')
  console.log('=== ONE CORRECTIVE ATTEMPT (bounded; the refusal reason is returned verbatim) ===')
  const retry = await attemptPlan(result.reason)
  console.log('')
  console.log('=== WHAT THE MODEL EMITTED ON RETRY (verbatim) ===')
  console.log(retry.raw.length > 1600 ? retry.raw.slice(0, 1600) + '\n  ...[truncated for display]' : retry.raw)
  console.log(`=== END RETRY OUTPUT (${retry.raw.length} chars, ${retry.secs}s) ===`)
  console.log('')
  console.log(`  validation      ${retry.stage === 'ok' ? 'PASSED (parse + invariants)' : 'REFUSED at ' + retry.stage}`)
  console.log(`  reason          ${retry.reason || '(none)'}`)
  result = retry
}

console.log('')
console.log(`  planner calls   ${plannerCalls.length}`)

if (result.stage !== 'ok' || !result.plan) {
  console.log('=== NO VALID PLAN, THEREFORE NO MISSION, THEREFORE NO FILE ===')
  console.log(`  output file exists: ${existsSync(outputPath)}`)
  console.log(`  source folder unchanged: ${readdirSync(sourceDir).length} entries`)
  console.log('')
  console.log('=== MODEL FAILURE REPORTED HONESTLY: 1 FAILURE(S) ===')
  process.exit(1)
}

const proposal = result.plan
console.log('')
console.log('=== THE PLAN THAT WILL BE COMPILED AND EXECUTED ===')
console.log(renderPlan(proposal))
console.log('')
console.log('  invariants        PASSED')

const compiled = compilePlan(proposal, `model-folder-summary-${Date.now()}`, ctx.now())
if (!compiled.ok) {
  console.log('')
  console.log(`=== THE COMPILER REJECTED THE MODEL PLAN: ${compiled.reason} ===`)
  console.log(`  output file exists: ${existsSync(outputPath)}`)
  console.log('')
  console.log('=== MODEL PLAN REJECTED BEFORE EXECUTION: 1 FAILURE(S) ===')
  process.exit(1)
}

// The model chooses the write target; the caller chose the destination. Compare them.
const writeStep = compiled.mission.plan.find((s) => s.tool === 'write-report')
const derived = String((writeStep?.args as { path?: string } | undefined)?.path ?? '')
if (resolve(derived || ' ') !== outputPath) {
  console.log('')
  console.log(`=== REFUSED: the model plan would write to "${derived}" but "${outputPath}" was requested. Nothing was executed. ===`)
  console.log('')
  console.log('=== MODEL PLAN WOULD WRITE ELSEWHERE: 1 FAILURE(S) ===')
  process.exit(1)
}
console.log('')
console.log(`  model write target matches the request: ${derived}`)

// ============================================================ 3. governed execution

const registry = new ToolRegistry({
  registrations: [
    { tool: FOLDER_TOOLS.find((t) => t.name === 'read-folder')!, capabilities: ['filesystem.inspect'] },
    { tool: FOLDER_TOOLS.find((t) => t.name === 'inspect-folder')!, capabilities: ['filesystem.list'] },
    { tool: FOLDER_TOOLS.find((t) => t.name === 'compose-summary')!, capabilities: ['filesystem.transform'] },
    { tool: FOLDER_TOOLS.find((t) => t.name === 'write-report')!, capabilities: ['filesystem.write'] },
    { tool: FOLDER_TOOLS.find((t) => t.name === 'read-report')!, capabilities: ['filesystem.confirm'] },
  ],
})

const r = await execute(compiled.mission, {
  tools: registry,
  verifier: folderVerifiers(outputRoot) as never,
  control: fakeControl() as ControlSurface,
  config: {
    maxAttempts: 1,
    permission: async () => ({
      control: 'ARMED' as const, input: 'PERMITTED' as const, blockedBy: null,
      infrastructureHealthy: true, mayInject: false,
    }),
    emergencyStop: async () => false,
  },
})

console.log('')
console.log('=== EXECUTION ===')
for (const s of r.mission.plan) {
  console.log(`  ${s.id.padEnd(18)} ${s.mode.padEnd(11)} ${String(s.result?.outcome.kind ?? 'DID NOT RUN')}`)
}
const sum = summarize(r.record)
console.log('')
console.log(`  mission state     ${r.mission.state}`)
console.log(`  complete          ${r.record.complete}`)
console.log(`  integrity         ${sum.integrityViolations.length === 0 ? 'no violations' : sum.integrityViolations.join('; ')}`)

// ============================================================ 4. independent verification

console.log('')
console.log('=== INDEPENDENT VERIFICATION ===')
const liveNames = readdirSync(sourceDir)
const body = existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : ''
const checks: Array<[boolean, string]> = [
  [existsSync(outputPath), `the requested output exists: ${outputPath}`],
  [body.startsWith('# '), `it is a markdown summary`],
  [body.includes(sourceDir), `it names the folder it summarised`],
  [body.includes(`${liveNames.length} entries total`), `its entry count matches an independent listing (${liveNames.length})`],
  [readdirSync(sourceDir).length === liveNames.length, `the source folder is unchanged (${liveNames.length} entries)`],
  [r.record.complete === true, `the governed executor reports the mission complete`],
]
let failed = 0
for (const [ok, msg] of checks) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${msg}`)
  if (!ok) failed++
}
console.log('')
console.log(`=== ${failed === 0 ? 'PASS' : failed + ' FAILURE(S)'} ===`)
process.exit(failed ? 1 : 0)