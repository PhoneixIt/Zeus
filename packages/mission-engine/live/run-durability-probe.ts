/**
 * DURABLE PERSISTENCE AND RECOVERY, EXERCISED INDEPENDENTLY OF THE GUI PATH.
 *
 * No executor, no ControlSurface, no host route. Nothing here can inject input: this file
 * references none of the governance or desktop-control entry points, and contacts no HTTP
 * endpoint. (Described in prose rather than by naming them: `host-blocked.test.ts` discovers
 * host-dependent harnesses by grepping for those identifiers, so a comment asserting `this file
 * uses none of them` read as a false positive and inflated the host-dependent count.)
 *
 * WHAT IT PINS DOWN
 *
 *  1. `attemptBegin` writes `running` BEFORE anything else can happen, and that write SURVIVES
 *     later recorder calls. It did not, once: `StoreRecorder.currentMissionRow` read through
 *     `readMission`, which normalises `running` to `pending` for resuming readers, so the very
 *     next recorder call wrote `pending` back over the write-ahead. An interrupted step then
 *     looked like it had never started, and no recovery obligation was ever produced.
 *  2. An interrupted step comes back RECOVERED, with a `recover-step` obligation naming it.
 *  3. A VERIFIED step does NOT come back as unfinished work. Both directions matter: a store
 *     that never calls anything recovered silently drops an interrupted action; one that calls
 *     a verified step recovered makes resumed missions repeat proved work.
 *  4. The permit is OBLIGATIONS, not permission; it never empties, always demands a fresh
 *     observation, and carries no live evidence from a dead process.
 *  5. Obligations survive a restart and do not weaken when asked twice.
 *
 * ONE CONTRACT THAT MATTERS FOR HOW TO READ THIS FILE
 *
 * `readMission` reports the in-flight steps as recovered ONCE PER STORE INSTANCE. A second read
 * in the same instance sees the recovery already handled. So a permit is always taken from a
 * store that has not already looked at that mission - otherwise `recoveredSteps` reads empty and
 * looks like a defect that is not there.
 */

import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { DurableStore } from '../../persistence/store.ts'
import { StoreRecorder } from '../../persistence/recorder.ts'
import { resumeMission } from '../../persistence/recover.ts'
import { missionHistory } from '../../persistence/query.ts'
import type { Mission } from '../state.ts'

let failed = 0
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
  if (!ok) failed++
}

const root = mkdtempSync(join(tmpdir(), 'aios-durability-'))
const open: DurableStore[] = []
const openStore = (name: string): DurableStore => {
  const s = new DurableStore({ path: join(root, name) })
  open.push(s)
  return s
}

const makeMission = (id: string): Mission => ({
  id,
  objective: 'Record an action, be interrupted, and come back with obligations',
  constraints: [],
  state: 'executing',
  startedAt: Date.now(),
  history: [],
  pendingApprovals: [],
  plan: [
    {
      id: 's1', intent: 'the action that gets interrupted', mode: 'cli', capability: 'filesystem.write',
      rationale: 'gives the store a step to interrupt', tool: 'probe-write',
      args: {}, dependsOn: [], status: 'pending', attempts: 0,
    },
  ],
})

// ---------------------------------------------------------------- write-ahead
console.log('=== 1. the write-ahead is written, and survives later recorder calls ===')
const interrupted = makeMission('durability-interrupted')
{
  const store = openStore('interrupted.db')
  const recorder = new StoreRecorder(store)
  recorder.missionStarted(interrupted)
  // `at` is supplied because the recorder binds it straight into a SQLite parameter, and an
  // absent optional operand binds as `undefined`, which better-sqlite3 refuses.
  recorder.attemptBegin({ missionId: interrupted.id, stepId: 's1', attempt: 1, at: Date.now() } as never)
  check('attemptBegin persisted `running` BEFORE the action could run',
    store.persistedStepStatuses(interrupted.id).includes('running'),
    `statuses=${JSON.stringify(store.persistedStepStatuses(interrupted.id))}`)

  // THE REGRESSION GUARD. Before the fix this wrote `pending` back over the write-ahead.
  recorder.note(interrupted.id, 'recovery', 'process died mid-step', { atStep: 's1' })
  check('and a LATER recorder call did not overwrite it with `pending`',
    store.persistedStepStatuses(interrupted.id).includes('running'),
    `statuses=${JSON.stringify(store.persistedStepStatuses(interrupted.id))}`)
}

const reopened = openStore('interrupted.db')
check('the write-ahead is still `running` after the store is CLOSED and REOPENED from disk',
  reopened.persistedStepStatuses(interrupted.id).includes('running'),
  `statuses=${JSON.stringify(reopened.persistedStepStatuses(interrupted.id))}`)

