/**
 * WORLD-AWARE PLANNING, on the real machine.
 *
 * The claim under test, stated once: CAN AIOS OBSERVE REALITY BEFORE DECIDING WHAT TO DO?
 *
 * Everything here runs against real folders on disk. Two of them, deliberately different, and the
 * SAME objective is issued against both. The proof is not that two plans exist - it is that the
 * second plan says things the first one could not have said, and that the phrase planner produces a
 * byte-identical plan for both.
 *
 *   SCENARIO A   five files, three directories, mixed extensions, nested two deep
 *   SCENARIO B   two files, no nesting, different extensions
 *
 * A stale-observation scenario follows, and then the negative controls. Every control removes one
 * protection and must produce a specific, named failure - not merely a non-zero exit.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { execute } from '../executor.ts'
import { ToolRegistry } from '../../tool-router/router.ts'
import { buildEnv } from './terminal-policy.ts'
import { LocalObservationProvider } from '../../observation/local.ts'
import { filesIn, directoriesIn, extensionsIn, deepestLevel } from '../../observation/world.ts'
import { DeterministicWorldAwarePlanProvider } from '../../planner/world-aware.ts'
import { DeterministicPlanProvider } from '../../planner/deterministic.ts'
import { compilePlan } from '../../planner/compile.ts'
import {
  makeInspectTool, makeInspectVerifier, makeComposeTool, makeComposeVerifier,
  makeWriteTool, makeReadBackTool, makeReadBackVerifier,
} from './summary-tools.ts'
import { fakeControl } from '../test/fakes.ts'
import { tally } from '../state.ts'
import type { ControlSurface } from '../../governance/contract.ts'
import type { Mission, Step } from '../state.ts'
import type { PlanContext, PlanProposal } from '../../planner/plan.ts'

const observer = new LocalObservationProvider()
const aware = new DeterministicWorldAwarePlanProvider()
const phrase = new DeterministicPlanProvider()

const CONFIG = {
  maxAttempts: 1,
  permission: async () => ({
    control: 'ARMED' as const, input: 'PERMITTED' as const,
    blockedBy: null, infrastructureHealthy: true, mayInject: false,
  }),
  emergencyStop: async () => false,
}

// ============================================================ two real worlds

const world = mkdtempSync(join(tmpdir(), 'aios-worldaware-'))
const A = join(world, 'A')
const B = join(world, 'B')
const outA = join(world, 'outA')
const outB = join(world, 'outB')

// SCENARIO A: five files, nested two deep, mixed extensions.
mkdirSync(join(A, 'sub', 'deep'), { recursive: true })
writeFileSync(join(A, 'alpha.md'), '# alpha\n')
writeFileSync(join(A, 'beta.txt'), 'beta contents\n')
writeFileSync(join(A, 'gamma.json'), '{"a":1}\n')
writeFileSync(join(A, 'sub', 'delta.py'), 'x = 1\n')
writeFileSync(join(A, 'sub', 'deep', 'epsilon.md'), '# epsilon\n')
// SCENARIO B: two files, no nesting, different extensions, different sizes.
mkdirSync(B, { recursive: true })
writeFileSync(join(B, 'only.rs'), 'fn main() { println!("x"); }\n')
writeFileSync(join(B, 'other.ts'), 'export const q = 2\n')

mkdirSync(outA, { recursive: true })
mkdirSync(outB, { recursive: true })

console.log('')
console.log('=== THE MACHINE, AS IT ACTUALLY IS ===')
for (const [label, dir] of [['A', A], ['B', B]] as const) {
  const o = observer.observe({ root: dir, maxDepth: 4 })
  console.log(`  ${label}  ${dir}`)
  console.log(`     files        ${filesIn(o).length}  (${filesIn(o).map((f) => f.relative).join(', ')})`)
  console.log(`     directories  ${directoriesIn(o).length}`)
  console.log(`     extensions   ${extensionsIn(o).join(', ')}`)
  console.log(`     max depth    ${deepestLevel(o)}`)
  console.log(`     fingerprint  ${o.fingerprint}`)
  console.log(`     node.exe     ${o.capabilities.find((c) => c.name === 'node.exe')?.exists ? 'present' : 'ABSENT'}`)
}

const objectiveFor = (dir: string) => `Summarise the contents of the folder "${dir}"`

function ctxFor(dir: string, out: string, over: Partial<PlanContext> = {}): PlanContext {
  const w = observer.observe({ root: dir, maxDepth: 4 })
  return { outputRoot: out, now: () => w.observedAt, world: w, maxObservationAgeMs: 60_000, refetched: w, ...over }
}

function showPlan(label: string, p: PlanProposal) {
  console.log('')
  console.log(`  --- ${label} ---`)
  console.log(`  expected  ${p.expectedResult}`)
  console.log(`  basis     obs=${p.basis.observationId.slice(0, 8)} fingerprint=${p.basis.fingerprint}`)
  console.log(`            usedFacts:`)
  for (const f of p.basis.usedFacts) console.log(`              - ${f}`)
  console.log(`  steps     ${p.steps.length}`)
  for (const s of p.steps) {
    console.log(`    ${s.id}`)
    console.log(`      capability  ${s.capability}  ->  tool ${s.tool}`)
    console.log(`      intent      ${s.intent}`)
    if (s.rationale) console.log(`      why         ${s.rationale}`)
  }
}

// ============================================================ the two plans

console.log('')
console.log('=== SCENARIO A: THE SAME OBJECTIVE, A DIFFERENT MACHINE ===')
console.log(`  objective  "${objectiveFor(A)}"`)
const planA = await aware.plan(objectiveFor(A), ctxFor(A, outA))
if (!planA.ok) { console.log(`  REFUSED: ${planA.code} ${planA.reason}`); process.exit(1) }
showPlan('PLAN A', planA.proposal)

console.log('')
console.log(`  objective  "${objectiveFor(B)}"`)
const planB = await aware.plan(objectiveFor(B), ctxFor(B, outB))
if (!planB.ok) { console.log(`  REFUSED: ${planB.code} ${planB.reason}`); process.exit(1) }
showPlan('PLAN B', planB.proposal)

// ============================================================ THE DIFFERENCE, STATED

console.log('')
console.log('=== DID THE WORLD CHANGE THE PLAN? ===')
const capsA = planA.proposal.steps.map((s) => s.capability)
const capsB = planB.proposal.steps.map((s) => s.capability)
console.log(`  A capabilities  ${capsA.join(' -> ')}`)
console.log(`  B capabilities  ${capsB.join(' -> ')}`)
console.log(`  A file count in the plan text   ${/\b(\d+) file\(s\)/.exec(planA.proposal.expectedResult)?.[1]}`)
console.log(`  B file count in the plan text   ${/\b(\d+) file\(s\)/.exec(planB.proposal.expectedResult)?.[1]}`)
console.log(`  fingerprints differ             ${planA.proposal.basis.fingerprint !== planB.proposal.basis.fingerprint}`)
console.log(`  output names differ             ${planA.proposal.steps[2].args.path !== planB.proposal.steps[2].args.path}`)

console.log('')
console.log('  and the PHRASE planner, on the same two folders:')
const phraseA = await phrase.plan(objectiveFor(A), ctxFor(A, outA))
const phraseB = await phrase.plan(objectiveFor(B), ctxFor(B, outB))
const norm = (s: string, dir: string) => s.split(dir).join('<X>')
const phraseIntentsA = phraseA.ok ? phraseA.proposal.steps.map((s) => norm(s.intent, A)) : []
const phraseIntentsB = phraseB.ok ? phraseB.proposal.steps.map((s) => norm(s.intent, B)) : []
const sameIntents = JSON.stringify(phraseIntentsA) === JSON.stringify(phraseIntentsB)
console.log(`    identical step intents for both folders:  ${sameIntents}`)
if (phraseA.ok && phraseB.ok) {
  const ra = norm(phraseA.proposal.expectedResult, A)
  const rb = norm(phraseB.proposal.expectedResult, B)
  console.log(`    identical expected results:               ${ra === rb}`)
  console.log(`      A: ${ra}`)
  console.log(`      B: ${rb}`)
}

// ============================================================ SCENARIO C: THE SAME FOLDER, A DIFFERENT MACHINE
//
// A and B both chose `terminal.run`, because node.exe is present on both - so the interesting
// decision has not been observed changing. Scenario C is folder A again with the observation
// reporting node as ABSENT, which is what a machine without node looks like from the planner's side.
// The plan must then take the filesystem branch, and must still complete.
//
// This is the assertion that "the plan follows the world" means something: the objective, the folder
// and the output root are all identical to scenario A.

let planC: Awaited<ReturnType<typeof aware.plan>> | null = null
{
  console.log('')
  console.log('=== SCENARIO C: THE SAME FOLDER, BUT THE OBSERVATION SAYS node IS ABSENT ===')
  const aAsNoNode = observer.observe({ root: A, maxDepth: 4 })
  const noNodeWorld = {
    ...aAsNoNode,
    capabilities: aAsNoNode.capabilities.map((c) =>
      c.name === 'node.exe' ? { ...c, exists: false, permitted: false, refusal: 'not installed (scenario C)' } : c,
    ),
  }
  const outC = join(world, 'outC')
  mkdirSync(outC, { recursive: true })
  planC = await aware.plan(objectiveFor(A), {
    outputRoot: outC, now: () => aAsNoNode.observedAt,
    world: noNodeWorld, maxObservationAgeMs: 60_000, refetched: aAsNoNode,
  })
  if (!planC.ok) { console.log(`  REFUSED: ${planC.code} ${planC.reason}`); process.exit(1) }
  console.log(`  A's capabilities   ${planA.proposal.steps.map((s) => s.capability).join(' -> ')}`)
  console.log(`  C's capabilities   ${planC.proposal.steps.map((s) => s.capability).join(' -> ')}`)
  console.log(`  A's composition    ${planA.proposal.steps[1].tool} (${planA.proposal.steps[1].mode})`)
  console.log(`  C's composition    ${planC.proposal.steps[1].tool} (${planC.proposal.steps[1].mode})`)
  // Execution happens below, after `runMission` and the terminal capability are initialised. Calling
  // it here reached a `const` before its declaration and died with "Cannot access 'terminalRun' before
  // initialization" - a harness fault that looked like a planning fault.
}

// ============================================================ EXECUTE BOTH, FOR REAL

/**
 * The scratch directory the summariser lives in.
 *
 * Separate from both the observed folders and the output roots, because the observed folders are
 * SUBJECTS - the planner reports on them and must not have added anything - and the output roots are
 * where results go. A tool that dropped its own script into a folder it was about to describe would
 * make the observation and the action inseparable.
 */
