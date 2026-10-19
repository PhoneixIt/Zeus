---

## PHASE 3 — ORCHESTRATOR CONVERGENCE: VALIDATION-COMPLETE

`packages/agent/`. Status: **validation-complete.** Recorded 2026-10-11.

This is the persistent implement → verify → review collaboration loop. It is **not** wired into
`package.json` scripts; it runs under the repository's own `test:unit` glob.

### Reproduction

```
node typecheck-gate.mjs
node --experimental-strip-types --no-warnings --test "packages/agent/test/convergence.test.ts"
node --experimental-strip-types --no-warnings --test "packages/agent/test/*.test.ts"
node --experimental-strip-types --no-warnings --test "packages/*/test/*.test.ts"
```

| Gate | Exit | Result |
|---|---|---|
| Type-check | 0 | 131 files, 0 type errors |
| Convergence | 0 | 18/18 (14 original + 4 regression) |
| Agent | 0 | 35/35 |
| Repository unit | 0 | 683/683 |

### What was actually broken

**1. The file did not compile.** A torn edit had left an orphaned `} else if (roundCount >=
task.maxReviewRounds) {` tail, a **second `reconcile()`**, and a **second `runCommand()`** outside the
class body. Recovery was by hash, not by line number: both `reconcile` bodies hashed to
`bcd8bc8ee679b95bb4215d303387a13cc32ae6b9f1a2010330c9c575658bc513` and both `runCommand` bodies to
`0d0b618dc1fc201e`, so all three were byte-identical duplicates and only those were removed.

**2. The evidence fingerprint could not tell a passing command from a failing one.**
`orchestrator.ts` gated the evidence block on `verifyOut` — whether the command *printed* anything —
rather than on whether a command was *defined*. `node -e "process.exit(0)"` and `node -e
"process.exit(3)"` both print nothing, so both collapsed to the same placeholder string and hashed to
**the same fingerprint** (`dc238e1ec973483351f4ba912c947f4e`). Two tasks whose verification had
genuinely diverged were indistinguishable to the review-reuse guard, which could therefore skip a
review across a real change. Fixed to gate on `task.verifyCommand`; the fingerprints now differ
(`0868a561…` vs `81ddabf0…`).

This is the **safety-relevant** finding of the phase: the reuse guard is the thing that avoids paying
twice for one opinion, and it was keyed on something that did not include the outcome.

**3. A fabricated result on a terminal task.** The guard that stops a `done`/`exhausted` task from
spending another cycle returned `Orchestrator.emptyState(…).implement`, which does not exist on
`OrchestratorState`. This never surfaced at runtime — `--experimental-strip-types` does **not**
typecheck — and was caught only by `typecheck-gate.mjs`. It would have recorded an implementation round
that never happened. Replaced with an explicit no-op carrying `ok: false` and a stated `failure`.

### The stale assertion

The resume test asserted `rounds[0].round === 2`. Measured behaviour: surviving rounds are
`round=0`, the resumed pair is `round=2`. `rounds[0]` is the first round *ever run*, before the crash.
Satisfying the assertion as written would require **rewriting the audit record of work already paid
for**. Corrected to index the first round *after* the resume, and **strengthened** with an added
assertion that `rounds[0].round === 0`. The implementation was not changed; it was already correct.

### Negative controls, shown to bite

Each regression test was run against a deliberately reverted fix and confirmed to fail; the source
was restored byte-identical after each.

| Reverted fix | Exit | pass/fail | Detected by |
|---|---|---|---|
| none (fixed) | 0 | 18/0 | — |
| `verifyOut` gate restored | 1 | 16/2 | original fingerprint test **+** `REGRESSION: a SILENT verify command` |
| terminal guard removed | 1 | 16/2 | `FRESH BUT UNRESOLVABLE` **+** `REGRESSION: a TERMINAL task runs no further cycle` |

The second row is worth stating plainly: the terminal guard is **load-bearing**. Removing it makes
`FRESH BUT UNRESOLVABLE` run **6** rounds instead of 3.

### Harness limitation — stated, because it changed the outcome

`node --experimental-strip-types` executes TypeScript **without typechecking**. Three type errors
(TS2339 on `emptyState().implement`, TS2459 and TS2305 on the unexported `Reviewer`/`ReviewVerdict`)
passed every runtime test and were caught only by `typecheck-gate.mjs`. **A green
`--experimental-strip-types` run is not evidence that the code typechecks.** Both gates must run.

### Remaining recovery-provenance risk

`packages/agent/orchestrator.ts` is **untracked in git** — `git show HEAD:packages/agent/orchestrator.ts`
returns 128, `git log -- packages/agent/orchestrator.ts` returns 128, `git stash list` is empty. The
duplicate removal is hash-proven, but there is **no authoritative pre-tear source** to diff against.
The repaired logic is evidenced by execution, not by provenance. Backups retained and not overwritten:

- `orchestrator_ts_backup_1791671954.ts` — `sha256 6120db1d…` (pre-edit)
- `orchestrator_ts_pre_repair_1791683044.ts` — `sha256 59e19abc…` (post-repair, pre-fix)

### Safety evidence preserved

Nothing pushed; no remote; no paid service; no remote inference; no network-dependent test. All
execution local. `packages/control-core` untouched. The 20 pre-existing modified tracked files and the
existing untracked set are unchanged — this phase's edits were confined to two untracked files under
`packages/agent/`, plus this ledger entry and the roadmap entry below.