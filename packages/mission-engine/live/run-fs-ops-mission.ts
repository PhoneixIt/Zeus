/**
 * GOVERNED FILE OPERATIONS, END TO END - one mission, six steps, one real command.
 * =============================================================================
 * Run: npm run mission:fs-ops
 *
 * THE WORKFLOW: stage a verified release candidate.
 *
 *   1. search   find the source file by NAME                  (observe - no effect)
 *   2. mkdir    create the staging directory                  (additive - no effect)
 *   3. copy     src/app.js -> dist/rc/app.js                  (additive - no effect)
 *   4. edit     bump the version IN THE COPY, keeping a backup (declares `delete` - approved)
 *   5. move     notes.txt -> dist/rc/NOTES.txt                (declares `delete` - approved)
 *   6. run      node --check dist/rc/app.js                   (a REAL command, real exit code)
 *
 * Then the mission's completion is re-derived from persisted step statuses after a close/reopen.
 *
 * =============================================================================
 * WHY THESE SIX, AND WHAT THE ORDER PROVES
 * =============================================================================
 *
 * The order is the dependency order, and each step's RESULT feeds the next step's ARGUMENTS rather
 * than being restated in them. Step 1 finds the path; steps 3 and 5 operate on paths the mission
 * discovered. That is what makes `search` a capability rather than a convenience: without it a plan
 * would have to invent the path it operates on, and inventing paths is how a mission goes to work on
 * the wrong file.
 *
 * Three of the six steps require a human approval and three do not, and the split is not decorative:
 * it is the claim that an operation which can DESTROY something existing is gated, and one which can
 * only ADD is not. Steps 4 and 5 overwrite or remove something that was already there. Steps 1, 2 and
 * 3 cannot lose anything, and gating them would be theatre.
 *
 * =============================================================================
 * THE CONTROLS ARE THE POINT
 * =============================================================================
 *
 * Each negative below runs the SAME mission with ONE thing changed, so a passing control cannot be
 * explained by the rest of the fixture. The approval-refusal control in particular runs the complete
 * happy-path wiring and changes only the decision - so it measures authorisation, not setup.
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { execute } from '../executor.ts'
import { DurableStore } from '../../persistence/store.ts'
import { StoreRecorder } from '../../persistence/recorder.ts'
import { liveControl, livePermission, blockOnHost, hostAvailability } from './live-control.ts'
import { ToolRegistry } from '../../tool-router/router.ts'
import { ApprovalStore, type ApprovalKey } from '../../governance/approval.ts'
import { fsOpsRegistration, fsOpsVerifier, filesAreIdentical } from './ops-tools.ts'
import { editFileRegistration, editFileVerifier } from './edit-tools.ts'
import { registerTerminal, makeTerminalVerifier } from './terminal-mode.ts'
import type { Tool } from '../executor.ts'
import type { ToolRegistration } from '../../tool-router/router.ts'
import type { Mission, Step } from '../state.ts'

const PROGRAM_FILES = process.env.ProgramFiles ?? 'C:/Program Files'
const NODE = join(PROGRAM_FILES, 'nodejs', 'node.exe')

let failures = 0
const check = (what: string, ok: unknown, detail = ''): void => {
  if (ok) { console.log(`   PASS  ${what}`); return }
  console.log(`   FAIL  ${what}${detail ? ` - ${detail}` : ''}`)
  failures += 1
}

// This harness drives the real control surface, so it cannot classify its own outcome without the
// host. Checked BEFORE any temporary directory is made, so a blocked run leaves nothing behind.
blockOnHost(await hostAvailability())

const work = mkdtempSync(join(tmpdir(), 'aios-m31-'))
const openStores: DurableStore[] = []
const mkStore = (p: string) => { const s = new DurableStore({ path: p }); openStores.push(s); return s }

// ============================================================================================
// THE FIXTURE - a small real project
// ============================================================================================

const SRC = join(work, 'src')
const APP = join(SRC, 'app.js')
const NOTES = join(work, 'notes.txt')
const RC = join(work, 'dist', 'rc')
const STAGED_APP = join(RC, 'app.js')
const STAGED_NOTES = join(RC, 'NOTES.txt')

// The validation command is a REAL external process reading the artefact, not a flag on node. The
// terminal policy requires argv[0] to be an existing script inside the workspace, and that
// constraint turns out to be the better design: `node --check` proves the file parses, whereas a
// script that READS THE ARTIFACT and reports what it found is what actually proves the release
// candidate has the version it claims.
const SCRIPTS = join(work, 'scripts')
const VALIDATOR = join(SCRIPTS, 'validate.js')
const REPORT = join(RC, 'CHECKS.txt')

const VALIDATOR_SOURCE = [
  "// Written by the mission fixture, not by the mission. It reads the artefact and reports.",
  "const fs = require('fs')",
  "const src = fs.readFileSync(process.argv[2], 'utf8')",
  "const m = src.match(/const VERSION = '([^']+)'/)",
  "const lines = ['parses: ' + Boolean(m), 'version: ' + (m ? m[1] : 'MISSING')]",
  "fs.writeFileSync(process.argv[3], lines.join('\\n') + '\\n')",
  "if (!m) process.exit(1)",
  "",
].join('\n')

/** What the report MUST say. Derived from the fixture, never from the artefact under test. */
const EXPECTED_REPORT = 'parses: true\nversion: 1.1.0\n'

