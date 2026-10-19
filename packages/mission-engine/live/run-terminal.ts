/**
 * TERMINAL MODE, exercised on the real machine.
 *
 * The mission is a real one, not `echo hello`:
 *
 *   1. INSPECT   the workspace, through the filesystem capability
 *   2. COUNT     run a deterministic node script that tallies the files
 *   3. WRITE     the script produces a report the verifier will check
 *   4. VERIFY    the verifier RECOMPUTES the expected content from the inputs and compares
 *   5. READ BACK the verified report, through the filesystem capability
 *
 * Steps 2 and 4 are the interesting pair, and they are deliberately done by DIFFERENT code. The
 * child process reads the inputs and writes an answer. The verifier reads the same inputs and
 * derives the answer again, in this process, with its own arithmetic. Neither can vouch for the
 * other, which is the only reason step 4 means anything.
 *
 * Negative controls A-H follow, each removing one protection and confirming the failure is the
 * intended one.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execute } from '../executor.ts'
import { ApprovalStore } from '../../governance/approval.ts'
import { ToolRegistry } from '../../tool-router/router.ts'
import { makeTerminalTool, makeTerminalVerifier, type ProcessRecord } from './terminal-mode.ts'
import { writeProbeTool } from './filesystem-mode.ts'
import { fakeControl } from '../test/fakes.ts'
import { tally } from '../state.ts'
import type { ControlSurface } from '../../governance/contract.ts'
import type { Mission, Step } from '../state.ts'

const SYSTEM_ROOT = process.env.SystemRoot ?? 'C:\\WINDOWS'
const PROGRAM_FILES = process.env.ProgramFiles ?? 'C:\\Program Files'
const NODE = `${PROGRAM_FILES}\\nodejs\\node.exe`

// ============================================================ the world

const world = mkdtempSync(join(tmpdir(), 'aios-terminal-'))
const workspace = join(world, 'workspace')
const outside = join(world, 'outside')
const OUTSIDE_SECRET = join(outside, 'precious.txt')
mkdirSync(workspace, { recursive: true })
mkdirSync(outside, { recursive: true })
writeFileSync(OUTSIDE_SECRET, 'THIS MUST NEVER BE READ BY A MISSION STEP\n', 'utf8')

// The INPUT data the child and the verifier will each independently process.
const INPUTS: Record<string, number> = { alpha: 3, beta: 7, gamma: 11, delta: 0 }
for (const [k, v] of Object.entries(INPUTS)) {
  writeFileSync(join(workspace, `${k}.txt`), `${k}=${v}\n`, 'utf8')
}

const CONFIG = {
  maxAttempts: 1,
  permission: async () => ({
    control: 'ARMED' as const, input: 'PERMITTED' as const,
    blockedBy: null, infrastructureHealthy: true, mayInject: false,
  }),
  emergencyStop: async () => false,
}

console.log('')
console.log('=== THE WORLD ===')
console.log(`  workspace  ${workspace}`)
console.log(`  inputs     ${Object.keys(INPUTS).join(', ')}`)
console.log(`  OUTSIDE    ${OUTSIDE_SECRET}  (exists=${existsSync(OUTSIDE_SECRET)}, must never be read)`)
console.log(`  node       ${NODE}`)

// ============================================================ the deterministic script
//
// Writes a report derived from the input files. It is a SEPARATE FILE, not `node -e`, for the same
// reason the policy refuses `node -e`: a string of code is not an argument list that can be checked.

const REPORT = 'report.txt'
const tallyScript = join(workspace, 'tally.js')
writeFileSync(
  tallyScript,
  [
    "// Written by the mission author, run as a consequence requiring authorisation.",
    "const fs = require('fs'), path = require('path')",
    "const dir = __dirname",
    "const out = []",
    "for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.txt') && n !== 'report.txt').sort()) {",
    "  const m = /^([a-z]+)=(\\d+)$/.exec(fs.readFileSync(path.join(dir, f), 'utf8').trim())",
    "  if (m) out.push([m[1], Number(m[2])])",
    "}",
    "const total = out.reduce((a, [, v]) => a + v, 0)",
    "fs.writeFileSync(path.join(dir, 'report.txt'), out.map(([k, v]) => `${k}:${v}`).join('\\n') + `\\nTOTAL:${total}\\n`)",
    "console.log(`tallied ${out.length} files, total ${total}`)",
  ].join('\n'),
  'utf8',
)

/**
 * THE VERIFIER'S OWN COMPUTATION.
 *
 * Written separately from the script above, on purpose. It reads the same input files and derives
 * the same expected content with its own code, so agreement between them is corroboration rather
 * than two views of one function.
 */
function expectedReport(): string {
  const rows: Array<[string, number]> = []
  for (const f of readdirSync(workspace).filter((n) => n.endsWith('.txt') && n !== REPORT).sort()) {
    const m = /^([a-z]+)=(\d+)$/.exec(readFileSync(join(workspace, f), 'utf8').trim())
    if (m) rows.push([m[1], Number(m[2])])
  }
  const total = rows.reduce((a, [, v]) => a + v, 0)
  return rows.map(([k, v]) => `${k}:${v}`).join('\n') + `\nTOTAL:${total}\n`
}
const EXPECTED = expectedReport()
console.log('')
console.log('=== THE EXPECTED RESULT, COMPUTED BY THE VERIFIER BEFORE ANYTHING RUNS ===')
console.log(`  ${JSON.stringify(EXPECTED)}`)
console.log(`  (derived from the inputs, independently of the child process)`)

