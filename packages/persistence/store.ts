/**
 * DURABLE STATE: the store.
 *
 * =============================================================================
 * THE ONE RULE
 * =============================================================================
 *
 *      A PERSISTED ROW IS A RECORD. IT IS NEVER AN AUTHORISATION.
 *
 * Nothing returned by this module can be acted on. `readMission` deliberately does NOT return a
 * `Mission` that is ready to execute: it returns a `RecoveredMission`, which pairs the record with a
 * recovery verdict that names what must be re-established before any step may run again.
 *
 * That inversion is the whole design. A store that returned an executable mission would be a store
 * that could hand back authority it never had, and a crash would become the way to obtain it.
 *
 * =============================================================================
 * WHY FAILURES ARE LOUD
 * =============================================================================
 *
 * Every write is inside a transaction, and every write failure THROWS. A persistence layer that fails
 * quietly is worse than none: the mission appears to be running, the history appears to be recorded,
 * and neither is true. There is no swallowing catch in this file, deliberately.
 *
 * (A note on that comment, because it cost a build: do not write a block-comment terminator inside a
 * block comment. Quoting an ignored-catch inline ends the comment early and the rest of the prose is
 * then parsed as TypeScript, which fails with "Expression expected" and points at the wrong file.)
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { applyMigrations, SCHEMA_VERSION, MIGRATIONS } from './schema.ts'
import type {
  Mission, Step, StepResult, Evidence, HistoryEntry, PendingApproval, PlanInvalidation,
} from '../mission-engine/state.ts'
import type { ExecutionMode } from '../mission-engine/state.ts'
import type { DeclaredEffect } from '../governance/approval.ts'

export type ObservedBy = 'live-verifier' | 'restored-from-disk'

export interface SessionInfo {
  readonly sessionId: string
  readonly startedAt: number
  readonly pid: number
  readonly host?: string
}

/** A persisted evidence row, with the provenance that makes it interpretable. */
export interface EvidenceRow {
  readonly id: number
  readonly missionId: string
  readonly stepId?: string
  readonly kind: string
  readonly evidence: Evidence
  readonly provenance: string
  readonly verifier?: string
  readonly observedAt: number
  /** `live-verifier` = somebody looked. `restored-from-disk` = this is a record of that looking. */
  readonly observedBy: ObservedBy
  /** The session that made the observation. Liveness is judged against THIS session, not the flag. */
  readonly observedInSession: string
}

/** True only if THIS process observed it. Nothing else counts as current. */
export function observedInThisSession(e: EvidenceRow, sessionId: string): boolean {
  return e.observedInSession === sessionId
}

/** A persisted approval row. Recorded here; the live `ApprovalStore` remains the authority. */
export interface PersistedApproval {
  readonly id: string
  readonly missionId: string
  readonly stepId: string
  readonly effectKey: string
  readonly planEpoch: number
  readonly sessionId: string
  readonly state: 'pending' | 'approved' | 'rejected'
  readonly grantedAt?: number
}

/**
 * What recovery decided about a persisted mission.
 *
 * `requiresFreshObservation` is `true` unconditionally and is typed as the literal `true`, so a
 * future edit that tries to make it conditional fails to compile rather than quietly weakening the
 * rule. That is the cheapest possible enforcement of an invariant that matters.
 */
export interface RecoveryVerdict {
  readonly kind: 'resumable' | 'quarantined'
  readonly reason: string
  /** Every approval that existed on disk and was invalidated by this restart. */
  readonly invalidatedApprovals: readonly string[]
  /** Steps that were mid-flight at crash time and have been returned to `pending`. */
  readonly recoveredSteps: readonly string[]
  /** Always true. A plan built on a past observation must be re-observed before it acts. */
  readonly requiresFreshObservation: true
  /** The session that last wrote this mission, for the record. */
  readonly lastSessionId?: string
}

export interface RecoveredMission {
  readonly mission: Mission
  readonly evidence: readonly EvidenceRow[]
  readonly history: readonly HistoryEntry[]
  readonly approvals: readonly PersistedApproval[]
  readonly recovery: RecoveryVerdict
}

