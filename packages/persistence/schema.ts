/**
 * DURABLE STATE: schema and migrations.
 *
 * =============================================================================
 * WHAT THIS IS
 * =============================================================================
 *
 * A versioned, append-only-ish record of what happened. Built on `node:sqlite`, which is part of
 * Node itself - so this adds ZERO npm dependencies, and the repository keeps the property it has had
 * since M9: nothing is fetched, nothing is bundled, nothing needs a registry.
 *
 * SQLite was chosen over a JSON file for one reason that matters more than speed: a JSON file written
 * on every step is a JSON file that can be half-written when the process dies, and a mission that
 * resumes from a half-written file resumes from a fiction. SQLite gives real transactions and a real
 * journal, so the failure mode is "the last transaction did not commit" rather than "the file is
 * truncated somewhere in the middle".
 *
 * =============================================================================
 * THE RULE THIS SCHEMA EXISTS TO KEEP
 * =============================================================================
 *
 *      A PERSISTED ROW IS A RECORD. IT IS NEVER AN AUTHORISATION.
 *
 * Every table here can be read back, and nothing here can be *acted on* directly. Authority lives in
 * the governance layer, in the live process, and it is re-derived on every restart. Concretely, and
 * enforced by tests rather than by comment:
 *
 *   * approvals are SESSION-SCOPED. A restart invalidates every one of them, unconditionally.
 *   * a step found `running` at crash time comes back `pending`. Never `done`, never `verified`.
 *   * `basis` is persisted so staleness can be CHECKED, and reading it always requires a fresh
 *     observation before the plan may act again.
 *   * evidence is persisted with `observed_by`, so a record from disk is never mistaken for something
 *     somebody just looked at.
 *
 * The failure this design exists to prevent is a database that, on restart, hands back a mission that
 * looks finished or looks authorised. That would be the durable version of "executed == succeeded",
 * which is the specific lie this project has refused since M1.
 */

/** Bumped whenever `MIGRATIONS` gains an entry. Never edit an applied migration. */
export const SCHEMA_VERSION = 1

export interface Migration {
  readonly version: number
  readonly name: string
  readonly sql: string
}

/**
 * Forward-only migrations.
 *
 * Each entry is applied inside one transaction together with the `schema_version` row that records it,
 * so a migration either lands completely or not at all. A half-applied schema is worse than none: it
 * looks like a database.
 */
/**
 * A guard that exists because it has been needed twice in this one file.
 *
 * The SQL below lives in a TypeScript template literal, so a BACKTICK inside any of its `--` comments
 * silently terminates the string and the remaining SQL is parsed as TypeScript. The error then points
 * at an unrelated line, in a different file, with a message like "Expected ',', got 'ident'".
 *
 * It is asserted in the test suite rather than left to discipline, because "be careful with quoting" is
 * not a property and a check is.
 */
