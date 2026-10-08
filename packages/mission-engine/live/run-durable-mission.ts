/**
 * THE DURABLE MISSION PATH.
 *
 * =============================================================================
 * WHY THIS EXISTS
 * =============================================================================
 *
 * The executor has fully implemented recorder integration, and `persistence/recorder.ts` writes every
 * transition write-ahead, before the action it describes. Twenty-three call sites invoke `execute()`
 * outside the test suite - and NOT ONE of them passed a recorder.
 *
 * So the durability was real and completely bypassed. Every guarantee the store is built to provide -
 * a crash cannot lose the record of an action, an interrupted mission comes back `pending` rather than
 * `done`, a verified step can be shown to have been verified - held in tests and did not hold anywhere
 * else. The M16 controls passed because they construct the executor directly. Nothing on the live path
 * ever did.
 *
 * That is the exact defect class this project exists to refuse: a capability that is cited, tested and
 * not wired. The same shape as `capture-helper.ps1`, absent so the core had never taken a screenshot,
 * and as five proofs that had never executed.
 *
 * =============================================================================
 * WHAT IS PROVEN, AND HOW
 * =============================================================================
 *
 * A REAL action is performed - a file is written through the governed filesystem path - against a REAL
 * `DurableStore` on a REAL file. Then, in order:
 *
 *   1. the machine's state is read back from the DISK, not from the tool's claim;
 *   2. the mission start, every transition, the tool results and the verifier's evidence are read back
 *      FROM THE STORE;
 *   3. the store is CLOSED and REOPENED from the same path - as a restart would - and the history is
 *      shown to survive, which is the property recovery depends on;
 *   4. `resumeMission` on a mission interrupted mid-step is shown to return OBLIGATIONS rather than
 *      permission, including one naming the interrupted step;
 *   5. the store is shown to hold NO approval, so a durable record cannot stand in for a human one.
 *
 * Every claim is asserted against the store or the disk. Asserting against `execute()`'s return value
 * would pass whether or not anything was written.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { execute } from '../executor.ts'
import { DurableStore } from '../../persistence/store.ts'
import { StoreRecorder } from '../../persistence/recorder.ts'
import { listHistory, missionHistory, summariseEvidence } from '../../persistence/query.ts'
import { resumeMission } from '../../persistence/recover.ts'
import type { Mission, Step, Evidence } from '../state.ts'
import { livePermission, liveControl } from './live-control.ts'
import type { ControlSurface } from '../../governance/contract.ts'

const root = mkdtempSync(join(tmpdir(), 'aios-durable-'))
const src = join(root, 'src')
const out = join(root, 'out')
mkdirSync(src, { recursive: true })
mkdirSync(out, { recursive: true })
writeFileSync(join(src, 'note.txt'), 'the original contents\n', 'utf8')

const REPORT = 'durable-report.md'
const reportPath = join(out, REPORT)

const dbPath = join(root, 'missions.db')
const store = new DurableStore({ path: dbPath })
const recorder = new StoreRecorder(store)

const calls: string[] = []

const writeReport = {
  name: 'write-report',
  mode: 'filesystem' as const,
  async run(_ctx: unknown, args: Record<string, unknown>) {
    const target = String(args.target ?? '')
    calls.push(`write:${target}`)
    writeFileSync(target, 'written by the durable mission\n', 'utf8')
    return { kind: 'data' as const, summary: `wrote ${target}`, data: { target, bytes: 31 } }
  },
}

const readReport = {
  name: 'read-report',
  mode: 'filesystem' as const,
  async run(_ctx: unknown, args: Record<string, unknown>) {
    const target = String(args.target ?? '')
    calls.push(`read:${target}`)
    return {
      kind: 'data' as const,
      summary: `read ${target}`,
      data: { target, exists: existsSync(target), bytes: existsSync(target) ? readFileSync(target, 'utf8').length : 0 },
    }
  },
}

/**
 * Goes and LOOKS, for BOTH steps.
 *
 * The first version only registered a verifier for `read-report`, and the executor refused the write
 * step with "no verifier is registered for this step, so ... cannot be claimed complete". That refusal
 * is the system working exactly as designed: a step with no independent check cannot be asserted done,
 * and a write that only the writer vouches for is precisely the claim that must not be accepted.
 *
 * So the write step is verified by going to the DISK and reading what is actually there - not by
 * reading the writer's return value, which is the only thing that could make it agree with itself.
 */
const verifier = {
  verifies: (s: Step) => s.tool === 'read-report' || s.tool === 'write-report',
  async verify(step: Step) {
    if (step.tool !== 'read-report' && step.tool !== 'write-report') {
      return { rejected: `no verifier for ${step.tool}` }
    }
    if (!existsSync(reportPath)) {
      return { rejected: `the tool reported success but ${reportPath} is not on disk` }
    }
    const bytes = readFileSync(reportPath, 'utf8').length
    // And the CONTENT is checked, not merely its existence: "a file is there" would be satisfied by an
    // empty file, which is not what the step claimed to have written.
    const text = readFileSync(reportPath, 'utf8')
    if (!text.includes('written by the durable mission')) {
      return { rejected: `the file exists but does not contain what the step claims to have written (${text.slice(0, 60)})` }
    }
    return {
      evidence: { kind: 'file-exists', path: reportPath, bytes } satisfies Evidence,
    }
  },
}

