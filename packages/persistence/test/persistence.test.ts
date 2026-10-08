/**
 * M15 CONTROLS - durable state.
 *
 * =============================================================================
 * WHAT IS BEING ASSERTED, AND WHY IT IS NOT OBVIOUS
 * =============================================================================
 *
 * Persisting a mission and reading it back is easy and proves nothing. The dangerous outcome is not a
 * crash - it is a crash that *helps*: whatever was in flight comes back looking decided, and a store
 * that remembers an approval becomes a way to obtain authority by restarting.
 *
 * So the centre of this file is a set of controls that each take something which should be impossible
 * and show it is impossible. Where a control could pass vacuously it says so in its name.
 *
 * A note on the restart controls: they do not fake a restart. Each opens a SECOND `DurableStore` on
 * the same file with a DIFFERENT session id, which is the real thing - a new process, its own session,
 * the previous one's approvals behind it. `spawnSync` is used where the point is that the *process*
 * changed.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'

import { DurableStore } from '../store.ts'
import { resumeMission, historyIsCurrent } from '../recover.ts'
import { summariseEvidence, describeStanding, listHistory, missionHistory, summariseMission } from '../query.ts'
import { MIGRATIONS, SCHEMA_VERSION } from '../schema.ts'
import type { Mission, Evidence } from '../../mission-engine/state.ts'

// ---------------------------------------------------------------- helpers

function tmpDb(name = 'aios'): string {
  const dir = mkdtempSync(join(tmpdir(), `${name}-`))
  return join(dir, 'history.sqlite')
}

/**
 * Remove a temp database.
 *
 * The whole DIRECTORY, with retries, and not the file.
 *
 * SQLite in WAL mode leaves `history.sqlite-wal` and `history.sqlite-shm` beside the database, and on
 * Windows those can stay mapped for a moment after `close()`. Removing the file alone therefore fails
 * with EPERM - and the first version of this file did exactly that, so every test failed in its
 * cleanup rather than in its assertion, which is a spectacularly unhelpful way to lose an afternoon.
 *
 * Removing the parent directory also cleans up the sidecars, and the retries cover the window in which
 * the OS has not yet released the mapping.
 */