const ORIGINAL_APP = "// release candidate\nconst VERSION = '1.0.0'\nmodule.exports = { VERSION }\n"
/**
 * What the staged file must contain afterwards - DERIVED from the source by the same
 * substitution the mission's edit step performs, not written out as a second literal. Two literals
 * would let a typo in the expectation pass as a verification.
 */
const NEXT_APP = ORIGINAL_APP.split("'1.0.0'").join("'1.1.0'")

function seedWorkspace(): void {
  rmSync(join(work, 'dist'), { recursive: true, force: true })
  rmSync(APP + '.aios-backup', { force: true })
  mkdirSync(SRC, { recursive: true })
  mkdirSync(SCRIPTS, { recursive: true })
  writeFileSync(VALIDATOR, VALIDATOR_SOURCE, 'utf8')
  writeFileSync(APP, ORIGINAL_APP, 'utf8')
  writeFileSync(NOTES, 'release notes for 1.0.0\n', 'utf8')
}

// ============================================================================================
// APPROVALS, WITH AN EXPLICIT MODE
// ============================================================================================

/**
 * An approval store that DECIDES, and whose decision is a constructor argument.
 *
 * The mode is explicit rather than inferred, because the difference between "a mission that was
 * authorised" and "a mission that was refused" is the single most important thing these scenarios
 * differ on, and a harness that leaves it implicit will eventually prove the wrong one.
 *
 * `request` is overridden rather than `decide`, so a grant happens in the same gate check that asked
 * for it. Approving BEFORE a request is not merely useless - `ApprovalStore` refuses to record a
 * decision for an action nobody asked about, which is the correct design and is why an earlier
 * harness in this repository had to be restructured around it.
 */