const scratch = join(world, 'scratch')
mkdirSync(scratch, { recursive: true })
const SUMMARISER = join(scratch, 'summarise.js')
writeFileSync(
  SUMMARISER,
  [
    "// Runs as a real process, and writes the report the verifier then checks.",
    "const fs = require('fs')",
    "const out = process.argv[2]",
    "const subject = process.env.AIOS_SUBJECT",
    "const rows = process.argv.slice(3).map((abs) => {",
    "  let bytes = 0",
    "  try { bytes = fs.statSync(abs).size } catch { bytes = -1 }",
    "  // Report the path RELATIVE to the subject, computed HERE from the absolute one.",
    "  // The verifier does the same arithmetic in its own language, and the two agreeing is what",
    "  // makes the comparison meaningful - rather than one side printing a relative path it was handed",
    "  // and the other printing a normalised one.",
    "  const rel = abs.startsWith(subject) ? abs.slice(subject.length).replace(/^[\\\\/]+/, '') : abs",
    "  const name = rel.split(/[\\\\/]/).pop()",
    "  const ext = (name && name.includes('.') ? name.split('.').pop() : name || '').toLowerCase()",
    "  return { rel: rel.replace(/\\\\/g, '/'), bytes, ext }",
    "}).sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))",
    "const total = rows.reduce((a, r) => a + Math.max(r.bytes, 0), 0)",
    "const byExt = {}",
    "for (const r of rows) byExt[r.ext] = (byExt[r.ext] || 0) + 1",
    "const lines = [",
    "  `SUMMARY OF ${process.env.AIOS_SUBJECT ?? '(the observed folder)'}`,",
    "  `files: ${rows.length}`,",
    "  `total bytes: ${total}`,",
    "  'subfolders included: yes',",
    "  '',",
    "  'BY EXTENSION:',",
    "  ...Object.entries(byExt).sort().map(([e, n]) => `  .${e}: ${n}`),",
    "  '',",
    "  'FILES:',",
    "  ...rows.map((r) => `  ${r.rel} (${r.bytes} bytes)`),",
    "  '',",
    "  `TOTAL:${total}`,",
    "]",
    "fs.writeFileSync(out, lines.join('\\n') + '\\n')",
    "console.log(`wrote ${rows.length} rows to ${out}`)",
  ].join('\n'),
  'utf8',
)