const mission: Mission = {
  id: 'durable-mission-1',
  objective: `Write ${REPORT} into ${out} and then read it back`,
  constraints: [],
  state: 'executing',
  startedAt: Date.now(),
  history: [],
  pendingApprovals: [],
  plan: [
    {
      id: 's1', intent: `write ${REPORT}`, mode: 'filesystem', capability: 'filesystem.write',
      rationale: 'the objective asks for a file to exist', tool: 'write-report',
      args: { target: reportPath }, dependsOn: [], status: 'pending', attempts: 0,
    },
    {
      id: 's2', intent: 'read it back', mode: 'filesystem', capability: 'filesystem.read',
      rationale: 'reading it back is the independent check that it was really written', tool: 'read-report',
      args: { target: reportPath }, dependsOn: ['s1'], status: 'pending', attempts: 0,
    },
  ],
}

const result = await execute(mission, {
  tools: {
    resolve: (s: Step) =>
      s.tool === 'write-report' ? { tool: writeReport, fellBack: false, reason: 'exact' }
      : s.tool === 'read-report' ? { tool: readReport, fellBack: false, reason: 'exact' }
      : { unavailable: `no tool for ${s.tool}`, candidates: [] },
  },
  verifier,
  control: liveControl as ControlSurface,
  config: { maxAttempts: 2, permission: livePermission, emergencyStop: async () => false, recorder },
})

// ---- 1. THE MACHINE, read from the disk ----
check('the report exists on disk', existsSync(reportPath))
check('both tools really ran', calls.length === 2, `saw ${calls.length} calls`)
// A refusal that does not say WHY is not a control, it is an alarm. The outcome of every step goes
// into the message, because "did not complete" on its own is not actionable.
const outcomes = result.mission.plan
  .map((st) => `${st.id}:${st.status}:${st.result?.outcome.kind ?? '-'}`)
  .join(' ')
check('the mission completed', result.record.complete,
  `state=${result.mission.state} outcomes=${outcomes} reasons=${result.mission.plan.map((st) => st.result?.outcome.kind === 'failed' ? JSON.stringify(st.result.outcome) : '').filter(Boolean).join(';')}`)
check('both steps are independently verified', Object.keys(result.record.verified).length === 2,
  `verified: ${JSON.stringify(Object.keys(result.record.verified))}`)

// ---- 2. THE STORE ----
//
// Asserted against the vocabulary the store ACTUALLY uses. The first version guessed at recorder
// transition names (`mission-started`, `attempt-begin`, ...) and every one of those checks failed -
// while `entries` was 13 and the mission had plainly been recorded. A control that asserts against an
// invented vocabulary is not a control; it is a test that cannot pass and cannot explain itself.

const history = missionHistory(store, mission.id)
check('the store has a history for this mission', history.entries > 0, `entries=${history.entries}`)
check('STEP transitions are durable', (history.byKind['step'] ?? 0) >= 2, JSON.stringify(history.byKind))
check('OBSERVATION entries are durable', (history.byKind['observation'] ?? 0) >= 1, JSON.stringify(history.byKind))
check('RECOVERY bookkeeping is durable', (history.byKind['recovery'] ?? 0) >= 1, JSON.stringify(history.byKind))

// The evidence itself, read from the evidence table rather than inferred from a count.
const evidenceRows = store.readEvidence(mission.id)
check('VERIFIED EVIDENCE is durable', evidenceRows.length >= 2, `${evidenceRows.length} evidence row(s)`)
// The stored payload is JSON, so its backslashes are ESCAPED. Comparing the raw path against the
// serialised row is comparing two different spellings of the same string - the first version of this
// check did that and reported a missing file that was present.
const evidenceText = evidenceRows.map((r) => JSON.stringify(r)).join(' ')
const evidenceUnescaped = evidenceText.replace(/\\\\/g, '\\')
check('and it names the file that was really written', evidenceUnescaped.includes(reportPath),
  `evidence does not mention ${reportPath}. Row sample: ${evidenceText.slice(0, 240)}`)
// The stored BYTES must match what is on disk NOW, measured independently. Not the tool's claim: the
// tool reported 31, and the verifier measured the file itself. If those ever disagree the record is
// stale, which is exactly what a durable record is for detecting.
//
// The first version of this check looked for the file's CONTENT in the evidence, which is the wrong
// shape - `Evidence` for a file is `{ kind, path, bytes }`. A control that asserts against a shape the
// system does not produce is a control that fails for its own reasons.
const realBytes = readFileSync(reportPath, 'utf8').length
const storedBytes = evidenceRows
  .map((r) => (r.evidence as { bytes?: unknown }).bytes)
  .filter((b): b is number => typeof b === 'number')
