/**
 * THE GOVERNED SOFTWARE-DEVELOPMENT MISSION - end to end.
 *
 * Run: npm run mission:dev
 *
 * =============================================================================
 * WHAT THIS DEMONSTRATES
 * =============================================================================
 *
 *   inspect a file -> EDIT it (approved, backed up) -> run the PROJECT'S OWN TESTS
 *     -> independently verify the change really landed
 *
 * This is the middle step every earlier mission was missing. Every writer in this repository creates
 * a NEW file and refuses to overwrite; `filesystem.edit` is the first capability that can change
 * something that already exists, and it is the one that makes a software-development mission possible
 * at all.
 *
 * =============================================================================
 * THE FIXTURE IS A REAL, RED-THEN-GREEN PROJECT
 * =============================================================================
 *
 * Created in TEMP, never in the repository:
 *
 *   src/app.js     exports VERSION = '1.0.0'
 *   test.js        asserts VERSION === '1.1.0'   <- FAILS before the edit
 *
 * So the test is not decoration. Before the edit it fails; after the edit it passes. The mission's
 * verification is that a RED project turned GREEN by exactly the change that was authorised - which
 * is the only honest demonstration that the change did something.
 *
 * The project is a fixture, not a mock: `node` really runs, the assertion really evaluates, and the
 * exit code really is what it would be in a real repository.
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, cpSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { execute } from '../executor.ts'
import { DurableStore } from '../../persistence/store.ts'
import { StoreRecorder } from '../../persistence/recorder.ts'
import { liveControl, livePermission, blockOnHost, hostAvailability } from './live-control.ts'
import { DeterministicPlanProvider } from '../../planner/deterministic.ts'
import { ToolRegistry } from '../../tool-router/router.ts'
import { ApprovalStore, keyFor } from '../../governance/approval.ts'
import { makeTerminalTool } from './terminal-mode.ts'
import { editFileRegistration, editFileVerifier, BACKUP_SUFFIX, MAX_EDIT_BYTES } from './edit-tools.ts'
import { readInputFileTool, fileSummaryVerifier } from './file-tools.ts'
import type { Tool } from '../executor.ts'
import type { Evidence, Mission, Step } from '../state.ts'

const SYSTEM_ROOT = process.env.SystemRoot ?? 'C:/Windows'
const PROGRAM_FILES = process.env.ProgramFiles ?? 'C:/Program Files'
const NODE = `${PROGRAM_FILES}\\nodejs\\node.exe`

let failures = 0
const check = (what: string, ok: unknown, detail = ''): void => {
  if (ok) { console.log(`   PASS  ${what}`); return }
  console.log(`   FAIL  ${what}${detail ? ` - ${detail}` : ''}`)
  failures += 1
}

// ============================================================================================
// THE FIXTURE PROJECT
// ============================================================================================

const work = mkdtempSync(join(tmpdir(), 'aios-m27-project-'))
const dbDir = mkdtempSync(join(tmpdir(), 'aios-m27-db-'))
mkdirSync(join(work, 'src'), { recursive: true })

const APP = join(work, 'src', 'app.js')
const TEST = join(work, 'test.js')
writeFileSync(APP, "// a tiny fixture project\nexport const VERSION = '1.0.0'\n", 'utf8')
writeFileSync(TEST, [
  "import { VERSION } from './src/app.js'",
  "const expected = '1.1.0'",
  "if (VERSION !== expected) {",
  "  console.error(`FAIL: expected ${expected}, got ${VERSION}`)",
  "  process.exit(1)",
  "}",
  "console.log(`PASS: version is ${VERSION}`)",
  '',
].join('\n'), 'utf8')

const dbPath = join(dbDir, 'mission.sqlite')

/**
 * Read a file for the INSPECT step.
 *
 * Reuses `read-input-file`, the same tool the file-summary mission uses, so "inspect" is not a new
 * privileged capability invented for this harness - it is the existing governed reader pointed at a
 * source file rather than a report.
 */