export function assertNoBackticksInSql(): string[] {
  return MIGRATIONS.flatMap((m) =>
    m.sql.split('\n').map((l, i) => [l, i] as const)
      .filter(([l]) => l.trimStart().startsWith('--') && l.includes('`'))
      .map(([, i]) => `migration ${m.version} line ${i + 1}: a backtick inside an SQL comment terminates the template literal`),
  )
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial',
    sql: `
-- ------------------------------------------------------------------ schema bookkeeping
-- schema_version is NOT created here. applyMigrations bootstraps it with CREATE TABLE IF NOT EXISTS
-- before running anything, because it has to know whether the file is a database at all before it can
-- trust it. Migration 1 declaring it as well made every migration fail with "table schema_version
-- already exists" - which is the same class of error as the KV-cache naming bug in M9: two components
-- each assuming they owned the same name.

-- ------------------------------------------------------------------ missions
--
-- The mission HEADER. Steps, history, evidence and approvals live in their own tables so that a
-- single step can be updated without rewriting the objective, and so evidence survives independently
-- of whether the mission itself is still loaded in memory.
--
-- Note what is NOT here: any column meaning "approved", "authorised", "verified" or "succeeded".
-- There is deliberately nowhere to write one. Completion is a DERIVED property computed from steps
-- and their evidence (see isComplete), and it is re-derived on every read rather than cached, because
-- a cached completion flag is a claim rather than a fact.
CREATE TABLE missions (
  id              TEXT    PRIMARY KEY,
  objective       TEXT    NOT NULL,
  constraints     TEXT    NOT NULL,               -- JSON array
  state           TEXT    NOT NULL,               -- MissionState
  proposal_digest TEXT,                           -- the digest the compiler stamped
  basis           TEXT,                           -- JSON PlanBasis; persisted so staleness can be CHECKED
  invalidated_by  TEXT,                           -- JSON PlanInvalidation
  started_at      INTEGER NOT NULL,
  finished_at     INTEGER,
  persisted_at    INTEGER NOT NULL
);

-- ------------------------------------------------------------------ steps
CREATE TABLE steps (
  mission_id TEXT    NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  step_id    TEXT    NOT NULL,
  seq        INTEGER NOT NULL,                    -- plan order; ids are stable, order is not implied by them
  intent     TEXT    NOT NULL,
  mode       TEXT    NOT NULL,
  capability TEXT,
  tool       TEXT,
  rationale  TEXT    NOT NULL,
  args       TEXT,                                -- JSON
  effect     TEXT,                                -- JSON DeclaredEffect - a DECLARATION, never a permission
  depends_on TEXT,                                -- JSON array
  status     TEXT    NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  result     TEXT,                                -- JSON StepResult, including its Evidence
  PRIMARY KEY (mission_id, step_id)
);
CREATE INDEX idx_steps_mission ON steps(mission_id, seq);

-- ------------------------------------------------------------------ evidence
--
-- Evidence is a FIRST-CLASS table, not a JSON blob inside a step, for one reason: provenance.
--
-- observed_by is the field that keeps the whole design honest. A verifier that looked at the world
-- thirty seconds ago and a row read back out of a file an hour later are not the same claim, and a
-- system that cannot tell them apart will eventually present a stale observation as a current one.
-- 'live-verifier' means somebody went and checked. 'restored-from-disk' means this is a record of
-- that, and it must be re-observed before it is relied upon again.
CREATE TABLE evidence (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  mission_id  TEXT    NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  step_id     TEXT,
  kind        TEXT    NOT NULL,
  payload     TEXT    NOT NULL,                   -- JSON, the Evidence value verbatim
  provenance  TEXT    NOT NULL,                   -- HOW it was obtained; never empty
  verifier    TEXT,                               -- the independent source, where one applies
  observed_at INTEGER NOT NULL,
  observed_by TEXT    NOT NULL CHECK (observed_by IN ('live-verifier', 'restored-from-disk')),
  -- WHICH SESSION observed it. Without this, observed_by describes only how a row was ORIGINALLY
  -- obtained, and a row written by a process that has since died still reads as a live observation -
  -- so a restarted mission believed it had just checked the machine. The permit filters on this
  -- column, not on observed_by alone. Found by a control asserting that nothing was observed in
  -- THIS process, which came back with one observation from a process that no longer existed.
obs_session_id TEXT NOT NULL
);
CREATE INDEX idx_evidence_mission ON evidence(mission_id, id);

-- ------------------------------------------------------------------ history
CREATE TABLE history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  mission_id TEXT    NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  at         INTEGER NOT NULL,
  kind       TEXT    NOT NULL,
  summary    TEXT    NOT NULL,
  detail     TEXT
);
CREATE INDEX idx_history_mission ON history(mission_id, id);

-- ------------------------------------------------------------------ approvals
--
-- SESSION SCOPED, and that is enforced by session_id, not by convention.
--
-- An approval means "a human, in this process, while the world was in this state, authorised this
-- specific action". A process restart ends that sentence. So every row carries the session that
-- created it, and recovery invalidates every row whose session is not the current one. The columns
-- below mirror governance/approval.ts rather than replacing it - this is a RECORD of the store, and
-- the live ApprovalStore remains the authority.
CREATE TABLE approvals (
  id          TEXT    PRIMARY KEY,
  mission_id  TEXT    NOT NULL,
  step_id     TEXT    NOT NULL,
  effect_key  TEXT    NOT NULL,                   -- from effectKey(); already contains the planEpoch
  plan_epoch  INTEGER NOT NULL,
  session_id  TEXT    NOT NULL,
  state       TEXT    NOT NULL,
  granted_at  INTEGER,
  payload     TEXT
);
CREATE INDEX idx_approvals_mission ON approvals(mission_id);
CREATE INDEX idx_approvals_session ON approvals(session_id);

-- ------------------------------------------------------------------ sessions
--
-- Every process that opens the store records a session. This is what makes "was this approval granted
-- in the current process?" answerable without guessing.
CREATE TABLE sessions (
  session_id  TEXT    PRIMARY KEY,
  started_at  INTEGER NOT NULL,
  pid         INTEGER NOT NULL,
  host        TEXT
);
`,
  },
]

/** A SQL single-quoted string literal. `'` is escaped by doubling it, per SQL. */
export function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * Apply every migration this database has not yet seen.
 *
 * `exec` runs DDL/DML; `readVersions` reads `schema_version`. They are separate because
 * `node:sqlite` does not return rows from the same handle used for DDL, and pretending otherwise
 * produced a first version of this function that kept applied versions in a module-level global -
 * which is exactly the kind of hidden state that makes a durability layer untrustworthy in a
 * process that opens two stores.
 *
 * Idempotent: against an up-to-date database it does nothing and returns 0.
 */
export function applyMigrations(
  exec: (sql: string) => void,
  readVersions: () => readonly number[],
  now: () => number,
): number {
  // On a fresh file `schema_version` does not exist yet. Creating it is how we find out whether the
  // path is usable as a database at all - and refusing here is better than a confusing error later.
  try {
    exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)')
  } catch (e) {
    throw new Error(
      `durable store: the path is not usable as a database (${(e as Error).message}). ` +
      'Refusing rather than starting a mission whose history could not be recorded.',
    )
  }

  const applied = new Set(readVersions())
  let count = 0
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue
    exec('BEGIN')
    try {
      exec(m.sql)
      // SINGLE quotes, deliberately. SQLite has a long-standing misfeature where a double-quoted
      // string that matches no column is reinterpreted as an identifier, and this build rejects it
      // outright rather than guessing - so `JSON.stringify(name)` produced
      //   no such column: "initial" - should this be a string literal in single-quotes?
      // which reads like a schema mistake and is a quoting one.
      exec(
        `INSERT INTO schema_version (version, name, applied_at) VALUES (${m.version}, ${sqlString(m.name)}, ${Math.trunc(now())})`,
      )
      exec('COMMIT')
      count++
    } catch (e) {
      try { exec('ROLLBACK') } catch { /* the transaction never opened */ }
      throw new Error(
        `durable store: migration ${m.version} (${m.name}) failed and was rolled back: ${(e as Error).message}`,
      )
    }
  }
  return count
}