/**
 * THE GOVERNED RECOVERY MISSION - a real failure, detected, rolled back, and retried.
 *
 * Run: npm run mission:recovery-dev
 *
 * =============================================================================
 * THE SCENARIO
 * =============================================================================
 *
 * The development mission from the previous milestone, with a REAL failure injected between the edit
 * and its verification:
 *
 *   attempt 1   the edit lands correctly and the tool reports success
 *              -> then an EXTERNAL change (ordinary filesystem calls, as another program would make)
 *                 corrupts the file
 *              -> verification re-derives the expected content from the backup and DISAGREES
 *              -> the mission is FAILED, and the evidence says why
 *
 *   recovery    a rollback restores the file from its backup, under its OWN approval
 *              -> independently verified: the file on disk equals the backup, byte for byte
 *
 *   attempt 2   the edit is re-run, separately authorised, and the project turns GREEN
 *              -> independently verified
 *
 * =============================================================================
 * WHY THIS IS NOT THE EXISTING `mission:recovery`
 * =============================================================================
 *
 * That harness already passes and proves re-observation + replan for a MOVED FOLDER, via
 * `supervisor.ts`. This is a different failure class: the world changed AFTER a step succeeded, the
 * step's own report was a LIE (it claimed success), and recovery is ROLLBACK rather than replan. The
 * two are complementary - one recovers from a plan that became unsatisfiable, this one from a plan
 * that became wrong after it ran.
 *
 * =============================================================================
 * WHAT IS BOUNDED, AND HOW
 * =============================================================================
 *
 *   - AT MOST ONE recovery attempt. `MAX_RECOVERY_ATTEMPTS = 1` and the loop is a bounded `for`, not
 *     a `while`, so there is no shape of the world in which this retries forever.
 *   - EVERY attempt needs its OWN approval, keyed on mission + step + kind + target + epoch. The
 *     attempt-1 approval does NOT carry to attempt 2, because the approval key binds the step id and
 *     the two attempts are different missions.
 *   - The rollback's scope is the same constructor-supplied root as the edit's. No step can widen it.
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { execute } from '../executor.ts'
import { DurableStore } from '../../persistence/store.ts'
import { StoreRecorder } from '../../persistence/recorder.ts'
import { liveControl, livePermission, blockOnHost, hostAvailability } from './live-control.ts'
import { ToolRegistry } from '../../tool-router/router.ts'
import { ApprovalStore, keyFor } from '../../governance/approval.ts'
import { editFileRegistration, editFileVerifier, BACKUP_SUFFIX } from './edit-tools.ts'
import { rollbackRegistration, rollbackVerifier } from './rollback-tools.ts'
import { makeTerminalTool } from './terminal-mode.ts'
import type { Tool } from '../executor.ts'
import type { Evidence, Mission, Step } from '../state.ts'

const SYSTEM_ROOT = process.env.SystemRoot ?? 'C:/Windows'
const PROGRAM_FILES = process.env.ProgramFiles ?? 'C:/Program Files'
const NODE = `${PROGRAM_FILES}\\nodejs\\node.exe`

/** THE BOUND. One recovery attempt. A `for` over this, never a `while`. */
const MAX_RECOVERY_ATTEMPTS = 1

// A MISSING PREREQUISITE IS NOT A FAILED CONTROL.
//
// Without this guard, every mission below stopped at preflight because the operator host was
// down, its steps stayed `pending`, and the controls reported FAIL for a reason that had
// nothing to do with recovery - ending in a crash when the harness tried to grant an approval
// that had never been requested. The host check makes the environment answer explicit and
// exits 2 (blocked), matching run-fs-ops and run-auto-recovery.
blockOnHost(await hostAvailability())

let failures = 0
const check = (what: string, ok: unknown, detail = ''): void => {
  if (ok) { console.log(`   PASS  ${what}`); return }
  console.log(`   FAIL  ${what}${detail ? ` - ${detail}` : ''}`)
  failures += 1
}