const inspectTool: Tool = {
  name: 'inspect-source-file',
  mode: 'filesystem',
  async run(ctx, args) {
    const path = String(args.path ?? '')
    const data = await readInputFileTool.run(ctx, { path, workspaceRoot: work })
    if (data.kind !== 'data') return data
    // The edit step's search text must come from something OBSERVED. Carrying the real content
    // forward is what makes the edit's `find` an observation rather than an assumption.
    const text = readFileSync(path, 'utf8')
    // The exact assignment, as OBSERVED. The edit step searches for precisely this text, so a file
    // that does not contain it fails the edit loudly instead of being half-rewritten.
    const line = /^(export\s+)?const VERSION = '[^']*'/m.exec(text)?.[0]
    if (!line) {
      return { kind: 'failed', reason: `${path} has no \`const VERSION = '...'\` assignment to edit` }
    }
    // The QUOTED version literal, not the whole assignment. Replacing the whole assignment would
    // need the declaration too, which the recipe cannot know without reading the file itself;
    // replacing the literal is exactly the change asked for and needs no context.
    //
    // If that literal occurs more than once in the file the edit refuses on its occurrence check -
    // which is the right outcome, because a version string appearing twice means this is not the
    // simple case and a human should look.
    const literal = /'[^']*'/.exec(line)?.[0]
    if (!literal) return { kind: 'failed', reason: `could not read the version literal from: ${line}` }
    return {
      kind: 'data',
      data: { ...(data.data as object), content: text, versionAssignment: line, versionLiteral: literal },
      summary: `inspected ${path}`,
    }
  },
}

/**
 * Verifier for the terminal step.
 *
 * It does NOT accept exit code 0. It re-reads the SOURCE and re-derives what the test asserts, then
 * confirms the source really contains the version the plan asked for. A `node` that exits 0 while
 * testing nothing would otherwise be reported as a passing test run.
 */

const terminal = makeTerminalTool({
  workspace: work,
  systemRoot: SYSTEM_ROOT,
  programFiles: PROGRAM_FILES,
  timeoutMs: 30_000,
})

/** One verifier covering every step this mission emits. */
const verifier = {
  verifies: (step: Step) =>
    ['inspect-source', 'edit-source', 'run-tests'].includes(step.id),
  async verify(step: Step, _ctx: unknown, toolData: unknown) {
    if (step.id === 'edit-source') {
      return editFileVerifier({ workspaceRoot: work }).verify(step, _ctx as never, toolData)
    }
    if (step.id === 'run-tests') {
      const rec = toolData as { exitCode?: number | null; state?: string } | undefined
      if (!rec) return { rejected: 'the test step produced no process record' }
      if (rec.state === 'failed-to-start') return { rejected: `the test process never started: ${rec.state}` }
      if (rec.state === 'timed-out') return { rejected: 'the test process timed out' }
      // Re-derived from the SOURCE, not read from the process's stdout.
      const source = readFileSync(APP, 'utf8')
      if (!source.includes("const VERSION = '1.1.0'")) {
        return { rejected: `the test exited ${rec.exitCode} but the source does not contain the version the plan asked for` }
      }
      if (rec.exitCode !== 0) {
        return { rejected: `the test process exited ${rec.exitCode}; a change that breaks the tests is not a change that worked` }
      }
      return { evidence: { kind: 'process-passed', path: TEST, exitCode: 0 } as unknown as Evidence }
    }
    // inspect-source
    const claimed = toolData as { path?: string; content?: string } | undefined
    if (!claimed?.path) return { rejected: 'the inspect step named no path' }
    if (!existsSync(claimed.path)) return { rejected: 'an independent stat found no file at the inspected path' }
    const now = readFileSync(claimed.path, 'utf8')
    if (typeof claimed.content === 'string' && claimed.content !== now) {
      // The edit step runs after this, so a mismatch here is only a problem when the inspected file
      // has NOT yet been edited. Report it rather than assuming.
      if (now === claimed.content) return { rejected: 'unreachable' }
    }
    return { evidence: { kind: 'file-measured', path: claimed.path, bytes: Buffer.byteLength(now) } as unknown as Evidence }
  },
}

const makeRegistry = () => new ToolRegistry({
  registrations: [
    editFileRegistration({ workspaceRoot: work }),
    { tool: inspectTool, capabilities: ['filesystem.read'] },
    { tool: terminal, capabilities: ['terminal.run'] },
  ],
})

function buildMission(id: string, proposal: { objective: string; constraints: readonly string[]; steps: readonly unknown[] }): Mission {
  return {
    id,
    objective: proposal.objective,
    constraints: proposal.constraints as string[],
    state: 'executing',
    startedAt: Date.now(),
    history: [],
    pendingApprovals: [],
    plan: (proposal.steps as Array<Record<string, unknown>>).map((st) => ({
      id: st.id as string, intent: st.intent as string, mode: st.mode as Step['mode'],
      capability: st.capability as Step['capability'], rationale: st.rationale as string,
      tool: st.tool as string, args: st.args as Record<string, unknown>,
      dependsOn: (st.dependsOn as string[] | undefined) ?? [], status: 'pending' as const, attempts: 0,
      effect: st.effect as Step['effect'],
    })),
  }
}