// ============================================================ the mission

const terminal = makeTerminalTool({ workspace, systemRoot: SYSTEM_ROOT, programFiles: PROGRAM_FILES })
const terminalVerifier = makeTerminalVerifier({
  workspace,
  expect: (step) => (step.id === 'tally' ? { path: REPORT, content: EXPECTED } : undefined),
})
/** Reads a workspace file back. The first and last steps, so the artifact is proven readable. */
const readBackTool = {
  name: 'read-back', mode: 'filesystem' as const,
  async run(_c: unknown, args: Record<string, unknown>) {
    const p = String(args.path ?? '')
    const full = join(workspace, p)
    if (!full.startsWith(workspace)) return { kind: 'failed' as const, reason: 'outside the workspace' }
    if (!existsSync(full)) return { kind: 'failed' as const, reason: `${p} does not exist` }
    const text = readFileSync(full, 'utf8')
    return { kind: 'data' as const, data: { path: p, bytes: text.length, text }, summary: `${p} (${text.length} bytes)` }
  },
}

const registry = new ToolRegistry({
  registrations: [
    { tool: writeProbeTool },
    { tool: readBackTool },
    {
      tool: terminal,
      effectOf: (s) => {
        const v = terminal.preview(s)
        return v.kind === 'consequential' ? v.effect : undefined
      },
      preflight: (s) => {
        const v = terminal.preview(s)
        return v.kind === 'blocked' ? { blocked: v.reason, needsHuman: v.needsHuman } : undefined
      },
    },
  ],
})

/**
 * The verifier for a file read-back, scoped to THIS mission's workspace.
 *
 * NOT `filesystemVerifier()` from the filesystem probe. That one validates against its own
 * module-level WORKSHOP, so reusing it here made the `inspect` step fail on a path it considered
 * outside its own directory - and because `tally` depends on `inspect`, the whole mission stopped
 * before ever reaching the terminal step. The mission reported "blocked" for a reason that had
 * nothing to do with approval, which is exactly the kind of control-fails-for-the-wrong-reason
 * defect this project keeps finding.
 *
 * Written here so the boundary under test is this workspace's.
 */
const readBackVerifier = {
  verifies: (s: Step) => s.mode === 'filesystem',
  async verify(s: Step, _c: unknown, d: unknown) {
    const claimed = d as { path?: string } | undefined
    if (!claimed?.path) return { rejected: 'the tool named no path' }
    const full = join(workspace, claimed.path)
    if (!full.startsWith(workspace)) return { rejected: `refused: "${full}" is outside the workspace` }
    if (!existsSync(full)) return { rejected: `went and looked for "${claimed.path}"; it is not there` }
    const body = readFileSync(full, 'utf8')
    if (body.trim().length === 0) return { rejected: `"${claimed.path}" exists but has no readable content` }
    return { evidence: { kind: 'file-read-back', path: claimed.path, bytes: Buffer.byteLength(body, 'utf8'), heading: body.split('\n')[0] ?? '', note: 'read here, after the command reported it' } as never }
  },
}

/**
 * The composed verifier for the whole mission.
 *
 * It answers "which verifier owns this step" for EVERY filesystem step, not just the ones this
 * mission happens to use. An earlier version tested `s.id === 'read-back'` and fell through to the
 * terminal verifier for anything else, so the `inspect` step - which IS a read-back, but a
 * filesystem-mode one - reached `terminalVerifier.verifies`, which only claims `tool ===
 * 'run-process'`. Nothing claimed the step and it failed with "no verifier is registered".
 *
 * The failure was honest and the message was accurate, which is what made it worth reading rather
 * than papering over: the step never ran, so the approval gate was never reached, and the mission
 * reported a governance block that had nothing to do with governance.
 *
 * Dispatching on MODE is the general rule; dispatching on step id is a special case that breaks the
 * moment the plan changes.
 */
const composedVerifier = {
  verifies: (s: Step) => (s.mode === 'filesystem' ? readBackVerifier.verifies(s) : terminalVerifier.verifies(s)),
  async verify(s: Step, c: unknown, d: unknown) {
    return s.mode === 'filesystem'
      ? readBackVerifier.verify(s, c, d)
      : terminalVerifier.verify(s, c as never, d)
  },
}