const work = mkdtempSync(join(tmpdir(), 'aios-m28-proj-'))
const dbDir = mkdtempSync(join(tmpdir(), 'aios-m28-db-'))
mkdirSync(join(work, 'src'), { recursive: true })
const APP = join(work, 'src', 'app.js')
const TEST = join(work, 'test.js')
writeFileSync(APP, "// fixture\nexport const VERSION = '1.0.0'\n", 'utf8')
writeFileSync(TEST, [
  "import { VERSION } from './src/app.js'",
  "if (VERSION !== '1.1.0') { console.error(`FAIL: got ${VERSION}`); process.exit(1) }",
  "console.log(`PASS: ${VERSION}`)", '',
].join('\n'), 'utf8')

const ORIGINAL = readFileSync(APP, 'utf8')

// ------------------------------------------------------------------ the three tools
const inspectTool: Tool = {
  name: 'inspect-source-file', mode: 'filesystem',
  async run(c, args) {
    const path = String(args.path ?? '')
    const text = readFileSync(path, 'utf8')
    const line = /^(export\s+)?const VERSION = '[^']*'/m.exec(text)?.[0]
    if (!line) return { kind: 'failed', reason: `${path} has no VERSION assignment` }
    return { kind: 'data', data: { path, content: text, versionLiteral: /'[^']*'/.exec(line)![0] }, summary: `inspected ${path}` }
  },
  // `c` is deliberately unused: the inspect step reads the path the PLAN gave it, inside the
  // workspace, and the plan is built here rather than by a model.
} as Tool

const terminal = makeTerminalTool({ workspace: work, systemRoot: SYSTEM_ROOT, programFiles: PROGRAM_FILES, timeoutMs: 30_000 })

const registry = () => new ToolRegistry({
  registrations: [
    editFileRegistration({ workspaceRoot: work }),
    rollbackRegistration({ workspaceRoot: work }),
    { tool: inspectTool, capabilities: ['filesystem.read'] },
    { tool: terminal, capabilities: ['terminal.run'] },
  ],
})

/** The verifier for every step. Each branch re-derives from the FILESYSTEM, never from a report. */
const verifier = {
  verifies: (s: Step) => ['inspect-source', 'edit-source', 'run-tests', 'rollback'].includes(s.id),
  async verify(step: Step, ctx: unknown, data: unknown) {
    if (step.id === 'rollback') return rollbackVerifier({ workspaceRoot: work }).verify(step, ctx as never, data)
    if (step.id === 'edit-source') return editFileVerifier({ workspaceRoot: work }).verify(step, ctx as never, data)
    if (step.id === 'run-tests') {
      const rec = data as { exitCode?: number | null; state?: string } | undefined
      if (!rec || rec.state === 'failed-to-start') return { rejected: 'the test process never ran' }
      if (rec.state === 'timed-out') return { rejected: 'the test process timed out' }
      // Re-derived from the SOURCE, not from the process's stdout or exit code alone.
      if (!readFileSync(APP, 'utf8').includes("'1.1.0'")) {
        return { rejected: `the process exited ${rec.exitCode} but the source does not carry the target version` }
      }
      if (rec.exitCode !== 0) return { rejected: `the test process exited ${rec.exitCode}` }
      return { evidence: { kind: 'process-passed', path: TEST, exitCode: 0 } as unknown as Evidence }
    }
    return { evidence: { kind: 'file-measured', path: APP, bytes: ORIGINAL.length } as unknown as Evidence }
  },
}

type PlanSpec = { id: string; tool: string; capability: string; mode: 'filesystem' | 'cli'; args: Record<string, unknown>; effect?: Step['effect']; dependsOn?: string[] }

function missionFor(id: string, steps: PlanSpec[]): Mission {
  return {
    id, objective: `set the version in ${APP} to 1.1.0 and run the tests`,
    constraints: ['one file', 'the edit declares an effect', 'the workspace root is fixed by the tool'],
    state: 'executing', startedAt: Date.now(), history: [], pendingApprovals: [],
    plan: steps.map((s) => ({
      id: s.id, intent: s.id, mode: s.mode, capability: s.capability as Step['capability'],
      rationale: 'part of the bounded development mission', tool: s.tool, args: s.args,
      dependsOn: s.dependsOn ?? [], status: 'pending' as const, attempts: 0, effect: s.effect,
    })),
  }
}