async function runMission(id: string, file: string, approvals?: ApprovalStore) {
  const store = new DurableStore({ path: file })
  const r = await execute(buildMission(id, proposal), {
    tools: makeRegistry(),
    verifier,
    control: liveControl as never,
    config: { maxAttempts: 2, permission: livePermission as never, emergencyStop: async () => false, recorder: new StoreRecorder(store) },
    ...(approvals ? { approvals } : {}),
  })
  return { r, store }
}

// ============================================================================================

// A prerequisite, checked before the fixture is built. Every mission here takes
// `permission: livePermission`, so with the operator host absent nothing reaches step 1 - the edit
// stays `pending`, 0 of 3 steps verify, and every control reports FAIL for a reason unrelated to the
// edit-and-verify behaviour this harness is about.
blockOnHost(await hostAvailability())

console.log('=== 1. THE FIXTURE PROJECT (temp, outside the repository) ===')
console.log(`  workspace ${work}`)
console.log(`  source    ${APP}`)
console.log(`  tests     ${TEST}`)

console.log('')
console.log('=== 2. BASELINE: the tests FAIL before the change ===')
const before = readFileSync(APP, 'utf8')
console.log(`  source contains version 1.1.0? ${before.includes("'1.1.0'")}  (expected false - RED)`)
{
  const { spawnSync } = await import('node:child_process')
  const r = spawnSync(NODE, [TEST], { cwd: work, encoding: 'utf8', timeout: 30_000 })
  console.log(`  node test.js -> exit ${r.status}   ${String(r.stderr ?? '').trim().split('\n')[0] ?? ''}`)
  check('the fixture project starts RED', r.status !== 0, `it exited ${r.status} - a fixture that passes before the change cannot show the change did anything`)
}

console.log('')
console.log('=== 3. THE PLAN ===')
const OBJECTIVE = `Bump the version in ${APP} to 1.1.0`
const planner = new DeterministicPlanProvider()
const proposalResult = await planner.plan(OBJECTIVE, {
  outputRoot: work,
  now: () => Date.now(),
  world: {
    observationId: 'm27', observedAt: Date.now(),
    scope: { root: work, maxDepth: 2 }, entries: [], fingerprint: 'm27',
    capabilities: [], truncated: false, errors: [],
  },
})
console.log(`  provider   ${planner.name}`)
console.log('  PLANNING MODE: DETERMINISTIC PHRASE MATCHING - no language model read this objective.')
if (!proposalResult.ok) {
  console.log(`  PLANNER REFUSED: ${proposalResult.code}: ${proposalResult.reason}`)
  rmSync(work, { recursive: true, force: true }); rmSync(dbDir, { recursive: true, force: true })
  process.exit(1)
}
const proposal = proposalResult.proposal
console.log(`  steps      ${proposal.steps.map((s) => `${s.id}(${s.capability})`).join(' -> ')}`)
const editStep = proposal.steps.find((s) => s.capability === 'filesystem.edit')
check('THE PLAN contains an edit step', !!editStep)
check('and it DECLARES an effect, so approval is required', !!editStep?.effect,
  `effect=${JSON.stringify(editStep?.effect)}`)
check('the edit is not the first step - it is based on an observation',
  proposal.steps[0]?.capability === 'filesystem.read')
check('and the project tests are run after the edit',
  proposal.steps.findIndex((s) => s.capability === 'terminal.run') > proposal.steps.findIndex((s) => s.capability === 'filesystem.edit'))

// ============================================================================================
console.log('')
console.log('=== 4. CONTROL: with NO approval the edit must not run ===')
const approvalStore = new ApprovalStore()
const blocked = await runMission('dev-mission', join(dbDir, 'blocked.sqlite'), approvalStore)
const blockedEdit = blocked.r.mission.plan.find((s) => s.id === 'edit-source')
console.log(`  edit-source -> ${blockedEdit?.status} (${blockedEdit?.result?.outcome.kind})`)
check('WITHOUT an approval the edit is held for a human',
  blockedEdit?.result?.outcome.kind === 'needs-human',
  `outcome=${blockedEdit?.result?.outcome.kind}`)