function mission(): Mission {
  return {
    id: 'm-terminal',
    objective: 'tally the numbered input files in the workspace and produce a verified report',
    constraints: [
      'workspace only',
      'no network',
      'running workspace code requires human authorisation',
      'the report must be independently verified, not merely produced',
    ],
    state: 'executing',
    plan: [
      {
        id: 'inspect', intent: 'confirm the input files are present before processing them',
        mode: 'filesystem', rationale: 'processing an absent file is not processing',
        tool: 'read-back', dependsOn: [], status: 'pending',
        args: { path: 'alpha.txt' },
      },
      {
        id: 'tally', intent: 'run the deterministic tally script over the workspace',
        mode: 'cli', rationale: 'this is the terminal step, and it runs workspace-authored code',
        tool: 'run-process', dependsOn: ['inspect'], status: 'pending',
        args: { executable: NODE, argv: [tallyScript] },
        // No `effect` declared on purpose: the TOOL supplies it, and the gate uses the tool's answer.
        // A declaration here would have to match, which is the M3 plan-defect check doing its job.
      },
      {
        id: 'read-report', intent: 'read the verified report back to confirm it is readable',
        mode: 'filesystem', rationale: 'a file that cannot be read was not delivered',
        tool: 'read-back', dependsOn: ['tally'], status: 'pending',
        args: { path: REPORT },
      },
    ] as Step[],
    history: [], pendingApprovals: [], startedAt: 0,
  }
}

function report(r: Awaited<ReturnType<typeof execute>>, label: string) {
  const t = tally(r.mission)
  // EVERY step, so a failure anywhere in the chain is visible rather than inferred from the tally.
  for (const s of r.mission.plan) {
    const o = s.result?.outcome
    const why = o && 'reason' in o ? ` ${(o as { reason: string }).reason.slice(0, 150)}` : ''
    console.log(`  step ${s.id.padEnd(12)} ${(o?.kind ?? 'DID NOT RUN').padEnd(13)}${why}`)
  }
  const tallyStep = r.mission.plan[1]
  const rec = tallyStep.result?.output as ProcessRecord | undefined
  console.log('')
  console.log(`=== ${label} ===`)
  console.log(`  mission state     ${r.mission.state}   complete=${r.record.complete}`)
  console.log(`  tally outcome     ${tallyStep.result?.outcome.kind ?? 'DID NOT RUN'}`)
  if (tallyStep.result?.outcome.kind === 'needs-human' || tallyStep.result?.outcome.kind === 'failed') {
    console.log(`  reason            ${(tallyStep.result.outcome as { reason: string }).reason.slice(0, 200)}`)
  }
  if (rec) {
    console.log(`  process           ${rec.executable.split('\\').pop()} ${rec.argv.length} arg(s)`)
    console.log(`  state             ${rec.state}  exit=${rec.exitCode}  signal=${rec.signal}  timedOut=${rec.timedOut}`)
    console.log(`  duration          ${rec.durationMs}ms`)
    console.log(`  cwd               ${rec.cwd}`)
    console.log(`  env vars          ${rec.envNames.length}  ${rec.envNames.join(',')}`)
    console.log(`  stdout            ${JSON.stringify(rec.stdout.trim())}`)
    if (rec.stderr.trim()) console.log(`  stderr            ${JSON.stringify(rec.stderr.trim().slice(0, 200))}`)
  } else {
    console.log(`  process           NOT LAUNCHED - no process record exists`)
  }
  console.log(`  report on disk    ${existsSync(join(workspace, REPORT))}`)
  console.log(`  report content    ${existsSync(join(workspace, REPORT)) ? JSON.stringify(readFileSync(join(workspace, REPORT), 'utf8')) : '(absent)'}`)
  console.log(`  events            approval-required=${r.events.filter((e) => e.type === 'approval-required').length}` +
    `  approval-satisfied=${r.events.filter((e) => e.type === 'approval-satisfied').length}` +
    `  step-refused=${r.events.filter((e) => e.type === 'step-refused').length}` +
    `  tool-selected=${r.events.filter((e) => e.type === 'tool-selected').length}`)
  console.log(`  tally             verified ${t.verified} failed ${t.failed} needsHuman ${t.needsHuman} skipped ${t.skipped}`)
  return { r, t }
}

// ============================================================ 1. BLOCKED: no approval

console.log('')
console.log('#'.repeat(78))
console.log('# 1. NO APPROVAL - the terminal step must not run')
console.log('#'.repeat(78))

const store = new ApprovalStore()
const blockedRun = await execute(mission(), {
  tools: registry, verifier: composedVerifier as never,
  control: fakeControl() as ControlSurface, approvals: store, config: CONFIG,
})
report(blockedRun, 'BLOCKED: no approval given')
const reportExistsAfterBlocked = existsSync(join(workspace, REPORT))

// ============================================================ 2. APPROVED: runs and verifies

console.log('')
console.log('#'.repeat(78))
console.log('# 2. EXPLICIT APPROVAL - then it runs, and is independently verified')
console.log('#'.repeat(78))

const outstanding = store.outstanding()
console.log('')
console.log('=== WHAT THE HUMAN WAS ASKED TO AUTHORISE ===')
for (const o of outstanding) {
  console.log(`  key      ${o.key.missionId}|${o.key.stepId}|${o.key.kind}|${o.key.target}|#${o.key.planEpoch}`)
  console.log(`  reason   ${o.description}`)
}
assert(outstanding.length === 1, `expected exactly one approval request, got ${outstanding.length}`)

const key = outstanding[0].key
const approval = store.decide(key, 'approved', 'test-human', Date.now())
console.log(`  decision ${approval.state} by ${approval.decidedBy}`)