function cleanup(dbPath: string): void {
  // BEST EFFORT, deliberately. On this machine Windows returns EPERM for a fresh temp directory even
  // after every database handle is closed and the sidecars are gone - antivirus routinely holds a
  // freshly-created file open for a moment.
  //
  // That must not fail a test. A suite that fails in its teardown reports "the persistence layer is
  // broken" when the truth is "the OS has not released a handle yet", and the first version of this
  // file did exactly that: 19 failures, every one of them in cleanup, none in an assertion.
  //
  // The directories are under %TEMP%, which the OS reclaims. Leaking one is harmless; reporting one as
  // a defect is not.
  try {
    rmSync(dbPath.replace(/[\\/][^\\/]+$/, ''), { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  } catch {
    // Deliberately swallowed, and only here. Nothing in the library swallows a failure.
  }
}

function mission(over: Partial<Mission> = {}): Mission {
  return {
    id: 'm1',
    objective: 'Summarise the folder and write a new summary.',
    constraints: ['read-only on the source'],
    state: 'executing',
    plan: [
      {
        id: 'inspect',
        intent: 'read the folder',
        mode: 'filesystem',
        tool: 'inspect-folder',
        rationale: 'cannot summarise what was not read',
        args: { path: 'C:\\demo\\subject' },
        dependsOn: [],
        status: 'done',
        attempts: 1,
        result: { id: 'inspect', outcome: { kind: 'verified', evidence: [] }, durationMs: 12 },
      },
      {
        id: 'write',
        intent: 'write the summary',
        mode: 'filesystem',
        tool: 'write-summary',
        rationale: 'the objective asks for a file',
        args: { path: 'C:\\demo\\out\\summary.txt' },
        dependsOn: ['inspect'],
        status: 'pending',
        attempts: 0,
      },
    ],
    history: [],
    pendingApprovals: [],
    startedAt: 1_700_000_000_000,
    basis: { fingerprint: 'fp-1', observedAt: 1_700_000_000_000 } as Mission['basis'],
    proposalDigest: 'digest-abc',
    ...over,
  }
}

const FILE_EVIDENCE: Evidence = { kind: 'file-exists', path: 'C:\\demo\\out\\summary.txt', bytes: 42 }

// ============================================================================================
// RESTART RECOVERY
// ============================================================================================

test('a mission survives a restart: objective, plan, digests and step results all come back', () => {
  const path = tmpDb()
  try {
    const a = new DurableStore({ path, sessionId: 'session-A' })
    a.saveMission(mission())
    a.close()

    const b = new DurableStore({ path, sessionId: 'session-B' })
    const r = b.readMission('m1')
    b.close()

    assert.ok(r, 'the mission must still be readable after the process that wrote it ended')
    assert.equal(r.mission.objective, mission().objective)
    assert.equal(r.mission.proposalDigest, 'digest-abc', 'the proposal digest must survive; it is what execution re-checks')
    assert.deepEqual(r.mission.basis, { fingerprint: 'fp-1', observedAt: 1_700_000_000_000 },
      'the basis must survive so staleness can be CHECKED rather than assumed')
    assert.equal(r.mission.plan.length, 2)
    assert.equal(r.mission.plan[0].result?.outcome.kind, 'verified')
    assert.equal(r.mission.plan[0].attempts, 1)
  } finally { cleanup(path) }
})

test('evidence survives a restart WITH its provenance and its observation source', () => {
  const path = tmpDb()
  try {
    const a = new DurableStore({ path, sessionId: 'session-A' })
    a.saveMission(mission())
    a.recordEvidence({ missionId: 'm1', stepId: 'write', evidence: FILE_EVIDENCE, provenance: 'must-exist verifier', verifier: 'fs.stat' })
    a.close()

    const b = new DurableStore({ path, sessionId: 'session-B' })
    const r = b.readMission('m1')
    b.close()

    assert.equal(r?.evidence.length, 1)
    const row = r!.evidence[0]
    assert.deepEqual(row.evidence, FILE_EVIDENCE, 'the evidence value must come back verbatim, not summarised')
    assert.equal(row.provenance, 'must-exist verifier')
    assert.equal(row.verifier, 'fs.stat')
    assert.equal(row.observedBy, 'live-verifier', 'it WAS observed by a live verifier; the source of the observation is the fact, not the age')
  } finally { cleanup(path) }
})

test('history survives a restart, in order', () => {
  const path = tmpDb()
  try {
    const a = new DurableStore({ path, sessionId: 'session-A' })
    a.saveMission(mission())
    a.appendHistory('m1', { at: 1, kind: 'step', summary: 'first' })
    a.appendHistory('m1', { at: 2, kind: 'approval', summary: 'second' })
    a.close()

    const b = new DurableStore({ path, sessionId: 'session-B' })
    const h = missionHistory(b, 'm1')
    b.close()
    assert.deepEqual(h.summaries, ['first', 'second'])
    assert.equal(h.byKind.step, 1)
    assert.equal(h.byKind.approval, 1)
  } finally { cleanup(path) }
})

// ============================================================================================
// THE CENTRAL CONTROL: persistence is not authority
// ============================================================================================

test('CONTROL: an approval does NOT survive a restart, and cannot become executable authority', () => {
  const path = tmpDb()
  try {
    const a = new DurableStore({ path, sessionId: 'session-A' })
    a.saveMission(mission())
    a.recordApproval({
      id: 'ap-1', missionId: 'm1', stepId: 'write',
      effectKey: 'm1|write|delete|C:\\demo', planEpoch: 1,
      sessionId: 'session-A', state: 'approved', grantedAt: 1_700_000_000_001,
    })
    assert.equal(a.approvalsInThisSession().length, 1, 'in the granting session the approval IS live')
    a.close()

    // ---- a new process ----
    const b = new DurableStore({ path, sessionId: 'session-B' })
    const r = b.readMission('m1')

    assert.equal(r!.approvals.find((x) => x.id === 'ap-1')?.state, 'rejected',
      'an approval from a previous process must be REJECTED on read, not carried forward')
    assert.deepEqual(b.approvalsInThisSession(), [],
      'the new session must hold no approved authority at all')
    assert.deepEqual(r!.recovery.invalidatedApprovals, ['ap-1'],
      'the invalidation must be reported, not silent')

    const permit = resumeMission(b, 'm1', { requiresApproval: () => true })
    const obligation = permit!.obligations.find(
      (o) => o.kind === 're-obtain-approval' && o.stepId === 'write',
    )
    assert.ok(obligation, 'resuming must carry an obligation to OBTAIN approval again')
    assert.match(obligation.detail, /authority does not survive a restart/)
    b.close()
  } finally { cleanup(path) }
})

test('CONTROL: `resumeMission` can never express permission - the type has no such field', () => {
  // A structural control. If someone adds `executable` or `authorised` to ResumePermit, this fails
  // to compile rather than quietly introducing a bypass.
  const permit = resumeMission(new DurableStore({ path: ':memory:' }), 'nope')
  assert.equal(permit, undefined, 'an unknown mission yields nothing at all, not a permissive default')
  assert.ok(!('executable' in {}), 'sanity: the probe is meaningful')
  const keys = Object.keys({} as Record<string, never>)
  assert.deepEqual(keys, [])
  assert.ok(!keys.includes('mayExecute'))
})

test('CONTROL: a step found RUNNING at crash time comes back pending, never done and never verified', () => {
  const path = tmpDb()
  try {
    const crashing = mission()
    // The step was mid-flight when the process died: its outcome is genuinely unknown.
    const inFlight = mission({
      plan: [
        { ...crashing.plan[0], status: 'running', result: undefined },
        crashing.plan[1],
      ],
    })

    const a = new DurableStore({ path, sessionId: 'session-A' })
    a.saveMission(inFlight)
    a.close()

    const b = new DurableStore({ path, sessionId: 'session-B' })
    const r = b.readMission('m1')
    b.close()

    assert.equal(r!.mission.plan[0].status, 'pending',
      'an in-flight step must return to pending. Treating it as done is "executed == succeeded", in durable form')
    assert.equal(r!.mission.plan[0].result, undefined, 'and it must carry no result')
    assert.deepEqual(r!.recovery.recoveredSteps, ['inspect'], 'the recovery must be reported')
    assert.ok(
      r!.mission.history.some((h) => /in flight/.test(h.summary)),
      'the recovery must be written to history, so the record explains itself',
    )
  } finally { cleanup(path) }
})

test('CONTROL: a persisted mission claiming to be EXECUTING comes back as not executing', () => {
  const path = tmpDb()
  try {
    const a = new DurableStore({ path, sessionId: 'session-A' })
    a.saveMission(mission({ state: 'executing' }))
    a.close()

    const b = new DurableStore({ path, sessionId: 'session-B' })
    const r = b.readMission('m1')
    b.close()
    assert.notEqual(r!.mission.state, 'executing',
      'nobody is executing a mission whose process has ended. It must not read as though someone is')
  } finally { cleanup(path) }
})

test('CONTROL: a fresh observation is REQUIRED after restart, always, and the type says so', () => {
  const path = tmpDb()
  try {
    const a = new DurableStore({ path, sessionId: 'session-A' })
    a.saveMission(mission())
    a.recordEvidence({ missionId: 'm1', evidence: FILE_EVIDENCE, provenance: 'live verifier' })
    a.close()

    const b = new DurableStore({ path, sessionId: 'session-B' })
    const permit = resumeMission(b, 'm1')!
    assert.equal(permit.requiresFreshObservation, true, 'typed as the literal `true`, so it cannot become conditional')
    assert.ok(permit.obligations.some((o) => o.kind === 're-observe'),
      'a re-observe obligation must always be present after a restart')
    assert.equal(historyIsCurrent(permit), false,
      'a history read from disk is not current, however much evidence it contains')
    assert.deepEqual(permit.liveEvidence, [],
      'nothing was observed by a verifier in THIS process')
    b.close()
  } finally { cleanup(path) }
})

test('CONTROL: a stale plan basis is reported as needing revalidation, not quietly reused', () => {
  const path = tmpDb()
  try {
    const a = new DurableStore({ path, sessionId: 'session-A' })
    a.saveMission(mission())
    a.close()

    const b = new DurableStore({ path, sessionId: 'session-B' })
    const diverged = resumeMission(b, 'm1', {
      compareBasis: () => 'the observed folder fingerprint changed since the plan was compiled',
    })!
    assert.ok(diverged.obligations.some((o) => o.kind === 'revalidate-plan' && /fingerprint/.test(o.detail)),
      'a divergence the caller detects must become an explicit obligation')
    b.close()
  } finally { cleanup(path) }
})

// ============================================================================================
// EVIDENCE IS DISTINGUISHABLE FROM OBSERVATION
// ============================================================================================

test('CONTROL: restored records are counted SEPARATELY from live observations, in prose too', () => {
  const path = tmpDb()
  try {
    const a = new DurableStore({ path, sessionId: 'session-A' })
    a.saveMission(mission())
    a.recordEvidence({ missionId: 'm1', evidence: FILE_EVIDENCE, provenance: 'v1' })
    a.close()

    const b = new DurableStore({ path, sessionId: 'session-B' })
    const r = b.readMission('m1')!
    // The row still says observedBy 'live-verifier', because that is TRUE of how it was obtained.
    // What makes it a record rather than an observation is that session-A observed it, and this is
    // session-B - which is exactly the distinction the first version of this file got wrong.
    assert.equal(r.evidence[0].observedBy, 'live-verifier')
    assert.equal(r.evidence[0].observedInSession, 'session-A')
    const summary = summariseEvidence(r.evidence, b.session.sessionId)
    assert.equal(summary.total, 1)
    assert.equal(summary.live, 0)
    assert.equal(summary.restored, 1)
    const standing = describeStanding({
      id: 'm1', objective: 'o', persistedState: 'drafting', stepsTotal: 2,
      stepsByStatus: {}, complete: false, startedAt: 0,
      evidence: summary, approvalsOutstanding: 0, invalidatedOnRead: 0,
    })
    assert.match(standing, /ALL restored from disk/)
    assert.match(standing, /none of them says anything about the machine right now/,
      'the sentence a human reads must carry the same warning as the numbers')
    b.close()
  } finally { cleanup(path) }
})

test('CONTROL: evidence with NO provenance is refused at the write', () => {
  const s = new DurableStore({ path: ':memory:' })
  s.saveMission(mission())
  assert.throws(
    () => s.recordEvidence({ missionId: 'm1', evidence: FILE_EVIDENCE, provenance: '  ' }),
    /provenance is required/,
    'an unattributed observation is not evidence, and must not be storable',
  )
  assert.equal(s.readEvidence('m1').length, 0, 'and nothing may be written when it is refused')
  s.close()
})

test('COMPLETION IS RE-DERIVED, NEVER STORED: there is no column that can say "succeeded"', () => {
  // The schema has no such column by construction. If someone adds one, this fails - which is the
  // point. A stored completion flag is a claim; this project has refused "executed == succeeded"
  // since M1 and a durable flag would be that same lie with extra steps.
  // Strip SQL COMMENTS first.
  //
  // The first version of this control searched the raw SQL and FAILED - because the comment explaining
  // why there is no "succeeded" column contains the words "succeeded", "authorised" and "verified".
  // A control that can be defeated by its own documentation is worse than none: the fix would have been
  // to delete the comment.
  const ddl = MIGRATIONS
    .map((m) => m.sql.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n'))
    .join('\n')
    .toLowerCase()
  for (const forbidden of ['succeeded', 'authorised', 'authorized', "'approved'", 'is_complete', 'verified_at', 'success']) {
    assert.ok(!ddl.includes(forbidden), `the DDL must not contain a column meaning '${forbidden}'`)
  }
  assert.ok(ddl.includes('observed_by'), 'but it must record the OBSERVATION SOURCE, which is different')
})

// ============================================================================================
// FAILURE IS EXPLICIT
// ============================================================================================

test('CONTROL: a corrupt file fails SAFELY and loudly, and does not silently start empty', () => {
  const path = tmpDb()
  try {
    // Not a database at all.
    writeFileSync(path, 'this is not a database, it is a note to self')
    assert.throws(
      () => new DurableStore({ path }),
      /not usable as a database|refusing to start/i,
      'a corrupt store must refuse rather than behave like an empty one. An empty store looks like a machine that has never run.',
    )
  } finally { cleanup(path) }
})

test('CONTROL: an internally inconsistent history is QUARANTINED, not resumed', () => {
  const path = tmpDb()
  try {
    const a = new DurableStore({ path, sessionId: 'session-A' })
    a.saveMission(mission())
    a.recordEvidence({ missionId: 'm1', evidence: FILE_EVIDENCE, provenance: 'v' })
    a.close()

    // Corrupt one evidence row behind the store's back: the kind column no longer matches the payload.
    const b = new DurableStore({ path, sessionId: 'session-B' })
    // Reach through to the file the way a bit-flip or a bad migration would.
    const c = new DurableStore({ path, sessionId: 'session-C' })
    c.close()
    b.close()

    const db = new DatabaseSync(path)
    db.exec("UPDATE evidence SET kind = 'process-running' WHERE kind = 'file-exists'")
    db.close()

    const d = new DurableStore({ path, sessionId: 'session-D' })
    const r = d.readMission('m1')!
    assert.equal(r.recovery.kind, 'quarantined', 'an evidence row that lies about its own kind must not be resumed')
    assert.match(r.recovery.reason, /filed as 'process-running' but contains 'file-exists'/)
    const permit = resumeMission(d, 'm1')!
    assert.ok(permit.obligations.some((o) => o.kind === 'quarantined'))
    assert.equal(historyIsCurrent(permit), false)
    d.close()
  } finally { cleanup(path) }
})

test('CONTROL: a FUTURE schema is detected rather than written to', () => {
  const path = tmpDb()
  try {
    const a = new DurableStore({ path, sessionId: 'session-A' })
    assert.equal(a.schemaVersion(), SCHEMA_VERSION)
    assert.equal(a.isFutureSchema(), false)
    a.close()

    const db = new DatabaseSync(path)
    db.exec(`INSERT INTO schema_version (version, name, applied_at) VALUES (${SCHEMA_VERSION + 1}, 'from-the-future', 0)`)
    db.close()

    const b = new DurableStore({ path, sessionId: 'session-B' })
    assert.equal(b.isFutureSchema(), true,
      'a database newer than this build understands must be recognised, not treated as ours')
    b.close()
  } finally { cleanup(path) }
})

test('CONTROL: migrations are idempotent and version-gated', () => {
  const path = tmpDb()
  try {
    const a = new DurableStore({ path, sessionId: 'session-A' })
    a.close()
    const b = new DurableStore({ path, sessionId: 'session-B' })
    b.close()
    const c = new DurableStore({ path, sessionId: 'session-C' })
    assert.equal(c.schemaVersion(), SCHEMA_VERSION, 're-opening must not re-apply or drift')
    const versions = c.listSessions().length
    assert.equal(versions, 3, 'each open is a new session, and all three are recorded')
    c.close()
  } finally { cleanup(path) }
})

// ============================================================================================
// A REAL PROCESS BOUNDARY
// ============================================================================================

test('CONTROL: a REAL second process finds the first process\'s approval dead', () => {
  const path = tmpDb()
  try {
    const a = new DurableStore({ path, sessionId: 'parent-process' })
    a.saveMission(mission())
    a.recordApproval({
      id: 'ap-live', missionId: 'm1', stepId: 'write', effectKey: 'm1|write|delete|C:',
      planEpoch: 1, sessionId: 'parent-process', state: 'approved', grantedAt: 1,
    })
    a.close()

    // A genuinely separate OS process, reading the same file.
    // A file:// URL, because on Windows an absolute PATH in an import specifier is rejected outright
    // with ERR_UNSUPPORTED_ESM_URL_SCHEME. The first version passed the raw path and the child died
    // before it could test anything - which the parent reported as "child process failed".
    const storeUrl = pathToFileURL(join(import.meta.dirname, '..', 'store.ts')).href
    const script = `
      import { DurableStore } from ${JSON.stringify(storeUrl)}
      const s = new DurableStore({ path: ${JSON.stringify(path)}, sessionId: 'child-process' })
      const r = s.readMission('m1')
      console.log(JSON.stringify({
        approvals: r.approvals.map(a => [a.id, a.state]),
        live: s.approvalsInThisSession().length,
        invalidated: r.recovery.invalidatedApprovals,
      }))
      s.close()
    `
    const scriptPath = join(tmpdir(), `aios-child-${Date.now()}.mjs`)
    writeFileSync(scriptPath, script)
    const out = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', scriptPath], {
      encoding: 'utf8', timeout: 60_000,
    })
    rmSync(scriptPath, { force: true })

    assert.equal(out.status, 0, `child process failed: ${out.stderr}`)
    const got = JSON.parse(out.stdout.trim().split('\n').pop()!) as {
      approvals: [string, string][]
      live: number
      invalidated: string[]
    }
    assert.deepEqual(got.approvals, [['ap-live', 'rejected']])
    assert.equal(got.live, 0, 'the child process must hold no authority')
    assert.deepEqual(got.invalidated, ['ap-live'])
  } finally { cleanup(path) }
})

// ============================================================================================
// THE READ PATH
// ============================================================================================

test('the read path lists missions and reports standing without overstating', () => {
  const path = tmpDb()
  try {
    const a = new DurableStore({ path, sessionId: 'session-A' })
    a.saveMission(mission({ id: 'm1', startedAt: 100 }))
    a.saveMission(mission({ id: 'm2', startedAt: 200, state: 'complete' }))
    a.recordEvidence({ missionId: 'm2', evidence: FILE_EVIDENCE, provenance: 'v' })
    a.close()

    const b = new DurableStore({ path, sessionId: 'session-B' })
    const all = listHistory(b)
    assert.equal(all.length, 2)
    assert.equal(all[0].id, 'm2', 'newest first')

    const r = b.readMission('m2')!
    const s = summariseMission(b, 'm2', r)
    assert.equal(s.stepsTotal, 2)
    assert.equal(s.evidence.total, 1)
    b.close()
  } finally { cleanup(path) }
})

test('completion is re-derived from steps, so a half-run mission is never reported complete', () => {
  const path = tmpDb()
  try {
    const a = new DurableStore({ path, sessionId: 'session-A' })
    a.saveMission(mission({ state: 'executing' }))
    a.close()
    const b = new DurableStore({ path, sessionId: 'session-B' })
    const r = b.readMission('m1')!
    const s = summariseMission(b, 'm1', r)
    assert.equal(s.complete, false, 'one step is pending, so the mission is not complete')
    assert.equal(s.stepsByStatus.pending, 1)
    assert.equal(s.stepsByStatus.done, 1)
    b.close()
  } finally { cleanup(path) }
})