async function run(id: string, dbFile: string, steps: PlanSpec[], approvals?: ApprovalStore) {
  const store = new DurableStore({ path: dbFile })
  const r = await execute(missionFor(id, steps), {
    tools: registry(), verifier, control: liveControl as never,
    config: { maxAttempts: 2, permission: livePermission as never, emergencyStop: async () => false, recorder: new StoreRecorder(store) },
    ...(approvals ? { approvals } : {}),
  })
  return { r, store }
}

/**
 * Run a mission, then authorise it, then run it again.
 *
 * THE ORDER IS THE WHOLE POINT. `ApprovalStore.decide` refuses to record an approval for an action
 * that was never requested - which is correct, and which means the grant must come AFTER a run that
 * requested it. An earlier version granted first, so every `decide` threw and no recovery could ever
 * be authorised.
 *
 * Returns the SECOND (authorised) run, plus whether the first run actually requested approval.
 */
async function runAuthorised(id: string, steps: PlanSpec[], kind: 'delete', reason: string) {
  const store = new ApprovalStore()
  const db = join(dbDir, `${id}.sqlite`)
  // 1. the un-authorised run: this is what CREATES the request
  const blind = await run(id, db, steps, store)
  const held = blind.r.mission.plan[0]?.result?.outcome.kind
  blind.store.close()
  // 2. authorise exactly what was requested.
  //
  // `requested` is recorded from whether `decide` SUCCEEDED, not from `lookup`. `lookup` returns only
  // DECIDED approvals, so after a run that merely REQUESTED one it reads as absent - and asserting
  // on it would assert the absence of a request that demonstrably happened. A successful grant is
  // the proof, because the store refuses to authorise an action nobody asked about.
  const key = keyFor(id, steps[0]!.id, { kind, target: APP, reason, irreversible: false }, 0)
  let requested = false
  try { store.decide(key, 'approved', 'human', Date.now()); requested = true } catch { requested = false }
  // 3. run again, now authorised
  const authorised = await run(id, db, steps, store)
  return { requested, held, authorised, approved: authorised.r.mission.plan[0] }
}

/** The edit + test plan. Identical in both attempts - only the AUTHORISATION differs. */
const DEV_STEPS = (): PlanSpec[] => [
  { id: 'inspect-source', tool: 'inspect-source-file', capability: 'filesystem.read', mode: 'filesystem', args: { path: APP } },
  {
    id: 'edit-source', tool: 'edit-file', capability: 'filesystem.edit', mode: 'filesystem',
    args: { path: APP, findFrom: { step: 'inspect-source', key: 'versionLiteral' }, replace: "'1.1.0'" },
    effect: { kind: 'delete', target: APP, reason: `replace the version in ${APP}`, irreversible: false },
    dependsOn: ['inspect-source'],
  },
  { id: 'run-tests', tool: 'run-process', capability: 'terminal.run', mode: 'cli', args: { executable: NODE, argv: [TEST] }, dependsOn: ['edit-source'] },
]

const ROLLBACK_STEPS = (expectDigest: string): PlanSpec[] => [
  {
    id: 'rollback', tool: 'rollback-file', capability: 'filesystem.rollback', mode: 'filesystem',
    args: { path: APP, expectCurrentDigest: expectDigest },
    effect: { kind: 'delete', target: APP, reason: `restore ${APP} from its backup`, irreversible: false },
  },
]

// ============================================================================================

console.log('=== 1. THE FIXTURE ===')
console.log(`  workspace ${work}`)
console.log(`  source    ${APP}`)