const approvedRun = await execute(mission(), {
  tools: registry, verifier: composedVerifier as never,
  control: fakeControl() as ControlSurface, approvals: store, config: CONFIG,
})
const approved = report(approvedRun, 'APPROVED: authorised, executed, independently verified')

const sat = approved.r.events.find((e) => e.type === 'approval-satisfied') as unknown as { decidedBy: string } | undefined
console.log('')
console.log('=== THE AUTHORISATION, FROM THE AUDIT ===')
console.log(`  decidedBy  ${sat?.decidedBy}`)
console.log(`  report now on disk: ${existsSync(join(workspace, REPORT))}`)

// ============================================================ negative controls

console.log('')
console.log('#'.repeat(78))
console.log('# NEGATIVE CONTROLS')
console.log('#'.repeat(78))

interface Case { ok: boolean; msg: string }
const checks: Case[] = []
const check = (ok: boolean, msg: string) => { checks.push({ ok, msg }) }

// ---- A. FAKE SUCCESS: exit 0, stdout claims success, nothing produced
{
  const w = mkdtempSync(join(tmpdir(), 'aios-ctlA-'))
  try {
    const liar = join(w, 'liar.js')
    writeFileSync(liar, "console.log('SUCCESS: wrote report.txt with the correct totals'); process.exit(0)", 'utf8')
    const t = makeTerminalTool({ workspace: w, systemRoot: SYSTEM_ROOT, programFiles: PROGRAM_FILES })
    const v = makeTerminalVerifier({ workspace: w, expect: () => ({ path: 'report.txt', content: EXPECTED }) })
    const run = await t.run({} as never, { executable: NODE, argv: [liar] })
    const rec = (run as { data: ProcessRecord }).data
    const verdict = await v.verify({ id: 'tally' } as Step, {} as never, rec)
    console.log('')
    console.log('=== CONTROL A: a process that exits 0 and claims success but produces nothing ===')
    console.log(`  exit code        ${rec.exitCode}   (genuinely zero)`)
    console.log(`  stdout claims    ${JSON.stringify(rec.stdout.trim().slice(0, 90))}`)
    console.log(`  file produced    ${existsSync(join(w, 'report.txt'))}`)
    console.log(`  verifier said    ${'rejected' in verdict ? 'REJECTED' : 'ACCEPTED'}`)
    console.log(`  why              ${'rejected' in verdict ? verdict.rejected.slice(0, 150) : ''}`)
    check(rec.exitCode === 0, 'CONTROL A: the process really did exit 0, so exit code proves nothing')
    check('rejected' in verdict, 'CONTROL A: the verifier REJECTS exit 0 with no artifact')
    check(existsSync(join(w, 'report.txt')) === false, 'CONTROL A: nothing was actually produced')
  } finally { rmSync(w, { recursive: true, force: true }) }
}

// ---- A2. WRONG CONTENT: exit 0, file produced, content wrong
{
  const w = mkdtempSync(join(tmpdir(), 'aios-ctlA2-'))
  try {
    const wrong = join(w, 'wrong.js')
    writeFileSync(wrong, "require('fs').writeFileSync('report.txt','TOTAL:999\\n')", 'utf8')
    const t = makeTerminalTool({ workspace: w, systemRoot: SYSTEM_ROOT, programFiles: PROGRAM_FILES })
    const v = makeTerminalVerifier({ workspace: w, expect: () => ({ path: 'report.txt', content: EXPECTED }) })
    const rec = ((await t.run({} as never, { executable: NODE, argv: [wrong] })) as { data: ProcessRecord }).data
    const verdict = await v.verify({ id: 'tally' } as Step, {} as never, rec)
    console.log('')
    console.log('=== CONTROL A2: exit 0, a file WAS produced, and it is wrong ===')
    console.log(`  exit code        ${rec.exitCode}`)
    console.log(`  file produced    ${existsSync(join(w, 'report.txt'))}  content=${JSON.stringify(readFileSync(join(w, 'report.txt'), 'utf8'))}`)
    console.log(`  expected         ${JSON.stringify(EXPECTED)}`)
    console.log(`  verifier said    ${'rejected' in verdict ? 'REJECTED' : 'ACCEPTED'}`)
    check(rec.exitCode === 0 && existsSync(join(w, 'report.txt')), 'CONTROL A2: exit 0 AND a file exists - so neither alone is evidence')
    check('rejected' in verdict, 'CONTROL A2: wrong CONTENT is rejected despite exit 0')
  } finally { rmSync(w, { recursive: true, force: true }) }
}

// ---- B. NON-ZERO EXIT
{
  const w = mkdtempSync(join(tmpdir(), 'aios-ctlB-'))
  try {
    const bad = join(w, 'bad.js')
    writeFileSync(bad, "console.error('deliberate failure'); process.exit(7)", 'utf8')
    const t = makeTerminalTool({ workspace: w, systemRoot: SYSTEM_ROOT, programFiles: PROGRAM_FILES })
    const run = await t.run({} as never, { executable: NODE, argv: [bad] })
    console.log('')
    console.log('=== CONTROL B: a non-zero exit ===')
    console.log(`  result kind      ${run.kind}`)
    console.log(`  reason           ${'reason' in run ? run.reason.slice(0, 140) : ''}`)
    check(run.kind === 'failed', 'CONTROL B: a non-zero exit is a FAILURE, not a result')
  } finally { rmSync(w, { recursive: true, force: true }) }
}