class HarnessApprovals extends ApprovalStore {
  /**
   * Keys this harness SAW a request for, in order.
   *
   * Named `seen` rather than `requested` because `ApprovalStore` already owns a private map of that
   * name - and a harness tally that shadows the store's own is a harness tally nobody can trust.
   */
  readonly seen: ApprovalKey[] = []
  #mode: 'grant' | 'deny' | 'manual'
  constructor(mode: 'grant' | 'deny' | 'manual' = 'manual') { super(); this.#mode = mode }
  override request(key: ApprovalKey, description: string): void {
    this.seen.push(key)
    super.request(key, description)
    if (this.#mode === 'grant') { try { this.decide(key, 'approved', 'harness', 1) } catch { /* reported below */ } }
    if (this.#mode === 'deny') { try { this.decide(key, 'rejected', 'harness', 1) } catch { /* reported below */ } }
  }
}

// ============================================================================================
// THE MISSION
// ============================================================================================

/** The six steps. `dependsOn` is real: each waits for the one that discovered its path. */
function buildMission(id: string, discovered: { app?: string; notes?: string } = {}): Mission {
  const app = discovered.app ?? APP
  const notes = discovered.notes ?? NOTES
  const steps = [
    {
      id: 'find-source', intent: `find the release source file under ${SRC}`, mode: 'filesystem' as const,
      capability: 'filesystem.search' as const,
      rationale: 'the path must be discovered, not assumed - an invented path is how a mission edits the wrong file',
      tool: 'search-files', args: { path: SRC, pattern: 'app.js' }, dependsOn: [] as string[],
    },
    {
      id: 'make-staging', intent: `create the staging directory ${RC}`, mode: 'filesystem' as const,
      capability: 'filesystem.write' as const,
      rationale: 'a destination must exist before anything can be placed in it',
      tool: 'make-directory', args: { path: RC }, dependsOn: ['find-source'] as string[],
    },
    {
      id: 'stage-app', intent: `copy ${app} to ${STAGED_APP}`, mode: 'filesystem' as const,
      capability: 'filesystem.copy' as const,
      rationale: 'the release candidate is built from an untouched copy, never from the source',
      tool: 'copy-file', args: { from: app, to: STAGED_APP }, dependsOn: ['find-source', 'make-staging'] as string[],
    },
    {
      id: 'bump-version', intent: `bump the version in ${STAGED_APP}`, mode: 'filesystem' as const,
      capability: 'filesystem.edit' as const,
      rationale: 'the staged copy, not the source, carries the new version',
      tool: 'edit-file', args: { path: STAGED_APP, find: "'1.0.0'", replace: "'1.1.0'" },
      dependsOn: ['stage-app'] as string[],
      effect: { kind: 'delete' as const, target: STAGED_APP, reason: `replace the version in ${STAGED_APP}`, irreversible: false },
    },
    {
      id: 'stage-notes', intent: `move ${notes} into the release as ${STAGED_NOTES}`, mode: 'filesystem' as const,
      capability: 'filesystem.move' as const,
      rationale: 'the notes ship with the release, so they belong beside it rather than at the root',
      tool: 'move-file', args: { from: notes, to: STAGED_NOTES },
      dependsOn: ['make-staging'] as string[],
    },
    {
      id: 'validate', intent: `run the release validator over ${STAGED_APP}`, mode: 'cli' as const,
      // `terminal.run`, and NOT `filesystem.confirm`: the executor requires a step's declared
      // capability to be one a registered tool actually serves, so naming a filesystem capability
      // for a process step is a plan defect the executor correctly refuses.
      capability: 'terminal.run' as const,
      rationale: 'a release candidate whose version is not what was asked for is not a release candidate',
      tool: 'run-process', args: { executable: NODE, argv: [VALIDATOR, STAGED_APP, REPORT] },
      dependsOn: ['bump-version', 'stage-notes'] as string[],
    },
  ]
  return {
    id, objective: `stage a verified 1.1.0 release candidate in ${RC}`,
    constraints: ['every path inside the workspace', 'the source file is never modified', 'a real validation command must pass'],
    state: 'executing', startedAt: Date.now(), history: [], pendingApprovals: [],
    plan: steps.map((s) => ({ ...s, status: 'pending' as const, attempts: 0 })),
  }
}

const ops = () => fsOpsRegistration({ workspaceRoot: work })
const terminal = () => registerTerminal({
  workspace: work, systemRoot: process.env.SystemRoot ?? 'C:/Windows', programFiles: PROGRAM_FILES,
}).registrations

const allRegs = (overrides: ToolRegistration[] = []): ToolRegistration[] => {
  const base: ToolRegistration[] = [...ops(), editFileRegistration({ workspaceRoot: work }), ...terminal()]
  // An override REPLACES a registration by tool name, so a control can substitute a lying tool
  // without any other part of the wiring changing.
  const patched = [...base]
  for (const o of overrides) {
    const i = patched.findIndex((r) => r.tool.name === o.tool.name)
    if (i >= 0) patched[i] = { ...patched[i]!, tool: o.tool }
  }
  return patched
}

/**
 * What the validation step REQUIRES the report to say.
 *
 * Mutable, and mutated by exactly one control - the one that proves this verification is not a
 * rubber stamp. A harness whose expectation cannot be made to fail has not tested its verification.
 */
let expectedReport = EXPECTED_REPORT

const verifier = {
  verifies: (s: Step) => s.tool === 'search-files' || s.tool === 'make-directory' ||
    s.tool === 'copy-file' || s.tool === 'move-file' || s.tool === 'edit-file' || s.tool === 'run-process',
  async verify(step: Step, ctx: unknown, data: unknown) {
    const c = ctx as never
    if (step.tool === 'edit-file') return editFileVerifier({ workspaceRoot: work }).verify(step, c, data)
    if (step.tool === 'run-process') {
      // The expectation is the report the validator SHOULD have written, derived from the fixture.
      // Taking it from what the process actually wrote would verify nothing. The verifier refuses a
      // step with no expectation, which is correct: a zero exit code alone is not evidence.
      return makeTerminalVerifier({
        workspace: work,
        expect: () => ({ path: REPORT, content: expectedReport }),
      }).verify(step, c, data)
    }
    return fsOpsVerifier({ workspaceRoot: work }).verify(step, c, data)
  },
}

async function runMission(opts: {
  id: string; approvals: ApprovalStore; overrides?: ToolRegistration[]
  discovered?: { app?: string; notes?: string }; db?: string
}) {
  const store = new DurableStore({ path: opts.db ?? join(work, `${opts.id}.sqlite`) })
  const r = await execute(buildMission(opts.id, opts.discovered), {
    tools: new ToolRegistry({ registrations: allRegs(opts.overrides) }),
    verifier,
    control: liveControl as never,
    approvals: opts.approvals,
    config: {
      maxAttempts: 1,
      permission: livePermission as never,
      emergencyStop: async () => false,
      recorder: new StoreRecorder(store),
    },
  })
  return { r, store }
}

const statusOf = (r: { mission: Mission }, id: string): string => {
  const s = r.mission.plan.find((x) => x.id === id)
  return `${s?.status}/${(s?.result?.outcome as { kind?: string } | undefined)?.kind ?? '-'}`
}
const reasonOf = (r: { mission: Mission }, id: string): string =>
  String((r.mission.plan.find((x) => x.id === id)?.result?.outcome as { reason?: string } | undefined)?.reason ?? '')

// ============================================================================================
// 1. THE HAPPY PATH
// ============================================================================================

console.log('=== 1. THE FULL MISSION: six steps, one real command ===')
{
  seedWorkspace()
  const approvals = new HarnessApprovals('grant')
  const { r, store } = await runMission({ id: 'ops-ok', approvals })

  for (const s of r.mission.plan) {
    console.log(`  ${s.id.padEnd(14)} -> ${statusOf(r, s.id)}`)
    // Print the reason for anything that did not commit. A harness that reports only pass/fail for
    // its own failures is a harness that makes the next person re-derive what went wrong.
    if (s.status !== 'done') {
      const why = reasonOf(r, s.id)
      if (why) console.log(`                   reason: ${why.slice(0, 160)}`)
    }
  }
  console.log('')

  check('every step reached a COMMITTED outcome', r.mission.plan.every((s) => s.status === 'done'),
    r.mission.plan.map((s) => `${s.id}=${s.status}`).join(','))
  check('the mission completed', r.record.complete === true)

  // The SEARCH's own summary is a tool claim; what is checkable is the evidence the INDEPENDENT
  // re-derivation produced - a count re-computed by searching the same world a second time.
  check('1. search FOUND exactly one match, re-derived by a second search',
    (r.mission.plan[0]!.result?.outcome as { evidence?: { count?: number } }).evidence?.count === 1,
    JSON.stringify(r.mission.plan[0]!.result?.outcome).slice(0, 130))
  check('2. the staging directory was actually created', existsSync(RC) )
  check('3. the staged copy exists', existsSync(STAGED_APP))
  // Not "identical to the source" - the source has since been left alone, and the staged copy has
  // since been edited, so that comparison would be asserting something false. What is checkable is
  // that the staged file equals the INDEPENDENTLY DERIVED post-edit content, byte for byte.
  check('3. the staged file equals the independently derived post-edit content',
    readFileSync(STAGED_APP, 'utf8') === NEXT_APP, JSON.stringify(readFileSync(STAGED_APP, 'utf8')))
  check('3. THE SOURCE IS UNTOUCHED - this is a copy, not a move', readFileSync(APP, 'utf8') === ORIGINAL_APP)
  check('4. the version was bumped in the COPY', readFileSync(STAGED_APP, 'utf8').includes("'1.1.0'"))
  check('4. and NOT in the source', !readFileSync(APP, 'utf8').includes("'1.1.0'"), readFileSync(APP, 'utf8'))
  check('4. a backup of the staged file was preserved', existsSync(STAGED_APP + '.aios-backup'),
    'an edit that cannot be rolled back must not be offered')
  check('5. the notes were MOVED, so the source location is gone', !existsSync(NOTES))
  check('5. and they are present in the release', readFileSync(STAGED_NOTES, 'utf8') === 'release notes for 1.0.0\n')
  check('6. the real validator process PASSED and verified', statusOf(r, 'validate') === 'done/verified', statusOf(r, 'validate'))
  check('6. it wrote its report, and the report says what we independently required',
    existsSync(REPORT) && readFileSync(REPORT, 'utf8') === EXPECTED_REPORT,
    existsSync(REPORT) ? JSON.stringify(readFileSync(REPORT, 'utf8')) : 'no report was written')

  const staged = approvals.seen.filter((k) => k.stepId === 'stage-notes')
  check('the destructive step REQUESTED an approval', staged.length === 1, JSON.stringify(approvals.seen.map((k) => k.stepId)))
  // Exactly the steps that change something: the two file operations that can DESTROY, plus the
  // validator, which WRITES its report and so declares its own effect. Notably absent are the three
  // additive steps - an additive operation demanding authorisation is the failure this design avoids.
  const asked = approvals.seen.map((k) => k.stepId)
  check('only the steps that change something asked for approval',
    asked.length === 3 && ['bump-version', 'stage-notes', 'validate'].every((id) => asked.includes(id)),
    JSON.stringify(asked))
  check('and no additive operation was made to require one',
    !['find-source', 'make-staging', 'stage-app'].some((id) => asked.includes(id)), JSON.stringify(asked))

  // PERSISTENCE: completion is RE-DERIVED after a close/reopen, never remembered.
  store.close()
  const re = mkStore(join(work, 'ops-ok.sqlite'))
  const m = re.readMission('ops-ok')
  check('the mission survives close/reopen', m !== undefined)
  check('completion is RE-DERIVED from persisted statuses',
    (m?.mission?.plan ?? []).every((s) => s.status === 'done'),
    JSON.stringify((m?.mission?.plan ?? []).map((s) => `${s.id}=${s.status}`)))
  check('and its evidence survives', re.readEvidence('ops-ok').length >= 6, `${re.readEvidence('ops-ok').length} rows`)
  re.close()
}

// ============================================================================================
// 2. APPROVAL REFUSAL
// ============================================================================================

console.log('')
console.log('=== 2. CONTROL: a refused approval stops the mission ===')
{
  seedWorkspace()
  const approvals = new HarnessApprovals('deny')
  const { r } = await runMission({ id: 'ops-deny', approvals })
  console.log(`  find-source -> ${statusOf(r, 'find-source')}   stage-notes -> ${statusOf(r, 'stage-notes')}`)

  check('the copy and the mkdir still ran - the gate is per-operation', statusOf(r, 'stage-app') === 'done/verified',
    statusOf(r, 'stage-app'))
  // A refusal HALTS the mission, so the refused step and everything after it carry no result at
  // all. Asserting `needs-human` here would be demanding a record the executor correctly does not
  // write: the step never ran, so there is no outcome to report.
  const refused = r.mission.plan.find((x) => x.id === 'bump-version')
  check('the EDIT never ran', refused?.status !== 'done' && refused?.result?.outcome.kind !== 'verified',
    statusOf(r, 'bump-version'))
  check('and its approval is recorded as REJECTED, not granted',
    approvals.seen.filter((k) => k.stepId === 'bump-version').every((k) => approvals.lookup(k)?.state === 'rejected'),
    JSON.stringify(approvals.seen.map((k) => `${k.stepId}=${approvals.lookup(k)?.state ?? 'none'}`)))
  check('the MOVE never ran', r.mission.plan.find((x) => x.id === 'stage-notes')?.result?.outcome.kind !== 'verified',
    statusOf(r, 'stage-notes'))
  check('the validation step NEVER RAN',
    r.mission.plan.find((x) => x.id === 'validate')?.result?.outcome.kind !== 'verified', statusOf(r, 'validate'))
  check('the mission did NOT complete', r.record.complete !== true)
  check('the notes were NOT moved', existsSync(NOTES), 'a refused move must leave the world alone')
  check('and the staged copy was not version-bumped', !readFileSync(STAGED_APP, 'utf8').includes("'1.1.0'"))
}

// ============================================================================================
// 3. TRAVERSAL
// ============================================================================================

console.log('')
console.log('=== 3. CONTROL: traversal is refused at the gate, before anything runs ===')
{
  seedWorkspace()
  const escape = join(work, '..', `escaped-${Date.now()}.js`)
  const approvals = new HarnessApprovals('grant')
  const { r } = await runMission({
    id: 'ops-traversal', approvals, discovered: { app: join(work, '..', 'elsewhere.js') },
  })
  const reason = reasonOf(r, 'stage-app')
  console.log(`  stage-app -> ${statusOf(r, 'stage-app')}`)
  check('a source outside the workspace was refused', statusOf(r, 'stage-app') !== 'done/verified', statusOf(r, 'stage-app'))
  check('the refusal NAMES the scope rule', /outside the workspace root/.test(reason), reason.slice(0, 130))
  // "Not unlockable by a human" is best shown by ABSENCE: no approval was ever requested for this
  // step, so there is nothing a human could grant. Asserting on the refusal's wording would only
  // prove the message survived an edit.
  check('and it is NOT unlockable by a human - no approval was ever requested for it',
    !approvals.seen.some((k) => k.stepId === 'stage-app'), JSON.stringify(approvals.seen.map((k) => k.stepId)))
  check('the step never ran at all', r.mission.plan.find((x) => x.id === 'stage-app')?.result?.outcome.kind !== 'verified',
    statusOf(r, 'stage-app'))
  check('nothing was written outside the workspace', !existsSync(escape))
}

// ============================================================================================
// 4. EXISTING DESTINATION
// ============================================================================================

console.log('')
console.log('=== 4. CONTROL: an existing destination is refused, not overwritten ===')
{
  seedWorkspace()
  mkdirSync(RC, { recursive: true })
  writeFileSync(STAGED_APP, 'PRECIOUS EXISTING CONTENT\n', 'utf8')
  const approvals = new HarnessApprovals('grant')
  const { r } = await runMission({ id: 'ops-exists', approvals })
  const reason = reasonOf(r, 'stage-app')
  console.log(`  stage-app -> ${statusOf(r, 'stage-app')}`)
  check('the copy was refused', statusOf(r, 'stage-app') !== 'done/verified', statusOf(r, 'stage-app'))
  check('the refusal says who decides', /decision for a human|refusing to overwrite/.test(reason), reason.slice(0, 140))
  check('and the existing file is BYTE-INTACT', readFileSync(STAGED_APP, 'utf8') === 'PRECIOUS EXISTING CONTENT\n')
}

// ============================================================================================
// 5. MISSING SOURCE
// ============================================================================================

console.log('')
console.log('=== 5. CONTROL: a missing source is refused ===')
{
  seedWorkspace()
  const approvals = new HarnessApprovals('grant')
  const { r } = await runMission({ id: 'ops-missing', approvals, discovered: { notes: join(work, 'no-such-notes.txt') } })
  const reason = reasonOf(r, 'stage-notes')
  console.log(`  stage-notes -> ${statusOf(r, 'stage-notes')}`)
  check('the move was refused', statusOf(r, 'stage-notes') !== 'done/verified', statusOf(r, 'stage-notes'))
  check('and it names the real cause', /no source at/.test(reason), reason.slice(0, 130))
}

// ============================================================================================
// 6. MISLEADING TOOL SUCCESS
// ============================================================================================

console.log('')
console.log('=== 6. CONTROL: a tool that claims a copy it never made ===')
{
  seedWorkspace()
  const lyingCopy: Tool = {
    name: 'copy-file', mode: 'filesystem',
    async run() {
      // Reports a transfer. Writes nothing. The file is not on disk anywhere.
      return { kind: 'data', data: { op: 'copy', from: APP, to: STAGED_APP, bytes: ORIGINAL_APP.length }, summary: 'claims a copy' }
    },
  }
  const approvals = new HarnessApprovals('grant')
  const { r } = await runMission({
    id: 'ops-lie', approvals, overrides: [{ tool: lyingCopy, capabilities: ['filesystem.copy'] } as ToolRegistration],
  })
  const reason = reasonOf(r, 'stage-app')
  console.log(`  stage-app -> ${statusOf(r, 'stage-app')}`)
  console.log(`  reason: ${reason.slice(0, 140)}`)
  check('the tool reported success and was still REJECTED', statusOf(r, 'stage-app').includes('failed'), statusOf(r, 'stage-app'))
  check('the rejection came from an INDEPENDENT check', /nothing at the destination/.test(reason), reason.slice(0, 140))
  check('no file exists at the claimed destination', !existsSync(STAGED_APP))
  check('the dependent steps never ran on a fiction', statusOf(r, 'bump-version') === 'skipped/-' || statusOf(r, 'bump-version').includes('skipped'),
    statusOf(r, 'bump-version'))
  check('the mission did NOT complete', r.record.complete !== true)
}

// ============================================================================================
// 7. INTERRUPTED OPERATION
// ============================================================================================

console.log('')
console.log('=== 7. CONTROL: a "move" that copied instead of moving ===')
{
  seedWorkspace()
  // A tool that copies and leaves the source - the classic half-finished move. The destination looks
  // perfect, so any check that only looked at the destination would pass it.
  const halfMove: Tool = {
    name: 'move-file', mode: 'filesystem',
    async run(_c, args) {
      const { copyFileSync } = await import('node:fs')
      const from = String(args.from); const to = String(args.to)
      copyFileSync(from, to)
      return { kind: 'data', data: { op: 'move', from, to, bytes: readFileSync(from).length }, summary: 'claims a move' }
    },
  }
  const approvals = new HarnessApprovals('grant')
  const { r } = await runMission({
    id: 'ops-interrupted', approvals, overrides: [{ tool: halfMove, capabilities: ['filesystem.move'] } as ToolRegistration],
  })
  const reason = reasonOf(r, 'stage-notes')
  console.log(`  stage-notes -> ${statusOf(r, 'stage-notes')}`)
  check('the half-finished move was REJECTED', statusOf(r, 'stage-notes').includes('failed'), statusOf(r, 'stage-notes'))
  check('the rejection names the defect precisely', /must REMOVE the source/.test(reason), reason.slice(0, 150))
  check('the source file was left in place by the verifier, not deleted', existsSync(NOTES))
}

// ============================================================================================
// 8. STALE STATE
// ============================================================================================

console.log('')
console.log('=== 8. CONTROL: a tool reporting a transfer the step never asked for ===')
{
  seedWorkspace()
  const decoy = join(work, 'src', 'decoy.js')
  writeFileSync(decoy, ORIGINAL_APP, 'utf8')
  const lyingCopy: Tool = {
    name: 'copy-file', mode: 'filesystem',
    async run(_c, args) {
      const { copyFileSync } = await import('node:fs')
      const from = String(args.from)
      copyFileSync(from, decoy + '.copy')  // copied somewhere the STEP never named
      return { kind: 'data', data: { op: 'copy', from, to: decoy + '.copy', bytes: ORIGINAL_APP.length }, summary: 'claims a copy elsewhere' }
    },
  }
  const approvals = new HarnessApprovals('grant')
  const { r } = await runMission({
    id: 'ops-stale', approvals, overrides: [{ tool: lyingCopy, capabilities: ['filesystem.copy'] } as ToolRegistration],
  })
  const reason = reasonOf(r, 'stage-app')
  console.log(`  stage-app -> ${statusOf(r, 'stage-app')}`)
  check('a transfer the step never requested is REJECTED', statusOf(r, 'stage-app').includes('failed'), statusOf(r, 'stage-app'))
  check('because verification re-derives the destination from the STEP', /nothing at the destination/.test(reason), reason.slice(0, 150))
  check('the mission did NOT complete', r.record.complete !== true)
  rmSync(decoy, { force: true })
  rmSync(decoy + '.copy', { force: true })
}

// ============================================================================================
// 9. RECOVERY, ONLY WHERE IT IS SAFE
// ============================================================================================

console.log('')
console.log('=== 9. RECOVERY: the move is NOT auto-recoverable, and says why ===')
{
  // Deliberately NOT a recovery scenario. The recovery policy built in the previous milestone covers
  // rolling back a file EDIT, and this mission's destructive step is a MOVE. Asserting that a move
  // failure is not silently repaired is the honest scope claim: recovery here would mean
  // re-creating the source, which is a different act from undoing an edit.
  seedWorkspace()
  rmSync(NOTES, { force: true })
  const approvals = new HarnessApprovals('grant')
  const { r } = await runMission({ id: 'ops-norecover', approvals })
  const reason = reasonOf(r, 'stage-notes')
  check('a move with a missing source fails', statusOf(r, 'stage-notes').includes('failed'), statusOf(r, 'stage-notes'))
  check('and nothing invented a replacement', !existsSync(STAGED_NOTES))
  check('while the copy that CAN be verified still committed', statusOf(r, 'stage-app') === 'done/verified',
    statusOf(r, 'stage-app'))
  void reason
}

// ============================================================================================
// 10. CONTROL: the validation is not a rubber stamp
// ============================================================================================

console.log('')
console.log('=== 10. CONTROL: the real command ran, but its output is WRONG ===')
{
  // Same fixture, same process, same everything - only the REQUIRED version differs. If the
  // verification were checking exit codes or trusting the process's own report, this would pass.
  seedWorkspace()
  expectedReport = 'parses: true\nversion: 9.9.9\n'
  const approvals = new HarnessApprovals('grant')
  const { r } = await runMission({ id: 'ops-wrong-version', approvals })
  const reason = reasonOf(r, 'validate')
  console.log(`  validate -> ${statusOf(r, 'validate')}`)
  check('the validator process itself SUCCEEDED - it is the expectation that failed',
    /does not match what was independently/.test(reason) || /verification rejected/.test(reason), reason.slice(0, 150))
  check('and the step was REJECTED rather than accepted on a zero exit code',
    statusOf(r, 'validate').includes('failed'), statusOf(r, 'validate'))
  check('the report on disk says what the process actually found, not what was expected',
    existsSync(REPORT) && readFileSync(REPORT, 'utf8') === EXPECTED_REPORT,
    existsSync(REPORT) ? JSON.stringify(readFileSync(REPORT, 'utf8')) : 'none')
  check('the mission did NOT complete on a real command whose answer was wrong', r.record.complete !== true)
  expectedReport = EXPECTED_REPORT
}

// ============================================================================================
// CLEANUP
// ============================================================================================

console.log('')
console.log('=== CLEANUP ===')
for (const s of openStores) { try { s.close() } catch { /* already closed */ } }
for (let i = 0; i < 6; i += 1) {
  try { rmSync(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); break }
  catch { await new Promise((r) => setTimeout(r, 400)) }
}
check('this run left no temporary directory behind', !existsSync(work), work)
void filesAreIdentical

console.log('')
if (failures) {
  console.log(`   === ${failures} FAILURE(S) ===`)
  process.exit(1)
}
console.log('   === PASS: six governed operations, one real command, every negative control ===')
process.exit(0)