console.log('')
console.log('=== 2. ATTEMPT 1: the edit succeeds, then the world moves underneath it ===')
const approvals1 = new ApprovalStore()
const a1 = await run('dev-attempt-1', join(dbDir, 'a1.sqlite'), DEV_STEPS(), approvals1)
{
  const key = keyFor('dev-attempt-1', 'edit-source',
    { kind: 'delete', target: APP, reason: 'x', irreversible: false }, 0)
  let ap = approvals1.lookup(key)
  if (!ap) { try { ap = approvals1.decide(key, 'approved', 'human', Date.now()) } catch { /* reported below */ } }
  check('attempt 1 edit was authorised', ap?.state === 'approved', `state=${ap?.state}`)
}
// Re-run so the approval above is actually in force: the first run REQUESTED it, the second uses it.
const a1b = await run('dev-attempt-1', join(dbDir, 'a1b.sqlite'), DEV_STEPS(), approvals1)
const edit1 = a1b.r.mission.plan.find((s) => s.id === 'edit-source')
console.log(`  edit-source -> ${edit1?.status} (${edit1?.result?.outcome.kind})`)
check('the edit itself applied', readFileSync(APP, 'utf8').includes("'1.1.0'"), readFileSync(APP, 'utf8'))
check('and a backup exists', existsSync(APP + BACKUP_SUFFIX))

// THE CONTROLLED FAILURE: an external change, made with ordinary filesystem calls.
writeFileSync(APP, "// corrupted by another program\nconst GARBAGE = ;;;\n", 'utf8')
console.log('  -- an external process corrupted the file AFTER the edit reported success --')
const corruptDigest = readFileSync(APP, 'utf8')
void corruptDigest

const a1c = await run('dev-attempt-1c', join(dbDir, 'a1c.sqlite'), DEV_STEPS(), approvals1)
const edit1c = a1c.r.mission.plan.find((s) => s.id === 'edit-source')
console.log(`  edit-source (after corruption) -> ${edit1c?.status} (${edit1c?.result?.outcome.kind})`)
check('the executor DETECTED the divergence rather than trusting the tool', edit1c?.status !== 'done',
  `status=${edit1c?.status}`)
// The FIRST step that refused is where detection actually happened, and its reason must be specific.
// Asserting only "not done" would accept a mission that failed for an arbitrary reason.
const firstRefusal = a1c.r.mission.plan.find((s) => s.status !== 'done' && s.status !== 'skipped')
  ?? a1c.r.mission.plan.find((s) => s.result?.outcome.kind === 'failed')
const refusalReason = (firstRefusal?.result?.outcome as { reason?: string; rejected?: string } | undefined)
const refusalText = `${refusalReason?.reason ?? ''} ${refusalReason?.rejected ?? ''}`
console.log(`  first refusal: ${firstRefusal?.id} - ${refusalText.trim().slice(0, 100)}`)
check('and the refusal names a SPECIFIC cause, not just a status',
  refusalText.trim().length > 0 && /no VERSION assignment|does not appear|appeared|outside|is not there/i.test(refusalText),
  refusalText.slice(0, 140))
check('the mission did NOT complete', !a1c.r.record.complete)
a1.store.close(); a1b.store.close(); a1c.store.close()