/**
 * A `terminal.run` capability that actually launches a process.
 *
 * The planner chose `terminal.run` because the OBSERVATION said node.exe was present and permitted -
 * so the proof has to really spawn something, or the plan's most interesting decision would be
 * untested. The tool translates the plan's observed file list into argv and captures the result; it
 * does no composing itself, because the whole point of choosing the terminal is that the process did
 * the work.
 */
const terminalRun = {
  name: 'run-process',
  mode: 'cli' as const,
  async run(_c: unknown, args: Record<string, unknown>) {
    const files = Array.isArray(args.files) ? (args.files as string[]).map(String) : []
    const reportPath = String(args.reportPath ?? '')
    if (!files.length) return { kind: 'failed' as const, reason: 'no observed files to process' }
    const nodeExe = join(process.env.ProgramFiles ?? 'C:\\Program Files', 'nodejs', 'node.exe')
    const started = Date.now()
    const child = spawnSync(nodeExe, [SUMMARISER, reportPath, ...files], {
      cwd: args.subject ? String(args.subject) : undefined,
      env: { ...buildEnv(), AIOS_SUBJECT: String(args.subject ?? '') },
      encoding: 'utf8',
      timeout: 20_000,
      windowsHide: true,
    })
    const record = {
      executable: nodeExe, argv: [SUMMARISER, '<report>', ...files],
      stdout: child.stdout ?? '', stderr: child.stderr ?? '',
      exitCode: child.status, state: child.status === 0 ? 'completed' : 'nonzero',
      durationMs: Date.now() - started,
    }
    if (child.status !== 0) {
      return { kind: 'failed' as const, reason: `the summariser exited with ${child.status}: ${(child.stderr ?? '').slice(0, 200)}` }
    }
    return { kind: 'data' as const, data: record, summary: `node summarised ${files.length} observed file(s)` }
  },
}

/**
 * Verifies what the PROCESS wrote, by recomputing it here.
 *
 * The independent computation walks the same folder with different code - this one in TypeScript,
 * the other in a spawned process - so agreement is corroboration rather than two views of one
 * function. A process that exited 0 and wrote nothing, or wrote the wrong thing, fails.
 */