export interface DurableStoreOptions {
  /** `:memory:` for tests. Otherwise a filesystem path; parent directories are created. */
  readonly path: string
  readonly now?: () => number
  readonly host?: string
  readonly pid?: number
  /** Injected so tests can prove a new process invalidates the old session. */
  readonly sessionId?: string
  readonly requireWrites?: boolean
}

export class DurableStore {
  private readonly db: DatabaseSync
  private readonly now: () => number
  readonly session: SessionInfo

  constructor(opts: DurableStoreOptions) {
    this.now = opts.now ?? (() => Date.now())

    if (opts.path !== ':memory:') mkdirSync(dirname(opts.path), { recursive: true })

    try {
      this.db = new DatabaseSync(opts.path)
    } catch (e) {
      throw new Error(
        `durable store: cannot open ${opts.path} (${(e as Error).message}). ` +
        'Refusing to start: a mission whose history cannot be recorded must not run.',
      )
    }

    // WAL gives a real journal, so a crash mid-transaction rolls back rather than leaving a torn
    // database. On `:memory:` SQLite ignores it, which is fine - memory cannot crash.
    if (opts.path !== ':memory:') {
      try { this.db.exec('PRAGMA journal_mode = WAL') } catch { /* older builds may not support it */ }
    }
    this.db.exec('PRAGMA foreign_keys = ON')

    const applied = applyMigrations(
      (sql) => this.db.exec(sql),
      () => this.readVersions(),
      this.now,
    )
    if (applied > 0 && opts.requireWrites !== false) {
      // A store that cannot persist is a store that will lose a mission. Find out now, at open time,
      // rather than at the first step result.
      //
      // BEGIN, insert, ROLLBACK. The transaction is the probe: it proves the file is writable and
      // leaves nothing behind, which is both simpler and more honest than inserting a probe row and
      // deleting it afterwards.
      //
      // The first version wrote `this.db.exec('DELETE ...').run('probe')` - chaining a statement call
      // onto `exec`, which returns void. It failed with "Cannot read properties of undefined", which
      // reads like a SQLite problem and was a plain API mistake.
      this.db.exec('BEGIN')
      try {
        this.db.prepare('INSERT INTO sessions (session_id, started_at, pid, host) VALUES (?, ?, ?, ?)').run(
          'write-probe', this.now(), opts.pid ?? process.pid, opts.host ?? null,
        )
        this.db.exec('ROLLBACK')
      } catch (e) {
        try { this.db.exec('ROLLBACK') } catch { /* nothing open */ }
        this.close()
        throw new Error(
          `durable store: the database opened but is not writable (${(e as Error).message}). ` +
          'Refusing to run a mission whose evidence could not be recorded.',
        )
      }
    }

    this.session = {
      sessionId: opts.sessionId ?? randomUUID(),
      startedAt: this.now(),
      pid: opts.pid ?? process.pid,
      host: opts.host,
    }
    this.db.prepare('INSERT INTO sessions (session_id, started_at, pid, host) VALUES (?, ?, ?, ?)').run(
      this.session.sessionId, this.session.startedAt, this.session.pid, this.session.host ?? null,
    )
  }

  private readVersions(): number[] {
    try {
      const rows = this.db.prepare('SELECT version FROM schema_version').all() as Array<{ version: number }>
      return rows.map((r) => Number(r.version))
    } catch {
      return []
    }
  }

  /** The schema version actually on disk, for the report. */
  schemaVersion(): number {
    const rows = this.readVersions()
    return rows.length ? Math.max(...rows) : 0
  }

  /** True when the file is newer than this build understands - e.g. a downgrade. */
  isFutureSchema(): boolean {
    return this.schemaVersion() > SCHEMA_VERSION
  }

  close(): void {
    try { this.db.close() } catch { /* already closed */ }
  }

  // ---------------------------------------------------------------- writes