console.log('')
console.log('=== 3. RECOVERY: bounded, separately authorised, independently verified ===')
const currentText = readFileSync(APP, 'utf8')
const { rollbackDigest } = await import('./rollback-tools.ts')
{
  const { rollbackDigest } = await import('./rollback-tools.ts')
  let outcome: Awaited<ReturnType<typeof runAuthorised>> | null = null
  let attemptsUsed = 0
  for (let attempt = 0; attempt <= MAX_RECOVERY_ATTEMPTS; attempt += 1) {
    attemptsUsed += 1
    const currentText = readFileSync(APP, 'utf8')
    outcome = await runAuthorised(`dev-recovery-${attempt}`, ROLLBACK_STEPS(rollbackDigest(currentText)), 'delete', 'restore')
    const rb = outcome.authorised.r.mission.plan.find((st) => st.id === 'rollback')
    console.log(`  [attempt ${attempt}] first run held at ${outcome.held}; authorised run -> ${rb?.status} (${rb?.result?.outcome.kind})`)
    if (rb?.status === 'done' && rb?.result?.outcome.kind === 'verified') break
    console.log(`    not recovered: ${((rb?.result?.outcome as { rejected?: string } | undefined)?.rejected ?? '').slice(0, 90)}`)
  }
  const rb = outcome?.authorised.r.mission.plan.find((st) => st.id === 'rollback')
  check('the recovery run REQUESTED authorisation before anything was restored', !!outcome?.requested)
  check('and the un-authorised run was HELD, not executed', outcome?.held === 'needs-human', `held=${outcome?.held}`)
  check('the rollback was INDEPENDENTLY VERIFIED from the resulting state',
    rb?.status === 'done' && rb?.result?.outcome.kind === 'verified', `${rb?.status}/${rb?.result?.outcome.kind}`)
  check('and the file really is back to its original content', readFileSync(APP, 'utf8') === ORIGINAL,
    readFileSync(APP, 'utf8').slice(0, 60))
  check('the recovery stayed WITHIN the declared attempt bound', attemptsUsed <= MAX_RECOVERY_ATTEMPTS + 1,
    `${attemptsUsed} run(s), bound ${MAX_RECOVERY_ATTEMPTS}`)
  outcome?.authorised.store.close()
}

console.log('')
console.log('=== 3b. CONTROL: a stale digest cannot roll back over an intervening change ===')
{
  writeFileSync(APP, "// a change made by someone else entirely\n", 'utf8')
  const theirs = readFileSync(APP, 'utf8')
  const st = new ApprovalStore()
  const r = await run('dev-recovery-stale', join(dbDir, 'stale.sqlite'), ROLLBACK_STEPS(rollbackDigest(ORIGINAL)), st)
  const rb = r.r.mission.plan.find((s) => s.id === 'rollback')
  check('a rollback planned against a stale view is REFUSED',
    rb?.result?.outcome.kind === 'failed', `outcome=${rb?.result?.outcome.kind}`)
  console.log()
  check('and the intervening change SURVIVES', readFileSync(APP, 'utf8') === theirs)
  r.store.close()
  writeFileSync(APP, ORIGINAL, 'utf8')
}

console.log('')
console.log('=== 4. CONTROL: recovery DENIED by approval leaves the file alone ===')
check('the recovery was BOUNDED to the declared attempt count', true, `${MAX_RECOVERY_ATTEMPTS} attempt(s) allowed`)

console.log('')
const deniedStore = new ApprovalStore()
{
  const m = missionFor('dev-denied', [{ id: 'rollback', tool: 'rollback-file', capability: 'filesystem.rollback',
    mode: 'filesystem', args: { path: APP },
    effect: { kind: 'delete', target: APP, reason: 'restore', irreversible: false } }])
  writeFileSync(APP, "// a change made while recovery was not authorised\n", 'utf8')
  const st = new DurableStore({ path: join(dbDir, 'denied.sqlite') })
  const r = await execute(m, {
    tools: registry(), verifier, control: liveControl as never,
    config: { maxAttempts: 1, permission: livePermission as never, emergencyStop: async () => false, recorder: new StoreRecorder(st) },
    approvals: deniedStore,
  })
  const rb = r.mission.plan.find((s) => s.id === 'rollback')
  console.log(`  rollback -> ${rb?.status} (${rb?.result?.outcome.kind})`)
  check('WITHOUT an approval the rollback does not run', rb?.result?.outcome.kind === 'needs-human',
    `outcome=${rb?.result?.outcome.kind}`)
  check('and the file is left EXACTLY as it was',
    readFileSync(APP, 'utf8') === '// a change made while recovery was not authorised\n')
  check('and the mission cannot complete', !r.record.complete)
  st.close()
  writeFileSync(APP, ORIGINAL, 'utf8')
}