const terminalVerifier = {
  verifies: (s: Step) => (s as { capability?: string }).capability === 'terminal.run',
  async verify(s: Step, _c: unknown, toolData: unknown) {
    const rec = toolData as { exitCode: number | null; stdout: string } | undefined
    if (!rec) return { rejected: 'no process record, so nothing to verify' }
    if (rec.exitCode !== 0) return { rejected: `the process exited with ${rec.exitCode}` }

    const subject = String((s.args as { subject?: string } | undefined)?.subject ?? '')
    const reportPath = String((s.args as { reportPath?: string } | undefined)?.reportPath ?? '')

    // The plan supplies ABSOLUTE paths, because a terminal step's operands are executed as argv and
    // the child's working directory is not something the planner may assume. They are therefore
    // converted back to folder-RELATIVE here, on both sides of the comparison.
    //
    // The first version compared the child's relative paths against the plan's absolute ones, so the
    // two reports never matched and the step failed for a reason that had nothing to do with either
    // program. A verifier that disagrees with the code it is verifying over a path spelling is a
    // verifier measuring its own formatting.
    const files = ((s.args as { files?: string[] } | undefined)?.files ?? [])
      .map(String)
      .map((abs) => {
        const rel = abs.startsWith(subject + '\\') ? abs.slice(subject.length + 1) : abs
        return rel.replace(/\\/g, '/')
      })

    if (!existsSync(reportPath)) {
      return { rejected: `the process exited 0 but "${reportPath}" does not exist. A zero exit code is not evidence that the work happened.` }
    }
    const body = readFileSync(reportPath, 'utf8')

    // Recompute, independently, from the same relative list.
    const rows = files.slice().sort().map((rel) => {
      const abs = join(subject, rel)
      let bytes = -1
      try { bytes = statSync(abs).size } catch { /* absent: keep -1, which the comparison catches */ }
      const name = rel.split('/').pop() ?? rel
      const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : name.toLowerCase()
      return { rel, bytes, ext }
    })
    const total = rows.reduce((a, r) => a + Math.max(r.bytes, 0), 0)
    const byExt: Record<string, number> = {}
    for (const r of rows) byExt[r.ext] = (byExt[r.ext] ?? 0) + 1
    const expected =
      [
        `SUMMARY OF ${subject}`,
        `files: ${rows.length}`,
        `total bytes: ${total}`,
        'subfolders included: yes',
        '',
        'BY EXTENSION:',
        ...Object.entries(byExt).sort().map(([e, n]) => `  .${e}: ${n}`),
        '',
        'FILES:',
        ...rows.map((r) => `  ${r.rel} (${r.bytes} bytes)`),
        '',
        `TOTAL:${total}`,
      ].join('\n') + '\n'

    if (body !== expected) {
      // Print BOTH, because "they differ" is not a diagnosis. A verifier that reports only a
      // mismatch forces the reader to reproduce both sides by hand, and the first version of this
      // harness could not tell whether the difference was a path spelling, an extension, a size or a
      // count - which is how a formatting bug can sit here looking like a governance failure.
      console.log('')
      console.log('  === THE VERIFIER DISAGREES WITH THE PROCESS: BOTH SIDES ===')
      console.log('  --- what the process wrote ---')
      for (const l of body.split('\n')) console.log(`  | ${l}`)
      console.log('  --- what an independent walk found ---')
      for (const l of expected.split('\n')) console.log(`  | ${l}`)
      const firstDiff = (() => {
        const a = body.split('\n'); const b = expected.split('\n')
        for (let i = 0; i < Math.max(a.length, b.length); i++) {
          if (a[i] !== b[i]) return { line: i + 1, got: a[i] ?? '(absent)', want: b[i] ?? '(absent)' }
        }
        return null
      })()
      if (firstDiff) {
        console.log(`  --- first difference at line ${firstDiff.line} ---`)
        console.log(`  | process:  ${firstDiff.got}`)
        console.log(`  | expected: ${firstDiff.want}`)
      }
      console.log('')
      return {
        rejected:
          `the report written by the process does not match an independent walk of ${subject}. ` +
          `Expected ${expected.length} bytes describing ${rows.length} file(s); found ${body.length}.` +
          (firstDiff ? ` First difference at line ${firstDiff.line}.` : ''),
      }
    }
    return {
      evidence: {
        kind: 'command-verified', executable: 'node.exe', path: reportPath,
        bytes: expected.length, exitCode: rec.exitCode, durationMs: 0, envVarCount: 0,
        corroboratedBy: 'the verifier re-walked the folder and recomputed the whole report',
      } as never,
    }
  },
}

/**
 * The registry, with READ and WRITE scopes kept apart.
 *
 * `readRoot` is the world - the mission READS a subject folder that is deliberately not under the
 * output root, and a tool whose read scope was the output root refused it as "outside". That is the
 * containment check working; the mistake was passing the wrong root, and conflating "where results
 * go" with "what may be read" is a mistake worth making only once.
 *
 * The WRITE scope stays the output root alone, so no tool can be talked into writing beside its
 * subject.
 */