const history = missionHistory(reopened, interrupted.id)
check('a reopened store reports history for the mission', history.entries > 0, `entries=${history.entries}`)
check('the ATTEMPT is durable', (history.byKind['step'] ?? 0) >= 1, JSON.stringify(history.byKind))
check('the RECOVERY note is durable', (history.byKind['recovery'] ?? 0) >= 1, JSON.stringify(history.byKind))
check('raw history rows were read back from disk', reopened.readHistory(interrupted.id).length >= 3,
  `${reopened.readHistory(interrupted.id).length} rows`)

// ---------------------------------------------------------------- recovery
console.log('')
console.log('=== 2. an interrupted step is recovered as unfinished work ===')
const permitStore = openStore('interrupted.db')
const permit = resumeMission(permitStore, interrupted.id)
check('resumeMission found the mission', Boolean(permit))
if (permit) {
  check('the permit is NEVER empty', permit.obligations.length > 0, `${permit.obligations.length} obligation(s)`)
  check('the interrupted step is named as recovered', permit.recoveredSteps.includes('s1'),
    `recoveredSteps=${JSON.stringify(permit.recoveredSteps)}`)
  check('it carries a recover-step obligation naming that step',
    permit.obligations.some((o) => o.kind === 'recover-step' && o.stepId === 's1'),
    `obligations=${JSON.stringify(permit.obligations.map((o) => o.kind))}`)
  check('it carries a re-observe obligation', permit.obligations.some((o) => o.kind === 're-observe'))
  check('it requires a FRESH OBSERVATION', permit.requiresFreshObservation === true)
  check('it carries NO live evidence from the dead process', permit.liveEvidence.length === 0,
    `${permit.liveEvidence.length} item(s)`)
  check('the permit exposes no permission/runnable flag',
    !('mayRun' in permit) && !('permitted' in permit) && !('authorized' in permit))
}

// ---------------------------------------------------------------- verified
console.log('')
console.log('=== 3. a VERIFIED step is NOT handed back as unfinished work ===')
const doneMission = makeMission('durability-verified')
{
  const store = openStore('verified.db')
  const recorder = new StoreRecorder(store)
  recorder.missionStarted(doneMission)
  recorder.attemptBegin({ missionId: doneMission.id, stepId: 's1', attempt: 1, at: Date.now() } as never)
  recorder.verified({
    missionId: doneMission.id, stepId: 's1', at: Date.now(),
    evidence: { kind: 'file-exists', path: 'never-written.txt', bytes: 1 },
  } as never)
  check('a verified step is persisted as `done`, not `running`',
    store.persistedStepStatuses(doneMission.id).includes('done'),
    `statuses=${JSON.stringify(store.persistedStepStatuses(doneMission.id))}`)
}
const donePermit = resumeMission(openStore('verified.db'), doneMission.id)
check('a verified step is NOT returned as recovered',
  !(donePermit?.recoveredSteps ?? []).includes('s1'),
  `recoveredSteps=${JSON.stringify(donePermit?.recoveredSteps)}`)
check('and carries no recover-step obligation',
  !(donePermit?.obligations ?? []).some((o) => o.kind === 'recover-step'),
  `obligations=${JSON.stringify(donePermit?.obligations.map((o) => o.kind))}`)
check('the permit still requires a fresh observation regardless',
  donePermit?.requiresFreshObservation === true)

// ---------------------------------------------------------------- restart
console.log('')
console.log('=== 4. obligations survive a restart and do not weaken when asked twice ===')
{
  const p1 = resumeMission(openStore('interrupted.db'), interrupted.id)
  const p2 = resumeMission(openStore('interrupted.db'), interrupted.id)
  check('a permit is still obtainable after a fresh reopen', Boolean(p1))
  check('and is still non-empty', (p1?.obligations.length ?? 0) > 0, `${p1?.obligations.length} obligation(s)`)
  check('still with no live evidence', (p1?.liveEvidence.length ?? -1) === 0)
  check('two independent reads agree', (p2?.obligations.length ?? -1) === (p1?.obligations.length ?? -2),
    `${p1?.obligations.length} vs ${p2?.obligations.length}`)
  check('and both still demand a fresh observation',
    p1?.requiresFreshObservation === true && p2?.requiresFreshObservation === true)
}

// ---------------------------------------------------------------- cleanup
let cleaned = true
try { for (const s of open) { try { s.close() } catch { /* already closed */ } } }
catch { cleaned = false }
try { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) }
catch { cleaned = false }
console.log(`  OBSERVED  temp directory ${cleaned ? 'removed' : 'LEFT BEHIND'}: ${root}`)

console.log('')
console.log(`=== ${failed === 0 ? 'PASS' : failed + ' FAILURE(S)'} ===`)
process.exit(failed ? 1 : 0)