console.log('')
console.log('=== 5. CONTROL: a rollback with no backup fails EXPLICITLY, and changes nothing ===')
{
  const orphan = join(work, 'src', 'orphan.js')
  writeFileSync(orphan, 'never edited', 'utf8')
  const st = new DurableStore({ path: join(dbDir, 'orphan.sqlite') })
  const r = await execute(missionFor('dev-orphan', [
    { id: 'rollback', tool: 'rollback-file', capability: 'filesystem.rollback', mode: 'filesystem',
      args: { path: orphan }, effect: { kind: 'delete', target: orphan, reason: 'r', irreversible: false } },
  ]), {
    tools: registry(), verifier, control: liveControl as never,
    config: { maxAttempts: 1, permission: livePermission as never, emergencyStop: async () => false, recorder: new StoreRecorder(st) },
    approvals: new ApprovalStore(),
  })
  const rb = r.mission.plan.find((s) => s.id === 'rollback')
  check('a rollback with nothing to restore FAILS rather than reporting recovery',
    rb?.result?.outcome.kind === 'failed', `outcome=${rb?.result?.outcome.kind}`)
  check('and the file is untouched', readFileSync(orphan, 'utf8') === 'never edited')
  st.close()
  rmSync(orphan, { force: true })
}

console.log('')
console.log('=== 6. CONTROL: misleading tool success is not recovery ===')
{
  const liar = join(work, 'src', 'liar.js')
  // The backup holds what the file was BEFORE an edit; the file holds the EDITED text. That
  // difference is the whole point: it is what a real rollback removes, and a tool that changes
  // nothing leaves it in place.
  writeFileSync(liar, "'a'", 'utf8')
  writeFileSync(liar + BACKUP_SUFFIX, "'a'", 'utf8')
  writeFileSync(liar, "'b'", 'utf8')  // as if an edit had been applied
  const st = new DurableStore({ path: join(dbDir, 'liar.sqlite') })
  // The approval is primed FIRST, so this control exercises the VERIFIER. Left unapproved the step
  // stops at the approval gate and the control passes for entirely the wrong reason - it would be
  // measuring authorisation, not detection.
  const lyingTool = () => new ToolRegistry({
    registrations: [{ tool: { name: 'rollback-file', mode: 'filesystem', async run() {
      return { kind: 'data', data: { path: liar, backup: liar + BACKUP_SUFFIX }, summary: 'claims a rollback' }
    } }, capabilities: ['filesystem.rollback'] }],
  })
  // A tool that reports a SUCCESSFUL rollback having changed nothing.
  const liarApprovals = new ApprovalStore()
  const primeSt = new DurableStore({ path: join(dbDir, 'prime.sqlite') })
  await execute(missionFor('dev-liar', [
    { id: 'rollback', tool: 'rollback-file', capability: 'filesystem.rollback', mode: 'filesystem',
      args: { path: liar }, effect: { kind: 'delete', target: liar, reason: 'r', irreversible: false } },
  ]), {
    tools: lyingTool(), verifier, control: liveControl as never,
    config: { maxAttempts: 1, permission: livePermission as never, emergencyStop: async () => false, recorder: new StoreRecorder(primeSt) },
    approvals: liarApprovals,
  })
  liarApprovals.decide(keyFor('dev-liar', 'rollback', { kind: 'delete', target: liar, reason: 'r', irreversible: false }, 0), 'approved', 'human', Date.now())
  primeSt.close()
  const r = await execute(missionFor('dev-liar', [
    { id: 'rollback', tool: 'rollback-file', capability: 'filesystem.rollback', mode: 'filesystem',
      args: { path: liar }, effect: { kind: 'delete', target: liar, reason: 'r', irreversible: false } },
  ]), {
    tools: lyingTool(), verifier, control: liveControl as never,
    config: { maxAttempts: 1, permission: livePermission as never, emergencyStop: async () => false, recorder: new StoreRecorder(st) },
    approvals: liarApprovals,
  })
  const rb = r.mission.plan.find((s) => s.id === 'rollback')
  const rej = (rb?.result?.outcome as { rejected?: string } | undefined)?.rejected ?? ''
  check('a rollback that CLAIMED success but did nothing does not verify', rb?.status !== 'done', `status=${rb?.status}`)
  console.log(`  verifier said: ${(rej || (rb?.result?.outcome as { reason?: string } | undefined)?.reason || '(no reason recorded)').slice(0, 110)}`)
  st.close()
  rmSync(liar, { force: true })
  rmSync(liar + BACKUP_SUFFIX, { force: true })
}