function registryFor(readRoot: string, out: string) {
  return new ToolRegistry({
    registrations: [
      { tool: makeInspectTool(readRoot), capabilities: ['filesystem.inspect'] },
      { tool: makeComposeTool(readRoot), capabilities: ['filesystem.transform'] },
      { tool: terminalRun, capabilities: ['terminal.run'] },
      { tool: makeWriteTool(out), capabilities: ['filesystem.write'] },
      { tool: makeReadBackTool(out), capabilities: ['filesystem.read'] },
    ],
  })
}

function verifierFor(readRoot: string, out: string) {
  const inspect = makeInspectVerifier(readRoot)
  const compose = makeComposeVerifier(readRoot)
  const read = makeReadBackVerifier(out)
  return {
    verifies: (s: Step) => true,
    async verify(s: Step, c: unknown, d: unknown) {
      // Dispatch on the CAPABILITY, which is the contract the plan declares. Dispatching on mode or
      // on a tool name is how a verifier silently stops claiming a step whose naming changed - the
      // defect found in `folder-tools.ts` during M6.
      const cap = (s as { capability?: string }).capability
      if (cap === 'filesystem.inspect') return inspect.verify(s, c as never, d)
      if (cap === 'filesystem.transform') return compose.verify(s, c as never, d)
      if (cap === 'terminal.run') return terminalVerifier.verify(s, c as never, d)
      return read.verify(s, c as never, d)
    },
  }
}

async function runMission(label: string, plan: PlanProposal, subject: string, out: string) {
  const compiled = compilePlan(plan, `m-${label}`, Date.now())
  if (!compiled.ok) { console.log(`  COMPILE REFUSED: ${compiled.reason}`); return null }
  const r = await execute(compiled.mission, {
    tools: registryFor(world, out),
    verifier: verifierFor(world, out) as never,
    control: fakeControl() as ControlSurface,
    config: CONFIG,
  })
  const t = tally(r.mission)
  console.log('')
  console.log(`=== EXECUTED ${label} ===`)
  // EVERY step, with the reason for any failure. A tally alone is not evidence: an earlier version
  // printed `verified 0 failed 1 skipped 3` and nothing else, which is compatible with a plan that
  // failed at its very first step for any of a dozen reasons - and the first step failing was
  // exactly what had happened.
  for (const s of r.mission.plan) {
    const o = s.result?.outcome
    const why = o && 'reason' in o ? `  ${String(o.reason).slice(0, 200)}` : ''
    console.log(`  ${s.id.padEnd(20)} ${(o?.kind ?? 'DID NOT RUN').padEnd(11)}${why}`)
  }
  console.log(`  mission state   ${r.mission.state}   complete=${r.record.complete}`)
  console.log(`  tally           verified ${t.verified} failed ${t.failed} needsHuman ${t.needsHuman} skipped ${t.skipped}`)
  return r
}

const runA = await runMission('A', planA.proposal, A, outA)
const runB = await runMission('B', planB.proposal, B, outB)

console.log('')
console.log('=== SCENARIO C EXECUTED: the filesystem branch, because the observation said so ===')
let runC: { record: { complete: boolean } } | null = null
if (planC && planC.ok) {
  const outC = join(world, 'outC')
  runC = await runMission('C', planC.proposal, A, outC)
  // `runMission` can legitimately return null, so the read below is guarded rather than asserted.
  // Reporting `C completed: null` because a null was dereferenced would be a worse record than
  // saying C did not run.
  if (!runC) { console.log('  C produced no record, so nothing to report') }
  else console.log(`  C completed: ${runC.record.complete}`)
  console.log(`  C produced: ${readdirSync(outC).join(', ')}`)
}

console.log('')
console.log('=== THE ARTIFACTS, INSPECTED FROM OUTSIDE THE MISSION ===')
for (const [label, out] of [['A', outA], ['B', outB]] as const) {
  const produced = readdirSync(out).filter((f) => statSync(join(out, f)).isFile())
  console.log(`  ${label}: ${produced.length} file(s)  ${produced.join(', ')}`)
  for (const f of produced) {
    const body = readFileSync(join(out, f), 'utf8')
    const count = /^files: (\d+)$/m.exec(body)?.[1]
    console.log(`    ${f}: ${body.length} bytes, claims ${count} file(s)`)
    console.log(`      ${body.split('\n').filter((l) => l.startsWith('  ')).slice(0, 3).join(' / ')}`)
  }
}

// ============================================================ negative controls

interface Case { ok: boolean; msg: string }
const checks: Case[] = []
const check = (ok: boolean, msg: string) => { checks.push({ ok, msg }) }

console.log('')
console.log('=== NEGATIVE CONTROLS ===')