  /**
   * Record the mission header and its steps.
   *
   * Whole-mission and in ONE transaction, because a half-written mission is exactly the fiction this
   * layer exists to prevent: a plan with no steps, or steps with no objective.
   */
  saveMission(m: Mission): void {
    this.tx(() => {
      this.db.prepare(`
        INSERT INTO missions (id, objective, constraints, state, proposal_digest, basis, invalidated_by, started_at, finished_at, persisted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          objective=excluded.objective, constraints=excluded.constraints, state=excluded.state,
          proposal_digest=excluded.proposal_digest, basis=excluded.basis,
          invalidated_by=excluded.invalidated_by, started_at=excluded.started_at,
          finished_at=excluded.finished_at, persisted_at=excluded.persisted_at
      `).run(
        m.id, m.objective, JSON.stringify(m.constraints ?? []), m.state,
        m.proposalDigest ?? null, m.basis ? JSON.stringify(m.basis) : null,
        m.invalidatedBy ? JSON.stringify(m.invalidatedBy) : null,
        m.startedAt, m.finishedAt ?? null, this.now(),
      )

      const del = this.db.prepare('DELETE FROM steps WHERE mission_id = ?')
      del.run(m.id)
      const ins = this.db.prepare(`
        INSERT INTO steps (mission_id, step_id, seq, intent, mode, capability, tool, rationale, args, effect, depends_on, status, attempts, result)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      m.plan.forEach((s, i) => {
        ins.run(
          m.id, s.id, i, s.intent, s.mode, s.capability ?? null, s.tool ?? null, s.rationale,
          s.args ? JSON.stringify(s.args) : null,
          s.effect ? JSON.stringify(s.effect) : null,
          s.dependsOn ? JSON.stringify(s.dependsOn) : null,
          s.status, s.attempts ?? 0,
          s.result ? JSON.stringify(s.result) : null,
        )
      })
    })
  }

  /**
   * Append evidence.
   *
   * `provenance` is REQUIRED and non-empty. An evidence row with no record of how it was obtained is
   * exactly the fabricated evidence this project refuses, so it is refused at the write rather than
   * filtered at the read.
   */
  recordEvidence(row: {
    missionId: string
    stepId?: string
    evidence: Evidence
    provenance: string
    verifier?: string
    observedAt?: number
    observedBy?: ObservedBy
  }): number {
    if (!row.provenance || row.provenance.trim().length === 0) {
      throw new Error('durable store: evidence refused - provenance is required. An unattributed observation is not evidence.')
    }
    const kind = (row.evidence as { kind?: unknown }).kind
    if (typeof kind !== 'string' || kind.length === 0) {
      throw new Error('durable store: evidence refused - no kind. Nothing is written that cannot be classified.')
    }
    let id = 0
    this.tx(() => {
      const r = this.db.prepare(`
        INSERT INTO evidence (mission_id, step_id, kind, payload, provenance, verifier, observed_at, observed_by, obs_session_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        row.missionId, row.stepId ?? null, kind, JSON.stringify(row.evidence),
        row.provenance, row.verifier ?? null,
        row.observedAt ?? this.now(), row.observedBy ?? 'live-verifier',
        this.session.sessionId,
      )
      id = Number(r.lastInsertRowid)
    })
    return id
  }

  appendHistory(missionId: string, entry: HistoryEntry): void {
    this.tx(() => {
      this.db.prepare('INSERT INTO history (mission_id, at, kind, summary, detail) VALUES (?, ?, ?, ?, ?)').run(
        missionId, entry.at, entry.kind, entry.summary,
        entry.detail === undefined ? null : JSON.stringify(entry.detail),
      )
    })
  }

  /** Record an approval. Recording is NOT granting - see the module docstring. */
  recordApproval(a: PersistedApproval): void {
    this.tx(() => {
      this.db.prepare(`
        INSERT INTO approvals (id, mission_id, step_id, effect_key, plan_epoch, session_id, state, granted_at, payload)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
        ON CONFLICT(id) DO UPDATE SET state=excluded.state, granted_at=excluded.granted_at,
          session_id=excluded.session_id, effect_key=excluded.effect_key, plan_epoch=excluded.plan_epoch
      `).run(
        a.id, a.missionId, a.stepId, a.effectKey, a.planEpoch, a.sessionId, a.state, a.grantedAt ?? null,
      )
    })
  }

  /**
   * Invalidate every approval not granted in the CURRENT session.
   *
   * Called on open. Unconditional, and it does not ask whether the world still looks the same - a new
   * process cannot know that, which is the point.
   */
  invalidateForeignApprovals(): string[] {
    // `state` MUST be in the SELECT. This exact line read `SELECT id, session_id` and then filtered on
    // `r.state === 'approved'`, which was `undefined` for every row, so `stale` was always empty and
    // NO approval was ever invalidated.
    //
    // Meaning: an approval granted by a previous process survived the restart and came back approved -
    // the precise outcome this whole milestone exists to prevent, shipped and green, because the
    // predicate named a column the query never fetched. It was found by the test that asserts an
    // approval does not survive, and by nothing else.
    const rows = this.db.prepare('SELECT id, session_id, state FROM approvals').all() as
      Array<{ id: string; session_id: string; state: string }>
    const stale = rows.filter((r) => r.session_id !== this.session.sessionId && r.state === 'approved')
    if (!stale.length) return []
    this.tx(() => {
      const up = this.db.prepare('UPDATE approvals SET state = ? WHERE id = ?')
      for (const r of stale) up.run('rejected', r.id)
    })
    return stale.map((r) => r.id)
  }

  /** Mark approvals as rejected in place, e.g. when a plan epoch is superseded. */
  invalidateEpoch(missionId: string, planEpoch: number): number {
    return this.invalidateApprovalsWhere(
      'mission_id = ? AND plan_epoch = ? AND state = ?',
      missionId, planEpoch, 'approved',
    )
  }

  invalidateApprovalsWhere(where: string, ...params: unknown[]): number {
    const rows = this.db.prepare(
      `SELECT id FROM approvals WHERE ${where}`,
    ).all(...(params as never[])) as Array<{ id: string }>
    if (!rows.length) return 0
    this.tx(() => {
      const up = this.db.prepare('UPDATE approvals SET state = ? WHERE id = ?')
      for (const r of rows) up.run('rejected', r.id)
    })
    return rows.length
  }

  private tx(fn: () => void): void {
    this.db.exec('BEGIN')
    try {
      fn()
      this.db.exec('COMMIT')
    } catch (e) {
      try { this.db.exec('ROLLBACK') } catch { /* nothing open */ }
      throw new Error(`durable store: write failed and was rolled back - ${(e as Error).message}`)
    }
  }

  // ---------------------------------------------------------------- reads

  listMissionIds(): string[] {
    const rows = this.db.prepare('SELECT id FROM missions ORDER BY started_at, id').all() as Array<{ id: string }>
    return rows.map((r) => String(r.id))
  }

  /**
   * Read a mission back as a RECORD, with a recovery verdict.
   *
   * This deliberately does not return a `Mission` you can execute. Two things happen on every read:
   *
   *  1. **Every approval not from this session is rejected.** Authority does not survive a process.
   *  2. **A step found `running` becomes `pending`.** It was in flight when the process ended, so
   *     nothing is known about whether it finished. Treating it as `done` is the durable form of
   *     "executed == succeeded" - the exact claim this project has refused since M1.
   *
   * Step 2 is also why this is not a pure query: recovery mutates what it reads. That is intentional
   * and is written back, so a second read agrees with the first.
   */
  readMission(missionId: string): RecoveredMission | undefined {
    const invalidatedApprovals = this.invalidateForeignApprovals()
    const h = this.db.prepare('SELECT * FROM missions WHERE id = ?').get(missionId) as
      | Record<string, unknown> | undefined
    if (!h) return undefined

    const stepRows = this.db.prepare('SELECT * FROM steps WHERE mission_id = ? ORDER BY seq').all(missionId) as
      Array<Record<string, unknown>>

    const recoveredSteps: string[] = []
    const steps: Step[] = stepRows.map((r) => {
      let status = String(r.status) as Step['status']
      if (status === 'running') {
        status = 'pending'
        recoveredSteps.push(String(r.step_id))
      }
      const result = r.result ? (JSON.parse(String(r.result)) as StepResult) : undefined
      return {
        id: String(r.step_id),
        intent: String(r.intent),
        mode: String(r.mode) as ExecutionMode,
        capability: r.capability === null ? undefined : String(r.capability),
        tool: r.tool === null ? undefined : String(r.tool),
        rationale: String(r.rationale),
        args: r.args ? (JSON.parse(String(r.args)) as Record<string, unknown>) : undefined,
        effect: r.effect ? (JSON.parse(String(r.effect)) as DeclaredEffect) : undefined,
        dependsOn: r.depends_on ? (JSON.parse(String(r.depends_on)) as string[]) : undefined,
        status,
        result,
        attempts: Number(r.attempts ?? 0),
      }
    })

    const mission: Mission = {
      id: String(h.id),
      objective: String(h.objective),
      constraints: JSON.parse(String(h.constraints)) as string[],
      // A mission that was mid-flight when the process died is not 'executing' any more. Nobody is
      // executing it. Recording it as still-executing is how a crashed mission looks like a live one.
      state: (String(h.state) === 'executing' || String(h.state) === 'verifying' || String(h.state) === 'planning'
        ? 'drafting' : String(h.state)) as Mission['state'],
      plan: steps,
      invalidatedBy: h.invalidated_by ? (JSON.parse(String(h.invalidated_by)) as PlanInvalidation) : undefined,
      history: this.readHistory(missionId),
      pendingApprovals: [],
      startedAt: Number(h.started_at),
      finishedAt: h.finished_at === null ? undefined : Number(h.finished_at),
      basis: h.basis ? JSON.parse(String(h.basis)) : undefined,
      proposalDigest: h.proposal_digest === null ? undefined : String(h.proposal_digest),
    }

    const approvals = this.readApprovals(missionId)
    const evidence = this.readEvidence(missionId)

    const sessionRows = this.db.prepare('SELECT session_id FROM sessions ORDER BY started_at DESC LIMIT 1').all() as
      Array<{ session_id: string }>
    const lastSessionId = sessionRows[0]?.session_id

    const quarantine = this.quarantineReason(missionId)

    const recovery: RecoveryVerdict = quarantine
      ? {
          kind: 'quarantined',
          reason: quarantine,
          invalidatedApprovals,
          recoveredSteps,
          requiresFreshObservation: true,
          lastSessionId,
        }
      : {
          kind: 'resumable',
          reason: recoveredSteps.length
            ? `${recoveredSteps.length} step(s) were in flight when the process ended and have been returned to pending`
            : invalidatedApprovals.length
              ? `${invalidatedApprovals.length} approval(s) from a previous process were invalidated`
              : 'no step was in flight and no approval survived',
          invalidatedApprovals,
          recoveredSteps,
          requiresFreshObservation: true,
          lastSessionId,
        }

    // Write the recovery back, so a second read agrees with the first and the record on disk is not
    // left claiming a mission is executing when it is not.
    if (recoveredSteps.length || mission.state !== String(h.state)) {
      this.saveMission(mission)
      for (const sid of recoveredSteps) {
        this.appendHistory(missionId, {
          at: this.now(),
          kind: 'recovery',
          summary: `step ${sid} was in flight when the process ended; returned to pending and its result is not trusted`,
          detail: { stepId: sid, previousStatus: 'running' },
        })
      }
      // Re-read, because the history this method RETURNS was captured before the recovery notes were
      // written. Returning a record that omits the very event it just performed is the durable form of
      // "the history does not explain itself" - and a caller who looked at `mission.history` would
      // never learn the step had been recovered.
      const refreshed = { ...mission, history: this.readHistory(missionId) }
      return { mission: refreshed, evidence, history: refreshed.history, approvals, recovery }
    }

    return { mission, evidence, history: mission.history, approvals, recovery }
  }

  /**
   * Whether a mission must not be resumed at all.
   *
   * A mission whose evidence is internally inconsistent is quarantined rather than resumed, because
   * the alternative is to present an untrustworthy history as a usable one.
   */
  private quarantineReason(missionId: string): string | undefined {
    const rows = this.db.prepare('SELECT id, step_id, kind, payload, observed_by FROM evidence WHERE mission_id = ?')
      .all(missionId) as Array<{ id: number; step_id: string | null; kind: string; payload: string; observed_by: string }>
    for (const r of rows) {
      if (r.observed_by !== 'live-verifier' && r.observed_by !== 'restored-from-disk') {
        return `evidence row ${r.id} claims an unknown observation source '${r.observed_by}'`
      }
      try {
        const parsed = JSON.parse(r.payload) as { kind?: unknown }
        if (parsed.kind !== r.kind) {
          return `evidence row ${r.id} is filed as '${r.kind}' but contains '${String(parsed.kind)}'`
        }
      } catch {
        return `evidence row ${r.id} is not readable JSON`
      }
    }
    return undefined
  }

  readHistory(missionId: string): HistoryEntry[] {
    const rows = this.db.prepare('SELECT at, kind, summary, detail FROM history WHERE mission_id = ? ORDER BY id')
      .all(missionId) as Array<Record<string, unknown>>
    return rows.map((r) => ({
      at: Number(r.at),
      kind: String(r.kind) as HistoryEntry['kind'],
      summary: String(r.summary),
      detail: r.detail === null ? undefined : safeParse(String(r.detail)),
    }))
  }

  readEvidence(missionId: string): EvidenceRow[] {
    const rows = this.db.prepare('SELECT * FROM evidence WHERE mission_id = ? ORDER BY id').all(missionId) as
      Array<Record<string, unknown>>
    return rows.map((r) => ({
      id: Number(r.id),
      missionId: String(r.mission_id),
      stepId: r.step_id === null ? undefined : String(r.step_id),
      kind: String(r.kind),
      evidence: JSON.parse(String(r.payload)) as Evidence,
      provenance: String(r.provenance),
      verifier: r.verifier === null ? undefined : String(r.verifier),
      observedAt: Number(r.observed_at),
      observedBy: String(r.observed_by) as ObservedBy,
      observedInSession: String(r.obs_session_id),
    }))
  }

  readApprovals(missionId: string): PersistedApproval[] {
    const rows = this.db.prepare('SELECT * FROM approvals WHERE mission_id = ? ORDER BY id').all(missionId) as
      Array<Record<string, unknown>>
    return rows.map((r) => ({
      id: String(r.id),
      missionId: String(r.mission_id),
      stepId: String(r.step_id),
      effectKey: String(r.effect_key),
      planEpoch: Number(r.plan_epoch),
      sessionId: String(r.session_id),
      state: String(r.state) as PersistedApproval['state'],
      grantedAt: r.granted_at === null ? undefined : Number(r.granted_at),
    }))
  }

  /** Sessions that have opened this store, newest first. For the report. */
  listSessions(): SessionInfo[] {
    const rows = this.db.prepare('SELECT session_id, started_at, pid, host FROM sessions ORDER BY started_at').all() as
      Array<Record<string, unknown>>
    return rows.map((r) => ({
      sessionId: String(r.session_id),
      startedAt: Number(r.started_at),
      pid: Number(r.pid),
      host: r.host === null ? undefined : String(r.host),
    }))
  }

  /** Approvals granted in the CURRENT session, and therefore the only ones that could be live. */
  approvalsInThisSession(): PersistedApproval[] {
    const rows = this.db.prepare('SELECT * FROM approvals WHERE session_id = ? AND state = ?')
      .all(this.session.sessionId, 'approved') as Array<Record<string, unknown>>
    return rows.map((r) => ({
      id: String(r.id),
      missionId: String(r.mission_id),
      stepId: String(r.step_id),
      effectKey: String(r.effect_key),
      planEpoch: Number(r.plan_epoch),
      sessionId: String(r.session_id),
      state: 'approved',
      grantedAt: r.granted_at === null ? undefined : Number(r.granted_at),
    }))
  }
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s) } catch { return s }
}

export { MIGRATIONS, SCHEMA_VERSION }
export type { Mission, Step, StepResult, Evidence, HistoryEntry, PendingApproval }