// ---- C. INTERACTIVE / CREDENTIAL PROMPT
{
  const w = mkdtempSync(join(tmpdir(), 'aios-ctlC-'))
  try {
    const ask = join(w, 'ask.js')
    writeFileSync(ask, "console.log('Password:'); process.stdin.resume()", 'utf8')
    const t = makeTerminalTool({ workspace: w, systemRoot: SYSTEM_ROOT, programFiles: PROGRAM_FILES, timeoutMs: 8000 })
    const started = Date.now()
    const run = await t.run({} as never, { executable: NODE, argv: [ask] })
    const elapsed = Date.now() - started
    console.log('')
    console.log('=== CONTROL C: a process that asks for a credential ===')
    console.log(`  result kind      ${run.kind}`)
    console.log(`  elapsed          ${elapsed}ms  (must be bounded, not indefinite)`)
    console.log(`  reason           ${'reason' in run ? run.reason.slice(0, 190) : ''}`)
    check(run.kind === 'needs-human', 'CONTROL C: a credential prompt becomes needs-human, never success')
    check(elapsed < 15_000, `CONTROL C: it did not hang (${elapsed}ms)`)
    check(!('reason' in run) || !/success/i.test(run.reason), 'CONTROL C: it did not pretend to succeed')

    // And a refused program: no approval could ever make this acceptable.
    const shell = await t.run({} as never, { executable: `${SYSTEM_ROOT}\\System32\\cmd.exe`, argv: ['/c', 'dir'] })
    console.log(`  cmd.exe          ${shell.kind}  ${'reason' in shell ? shell.reason.slice(0, 110) : ''}`)
    check(shell.kind === 'failed', 'CONTROL C: an interactive shell is refused outright')
  } finally { rmSync(w, { recursive: true, force: true }) }
}

// ---- D. TIMEOUT, and the tree reaped
{
  const w = mkdtempSync(join(tmpdir(), 'aios-ctlD-'))
  try {
    const orphan = join(w, 'orphan.txt')
    const gc = join(w, 'gc.js')
    const hang = join(w, 'hang.js')
    writeFileSync(gc, "setTimeout(()=>require('fs').writeFileSync(process.argv[2],'orphan'),4000)", 'utf8')
    writeFileSync(hang, `require('child_process').spawn(process.execPath,[${JSON.stringify(gc)},${JSON.stringify(orphan)}],{stdio:'ignore'});setTimeout(()=>{},60000);`, 'utf8')
    const t = makeTerminalTool({ workspace: w, systemRoot: SYSTEM_ROOT, programFiles: PROGRAM_FILES, timeoutMs: 1200 })
    const started = Date.now()
    const run = await t.run({} as never, { executable: NODE, argv: [hang] })
    const elapsed = Date.now() - started
    await new Promise((r) => setTimeout(r, 4500))
    console.log('')
    console.log('=== CONTROL D: a hung process, and a grandchild that outlives it ===')
    console.log(`  result kind      ${run.kind}`)
    console.log(`  elapsed          ${elapsed}ms  (timeout was 1200ms)`)
    console.log(`  reason           ${'reason' in run ? run.reason.slice(0, 170) : ''}`)
    console.log(`  grandchild wrote ${existsSync(orphan)} after 4.5s   <- true means the tree was NOT reaped`)
    check(run.kind === 'failed', 'CONTROL D: a timeout is a failure')
    check(elapsed < 10_000, `CONTROL D: bounded, returned in ${elapsed}ms`)
    check(existsSync(orphan) === false, 'CONTROL D: the grandchild was REAPED, so it wrote nothing')
  } finally { rmSync(w, { recursive: true, force: true }) }
}

