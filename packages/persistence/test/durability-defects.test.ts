/**
 * REGRESSION TESTS FOR THE THREE DURABILITY DEFECTS.
 *
 * Each of these pins a specific, previously-wrong behaviour. They exist because the fixes are
 * easy to undo by accident: every one of them is a change that makes a code path look simpler.
 *
 * A. THE WRITE-AHEAD SURVIVED ONLY ONE CALL.
 *    `attemptBegin` persisted `running` before the action could run - and then the next recorder
 *    call destroyed it. `StoreRecorder` builds writes on a read of the current row, and that read
 *    went through `readMission`, which performs RECOVERY: it rewrites `running` to `pending`,
 *    records the step as recovered, and writes that back. A live process was therefore recovering
 *    its own in-flight step and claiming in the history that the step "was in flight when the
 *    process ended" while the process was still running it. The fix adds a non-recovering read
 *    for writers; these tests fail if that read is ever removed.
 *
 * B. A VERIFIED STEP WAS STILL CLASSIFIED AS UNFINISHED.
 *    `verified` recorded proof that a step had completed and left its status at `running`, so the
 *    next resume issued a `recover-step` obligation - an instruction to repeat an action that had
 *    already been independently proved. These tests fail if `verified` stops settling the status.
 *
 * C. HANDLES OUTLIVED `close()`.
 *    Every store here is closed and its directory removed, including on the failure path, so a
 *    leaked SQLite handle cannot hide behind a green suite.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { DurableStore } from '../../persistence/store.ts'
import { StoreRecorder } from '../../persistence/recorder.ts'
import { resumeMission } from '../../persistence/recover.ts'
import type { Mission } from '../../mission-engine/state.ts'

const missionOf = (id: string): Mission => ({
  id,
  objective: 'an action that may be interrupted',
  constraints: [],
  state: 'executing',
  startedAt: Date.now(),
  history: [],
  pendingApprovals: [],
  plan: [
    {
      id: 's1', intent: 'the action', mode: 'cli', capability: 'filesystem.write',
      rationale: 'so there is a step to interrupt', tool: 'probe',
      args: {}, dependsOn: [], status: 'pending', attempts: 0,
    },
  ],
})

/** A store on a real file, closed and removed whatever the test does. */
function scratch(t: { after: (fn: () => void) => void }): { db: string; open: () => DurableStore } {
  const root = mkdtempSync(join(tmpdir(), 'aios-persist-reg-'))
  const db = join(root, 'missions.db')
  // One hook, doing close-then-remove in that order. Registering the removal separately meant it
  // ran FIRST - `after` hooks run in registration order - so every test failed with EPERM on an
  // open handle and the suite reported a leak that the test itself had caused.
  const opened: DurableStore[] = []
  t.after(() => {
    for (const s of opened) { try { s.close() } catch { /* already closed */ } }
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    assert.equal(existsSync(root), false, 'the scratch directory must be removable: a store handle outlived close()')
  })
  const open = (): DurableStore => {
    const s = new DurableStore({ path: db })
    opened.push(s)
    return s
  }
  return { db, open }
}

// ------------------------------------------------------------------ A
test('A1: attemptBegin writes `running` before the action can run', (t) => {
  const { open } = scratch(t)
  const m = missionOf('reg-a1')
  const s = open()
  new StoreRecorder(s).missionStarted(m)
  assert.deepEqual(s.persistedStepStatuses(m.id), ['pending'])
  new StoreRecorder(s).attemptBegin({ missionId: m.id, stepId: 's1', attempt: 1, at: Date.now() } as never)
  assert.deepEqual(s.persistedStepStatuses(m.id), ['running'])
})

test('A2: a LATER recorder call does not overwrite the write-ahead with `pending`', (t) => {
  const { open } = scratch(t)
  const m = missionOf('reg-a2')
  const s = open()
  const r = new StoreRecorder(s)
  r.missionStarted(m)
  r.attemptBegin({ missionId: m.id, stepId: 's1', attempt: 1, at: Date.now() } as never)
  // This is the call that used to perform a recovery and clobber the write-ahead.
  r.note(m.id, 'note', 'an ordinary recorder call mid-step', { atStep: 's1' })
  assert.deepEqual(s.persistedStepStatuses(m.id), ['running'],
    'an ordinary recorder call must not resolve an in-flight step to pending')
})

test('A3: a live recorder does not claim the process ended mid-step', (t) => {
  const { open } = scratch(t)
  const m = missionOf('reg-a3')
  const s = open()
  const r = new StoreRecorder(s)
  r.missionStarted(m)
  r.attemptBegin({ missionId: m.id, stepId: 's1', attempt: 1, at: Date.now() } as never)
  r.note(m.id, 'note', 'still running', {})
  const recoveryRows = s.readHistory(m.id).filter((h) => h.kind === 'recovery')
  assert.equal(recoveryRows.length, 0,
    'a live process must not write a recovery row for a step it is still running')
})

test('A4: the write-ahead is still `running` after close and reopen from disk', (t) => {
  const { open } = scratch(t)
  const m = missionOf('reg-a4')
  const s1 = open()
  const r = new StoreRecorder(s1)
  r.missionStarted(m)
  r.attemptBegin({ missionId: m.id, stepId: 's1', attempt: 1, at: Date.now() } as never)
  s1.close()
  assert.deepEqual(open().persistedStepStatuses(m.id), ['running'])
})