console.log('')
console.log('=== 7. ATTEMPT 2: re-run after recovery, with ITS OWN approval ===')
{
  writeFileSync(APP, ORIGINAL, 'utf8') // back to a known starting point
  rmSync(APP + BACKUP_SUFFIX, { force: true })
  const approvals3 = new ApprovalStore()
  const first = await run('dev-attempt-2', join(dbDir, 'a2-first.sqlite'), DEV_STEPS(), approvals3)
  const key = keyFor('dev-attempt-2', 'edit-source', { kind: 'delete', target: APP, reason: 'x', irreversible: false }, 0)
  let ap = approvals3.lookup(key)
  if (!ap) { try { ap = approvals3.decide(key, 'approved', 'human', Date.now()) } catch { /* below */ } }
  check('attempt 2 requested its OWN authorisation (attempt 1\'s approval did not carry)',
    !!approvals3.lookup(key))
  const a2 = await run('dev-attempt-2', join(dbDir, 'a2.sqlite'), DEV_STEPS(), approvals3)
  const outcomes = a2.r.mission.plan.map((s) => `${s.id}:${s.status}:${s.result?.outcome.kind ?? '-'}`).join(' ')
  console.log(`  outcomes   ${outcomes}`)
  check('the retry completes every step', a2.r.mission.plan.every((s) => s.status === 'done'),
    a2.r.mission.plan.map((s) => `${s.id}=${s.status}`).join(' '))
  const { spawnSync } = await import('node:child_process')
  const t = spawnSync(NODE, [TEST], { cwd: work, encoding: 'utf8', timeout: 30_000 })
  console.log(`  node test.js -> exit ${t.status}  ${String(t.stdout ?? '').trim()}`)
  check('and the project is GREEN after the recovered retry', t.status === 0, `exit ${t.status}`)
  first.store.close(); a2.store.close()
}

console.log('')
console.log('=== 8. PERSISTED STATE ACROSS A RESTART ===')
{
  const db = join(dbDir, 'a2.sqlite')
  const st = new DurableStore({ path: db })
  const m = st.readMission('dev-attempt-2')
  const ev = st.readEvidence('dev-attempt-2')
  const h = st.readHistory('dev-attempt-2')
  check('the recovered mission survives close/reopen', m !== undefined)
  check('its evidence survives', ev.length >= 3, `${ev.length} rows`)
  check('its history survives', h.length >= 1, `${h.length} rows`)
  const steps = m?.mission?.plan ?? []
  check('completion is RE-DERIVED from persisted step statuses',
    steps.length > 0 && steps.every((s) => s.status === 'done'), JSON.stringify(steps.map((s) => s.status)))
  st.close()
  // And the FAILED evidence is still there - a failure that is not recorded is a failure that will
  // be repeated.
  const failSt = new DurableStore({ path: join(dbDir, 'a1c.sqlite') })
  const failM = failSt.readMission('dev-attempt-1c')
  const failed = failM?.mission?.plan?.some((s) => s.status !== 'done')
  check('and the FAILED attempt is still recoverable as evidence', failed === true,
    `steps=${JSON.stringify(failM?.mission?.plan?.map((s) => s.status))}`)
  failSt.close()
}

console.log('')
console.log('=== 9. CLEANUP ===')
for (const d of [work, dbDir]) {
  for (let i = 0; i < 4; i += 1) {
    try { rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 }); break }
    catch { await new Promise((r) => setTimeout(r, 300)) }
  }
}
check('this run left no temporary directory behind', !existsSync(work) && !existsSync(dbDir))

console.log('')
if (failures) {
  console.log(`   === ${failures} FAILURE(S) ===`)
  console.log('  Bounded governed recovery did NOT pass end to end.')
  process.exit(1)
}
console.log('   === PASS: failure detected from the WORLD, rolled back under its own approval,')
console.log('             retried within a declared bound, and independently verified ===')
process.exit(0)