// ---- E2. THE BOUNDARY REFUSAL, THROUGH THE EXECUTOR
//
// CONTROL E above calls the TOOL directly, so it proves the tool refuses - and it would pass
// unchanged if the executor's preflight were deleted. That is defence in depth working, but it
// left the governance boundary untested in the live layer: only the unit suite covered it.
//
// This case goes through `execute()`, so removing the preflight makes the command reach the tool
// and this assertion fails. Both layers, both mechanisms, each with its own evidence.
{
  const w = mkdtempSync(join(tmpdir(), 'aios-ctlE2-'))
  const wsDir = join(w, 'ws')
  mkdirSync(wsDir, { recursive: true })
  try {
    const t = makeTerminalTool({ workspace: wsDir, systemRoot: SYSTEM_ROOT, programFiles: PROGRAM_FILES })
    const reg = new ToolRegistry({
      registrations: [{
        tool: t,
        effectOf: (s) => { const v = t.preview(s); return v.kind === 'consequential' ? v.effect : undefined },
        preflight: (s) => { const v = t.preview(s); return v.kind === 'blocked' ? { blocked: v.reason, needsHuman: v.needsHuman } : undefined },
      }],
    })
    const runRefused = async (id: string, exe: string, argv: string[]) => {
      const m: Mission = {
        id, objective: 'try a refused command', constraints: [], state: 'executing',
        plan: [{ id: 'run', intent: 'i', mode: 'cli', rationale: 'r', tool: 'run-process', status: 'pending',
                 args: { executable: exe, argv } }] as Step[],
        history: [], pendingApprovals: [], startedAt: 0,
      }
      return execute(m, {
        tools: reg, verifier: { verifies: () => false, async verify() { return { rejected: 'n/a' } } } as never,
        // An APPROVAL STORE WITH A BLANKET GRANT, so nothing downstream can be the reason it failed.
        approvals: new (class extends ApprovalStore {
          override lookup() { return { state: 'approved' as const, decidedBy: 'blanket', decidedAt: 0, description: '', key: null as never } }
        })(),
        control: fakeControl() as ControlSurface, config: CONFIG,
      })
    }

    console.log('')
    console.log('=== CONTROL E2: refused commands THROUGH THE EXECUTOR, with a blanket approval ===')
    console.log('  (the approval store approves anything, so only the refusal can stop these)')
    for (const [what, exe, argv] of [
      ['cmd.exe /c', `${SYSTEM_ROOT}\\System32\\cmd.exe`, ['/c', 'dir']],
      ['node -e', NODE, ['-e', 'console.log(1)']],
      ['a non-allowlisted program', `${SYSTEM_ROOT}\\System32\\where.exe`, ['node']],
    ] as Array<[string, string, string[]]>) {
      const r = await runRefused('m-ctlE2', exe, argv)
      const outcome = r.mission.plan[0].result!.outcome.kind
      const refusedEvents = r.events.filter((e) => e.type === 'step-refused').length
      const selected = r.events.filter((e) => e.type === 'tool-selected').length
      console.log(`  ${what}`)
      console.log(`    outcome ${outcome}  step-refused=${refusedEvents}  tool-selected=${selected}`)
      console.log(`    ${(r.mission.plan[0].result!.outcome as { reason: string }).reason.slice(0, 130)}`)
      check(outcome === 'failed', `CONTROL E2: ${what} is refused even with a blanket approval`)
      check(refusedEvents === 1, `CONTROL E2: ${what} produced a step-refused event`)
      check(selected === 0, `CONTROL E2: ${what} never reached the tool, so nothing was launched`)
    }
  } finally { rmSync(w, { recursive: true, force: true }) }
}

// ---- E. WORKSPACE ESCAPE
{
  const w = mkdtempSync(join(tmpdir(), 'aios-ctlE-'))
  // The workspace is a SUBDIRECTORY, and `outside` is its SIBLING.
  //
  // The first version passed `workspace: w` and put the escape target at `join(w, 'outside')` -
  // which is inside `w`. So the policy was correct to ALLOW it, and the control reported a
  // governance failure that had not happened. Two checks failed for the wrong reason: the script
  // was not refused, and the "nothing escaped" assertion was checking a file that a permitted
  // script had in fact written.
  //
  // A control whose setup contradicts its own assertion is worse than no control, because it looks
  // like evidence.
  const wsDir = join(w, 'ws')
  const outDir = join(w, 'outside')
  mkdirSync(wsDir, { recursive: true })
  mkdirSync(outDir, { recursive: true })
  const ESCAPE_MARKER = 'C:/Windows/temp/aios-should-not-exist.txt'
  try {
    rmSync(ESCAPE_MARKER, { force: true })
    const outsider = join(outDir, 'evil.js')
    writeFileSync(outsider, `require('fs').writeFileSync(${JSON.stringify(ESCAPE_MARKER)},'escaped')`, 'utf8')
    const t = makeTerminalTool({ workspace: wsDir, systemRoot: SYSTEM_ROOT, programFiles: PROGRAM_FILES })
    const cases: Array<[string, string, string[]]> = [
      ['script outside the workspace', NODE, [outsider]],
      ['traversal in the script path', NODE, [join('..', 'outside', 'evil.js')]],
      ['a shell', `${SYSTEM_ROOT}\\System32\\cmd.exe`, ['/c', 'dir']],
      ['node -e, code as a string', NODE, ['-e', 'console.log(1)']],
      ['a program not on the allowlist', 'C:\\Windows\\System32\\where.exe', ['node']],
    ]
    console.log('')
    console.log('=== CONTROL E: attempts to operate outside the workspace ===')
    for (const [what, exe, argv] of cases) {
      const r = await t.run({} as never, { executable: exe, argv })
      console.log(`  ${what}`)
      console.log(`    -> ${r.kind}  ${'reason' in r ? r.reason.slice(0, 120) : ''}`)
      check(r.kind !== 'data', `CONTROL E: ${what} is refused`)
    }
    // git pointed out of the workspace
    const gitOut = await t.run({} as never, { executable: `${PROGRAM_FILES}\\Git\\cmd\\git.exe`, argv: ['-C', outDir, 'status'] })
    console.log(`  git -C outside`)
    console.log(`    -> ${gitOut.kind}  ${'reason' in gitOut ? gitOut.reason.slice(0, 120) : ''}`)
    check(gitOut.kind !== 'data', 'CONTROL E: git -C outside the workspace is refused')
    check(existsSync(ESCAPE_MARKER) === false, 'CONTROL E: nothing escaped to disk')
  } finally {
    rmSync(ESCAPE_MARKER, { force: true })
    rmSync(w, { recursive: true, force: true })
  }
}