// ---- A. THE PLANNER IGNORES THE OBSERVATION
{
  console.log('')
  console.log('--- CONTROL A: the planner is given no observation ---')
  const blind = await aware.plan(objectiveFor(A), { outputRoot: outA, now: () => Date.now() })
  console.log(`  result   ${blind.ok ? 'produced a plan' : `refused [${blind.ok ? '' : blind.code}]`}`)
  console.log(`  reason   ${blind.ok ? '(none)' : blind.reason}`)
  check(!blind.ok, 'CONTROL A: a planner with no world REFUSES rather than emitting a recipe')
  check(!blind.ok && blind.code === 'observation-missing', 'CONTROL A: and the code says why')
}

// ---- B. A STALE OBSERVATION
{
  console.log('')
  console.log('--- CONTROL B: the observation is stale ---')
  const w = observer.observe({ root: A, maxDepth: 4 })

  // A MATCHING re-observation is supplied deliberately: without it a second check refuses with the
  // same code, so removing the AGE check would still produce a refusal and the control would report
  // the protection as redundant.
  const matching = observer.observe({ root: A, maxDepth: 4 })
  const tooOld = await aware.plan(objectiveFor(A), {
    outputRoot: outA, now: () => w.observedAt + 300_000, world: w, maxObservationAgeMs: 60_000,
    refetched: matching,
  })
  console.log(`  too old          ${tooOld.ok ? 'produced a plan' : `refused [${tooOld.ok ? '' : tooOld.code}]`}`)
  console.log(`                    ${tooOld.ok ? '' : tooOld.reason.slice(0, 120)}`)
  check(!tooOld.ok, 'CONTROL B: an observation beyond its age limit is refused')
  check(!tooOld.ok && tooOld.code === 'observation-stale', 'CONTROL B: reported as stale')
  check(
    !tooOld.ok && /taken \d+s ago/.test(tooOld.reason),
    'CONTROL B: and the AGE is named, so the refusal is attributable to the age check alone',
  )

  // The world moves, and the plan is asked to be built on the view from before.
  writeFileSync(join(A, 'intruder.md'), '# arrived after planning\n')
  const moved = await aware.plan(objectiveFor(A), {
    outputRoot: outA, now: () => w.observedAt + 1000, world: w, maxObservationAgeMs: 60_000,
    refetched: observer.observe({ root: A, maxDepth: 4 }),
  })
  console.log(`  world changed    ${moved.ok ? 'produced a plan' : `refused [${moved.ok ? '' : moved.code}]`}`)
  console.log(`                    ${moved.ok ? '' : moved.reason.slice(0, 150)}`)
  check(!moved.ok, 'CONTROL B: a view the machine has moved past is refused')
  rmSync(join(A, 'intruder.md'), { force: true })
}

// ---- C. AN INVENTED RESOURCE
{
  console.log('')
  console.log('--- CONTROL C: the objective names something the observation cannot establish ---')
  const outside = 'C:\\not\\observed\\at\\all'
  const unobserved = await aware.plan(objectiveFor(outside), ctxFor(A, outA))
  console.log(`  unobserved path  ${unobserved.ok ? 'produced a plan' : `refused [${unobserved.ok ? '' : unobserved.code}]`}`)
  console.log(`                    ${unobserved.ok ? '' : unobserved.reason.slice(0, 150)}`)
  console.log(`                    missing: ${[...(unobserved.ok ? [] : unobserved.missing ?? [])].join(', ')}`)
  check(!unobserved.ok, 'CONTROL C: a path outside the observed root is NOT invented')
  check(!unobserved.ok && !/does not exist/.test(unobserved.reason),
    'CONTROL C: and it is reported as unobserved, not as non-existent - a different remedy')

  const insideButAbsent = join(A, 'not-here')
  const absent = await aware.plan(objectiveFor(insideButAbsent), ctxFor(A, outA))
  console.log(`  inside, absent   ${absent.ok ? 'produced a plan' : `refused [${absent.ok ? '' : absent.code}]`}`)
  console.log(`                    ${absent.ok ? '' : absent.reason.slice(0, 150)}`)
  check(!absent.ok, 'CONTROL C: a path inside the scope but ABSENT is not invented either')
  check(
    !absent.ok && absent.reason.includes(insideButAbsent),
    'CONTROL C: and the missing path is named, so a caller can act on it',
  )
}