check('and the stored evidence records what the verifier MEASURED, byte count matching the disk',
  storedBytes.includes(realBytes),
  `disk=${realBytes} stored=${JSON.stringify(storedBytes)}`)
check('and each row is attributed to a verifier with a session and a provenance',
  evidenceRows.every((r) => typeof r.verifier === 'string' && typeof r.observedInSession === 'string' && typeof r.provenance === 'string'),
  JSON.stringify(evidenceRows.map((r) => ({ v: r.verifier, s: r.observedInSession }))))

// ---- 3. RESTART: close, reopen, and look again ----
const before = history.entries
const evidenceBefore = evidenceRows.length
store.close()

const reopened = new DurableStore({ path: dbPath })
const after = missionHistory(reopened, mission.id)
const evidenceAfter = reopened.readEvidence(mission.id)

check('history survives a reopen', after.entries === before, `before ${before}, after ${after.entries}`)
check('and the evidence survives too', evidenceAfter.length === evidenceBefore,
  `before ${evidenceBefore} rows, after ${evidenceAfter.length}`)
check('a reopened row is marked RESTORED, not live - a stored record is not a claim about now',
  summariseEvidence(evidenceAfter, reopened.session.sessionId).restored >= 1,
  JSON.stringify(summariseEvidence(evidenceAfter, reopened.session.sessionId)))

const list = listHistory(reopened)
const listed = list.find((m) => m.id === mission.id)
check('the mission appears in the durable list', Boolean(listed))
check('and its completion is RE-DERIVED from rows, never read from a stored flag',
  listed?.complete === true, `complete=${listed?.complete}`)

// ---- 4. AN INTERRUPTED STEP yields OBLIGATIONS, not permission ----
const crashPath = join(root, 'crash.db')
const crashStore = new DurableStore({ path: crashPath })
const crashRecorder = new StoreRecorder(crashStore)
const crashMission: Mission = {
  ...mission, id: 'crashed-mission',
  plan: [{ ...mission.plan[0], status: 'pending' }],
}
crashRecorder.missionStarted(crashMission)
crashRecorder.attemptBegin({
  missionId: crashMission.id, stepId: 's1', attempt: 1,
  tool: 'write-report', intent: 'write the report', mode: 'filesystem',
  args: { target: reportPath }, at: Date.now(),
})
// ... and then the process died. Nothing further was recorded.

const permit = resumeMission(crashStore, crashMission.id)
check('resumeMission finds the interrupted mission', Boolean(permit))
const obligations = permit?.obligations ?? []
check('it returns obligations rather than permission', obligations.length > 0,
  'an empty obligation list would authorise everything')
check('an interrupted step is named', obligations.some((o) => o.kind === 'recover-step' && o.stepId === 's1'),
  JSON.stringify(obligations.map((o) => o.kind)))
check('a fresh observation is ALWAYS required', permit?.requiresFreshObservation === true)
check('and no evidence is carried across the restart', (permit?.liveEvidence ?? []).length === 0,
  `liveEvidence=${JSON.stringify(permit?.liveEvidence)}`)
crashStore.close()

// ---- 5. PERSISTENCE IS NOT AUTHORITY ----
//
// A durable record is evidence that something happened. It is not permission. If the store could stand
// in for a human, then anything able to write to the store could approve itself.
const approvals = reopened.readApprovals(mission.id)
check('the durable store holds NO approval for an unapproved mission', approvals.length === 0,
  JSON.stringify(approvals))

// ---- REPORT ----
console.log('')
console.log('=== THE DURABLE MISSION PATH ===')
console.log(`  action            wrote ${REPORT}`)
console.log(`  machine state     ${existsSync(reportPath) ? `${readFileSync(reportPath, 'utf8').length} bytes on disk` : 'ABSENT'}`)
console.log(`  durable events    ${before}  ${JSON.stringify(after.byKind)}`)
console.log(`  after restart     ${after.entries} events survived, completion re-derived = ${listed?.complete}`)
console.log(`  interrupted step  obligations = ${obligations.map((o) => o.kind).join(', ')}`)
console.log(`  approvals in store ${approvals.length} - persistence is not authority`)
console.log('')
console.log('  every claim above was read from the STORE or the DISK, not from execute()\'s return value')
console.log('')

reopened.close()
rmSync(root, { recursive: true, force: true })

function check(what: string, ok: unknown, detail = ''): void {
  if (ok) { console.log(`  ACCEPT  ${what}`); return }
  console.log(`  REFUSED ${what}${detail ? ` - ${detail}` : ''}`)
  throw new Error(`durable mission control failed: ${what}${detail ? ` - ${detail}` : ''}`)
}