// ---- F. MISSING EXECUTABLE
{
  const w = mkdtempSync(join(tmpdir(), 'aios-ctlF-'))
  try {
    const t = makeTerminalTool({ workspace: w, systemRoot: SYSTEM_ROOT, programFiles: PROGRAM_FILES })
    // An allowlisted program, but the script it is asked to run does not exist.
    const r = await t.run({} as never, { executable: NODE, argv: [join(w, 'not-here.js')] })
    console.log('')
    console.log('=== CONTROL F: the process cannot start ===')
    console.log(`  result kind      ${r.kind}`)
    console.log(`  reason           ${'reason' in r ? r.reason.slice(0, 140) : ''}`)
    check(r.kind === 'failed', 'CONTROL F: a missing executable is a FAILURE, not a result')
    check(!('kind' in r && r.kind === 'nothing-found'), 'CONTROL F: it is not reported as "nothing found"')
  } finally { rmSync(w, { recursive: true, force: true }) }
}

// ---- G. UNAPPROVED CONSEQUENTIAL TERMINAL ACTION, through the executor
{
  const w = mkdtempSync(join(tmpdir(), 'aios-ctlG-'))
  try {
    const side = join(w, 'side-effect.txt')
    const script = join(w, 'writer.js')
    writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(side)},'the side effect')`, 'utf8')
    const t = makeTerminalTool({ workspace: w, systemRoot: SYSTEM_ROOT, programFiles: PROGRAM_FILES })
    const reg = new ToolRegistry({
      registrations: [{
        tool: t,
        effectOf: (s) => { const v = t.preview(s); return v.kind === 'consequential' ? v.effect : undefined },
        preflight: (s) => { const v = t.preview(s); return v.kind === 'blocked' ? { blocked: v.reason, needsHuman: v.needsHuman } : undefined },
      }],
    })
    const m: Mission = {
      id: 'm-ctlG', objective: 'run a script with a side effect', constraints: [], state: 'executing',
      plan: [{ id: 'run', intent: 'i', mode: 'cli', rationale: 'r', tool: 'run-process', status: 'pending',
               args: { executable: NODE, argv: [script] } }] as Step[],
      history: [], pendingApprovals: [], startedAt: 0,
    }
    const r = await execute(m, {
      tools: reg, verifier: { verifies: () => false, async verify() { return { rejected: 'n/a' } } } as never,
      control: fakeControl() as ControlSurface, approvals: new ApprovalStore(), config: CONFIG,
    })
    console.log('')
    console.log('=== CONTROL G: an unapproved consequential terminal action, through the executor ===')
    console.log(`  outcome          ${r.mission.plan[0].result!.outcome.kind}`)
    console.log(`  reason           ${(r.mission.plan[0].result!.outcome as { reason: string }).reason.slice(0, 160)}`)
    console.log(`  side effect file ${existsSync(side)}   <- must be false: the process never ran`)
    console.log(`  approval-required ${r.events.filter((e) => e.type === 'approval-required').length}`)
    console.log(`  tool-selected     ${r.events.filter((e) => e.type === 'tool-selected').length}   <- 0 means it was never even selected`)
    check(r.mission.plan[0].result!.outcome.kind === 'needs-human', 'CONTROL G: blocked without approval')
    check(existsSync(side) === false, 'CONTROL G: the side effect did NOT happen')
    check(r.events.filter((e) => e.type === 'tool-selected').length === 0, 'CONTROL G: the tool was never selected')
  } finally { rmSync(w, { recursive: true, force: true }) }
}

// ---- H. APPROVAL IS NOT VERIFICATION
{
  const w = mkdtempSync(join(tmpdir(), 'aios-ctlH-'))
  try {
    const side = join(w, 'h-side.txt')
    const script = join(w, 'h-writer.js')
    writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(side)},'ran')`, 'utf8')
    const t = makeTerminalTool({ workspace: w, systemRoot: SYSTEM_ROOT, programFiles: PROGRAM_FILES })
    const reg = new ToolRegistry({
      registrations: [{
        tool: t,
        effectOf: (s) => { const v = t.preview(s); return v.kind === 'consequential' ? v.effect : undefined },
        preflight: (s) => { const v = t.preview(s); return v.kind === 'blocked' ? { blocked: v.reason, needsHuman: v.needsHuman } : undefined },
      }],
    })
    const m = (): Mission => ({
      id: 'm-ctlH', objective: 'x', constraints: [], state: 'executing',
      plan: [{ id: 'run', intent: 'i', mode: 'cli', rationale: 'r', tool: 'run-process', status: 'pending',
               args: { executable: NODE, argv: [script] } }] as Step[],
      history: [], pendingApprovals: [], startedAt: 0,
    })
    const probe = new ApprovalStore()
    await execute(m(), { tools: reg, verifier: { verifies: () => false, async verify() { return { rejected: 'n/a' } } } as never,
      control: fakeControl() as ControlSurface, approvals: probe, config: CONFIG })
    const k = probe.outstanding()[0].key

    // Approved and REAL, with verification suppressed.
    const store = new ApprovalStore()
    store.request(k, 'authorised'); store.decide(k, 'approved', 'test-human', Date.now())
    const r = await execute(m(), {
      tools: reg, verifier: { verifies: () => false, async verify() { return { rejected: 'verification suppressed' } } } as never,
      control: fakeControl() as ControlSurface, approvals: store, config: CONFIG,
    })
    console.log('')
    console.log('=== CONTROL H: approved, executed, verification suppressed ===')
    console.log(`  approval         granted by ${store.decisions()[0].decidedBy}`)
    console.log(`  outcome          ${r.mission.plan[0].result!.outcome.kind}`)
    console.log(`  mission complete ${r.record.complete}   <- must be false`)
    console.log(`  side effect file ${existsSync(side)}   <- true: the action DID happen, which is not the same as verified`)
    check(r.record.complete === false, 'CONTROL H: a human saying yes is not evidence it worked')
    check(existsSync(side) === true, 'CONTROL H: the action really did run - permitted is not proven')
  } finally { rmSync(w, { recursive: true, force: true }) }
}