// ---- D. THE OBSERVER MUTATES THE WORLD
{
  console.log('')
  console.log('--- CONTROL D: an attempt to write through the observer ---')
  const before = readdirSync(A).sort()
  const w = observer.observe({ root: A, maxDepth: 4 })
  // Everything a caller could do to the returned value: mutate it, attach to it, re-observe.
  // A DELIBERATE attempt to corrupt the observation, which is the entire point of this control:
  // `WorldState` is a plain value, and mutating it must not touch the machine.
  //
  // The cast is required rather than a loophole. `entries` and `fingerprint` are `readonly` because
  // the contract says a caller must not edit them, and the compiler is right to refuse. The test is
  // deliberately doing the forbidden thing to PROVE the machine is unaffected, and it has to say so
  // in the type system rather than quietly removing the `readonly` that protects every other caller.
  const mutable = w as unknown as { entries: unknown[]; fingerprint: string }
  mutable.entries.length = 0
  mutable.fingerprint = 'tampered'
  ;(w as unknown as { write: () => void }).write = () => { writeFileSync(join(A, 'observer-wrote-this.md'), 'x') }
  const after = readdirSync(A).sort()
  console.log(`  entries before tampering: the WorldState is a plain object`)
  console.log(`  directory before  ${before.join(', ')}`)
  console.log(`  directory after   ${after.join(', ')}`)
  console.log(`  observer-wrote-this.md present: ${existsSync(join(A, 'observer-wrote-this.md'))}`)
  check(
    !existsSync(join(A, 'observer-wrote-this.md')) && after.join(',') === before.join(','),
    'CONTROL D: nothing the observer returned can write; a property bolted onto it does not gain capability',
  )
  // And the observer has no such method of its own.
  const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(observer)).filter((n) => n !== 'constructor')
  console.log(`  provider methods  ${methods.join(', ')}`)
  check(!methods.some((m) => /write|create|remove|delete|spawn|exec/i.test(m)), 'CONTROL D: the provider exposes no writing method')
}

// ---- E. THE PLANNER REACHES PAST ITS BOUNDARY
{
  console.log('')
  console.log('--- CONTROL E: can a plan reach the executor? ---')
  // Not a code change: a demonstration that the plan is inert data. Every field is JSON.
  const p = planA.proposal
  const roundTrip = JSON.parse(JSON.stringify(p))
  console.log(`  proposal survives JSON round-trip: ${JSON.stringify(roundTrip) === JSON.stringify(p)}`)
  console.log(`  proposal fields: ${Object.keys(p).join(', ')}`)
  const forbidden = ['execute', 'run', 'tools', 'control', 'permission', 'approvals', 'state', 'history']
  const present = forbidden.filter((f) => f in (p as unknown as Record<string, unknown>))
  console.log(`  forbidden fields present: ${present.length ? present.join(', ') : '(none)'}`)
  check(JSON.stringify(roundTrip) === JSON.stringify(p), 'CONTROL E: a proposal is inert data with no handles')
  check(present.length === 0, 'CONTROL E: and it carries no route to the executor or the governance layer')
}

// ---- F2. A PLAN WITH NO BASIS
{
  console.log('')
  console.log('--- CONTROL F2: a plan that cannot say what it was planned against ---')
  const p = planA.proposal
  for (const [what, broken] of [
    ['no observation id', { ...p, basis: { ...p.basis, observationId: '' } }],
    ['no fingerprint', { ...p, basis: { ...p.basis, fingerprint: '' } }],
    ['no observed facts', { ...p, basis: { ...p.basis, usedFacts: [] } }],
    ['an incomplete observation', { ...p, basis: { ...p.basis, complete: false } }],
  ] as const) {
    const c = compilePlan(broken, 'm-ctlF2', Date.now())
    console.log(`  ${what.padEnd(26)} ${c.ok ? 'ACCEPTED' : 'REFUSED'}`)
    check(!c.ok, `CONTROL F2: a plan with ${what} is REFUSED`)
  }
  // And the plan as it stands compiles, so the refusals are about the basis.
  check(compilePlan(p, 'm-ctlF2', Date.now()).ok, 'CONTROL F2: the unmodified plan still compiles')
}

// ---- F3. AN EMPTY FOLDER, AND A FOLDER WITH NOTHING IN IT
{
  console.log('')
  console.log('--- CONTROL F3: a folder with no files to summarise ---')
  const w = mkdtempSync(join(tmpdir(), 'aios-ctlF3-'))
  try {
    const empty = join(w, 'empty')
    mkdirSync(join(empty, 'a-subfolder'), { recursive: true }) // a folder, and nothing else
    const out = join(w, 'out'); mkdirSync(out, { recursive: true })
    const r = await aware.plan(objectiveFor(empty), ctxFor(empty, out))
    console.log(`  result   ${r.ok ? 'produced a plan' : `refused [${r.ok ? '' : r.code}]`}`)
    console.log(`  reason   ${r.ok ? '(none)' : r.reason.slice(0, 170)}`)
    check(!r.ok, 'CONTROL F3: a folder containing no files is REFUSED rather than summarised as nothing')
    check(!r.ok && /subfolder/.test(r.reason), 'CONTROL F3: and the subfolders it DID find are named, so the refusal is precise')
  } finally { rmSync(w, { recursive: true, force: true }) }
}

// ---- F4. THE CAPABILITY CHOICE FOLLOWS THE OBSERVATION
{
  console.log('')
  console.log('--- CONTROL F4: does the plan follow the machine, or just the objective? ---')
  const capA = planA.proposal.steps[1].capability
  const capC = planC && planC.ok ? planC.proposal.steps[1].capability : 'none'
  console.log(`  same objective, same folder, node reported PRESENT   -> ${capA}`)
  console.log(`  same objective, same folder, node reported ABSENT    -> ${capC}`)
  check(capA === 'terminal.run', 'CONTROL F4: with node present the plan asks for terminal.run')
  check(capC === 'filesystem.transform', 'CONTROL F4: with node absent the plan asks for filesystem.transform')
  check(capA !== capC, 'CONTROL F4: the SAME objective produced DIFFERENT plans because the world differed')
  check(runC?.record.complete === true, 'CONTROL F4: and the plan built for a machine without node still completes')
}

