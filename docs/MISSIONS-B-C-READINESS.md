# Missions B and C - readiness and live verification procedure

**Status:** implementation present; deterministic tests pass; **live demonstration pending** the
operator host and a desktop session.
**Last measured:** 2026-10-23 on the laptop (Windows 11 Home, i3-1115G4, 7.8 GB RAM).
**Budget:** $0. Nothing here starts a paid or billable resource.

This document separates four different things that are easy to blur together:

| Kind of evidence | What it means | Where it is |
|---|---|---|
| Unit / deterministic integration | code paths exercised with fakes; no desktop | `packages/*/test/*.test.ts` |
| Real local run, no desktop control | real browser process, real files, real verifier | commands below |
| Host-blocked | the prerequisite is missing; **no check was evaluated** | `=== HOST-BLOCKED ===` |
| Live demonstration | the full mission through the real path, on the real laptop, with recorded evidence | **pending** |

A host-blocked run is not a pass and not a product failure. It is the honest third answer.

---

## 0. Readiness check (read-only)

```powershell
npm run live:readiness
```

It never starts, stops, arms, or reconfigures the operator host, and never clicks or types. It
checks Node, platform, free memory/disk, the host state file and `/ping`/`/windows`/`/observe`,
the browser binary, and PowerShell. It exits `0` only when every required prerequisite is present.

Measured on 2026-10-23:

```
PASS  node, platform, memory (1.1 GB free of 7.8 GB), disk (101.5 GB free)
PASS  operator-host-state       ...\Temp\opencode\operator\host.json
FAIL  operator-host-ping        fetch failed: ECONNREFUSED 127.0.0.1:61142
FAIL  operator-host-windows
FAIL  operator-host-observe
PASS  browser                   ...\Microsoft\Edge\Application\msedge.exe
PASS  powershell
PENDING free-model-call, mission-b-live, mission-c-live
```

The state file exists but nothing answered on its port: **it is stale**. Start the host
deliberately with `npm run control:up`, then re-run the check.

---

## Mission B - research plus visible browser navigation

### What the objective requires

1. retrieve information from a real page;
2. navigate a **visible** browser (the person can watch it move);
3. preserve source evidence that can be re-checked independently;
4. produce a useful answer, not a success banner.

### What is implemented

| Piece | File | Notes |
|---|---|---|
| Research desk (visible window + engine) | `live/run-research-desk.ts`, `live/research-app.ts` | WinForms window; drives its own isolated Chromium; persists under `~/.aios/research`; verification re-reads from disk in a fresh process |
| Research engine | `live/research-engine.ts` | `--json` one record per run; scroll/click/back are read back from the page, not asserted |
| Governed navigation mission | `live/run-navigation-mission.ts` | real plan step navigates; approval is required and a no-approval control runs first |
| Browser-to-file mission | `live/run-browser-mission.ts` | page read → summary → artifact, every step independently verified |
| Untrusted content handling | `live/web-extract.ts`, `live/browser-tools.ts` (Stage E tests) | page text is data; instructions in it are reported, never followed |

All browser harnesses now accept **`AIOS_BROWSER_VISIBLE=1`**, which omits `--headless=new` and
shows the same isolated browser window. Default remains headless so tests never take over the
desktop. The visible mode does not change the plan, the policy, the approval, or the verifier.

### Procedure - visible research (no operator host required)

```powershell
$env:AIOS_BROWSER_VISIBLE = "1"
node --experimental-strip-types --no-warnings `
  packages/mission-engine/live/research-engine.ts --json https://example.com
Remove-Item Env:AIOS_BROWSER_VISIBLE
```

Expected: one JSON object with `stage:"complete"`, `verified:true`, an `artifactPath`, and an
`interaction` block whose `clickedHref`, `urlAfterClick`, `backTo`, and `scrolled` values came from
the page itself. The record is written under `~/.aios/research/runs/`.

For the interactive version:

```powershell
node --experimental-strip-types --no-warnings packages/mission-engine/live/run-research-desk.ts
```

Enter an `https://` URL in the window and press **Research**. The window shows the verdict; the
artifact and record survive the app.

### Procedure - governed navigation with approval

```powershell
$env:AIOS_BROWSER_VISIBLE = "1"
npm run mission:navigate
Remove-Item Env:AIOS_BROWSER_VISIBLE
```

This runs the mission **twice**: once with no approval (must stop at `needs-human`) and once with
an approval for the exact destination. A clean run ends with `EXIT=0`, every step `done` and
independently verified, and the persistence section passing after a store close/reopen.

### Measured 2026-10-23 (real local execution)

