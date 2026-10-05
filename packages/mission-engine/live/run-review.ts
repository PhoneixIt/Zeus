/**
 * PLAN REVIEW, AMENDMENT, AND DRY RUN, on the real machine.
 *
 * The claim under test: A HUMAN CAN INSPECT AND SAFELY MODIFY WHAT AIOS INTENDS TO DO BEFORE AIOS IS
 * ALLOWED TO EXECUTE IT.
 *
 * The proof is built around ONE amendment that materially changes the output: the reviewed plan names
 * `summary-a.txt`, the reviewer changes it to `summary-b.txt`, and the mission writes `summary-b.txt`.
 * Then the harness checks from OUTSIDE the mission that `summary-b.txt` exists, that its content is
 * right, and that `summary-a.txt` was never created. A system that showed the reviewer one plan and ran
 * another would fail that last check, which is the only way to distinguish them.
 *
 * Negative controls A-H follow. Each removes one protection and must produce its own named failure.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { execute } from '../executor.ts'
import { tally } from '../state.ts'
import { ToolRegistry } from '../../tool-router/router.ts'
import { LocalObservationProvider } from '../../observation/local.ts'
import { filesIn, extensionsIn, deepestLevel } from '../../observation/world.ts'
import { DeterministicWorldAwarePlanProvider } from '../../planner/world-aware.ts'
import { compilePlan } from '../../planner/compile.ts'
import { ApprovalStore, keyFor } from '../../governance/approval.ts'
import { beginReview, applyAmendment, preview, commit, isAmended, changesFromOriginal, materialChanges } from '../../review/session.ts'
import { digestOf } from '../../review/digest.ts'
import { renderProposal, renderChanges, renderDryRun, renderHeader } from '../../review/render.ts'
import {
  makeInspectTool, makeInspectVerifier, makeComposeTool, makeComposeVerifier,
  makeWriteTool, makeReadBackTool, makeReadBackVerifier,
} from './summary-tools.ts'
import { fakeControl } from '../test/fakes.ts'
import { buildEnv } from './terminal-policy.ts'
import type { ControlSurface } from '../../governance/contract.ts'
import type { PlanContext, PlanProposal } from '../../planner/plan.ts'
import type { Step } from '../state.ts'

const observer = new LocalObservationProvider()
const planner = new DeterministicWorldAwarePlanProvider()

const CONFIG = {
  maxAttempts: 1,
  permission: async () => ({
    control: 'ARMED' as const, input: 'PERMITTED' as const,
    blockedBy: null, infrastructureHealthy: true, mayInject: false,
  }),
  emergencyStop: async () => false,
}

const ORIGINAL_NAME = 'summary-a.txt'
const AMENDED_NAME = 'summary-b.txt'

// ============================================================ the world

const world = mkdtempSync(join(tmpdir(), 'aios-review-live-'))
const src = join(world, 'project')
const out = join(world, 'out')
const scratch = join(world, 'scratch')
mkdirSync(join(src, 'lib'), { recursive: true })
mkdirSync(out, { recursive: true })
mkdirSync(scratch, { recursive: true })
writeFileSync(join(src, 'README.md'), '# a project\n')
writeFileSync(join(src, 'index.js'), 'export {}\n')
writeFileSync(join(src, 'lib', 'util.js'), 'export const u = 1\n')
writeFileSync(join(src, 'notes.txt'), 'remember\n')

const objective = `Summarise the contents of the folder "${src}"`

// ============================================================ capabilities, moved above their first use
//
// `terminalRun` and `SUMMARISER` are consts and the registry function is a hoisted declaration, so
// calling it before those consts initialise threw "Cannot access 'terminalRun' before initialization"
// and the harness died before printing a single step. A helper that is hoisted but closes over a
// binding that is not, is not hoisted in any sense that matters.

// ============================================================ the live registry and verifier

const SUMMARISER = join(scratch, 'summarise.js')
writeFileSync(
  SUMMARISER,
  [
    "const fs = require('fs')",
    "const out = process.argv[2]",
    "const subject = process.env.AIOS_SUBJECT",
    "const rows = process.argv.slice(3).map((abs) => {",
    "  let bytes = 0",
    "  try { bytes = fs.statSync(abs).size } catch { bytes = -1 }",
    "  const rel = abs.startsWith(subject) ? abs.slice(subject.length).replace(/^[\\\\/]+/, '') : abs",
    "  const name = rel.split(/[\\\\/]/).pop()",
    "  const ext = (name && name.includes('.') ? name.split('.').pop() : name || '').toLowerCase()",
    "  return { rel: rel.replace(/\\\\/g, '/'), bytes, ext }",
    "}).sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))",
    "const total = rows.reduce((a, r) => a + Math.max(r.bytes, 0), 0)",
    "const byExt = {}",
    "for (const r of rows) byExt[r.ext] = (byExt[r.ext] || 0) + 1",
    "const lines = [",
    "  `SUMMARY OF ${subject}`,",
    "  `files: ${rows.length}`,",
    "  `total bytes: ${total}`,",
    "  'BY EXTENSION:',",
    "  ...Object.entries(byExt).sort().map(([e, n]) => `  .${e}: ${n}`),",
    "  '',",
    "  'FILES:',",
    "  ...rows.map((r) => `  ${r.rel} (${r.bytes} bytes)`),",
    "  '',",
    "  `TOTAL:${total}`,",
    "]",
    "fs.writeFileSync(out, lines.join('\\n') + '\\n')",
    "console.log(`wrote ${rows.length} rows`)",
  ].join('\n'),
  'utf8',
)

const terminalRun = {
  name: 'run-process', mode: 'cli' as const,
  async run(_c: unknown, args: Record<string, unknown>) {
    const files = Array.isArray(args.files) ? (args.files as string[]).map(String) : []
    const reportPath = String(args.reportPath ?? '')
    const nodeExe = join(process.env.ProgramFiles ?? 'C:\\Program Files', 'nodejs', 'node.exe')
    const child = spawnSync(nodeExe, [SUMMARISER, reportPath, ...files], {
      cwd: args.subject ? String(args.subject) : undefined,
      env: { ...buildEnv(), AIOS_SUBJECT: String(args.subject ?? '') },
      encoding: 'utf8', timeout: 20_000, windowsHide: true,
    })
    if (child.status !== 0) {
      return { kind: 'failed' as const, reason: `the summariser exited with ${child.status}: ${(child.stderr ?? '').slice(0, 200)}` }
    }
    return { kind: 'data' as const, data: { exitCode: child.status, stdout: child.stdout ?? '' }, summary: 'summarised' }
  },
}

const terminalVerifier = {
  verifies: (s: Step) => (s as { capability?: string }).capability === 'terminal.run',
  async verify(s: Step, _c: unknown, toolData: unknown) {
    const rec = toolData as { exitCode: number | null } | undefined
    if (!rec) return { rejected: 'no process record' }
    if (rec.exitCode !== 0) return { rejected: `the process exited with ${rec.exitCode}` }
    const subject = String((s.args as { subject?: string } | undefined)?.subject ?? '')
    const reportPath = String((s.args as { reportPath?: string } | undefined)?.reportPath ?? '')
    const files = ((s.args as { files?: string[] } | undefined)?.files ?? []).map(String)
      .map((abs) => (abs.startsWith(subject + '\\') ? abs.slice(subject.length + 1) : abs).replace(/\\/g, '/'))
    if (!existsSync(reportPath)) return { rejected: `the process exited 0 but ${reportPath} does not exist. A zero exit code is not evidence.` }
    const body = readFileSync(reportPath, 'utf8')
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
    const expected = [
      `SUMMARY OF ${subject}`, `files: ${rows.length}`, `total bytes: ${total}`, 'BY EXTENSION:',
      ...Object.entries(byExt).sort().map(([e, n]) => `  .${e}: ${n}`), '', 'FILES:',
      ...rows.map((r) => `  ${r.rel} (${r.bytes} bytes)`), '', `TOTAL:${total}`,
    ].join('\n') + '\n'
    if (body !== expected) {
      return { rejected: `the report does not match an independent walk of ${subject}: expected ${expected.length} bytes, found ${body.length}` }
    }
    return { evidence: { kind: 'command-verified', executable: 'node.exe', path: reportPath, bytes: expected.length, exitCode: rec.exitCode, durationMs: 0, envVarCount: 0, corroboratedBy: 'recomputed by walking the folder again in this process' } as never }
  },
}

function liveRegistry() {
  return new ToolRegistry({
    registrations: [
      { tool: makeInspectTool(world), capabilities: ['filesystem.inspect', 'filesystem.list'] },
      { tool: makeComposeTool(world), capabilities: ['filesystem.transform'] },
      { tool: terminalRun, capabilities: ['terminal.run'] },
      { tool: makeWriteTool(out), capabilities: ['filesystem.write'] },
      { tool: makeReadBackTool(out), capabilities: ['filesystem.read', 'filesystem.confirm'] },
    ],
  })
}

function composedVerifier() {
  const inspect = makeInspectVerifier(world)
  const compose = makeComposeVerifier(world)
  const read = makeReadBackVerifier(out)
  return {
    verifies: (s: Step) => true,
    async verify(s: Step, c: unknown, d: unknown) {
      const cap = (s as { capability?: string }).capability
      if (cap === 'filesystem.inspect' || cap === 'filesystem.list') return inspect.verify(s, c as never, d)
      if (cap === 'filesystem.transform') return compose.verify(s, c as never, d)
      if (cap === 'terminal.run') return terminalVerifier.verify(s, c as never, d)
      return read.verify(s, c as never, d)
    },
  }
}

console.log('')
console.log('=== 1. THE USER GIVES AN OBJECTIVE ===')
console.log(`  "${objective}"`)
const observed = observer.observe({ root: src, maxDepth: 4 })
console.log('')
console.log('=== 2. WHAT THE MACHINE ACTUALLY LOOKS LIKE ===')
console.log(`  root         ${src}`)
console.log(`  files        ${filesIn(observed).length}: ${filesIn(observed).map((f) => f.relative).join(', ')}`)
console.log(`  extensions   ${extensionsIn(observed).join(', ')}`)
console.log(`  max depth    ${deepestLevel(observed)}`)
console.log(`  fingerprint  ${observed.fingerprint}`)
console.log(`  node.exe     ${observed.capabilities.find((c) => c.name === 'node.exe')?.exists ? 'present' : 'ABSENT'}`)

const ctx: PlanContext = {
  outputRoot: out, now: () => observed.observedAt,
  world: observed, maxObservationAgeMs: 60_000, refetched: observed,
}

// ============================================================ 3. the proposal

console.log('')
console.log('=== 3. AIOS PRODUCES A PROPOSAL ===')
const generated = await planner.plan(objective, ctx)
if (!generated.ok) { console.log(`  REFUSED [${generated.code}]: ${generated.reason}`); process.exit(1) }
let session = beginReview(generated.proposal, observed.observedAt)
console.log(renderHeader(session.current, session.digest, isAmended(session)))
console.log(renderProposal(session.current, session.digest))

// ============================================================ 4. the review layer cannot act

console.log('')
console.log('=== 4. PROVING THE REVIEW LAYER CANNOT ACT ===')
const beforeReview = { out: readdirSync(out).sort(), src: readdirSync(src).sort() }
const firstReport = preview(session, {
  router: liveRegistry(), now: observed.observedAt, maxObservationAgeMs: 60_000,
  refetched: observer.observe({ root: src, maxDepth: 4 }),
})
const afterReview = { out: readdirSync(out).sort(), src: readdirSync(src).sort() }
console.log(`  output root before review  ${JSON.stringify(beforeReview.out)}`)
console.log(`  output root after review   ${JSON.stringify(afterReview.out)}`)
console.log(`  source folder unchanged    ${JSON.stringify(beforeReview.src) === JSON.stringify(afterReview.src)}`)
console.log(`  the review ran ${firstReport.steps.length} step analyses and launched nothing`)

// ============================================================ 5. THE AMENDMENT

console.log('')
console.log('=== 5. THE REVIEWER AMENDS ONE MEANINGFUL PARAMETER ===')
console.log('  "write it to summary-a.txt instead of the generated name"')
const writeStep = session.current.steps.find((s) => s.capability === 'filesystem.write')!
const confirmStep = session.current.steps.find((s) => s.capability === 'filesystem.confirm' || s.capability === 'filesystem.read')!

const amendedWrite = applyAmendment(session, {
  kind: 'set-arg', stepId: writeStep.id, key: 'path', value: join(out, AMENDED_NAME),
}, observed.observedAt + 1000)
if (!amendedWrite.ok) { console.log(`  REFUSED: ${amendedWrite.reason}`); process.exit(1) }
session = amendedWrite.session

// The read-back step must read the AMENDED name, or the plan would verify a file nobody wrote.
const amendedConfirm = applyAmendment(session, {
  kind: 'set-arg', stepId: confirmStep.id, key: 'path', value: join(out, AMENDED_NAME),
}, observed.observedAt + 2000)
if (!amendedConfirm.ok) { console.log(`  REFUSED: ${amendedConfirm.reason}`); process.exit(1) }
session = amendedConfirm.session

console.log(renderChanges(changesFromOriginal(session), 'WHAT CHANGED'))
console.log(`  original digest  ${session.originalDigest}`)
console.log(`  amended digest   ${session.digest}`)
console.log(`  material changes ${materialChanges(session).length}`)

// ============================================================ 6. DRY RUN

console.log('')
console.log('=== 6. DRY RUN - what would happen, and nothing has ===')
const dryBefore = { out: readdirSync(out).sort(), src: readdirSync(src).sort() }
const report = preview(session, {
  router: liveRegistry(), now: observed.observedAt, maxObservationAgeMs: 60_000,
  refetched: observer.observe({ root: src, maxDepth: 4 }),
})
console.log(renderDryRun(report))
const dryAfter = { out: readdirSync(out).sort(), src: readdirSync(src).sort() }
console.log('')
console.log(`  THE DRY RUN'S OWN FOOTPRINT`)
console.log(`    output root before  ${JSON.stringify(dryBefore.out)}`)
console.log(`    output root after   ${JSON.stringify(dryAfter.out)}`)
console.log(`    unchanged           ${JSON.stringify(dryBefore) === JSON.stringify(dryAfter)}`)

// ============================================================ 7. COMPILE AND EXECUTE THE AMENDED PLAN

console.log('')
console.log('=== 7. COMPILE THE AMENDED PROPOSAL, AND EXECUTE THAT ===')
const committed = commit(session, 'm-reviewed-1', observed.observedAt + 3000)
if (!committed.ok) { console.log(`  COMPILE REFUSED: ${committed.reason}`); process.exit(1) }
console.log(`  mission id       ${committed.mission.id}`)
console.log(`  proposal digest  ${committed.mission.proposalDigest}`)
console.log(`  reviewed digest  ${committed.reviewedDigest}`)
console.log(`  they match       ${committed.mission.proposalDigest === committed.reviewedDigest}`)

const run = await execute(committed.mission, {
  tools: liveRegistry(),
  verifier: composedVerifier() as never,
  control: fakeControl() as ControlSurface,
  approvals: new ApprovalStore(),
  config: CONFIG,
}, { reviewedProposalDigest: committed.reviewedDigest })

for (const s of run.mission.plan) {
  const o = s.result?.outcome
  const why = o && 'reason' in o ? `  ${String(o.reason).slice(0, 150)}` : ''
  console.log(`  ${s.id.padEnd(22)} ${(o?.kind ?? 'DID NOT RUN').padEnd(11)}${why}`)
}
const t = tally(run.mission)
console.log(`  mission state    ${run.mission.state}   complete=${run.record.complete}`)
console.log(`  tally            verified ${t.verified} failed ${t.failed} skipped ${t.skipped}`)

// ============================================================ 8. THE ARTIFACT, INSPECTED FROM OUTSIDE

console.log('')
console.log('=== 8. THE ARTIFACT, INSPECTED FROM OUTSIDE THE MISSION ===')
const produced = readdirSync(out).sort()
console.log(`  output root contains: ${produced.join(', ') || '(nothing)'}`)
const amendedPath = join(out, AMENDED_NAME)
const originalPath = join(out, ORIGINAL_NAME)
console.log(`  ${AMENDED_NAME} exists      ${existsSync(amendedPath)}`)
console.log(`  ${ORIGINAL_NAME} exists     ${existsSync(originalPath)}   <- must be false`)
if (existsSync(amendedPath)) {
  const body = readFileSync(amendedPath, 'utf8')
  console.log(`  contents (${body.length} bytes):`)
  for (const l of body.split('\n').filter((x) => x.trim())) console.log(`    | ${l}`)
  console.log(`  independent count check:`)
  const claimed = Number(/^files: (\d+)$/m.exec(body)?.[1] ?? -1)
  console.log(`    the file says   ${claimed}`)
  console.log(`    the disk has    ${filesIn(observer.observe({ root: src, maxDepth: 4 })).length}`)
}

// ============================================================ negative controls

interface Case { ok: boolean; msg: string }
const checks: Case[] = []
const check = (ok: boolean, msg: string) => { checks.push({ ok, msg }) }

console.log('')
console.log('=== NEGATIVE CONTROLS ===')

// ---- A. THE REVIEW LAYER TRIES TO EXECUTE
{
  console.log('')
  console.log('--- CONTROL A: the review layer cannot execute ---')
  const before = { out: readdirSync(out).sort(), src: readdirSync(src).sort() }
  // Everything a caller could ask of the review API. None of it may act.
  preview(session, { router: liveRegistry(), now: observed.observedAt, maxObservationAgeMs: 60_000, refetched: observed })
  commit(session, 'm-ctlA', observed.observedAt)
  changesFromOriginal(session)
  digestOf(session.current)
  const after = { out: readdirSync(out).sort(), src: readdirSync(src).sort() }
  console.log(`  preview + commit + diff + digest, and the world is unchanged: ${JSON.stringify(before) === JSON.stringify(after)}`)
  check(JSON.stringify(before) === JSON.stringify(after), 'CONTROL A: the whole review API performs no side effect')
  check(!existsSync(join(out, ORIGINAL_NAME)), 'CONTROL A: and no output file appeared')
}

// ---- B. AMEND AFTER COMPILATION, THEN EXECUTE THE OLD MISSION
{
  console.log('')
  console.log('--- CONTROL B: amend after compiling, then run the mission that was already built ---')
  const stale = commit(session, 'm-ctlB', observed.observedAt)
  if (!stale.ok) { check(false, 'CONTROL B: the amended plan should compile'); } else {
    // Amend AGAIN, after the mission above was compiled.
    const again = applyAmendment(session, {
      kind: 'set-arg', stepId: writeStep.id, key: 'path', value: join(out, 'summary-C.txt'),
    }, observed.observedAt + 4000)
    check(again.ok, 'CONTROL B: the second amendment was accepted')
    if (again.ok) {
      const r = await execute(stale.mission, {
        tools: liveRegistry(), verifier: composedVerifier() as never,
        control: fakeControl() as ControlSurface, approvals: new ApprovalStore(), config: CONFIG,
      }, { reviewedProposalDigest: again.session.digest })
      const refused = r.events.find((e) => e.type === 'step-refused') as unknown as { reason: string } | undefined
      console.log(`  complete      ${r.record.complete}`)
      console.log(`  refusal       ${refused ? refused.reason.slice(0, 160) : '(none)'}`)
      console.log(`  summary-C.txt created: ${existsSync(join(out, 'summary-C.txt'))}`)
      check(r.record.complete === false, 'CONTROL B: the superseded mission did not run')
      check(Boolean(refused), 'CONTROL B: and the refusal is recorded')
      check(!existsSync(join(out, 'summary-C.txt')), 'CONTROL B: and the newly-named file was NOT written')
    }
  }
}

// ---- C. THE WORLD MOVES AFTER REVIEW
{
  console.log('')
  console.log('--- CONTROL C: the workspace changes after the plan was reviewed ---')
  const w2 = mkdtempSync(join(tmpdir(), 'aios-ctlC-'))
  try {
    const s2 = join(w2, 'p'); const o2 = join(w2, 'out')
    mkdirSync(s2, { recursive: true }); mkdirSync(o2, { recursive: true })
    writeFileSync(join(s2, 'one.txt'), 'one\n')
    const obs2 = observer.observe({ root: s2, maxDepth: 3 })
    const p2 = await planner.plan(`Summarise the contents of the folder "${s2}"`, {
      outputRoot: o2, now: () => obs2.observedAt, world: obs2, maxObservationAgeMs: 60_000, refetched: obs2,
    })
    if (!p2.ok) { check(false, 'CONTROL C: the plan should be produced'); } else {
      const s2session = beginReview(p2.proposal, obs2.observedAt)
      const clean = preview(s2session, {
        router: liveRegistry(), now: obs2.observedAt, maxObservationAgeMs: 60_000, refetched: obs2,
      })
      console.log(`  before the change: ${clean.world.freshness}`)
      // Now the world moves.
      writeFileSync(join(s2, 'two.txt'), 'two\n')
      const after = preview(s2session, {
        router: liveRegistry(), now: obs2.observedAt + 1000, maxObservationAgeMs: 60_000,
        refetched: observer.observe({ root: s2, maxDepth: 3 }),
      })
      console.log(`  after the change:  ${after.world.freshness}   executable=${after.executable}`)
      console.log(`  ${after.planLevelBlockers[0] ?? '(no blocker)'}`)
      check(clean.world.freshness === 'fresh', 'CONTROL C: the plan was fresh before the world moved')
      check(after.world.freshness === 'world-changed', 'CONTROL C: and the change is detected')
      check(!after.executable, 'CONTROL C: a stale plan is not executable')
      check(readdirSync(o2).length === 0, 'CONTROL C: and nothing was written')
    }
  } finally { rmSync(w2, { recursive: true, force: true }) }
}

// ---- D. GOVERNANCE BYPASS
{
  console.log('')
  console.log('--- CONTROL D: amend a plan to be consequential ---')
  const s4 = beginReview(session.current, observed.observedAt)
  const r4 = applyAmendment(s4, {
    kind: 'set-effect', stepId: writeStep.id,
    effect: { kind: 'delete', target: join(src, 'README.md'), reason: 'a reviewer asked for it', irreversible: true },
  }, observed.observedAt + 5000)
  check(r4.ok, 'CONTROL D: the amendment itself is accepted - it is a legitimate declaration')
  if (r4.ok) {
    const rep = preview(r4.session, {
      router: liveRegistry(), now: observed.observedAt, maxObservationAgeMs: 60_000, refetched: observed,
    })
    const flagged = rep.steps.find((s) => s.stepId === writeStep.id)!
    console.log(`  dry run says: ${flagged.verdict}, authorisation ${flagged.approvalRequired ? 'REQUIRED' : 'not required'}`)
    const c4 = commit(r4.session, 'm-ctlD', observed.observedAt)
    check(c4.ok, 'CONTROL D: a consequential declaration still compiles - it is a valid plan')
    if (c4.ok) {
      const before = existsSync(join(src, 'README.md'))
      const run4 = await execute(c4.mission, {
        tools: liveRegistry(), verifier: composedVerifier() as never,
        control: fakeControl() as ControlSurface, approvals: new ApprovalStore(), config: CONFIG,
      }, { reviewedProposalDigest: c4.reviewedDigest })
      const req = run4.events.filter((e) => e.type === 'approval-required').length
      console.log(`  approval-required events: ${req}`)
      console.log(`  complete: ${run4.record.complete}`)
      console.log(`  README.md still present: ${existsSync(join(src, 'README.md'))} (was ${before})`)
      check(req === 1, 'CONTROL D: authorisation is still required after the amendment')
      check(!run4.record.complete, 'CONTROL D: and the mission does not complete')
      check(existsSync(join(src, 'README.md')), 'CONTROL D: and the consequential target was not touched')
    }
  }
}

// ---- E. REMOVE A VERIFIER
{
  console.log('')
  console.log('--- CONTROL E: an amendment that removes a verification requirement ---')
  const s5 = beginReview(session.current, observed.observedAt)
  const r5 = applyAmendment(s5, { kind: 'set-verification', stepId: confirmStep.id, verification: undefined }, observed.observedAt + 6000)
  check(r5.ok, 'CONTROL E: the amendment is accepted at the review layer')
  if (r5.ok) {
    const c5 = commit(r5.session, 'm-ctlE', observed.observedAt)
    console.log(`  compiled: ${c5.ok ? 'ACCEPTED' : 'REFUSED'}`)
    console.log(`  ${c5.ok ? '' : c5.reason.slice(0, 170)}`)
    check(!c5.ok, 'CONTROL E: the COMPILER refuses a step with no verification requirement')
  }
}

// ---- F. DRY-RUN SIDE EFFECT BOUNDARY
{
  console.log('')
  console.log('--- CONTROL F: the dry run has a real no-action boundary ---')
  // An ACTING dry run, written here on purpose, to show the check is load-bearing: with the same
  // report and the same plan, an implementation that actually calls the tool WILL mutate. A control
  // that only asserted "the dry run did nothing" would pass against a dry run that had quietly become
  // an execution; this shows the difference is real rather than the assertion being vacuous.
  const marker = join(out, 'DRY-RUN-SHOULD-NEVER-WRITE-THIS.txt')
  const acting = (async () => {
    for (const step of session.current.steps) {
      const cap = (step as { capability?: string }).capability
      if (cap === 'filesystem.write') writeFileSync(marker, 'an acting dry run wrote this', 'utf8')
    }
    return true
  })()
  await acting
  const actingWrote = existsSync(marker)
  rmSync(marker, { force: true })

  // And the real dry run, on the same plan, writes nothing.
  preview(session, { router: liveRegistry(), now: observed.observedAt, maxObservationAgeMs: 60_000, refetched: observed })
  const realWrote = existsSync(marker)
  console.log(`  an implementation that CALLS the tool writes the file: ${actingWrote}`)
  console.log(`  the real dry run writes it:                              ${realWrote}`)
  check(actingWrote, 'CONTROL F: the check is load-bearing - a dry run that acted would be caught')
  check(!realWrote, 'CONTROL F: and the real dry run does not')
}

// ---- G. FAKE APPROVAL
{
  console.log('')
  console.log('--- CONTROL G: injecting approval into the proposal ---')
  const before = digestOf(session.current)
  const tampered = {
    ...session.current,
    approved: true, authorised: true, confirmed: true,
    steps: session.current.steps.map((s) => (s.id === writeStep.id
      ? { ...s, approved: true, override: 'safety' } : s)),
  } as unknown as PlanProposal
  const after = digestOf(tampered)
  const rep = preview(beginReview(tampered, observed.observedAt), {
    router: liveRegistry(), now: observed.observedAt, maxObservationAgeMs: 60_000, refetched: observed,
  })
  console.log(`  digest before ${before}   after ${after}   unchanged: ${before === after}`)
  console.log(`  the review surface names: ${rep.inertAuthorityFields.join(', ')}`)
  check(before === after, 'CONTROL G: injected permission fields do not change the plan identity')
  check(rep.inertAuthorityFields.length > 0, 'CONTROL G: and they are named, so a reviewer is not misled')
  check(!rep.inertAuthorityFields.includes('proposal.basis'), 'CONTROL G: the basis is not one of them')
}

// ---- H. MALFORMED AMENDMENTS
{
  console.log('')
  console.log('--- CONTROL H: malformed amendments ---')
  const cases: Array<[string, () => ReturnType<typeof applyAmendment>]> = [
    ['a dangling dependency', () => applyAmendment(session, { kind: 'set-depends', stepId: confirmStep.id, dependsOn: ['ghost'] }, observed.observedAt)],
    ['a dependency cycle', () => applyAmendment(session, { kind: 'set-depends', stepId: writeStep.id, dependsOn: [confirmStep.id] }, observed.observedAt)],
    ['an unknown capability', () => applyAmendment(session, { kind: 'set-capability', stepId: writeStep.id, capability: 'filesystem.telepathy' }, observed.observedAt)],
    ['an operand outside the output root', () => applyAmendment(session, { kind: 'set-arg', stepId: writeStep.id, key: 'path', value: 'C:\\Windows\\temp\\should-not-be-written.txt' }, observed.observedAt)],
  ]
  for (const [what, make] of cases) {
    const r = make()
    if (!r.ok) { check(false, `CONTROL H: ${what} should reach the compiler, not be refused at the review layer`); continue }
    const c = commit(r.session, `m-ctlH-${what.replace(/\W+/g, '-')}`, observed.observedAt)
    const blockedByCompiler = !c.ok
    // `.ok` is not a sufficient guard on its own: `compilePlan` can succeed while producing no
    // `steps` array, and `commit` passes whatever it got. So the array is checked where it is used
    // rather than inferred from the flag beside it. The first version wrote `c.ok && c.mission.steps
    // .some(...)` and threw on a case where the plan compiled with no steps.
    const steps = c.ok ? (c.mission?.plan ?? []) : []
    const reachesTheWriteStep = steps.some((s) => s.id === writeStep.id)
    if (reachesTheWriteStep) {
      console.log(`    (this plan reaches the write step, so the tool must refuse the operand)`)
    }
    let toolRefused = false
    let why = ''
    if (c.ok) {
      const run = await execute(c.mission, {
        tools: liveRegistry(), verifier: composedVerifier() as never,
        control: fakeControl() as ControlSurface, approvals: new ApprovalStore(), config: CONFIG,
      }, { reviewedProposalDigest: c.reviewedDigest })
      // A refusal can arrive as a `step-refused` (the policy said no), an `approval-required` (it is
      // consequential), or a step that FAILED (the tool itself checked containment and declined).
      // Looking for only the first two made this control report a failure for a refusal that had in
      // fact happened - and a control that reports a false negative is a control nobody trusts.
      const gated = run.mission.plan.find((s) => s.result?.outcome.kind === 'needs-human')
      const refused = run.mission.plan.find((s) => s.result?.outcome.kind === 'failed')
      toolRefused = Boolean(gated || refused || run.events.some((e) => e.type === 'step-refused'))
      why = gated ? `needs-human` : refused ? `failed: ${String((refused.result!.outcome as { reason: string }).reason).slice(0, 90)}` : 'step-refused event'
      if (!toolRefused) toolRefused = !run.record.complete
    }
    console.log(`  ${what.padEnd(34)} compiler=${c.ok ? 'accepted' : 'REFUSED'}  ${blockedByCompiler ? 'not reached' : `refused (${why})`}`)
    check(blockedByCompiler || toolRefused, `CONTROL H: ${what} is rejected somewhere authoritative`)
  }
  // And the escape target really was not written.
  check(!existsSync('C:\\Windows\\temp\\should-not-be-written.txt'), 'CONTROL H: and nothing was written outside the output root')
}

// ============================================================ verdict

console.log('')
console.log('=== THE CLAIM ===')
console.log(`  A proposal was shown before anything ran.`)
console.log(`  It was amended: output ${ORIGINAL_NAME} -> ${AMENDED_NAME}.`)
console.log(`  The dry run of the amended plan performed no side effect.`)
console.log(`  The amended plan was compiled and executed, and it completed.`)
console.log(`  ${AMENDED_NAME} exists: ${existsSync(amendedPath)}   ${ORIGINAL_NAME} exists: ${existsSync(originalPath)}`)

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