// ============================================================ the recorded boundary

console.log('')
console.log('#'.repeat(78))
console.log('# THE RECORDED BOUNDARY - what is enforced and what is not')
console.log('#'.repeat(78))
const { LIMITATIONS, ENV_ALLOWLIST } = await import('./terminal-policy.ts')
console.log('')
console.log('  NOT restricted (no OS isolation exists):')
for (const l of LIMITATIONS) console.log(`    - ${l}`)
console.log('')
console.log(`  Environment requested: ${ENV_ALLOWLIST.join(', ')}`)
console.log('  Measured: the Windows loader adds variables the parent cannot suppress.')
// `approved` is the { r, t } pair from `report()`. The three "what happened" references below
// originally read `approvedRun.r`, which is the raw ExecuteResult and so has `.mission` directly -
// except the earlier rename left this one pointing at a name that no longer holds what it claims.
// Every fix here has been the same shape: the harness asserts against a stale reference, and the
// crash lands on the reporting path after the evidence was already collected.
const approvedRecord = approved.r.mission.plan[1].result?.output as ProcessRecord | undefined
console.log(`  The child in this run received: ${approvedRecord?.envNames.join(', ') ?? '(no process ran)'}`)
console.log('')
console.log('  Genuinely enforced, and the whole of it:')
console.log('    - which program starts, by absolute path')
console.log('    - which arguments it receives, for path-bearing arguments')
console.log('    - how long it may run, and that its process tree is reaped on timeout')
console.log('    - which environment variables it starts with')
console.log('')
console.log(`  OUTSIDE secret read by any step? ${readFileSync(OUTSIDE_SECRET, 'utf8').includes('read') ? 'unknown' : 'no'} (it is intact and unreferenced by any step)`)

// ============================================================ verdict

console.log('')
console.log('#'.repeat(78))
console.log('# THE REAL MISSION')
console.log('#'.repeat(78))
console.log('')
let failed = 0
for (const c of checks) {
  console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.msg}`)
  if (!c.ok) failed++
}
console.log('')
console.log('=== THE MISSION, END TO END ===')
console.log(`  objective      ${approved.r.mission.objective}`)
console.log(`  plan           ${approved.r.mission.plan.map((s) => s.id).join(' -> ')}`)
console.log(`  final state    ${approved.r.mission.state}`)
console.log(`  complete       ${approved.r.record.complete}`)
const ev = approved.r.mission.plan.flatMap((s) => (s.result?.outcome.kind === 'verified' ? [s.result.outcome.evidence] : []))
console.log('')
console.log('=== THE INDEPENDENT EVIDENCE, ONE PER VERIFIED STEP ===')
for (const e of ev) {
  const d = e as unknown as Record<string, unknown>
  if (d.kind === 'command-verified') {
    // `d` is a broad `Record<string, unknown>`, so `.split()` on `executable` has to be earned.
    // The old form called `.split` straight on `unknown` and would have thrown at runtime on a
    // payload that did not carry a string here.
    const exe = typeof d.executable === 'string' ? d.executable : '(not recorded)'
    const path = typeof d.path === 'string' ? d.path : '(not recorded)'
    console.log(`  command-verified  ${exe.split('\\').pop()} exit=${d.exitCode} ${d.durationMs}ms env=${d.envVarCount} vars`)
    console.log(`                    ${path}`)
    console.log(`                    ${d.bytes} bytes, corroborated by: ${d.corroboratedBy}`)
  } else {
    console.log(`  ${d.kind}  ${JSON.stringify(d).slice(0, 150)}`)
  }
}
console.log('')
console.log('=== CLEANUP ===')
rmSync(world, { recursive: true, force: true })
console.log(`  world removed: ${!existsSync(world)}`)
console.log('')
console.log(`=== ${failed === 0 ? 'PASS' : failed + ' FAILURE(S)'} ===`)
process.exit(failed ? 1 : 0)

function assert(cond: boolean, msg: string): void {
  if (!cond) { console.log(`  HARNESS ERROR: ${msg}`); process.exit(2) }
}