test('A5: an interrupted step is recovered as unfinished, with a recover-step obligation', (t) => {
  const { open } = scratch(t)
  const m = missionOf('reg-a5')
  const s1 = open()
  const r = new StoreRecorder(s1)
  r.missionStarted(m)
  r.attemptBegin({ missionId: m.id, stepId: 's1', attempt: 1, at: Date.now() } as never)
  s1.close()
  const permit = resumeMission(open(), m.id)
  assert.ok(permit, 'the interrupted mission must be recoverable')
  assert.ok(permit!.recoveredSteps.includes('s1'), 'the in-flight step must be named')
  assert.ok(permit!.obligations.some((o) => o.kind === 'recover-step' && o.stepId === 's1'),
    'an interrupted action must not be silently discarded')
})

// ------------------------------------------------------------------ B
test('B1: a verified step is persisted as `done`', (t) => {
  const { open } = scratch(t)
  const m = missionOf('reg-b1')
  const s = open()
  const r = new StoreRecorder(s)
  r.missionStarted(m)
  r.attemptBegin({ missionId: m.id, stepId: 's1', attempt: 1, at: Date.now() } as never)
  r.verified({
    missionId: m.id, stepId: 's1', at: Date.now(), verifier: 'test',
    evidence: { kind: 'file-exists', path: 'never-written.txt', bytes: 1 },
  } as never)
  assert.deepEqual(s.persistedStepStatuses(m.id), ['done'])
})

test('B2: a verified step is NOT returned as unfinished work', (t) => {
  const { open } = scratch(t)
  const m = missionOf('reg-b2')
  const s1 = open()
  const r = new StoreRecorder(s1)
  r.missionStarted(m)
  r.attemptBegin({ missionId: m.id, stepId: 's1', attempt: 1, at: Date.now() } as never)
  r.verified({
    missionId: m.id, stepId: 's1', at: Date.now(), verifier: 'test',
    evidence: { kind: 'file-exists', path: 'never-written.txt', bytes: 1 },
  } as never)
  s1.close()
  const permit = resumeMission(open(), m.id)
  assert.ok(!permit!.recoveredSteps.includes('s1'),
    'a verified step must not be classified as work needing repetition')
  assert.ok(!permit!.obligations.some((o) => o.kind === 'recover-step'),
    'a verified step must not carry a recover-step obligation')
})

test('B3: verification does not overwrite an already-failed step', (t) => {
  const { open } = scratch(t)
  const m = missionOf('reg-b3')
  const s = open()
  const r = new StoreRecorder(s)
  r.missionStarted(m)
  r.attemptOutcome({
    missionId: m.id, stepId: 's1', attempt: 1, at: Date.now(),
    outcome: { kind: 'failed', reason: 'the tool refused' },
  } as never)
  r.verified({
    missionId: m.id, stepId: 's1', at: Date.now(), verifier: 'test',
    evidence: { kind: 'file-exists', path: 'x', bytes: 1 },
  } as never)
  assert.notEqual(s.persistedStepStatuses(m.id)[0], 'done',
    'a settled outcome must not be resurrected into done by a late verification')
})

// ------------------------------------------------------------------ the permit
test('P1: the permit is obligations, never empty, and never permission', (t) => {
  const { open } = scratch(t)
  const m = missionOf('reg-p1')
  const s1 = open()
  const r = new StoreRecorder(s1)
  r.missionStarted(m)
  r.attemptBegin({ missionId: m.id, stepId: 's1', attempt: 1, at: Date.now() } as never)
  s1.close()
  const permit = resumeMission(open(), m.id)!
  assert.ok(permit.obligations.length > 0, 'obligations are never empty by construction')
  assert.equal(permit.requiresFreshObservation, true)
  assert.equal(permit.liveEvidence.length, 0, 'no evidence may be inherited from a dead process')
  assert.ok(!('mayRun' in permit) && !('permitted' in permit) && !('authorized' in permit),
    'the permit must not be usable as authorisation')
})

test('P2: obligations survive a restart and never weaken to empty when asked twice', (t) => {
  const { open } = scratch(t)
  const m = missionOf('reg-p2')
  const s1 = open()
  const r = new StoreRecorder(s1)
  r.missionStarted(m)
  r.attemptBegin({ missionId: m.id, stepId: 's1', attempt: 1, at: Date.now() } as never)
  s1.close()
  const a = resumeMission(open(), m.id)!
  const b = resumeMission(open(), m.id)!
  // The COUNTS are deliberately not compared. Recovery is consumed once and written back to
  // disk, so the first permit carries the `recover-step` obligation and later ones do not -
  // that is the design, and it is what stops a mission being recovered twice. What must hold
  // is that a permit never empties and never stops demanding a fresh observation.
  assert.ok(a.obligations.length > 0, 'the first permit is non-empty')
  assert.ok(b.obligations.length > 0, 'a later permit must not weaken to empty')
  assert.equal(a.requiresFreshObservation, true)
  assert.equal(b.requiresFreshObservation, true)
})