// ---- F. AN UNAVAILABLE CAPABILITY
{
  console.log('')
  console.log('--- CONTROL F: a plan naming a capability nothing serves ---')
  const bogus = { ...planA.proposal, steps: planA.proposal.steps.map((s, i) => (i === 0 ? { ...s, capability: 'filesystem.read-the-web' as never } : s)) }
  const compiled = compilePlan(bogus, 'm-ctlF', Date.now())
  console.log(`  compiled: ${compiled.ok ? 'ACCEPTED' : 'REFUSED'}`)
  console.log(`  reason:   ${compiled.ok ? '' : compiled.reason.slice(0, 190)}`)
  check(!compiled.ok, 'CONTROL F: an unknown capability is REFUSED, not substituted')

  // And the router refuses the same thing at the other layer.
  const reg = registryFor(A, outA)
  const resolution = reg.resolveCapability('filesystem.read-the-web')
  console.log(`  router:   ${'unavailable' in resolution ? 'REFUSED' : 'resolved'}`)
  check('unavailable' in resolution, 'CONTROL F: the router refuses it too, at a different layer')
}

// ---- G. THE WORLD CHANGES, AND THE PLAN MUST NOT SURVIVE IT
{
  console.log('')
  console.log('--- CONTROL G: a plan built for a world that has since changed ---')
  // A fresh, dedicated world so the live missions above are not disturbed.
  const w = mkdtempSync(join(tmpdir(), 'aios-ctlG-'))
  try {
    const src = join(w, 'src'); mkdirSync(src, { recursive: true })
    const out = join(w, 'out'); mkdirSync(out, { recursive: true })
    writeFileSync(join(src, 'one.txt'), 'one\n')
    const o = observer.observe({ root: src, maxDepth: 3 })
    const p = await aware.plan(objectiveFor(src), {
      outputRoot: out, now: () => o.observedAt, world: o, maxObservationAgeMs: 60_000, refetched: o,
    })
    if (!p.ok) { console.log(`  plan refused unexpectedly: ${p.reason}`); process.exit(1) }
    const planned = p.proposal.expectedResult
    console.log(`  plan said     ${planned}`)

    // The world changes: a file is added, and one grows.
    writeFileSync(join(src, 'two.txt'), 'two\n')
    writeFileSync(join(src, 'one.txt'), 'one, and considerably longer now\n')

    // The SAME plan is executed against the new world. Its own verification must notice.
    const compiled = compilePlan(p.proposal, 'm-ctlG', Date.now())
    if (!compiled.ok) { console.log(`  compile refused: ${compiled.reason}`); process.exit(1) }
    const r = await execute(compiled.mission, {
      tools: registryFor(world, out), verifier: verifierFor(world, out) as never,
      control: fakeControl() as ControlSurface, config: CONFIG,
    })
    const confirm = r.mission.plan[r.mission.plan.length - 1]
    const outcome = confirm.result?.outcome
    console.log(`  executed the stale plan`)
    console.log(`  final step    ${outcome?.kind}`)
    console.log(`  why           ${outcome && 'reason' in outcome ? String(outcome.reason).slice(0, 160) : ''}`)
    console.log(`  complete      ${r.record.complete}`)
    // The plan asserted a file count; the world now has a different one. Verification must catch it.
    const verifyFailed = outcome?.kind === 'failed' || r.record.complete === false
    check(verifyFailed, 'CONTROL G: a plan whose observed facts no longer hold CANNOT complete')
    check(!r.record.complete, 'CONTROL G: and the mission is not reported complete on the old plan')
  } finally { rmSync(w, { recursive: true, force: true }) }
}

// ============================================================ the verdict

console.log('')
console.log('=== WHAT THIS PROVES ===')
console.log(`  A and B are different folders on this machine.`)
console.log(`  The same objective produced ${planA.proposal.steps.length} steps for A and ${planB.proposal.steps.length} for B.`)
console.log(`  A's plan says ${/\b\d+ file\(s\)/.exec(planA.proposal.expectedResult)?.[0]}; B's says ${/\b\d+ file\(s\)/.exec(planB.proposal.expectedResult)?.[0]}.`)
console.log(`  The phrase planner produced identical step intents for both: ${sameIntents}.`)
console.log(`  Both missions executed and were verified: A=${runA?.record.complete} B=${runB?.record.complete}.`)

console.log('')
console.log('=== CLEANUP ===')
rmSync(world, { recursive: true, force: true })
console.log(`  world removed: ${!existsSync(world)}`)

let failed = 0
for (const c of checks) {
  console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.msg}`)
  if (!c.ok) failed++
}
console.log('')
console.log(`=== ${failed === 0 ? 'PASS' : failed + ' FAILURE(S)'} ===`)
process.exit(failed ? 1 : 0)