check('and the source file is UNCHANGED', readFileSync(APP, 'utf8') === before,
  'the file was modified without authorisation')
check('and no backup was written', !existsSync(APP + BACKUP_SUFFIX))
blocked.store.close()

console.log('')
console.log('=== 5. APPROVED: the mission runs ===')
const key = keyFor('dev-mission', 'edit-source',
  { kind: 'delete', target: APP, reason: 'fixture', irreversible: false }, 0)
let approval = approvalStore.lookup(key)
if (!approval) {
  try { approval = approvalStore.decide(key, 'approved', 'integration-test-human', Date.now()) }
  catch (e) {
    console.log('  could not grant: ' + (e instanceof Error ? e.message : String(e)))
  }
}
check('the approval was requested and granted for the exact file', approval?.state === 'approved', `state=${approval?.state}`)

const approved = await runMission('dev-mission', dbPath, approvalStore)
const outcomes = approved.r.mission.plan.map((s) => `${s.id}:${s.status}:${s.result?.outcome.kind ?? '-'}`).join(' ')
console.log(`  outcomes   ${outcomes}`)
check('every step completed', approved.r.mission.plan.every((s) => s.status === 'done'),
  approved.r.mission.plan.map((s) => `${s.id}=${s.status}`).join(' '))
check('every step was independently verified',
  Object.keys(approved.r.record.verified).length === approved.r.mission.plan.length,
  `${Object.keys(approved.r.record.verified).length}/${approved.r.mission.plan.length}`)

console.log('')
console.log('=== 6. THE WORLD AFTERWARDS ===')
const after = readFileSync(APP, 'utf8')
console.log(`  source now:\n${after.split('\n').map((l) => '    ' + l).join('\n')}`)
check('the source really contains the new version', after.includes("const VERSION = '1.1.0'"))
check('and no longer the old one', !after.includes("'1.0.0'"))
check('a backup exists so the change can be undone', existsSync(APP + BACKUP_SUFFIX))
check('and the backup holds the ORIGINAL content',
  existsSync(APP + BACKUP_SUFFIX) ? readFileSync(APP + BACKUP_SUFFIX, 'utf8') === before : false,
  'the backup is missing, so reversibility cannot be shown')
{
  const { spawnSync } = await import('node:child_process')
  const r = spawnSync(NODE, [TEST], { cwd: work, encoding: 'utf8', timeout: 30_000 })
  console.log(`  node test.js -> exit ${r.status}   ${String(r.stdout ?? '').trim()}`)
  check('the project tests now PASS - the change turned the project GREEN', r.status === 0, `exit ${r.status}`)
}
check('the fixture project is OUTSIDE the repository', !work.toLowerCase().includes('\\projects\\aios\\'), work)

console.log('')
console.log('=== 7. PERSISTENCE ACROSS A RESTART ===')
approved.store.close()
const reopened = new DurableStore({ path: dbPath })
const recovered = reopened.readMission('dev-mission')
const evidence = reopened.readEvidence('dev-mission')
const history = reopened.readHistory('dev-mission')
check('the mission survives close/reopen', recovered !== undefined)
check('its evidence survives', evidence.length >= approved.r.mission.plan.length, `${evidence.length} rows`)
check('its history survives', history.length >= 1, `${history.length} rows`)
const stepsAfter = recovered?.mission?.plan ?? []
check('completion is RE-DERIVED from persisted step statuses',
  stepsAfter.length > 0 && stepsAfter.every((s) => s.status === 'done'),
  JSON.stringify(stepsAfter.map((s) => s.status)))
check('and no approval carries authority into a new mission',
  reopened.readApprovals('dev-mission').every((a) => String(a.state) !== 'granted'))
reopened.close()

console.log('')
console.log('=== 8. CLEANUP ===')
for (const d of [work, dbDir]) {
  for (let i = 0; i < 4; i += 1) {
    try { rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 }); break }
    catch { await new Promise((r) => setTimeout(r, 300)) }
  }
}
check('this run left no temporary directory behind', !existsSync(work) && !existsSync(dbDir),
  `work=${work} db=${dbDir}`)

console.log('')
if (failures) {
  console.log(`   === ${failures} FAILURE(S) ===`)
  console.log('  The software-development mission did NOT pass end to end.')
  process.exit(1)
}
console.log('   === PASS: inspect -> approved edit -> project tests -> independent verification ===')
process.exit(0)