| Command | Result |
|---|---|
| `npm run mission:navigate` (headless, real example.com) | **exit 0**, 4/4 steps verified, 2 consecutive clean runs |
| `AIOS_BROWSER_VISIBLE=1 ... research-engine.ts --json https://example.com` | **exit 0**, `verified:true`, clicked a real link, went back, `scrolled:true` |
| `npm run mission:browser` | **host-blocked (exit 2)**: the step asks the operator host for input permission |
| `npm run mission:browser` before its host guard | failed later and left temp dirs; the guard made the prerequisite explicit and stopped that |

The navigation harness initially failed its independent character-count cross-check (156 vs a
later, complete body). The cause was a real read-timing defect: `readPage` returned before the
document finished rendering. `operator.mjs` now waits (bounded) for `readyState === complete` and
two agreeing reads. That fix is what made the two clean runs possible; it is not a relaxed check.

### What is still **pending live verification**

- the **full Mission B through the chat path** (a natural-language request → governed plan →
  visible navigation → research evidence → useful answer) while the operator host is running;
- a research target that yields actual **findings**, not only structural facts about a fixture;
- citations rendered in the AIOS UI.

Do not mark Mission B complete until those have a recorded, reproducible run.

---

## Mission C - a reversible laptop action

### What the objective requires

1. a real action on the machine;
2. explicit authorisation for that exact action;
3. independent verification of the outcome;
4. persisted evidence;
5. safe recovery, including rollback, with no blind replay.

### What is implemented

| Piece | File | Notes |
|---|---|---|
| Governed file operations | `live/run-fs-ops-mission.ts` | six steps; three need approval; real `node --check`; completion re-derived after close/reopen |
| Executor-driven recovery | `live/run-auto-recovery.ts` | one `execute()` call; the executor asks the policy, obtains authorisation, runs and verifies rollback, re-runs the step |
| Recovery harness with controls | `live/run-dev-recovery.ts` | denial, missing backup, lying tool, bounded attempts |
| Rollback policy and tool | `live/rollback-recovery.ts`, `live/rollback-tools.ts` | rollback is an ordinary governed step, not a private back door |
| Write-ahead ledger | `packages/persistence/` | intent → outcome → evidence → settled; unknown outcome is recorded as unknown |

### Procedure

Prerequisite: the operator host is answering (`npm run live:readiness` is READY or only PENDING
on the mission lines).

```powershell
npm run mission:fs-ops        # approval-gated file operations + restart verification
npm run mission:auto-recovery # executor-driven rollback after verification rejects a lying tool
npm run mission:recovery-dev  # explicit controls: refusal, missing backup, lying tool, bounded retry
```

What to record for each:

- exit code and the PASS/FAIL lines;
- the approval that was requested and granted (exact action and target);
- the persisted mission row and step history from `~/.aios/agent/aios.db`;
- the verifier's evidence for the action and for the rollback;
- the result of reopening the store (the recovery state must survive a restart).

### Measured 2026-10-23

| Command | Result |
|---|---|
| `npm run mission:fs-ops` | **host-blocked (exit 2)**, no check evaluated |
| `npm run mission:auto-recovery` | **host-blocked (exit 2)**, no check evaluated |
| `npm run mission:dev` | **host-blocked (exit 2)**, no check evaluated |
| `npm run mission:recovery-dev` | **host-blocked (exit 2)**, no check evaluated |
| `npm run mission:recovery-dev` before its guard | crashed trying to grant an approval that was never requested; the guard now reports the missing host instead |

Mission C is therefore **implementation-ready, live-pending**. It has not been performed on the
laptop.

---

## What the operator host actually blocks, and the shortest path

The host is the only process permitted to observe the desktop and inject input. Without it:

- `livePermission` cannot answer, so missions that use `liveControl` stop at preflight;
- the chat/authorization suites fail with `ECONNREFUSED 127.0.0.1:61142`.

Shortest path:

```powershell
npm run control:up           # start the operator host deliberately
npm run live:readiness       # confirm ping/windows/observe and no latched emergency stop
npm run control:proofs       # the safety gate; must exit 0 with nothing skipped
```

Then run the Mission B and C procedures above and attach the evidence. Do **not** arm autonomy,
clear an emergency stop, or weaken an approval to make a demonstration pass. A blocked run stays
blocked; that is the correct outcome.

---

## Safety boundaries that remain in force

- Every effectful step still needs its declaration and, where required, an approval for that exact
  action and target.
- A persisted row is a record, never an authorisation. Recovery is a **fresh** governed mission.
- A model's prose cannot grant permission or mark a step verified.
- Unknown outcomes are recorded as unknown; nothing is replayed blindly.
- Rollback is bounded, in-scope, separately approved, and separately verified.
- Allowlists and working-directory checks are not described as a complete sandbox.
