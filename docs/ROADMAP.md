# Zeus V1.0 — Capability Roadmap to the Full Vision

**Status:** plan for approval. Nothing here is built yet.
**Date:** 2026-10-19 · **Repo:** `aios` @ `616b541` → `03995f6` (mirrored to GitHub)
**Hardware (measured 2026-10-19, not assumed):** i3-1115G4, 2 cores / 4 threads, **7.8 GB RAM**, Intel UHD (no dedicated GPU), 86 GB free disk, Windows 11 Home.
**Budget:** $0. No paid APIs, no subscriptions, no billable infrastructure.

---

## 0. The constraint, measured and corrected

**This machine has 7.8 GB RAM. Measured breakdown:**

| Process family | Memory |
|---|---|
| Edge (browser) | 1,527 MB |
| OpenCode desktop (CLI service + app) | ~860 MB |
| ChatGPT desktop | 348 MB |
| Windows services + Defender + VPN | ~1,200 MB |
| **Zeus (harness + server + host)** | **56 MB** |

**Correction to an earlier finding.** I initially reported a 420 MB "leaked" `opencode-cli` process and treated it as P0. On inspection that is wrong on both counts:

- It is `opencode-cli **serve --service**` — the OpenCode **desktop app's** background backend, not a Zeus process. Zeus's planner spawns `run`, never `serve` (`opencode-planner.ts:208`).
- **Zeus's total footprint is 56 MB.** It is not the memory problem.

Killing it would break your OpenCode desktop app for no benefit. **I did not kill it**, and the roadmap no longer calls for it.

**What is true and still binding:** with 7.8 GB shared between a browser, a desktop IDE-agent, and Windows, the machine runs at roughly 1 GB free. That is enough for Zeus today but leaves little margin, and it is why long planning calls are slow (15–180 s measured). Two consequences for the plan:

- **Zeus must stay small.** A capability that costs hundreds of MB (a headless browser, a local model) is a different architecture, not a new tool.
- **Memory discipline belongs in the test plan** (P1.6), not in a kill-the-process action.

---

## 1. Current state, honestly labelled

Four different labels, because conflating them is what produced every false success so far.

### DEMONSTRATED — proven by a live run with observable evidence

| Capability | Evidence |
|---|---|
| Visible GUI mission (Chrome, OCR, write, read-back) | mission `ed2e2073`, 5/5 steps verified, 31.4 s |
| NAKIVO recursive inventory + independent verification | `nakivo-inventory-2026-10-19-R3.csv`, 413 rows, byte totals match exactly |
| Artifact protection against a failed mission | proof script: 3 scenarios, protected file byte-identical |
| Planner reaches execution | `job-mveo99eg` `createdAt === completedAt`, exit 0 |
| Host identity rebinding | 6 tests, live restart scenario |
| Launcher stale-server recovery | live test: stale PID detected, ended, rebound |

### IMPLEMENTED, NOT DEMONSTRATED

- 11 registered capabilities (`web-research`, `write-file`, `spreadsheet`, `list-windows`, `survey-window`, `ocr`, `launch-app`, `read-file`, `terminal`, `desktop-input`, `screen-diff`)
- SQLite persistence layer (`packages/persistence`) — **not wired into the agent loop** (no `MissionRecorder` passed, so all write-ahead guarantees are inert)
- Recovery engine (`recovery.ts`) — policy only, never imported by the executor
- Approval flow (`run-approval.ts`)
- Model pool rotation across ~11 free models

### PARTIAL / BLOCKED

- **`terminal` escapes the artifact contract.** A live mission wrote 407 rows to a new file via the shell while every check believed the plan was refused. Highest-severity correctness gap.
- **The model fabricates counts.** Claimed "296 files" when 407 were written. The false-success guard now catches the *narration*, not the number.
- **OCR fidelity is bounded.** Pixel reading gave "documentation examples" for "illustrative examples".
- **`Documents` is unwritable by Zeus's own tools** — a deliberate permission-scope decision, not a bug.
- **Typecheck gate red**: 1 pre-existing error (`run-browser-gui-workflow.ts` TS1005, orphaned file). Makes 4 tests fail repo-wide.

### MISSING (measured against your stated goals)

Multi-window GUI orchestration · scroll/hover/menu navigation · clipboard transfer · file-picker and dialog handling · pagination/scrape-with-coverage · spreadsheet *editing* of existing files · PDF/Office read+write · email · scheduling · persistent memory across restarts · concurrent missions · model self-improvement · business-lifecycle capability (research→product→GTM→sales→finance→ops).

---

## 2. Priority order

Sequenced by **unblocks-other-work**, not by excitement.

### P0 — Close the holes that let it lie or destroy (≈1 day)

Ordered by **risk of real harm**, not by size. Each one is a defect that has already caused damage.

| # | Item | Why | Est | Acceptance |
|---|---|---|---|---|
| 0.1 | **`terminal` under the artifact contract** | Real data loss: a shell-written file bypassed every write guard. Highest-severity correctness gap. | 6 h | A mission cannot create/overwrite a file via the shell outside its declared artifacts (SHA-256 before/after, real tool) |
| 0.2 | **Stop the count fabrication** | The model claimed "296 files" when 407 were written. A lie in the report is worse than a failure. | 4 h | Every number in the final message traces to a cited evidence id, or is absent |
| 0.3 | **Fix the typecheck gate** | The gate is red, which makes 4 repo tests fail and hides future regressions | 1 h | `node typecheck-gate.mjs` exits 0; the 4 tests pass |
| 0.4 | **Clean up the orphaned file** | `run-browser-gui-workflow.ts` is unreferenced and blocks item 0.3 | 30 m | Either wired in or removed, with the reason recorded |

**Note on 0.1:** full shell interception, not a post-run audit. Rationale: an audit tells you *after* the damage that a file changed; interception prevents it. The shell is the only write route that bypasses every artifact rule, and it is demonstrably reachable by a model's plan. The cost is that `terminal` becomes "declared artifacts + read-only commands" — which is the correct boundary and is enforced, not assumed.

### P1 — Make a mission trustworthy (≈1 week)

| # | Item | Est | Acceptance |
|---|---|---|---|
| 1.1 | **Wire `MissionRecorder` into the agent loop** | 1 d | Every attempt persisted before execution; crash resumes with known state |
| 1.2 | **Numeric claims must cite evidence** | 2 d | No number in output without a `source: stepId` reference |
| 1.3 | **Self-verification before reporting** | 3 d | Mission re-reads its own artifact and compares hash before `ok: true` |
| 1.4 | **Concurrent-mission isolation** | 2 d | Two missions cannot touch each other's artifacts (proven by test) |
| 1.5 | **Idempotent retries** | 2 d | Re-running a completed mission is a no-op, not a duplicate |
| 1.6 | **Memory-discipline test** | 1 d | 10 consecutive missions leave no orphan process; Zeus RSS returns to baseline (the leak in `opencode-planner.ts:222` is real, just not the one I first blamed) |

**Standing test rule for every block that follows:** a capability is not "added" when it compiles. It is added when (a) it has a test that fails without it, (b) it has been run live with recorded evidence, and (c) it has a *negative* test proving the failure mode cannot recur. Every item below carries an acceptance line of that shape.

### P2 — A complete GUI operator (≈2 weeks)

The largest capability gap. Right now Zeus can open an app and type at it; it cannot *use* software.

| # | Item | Est | Notes |
|---|---|---|---|
| 2.1 | Scroll, hover, drag, menu traversal | 3 d | Primitives missing from `desktop-input` |
| 2.2 | Window lifecycle: resize, move, minimise, tile | 2 d | |
| 2.3 | **Clipboard transfer between apps** | 2 d | Unlocks the cross-app workflows you asked for |
| 2.4 | File pickers, save-as dialogs, message boxes | 3 d | |
| 2.5 | Multi-monitor + DPI awareness | 1 d | |
| 2.6 | Unexpected-dialog / focus-loss detection | 2 d | You named this explicitly |
| 2.7 | User-takeover + emergency-stop honouring | 1 d | Partially present; verify under load |

### P3 — Real research (≈1.5 weeks)

| # | Item | Est | Notes |
|---|---|---|---|
| 3.1 | Pagination + infinite scroll + lazy load | 3 d | |
| 3.2 | JS-rendered pages (no silent headless substitution) | 4 d | Must stay visible when you asked to see it |
| 3.3 | **Coverage accounting** — discovered / visited / extracted / failed / skipped | 3 d | "Full research" must be measurable |
| 3.4 | Source URL traceability per fact | 2 d | |
| 3.5 | Contradiction detection across sources | 3 d | You asked for facts vs inference |
| 3.6 | Tables, PDFs, structured extraction | 4 d | |
| 3.7 | Coverage gate: stop when criteria met, blocked, or limit hit | 2 d | |

### P4 — Cross-application work (≈1.5 weeks)

| # | Item | Est |
|---|---|---|
| 4.1 | Read/write **existing** spreadsheets (not just create) | 3 d |
| 4.2 | Office document (docx/xlsx/pptx) read + write | 5 d |
| 4.3 | PDF read + generate | 3 d |
| 4.4 | Browser → app data transfer with verification | 3 d |
| 4.5 | Email drafting (draft only; sending needs approval) | 3 d |

### P5 — A machine that remembers and recovers (≈1 week)

| # | Item | Est |
|---|---|---|
| 5.1 | Session resume across restart | 3 d |
| 5.2 | Mission checkpoints + rollback | 3 d |
| 5.3 | Scheduled/recurring missions | 2 d |
| 5.4 | Learned-failure memory ("this approach failed here") | 3 d |

### P6 — Development agent (≈1 week)

| # | Item | Est |
|---|---|---|
| 6.1 | Repo inspection, bounded fix, test, diff, evidence | 4 d |
| 6.2 | Safe controlled-failure injection to prove recovery | 2 d |
| 6.3 | Rollback path for every self-change | 2 d |

### P7 — Business lifecycle (≈6–10 weeks, staged)

Your Section 16 vision. Honest sizing: this is months, not days, and depends on P1–P6 being solid.

| Stage | Scope | Est |
|---|---|---|
| 7.1 | Market/competitor research → structured report | 1 wk |
| 7.2 | Product requirements, architecture, roadmap drafting | 1 wk |
| 7.3 | Codebase/product build via coding agents | 2 wks |
| 7.4 | Website, docs, pricing, launch assets | 1 wk |
| 7.5 | GTM: SEO, content, social, email drafts | 2 wks |
| 7.6 | Prospects, CRM, outreach drafts, pipeline | 2 wks |
| 7.7 | Pricing, budgets, forecasts, unit economics | 1 wk |
| 7.8 | Monitoring → recommend → **propose** changes | 2 wks |

Every external action stays draft-until-approved. Nothing publishes, sends, buys, or commits legally without you.

---

## 3. What it needs — tools, integrations, decisions

### Already present, no cost
Node 24 · Python 3.14 · Git · VS Code · the 11 capabilities · Operator Host (C#) · SQLite · Windows UIA + OCR.

### Needed (all free/open-source)

| Need | Tool | Licence | Why |
|---|---|---|---|
| Existing-file spreadsheet editing | SheetJS (`xlsx`) | Apache-2.0 | Read *and* write xlsx |
| docx/pptx | `python-docx`, `python-pptx` | MIT | Office formats |
| PDF | `pypdf`, `reportlab` | BSD | Read + generate |
| Web scraping | Playwright | Apache-2.0 | Pagination, lazy-load, JS |
| HTML parsing | `cheerio` | MIT | Structured extraction |
| Dataframes | `pandas` | BSD | Analysis, CSV correctness |
| Scheduling | `node-cron` | ISC | Recurring missions |
| Secrets | OS keychain (DPAPI) | OS | Never a token in a repo |

### Explicitly NOT doing
No paid API. No cloud LLM. No Docker (absent, and 0.3 GB free forbids it). No local model training on this hardware — an i3 with 8 GB and no GPU cannot train a useful model; local *inference* of a small model is possible but slow and will compete with Zeus for the same RAM.

### On your model question
**Do not train or fine-tune.** Every failure this session was a software defect: a cached handle, a stale readiness check, a destination substitution, an unguarded exit, a lying verifier. None is a model-capability problem. The model plans competently — it produced the correct 8-step NAKIVO plan. It fails at *reporting*, which is engineering. Spend the effort on verification and artifact integrity; that's where the value is.

Local inference remains a legitimate *future* option if remote free models prove unreliable, but it is not a current priority and would worsen the memory problem.

---

## 4. Roadmap shape

**Single continuous workstream, one P-block per session, checkpoint after each.** Not a parallel portfolio: with ~1 GB free and a browser plus a desktop agent already resident, two efforts at once guarantees flaky results and more debugging of the wrong thing.

**Cadence per block:**
1. Implement the smallest correct version.
2. Add the failing-first test **and** the negative test.
3. Run it live, capture evidence.
4. Report what was measured — not what was intended.
5. Commit only when the block is green.

## 5. Decisions — answered

| # | Question | Answer | Consequence |
|---|---|---|---|
| 1 | Kill the 420 MB process? | **No — and it was the wrong question.** It is the OpenCode desktop app's service, not a Zeus leak; Zeus is 56 MB total. | Left running. Roadmap corrected; no kill performed. |
| 2 | Is the GitHub repo private? | **Yes.** | No action. Backup is valid and secret scan was clean. |
| 3 | Shell interception scope? | **Full interception** (as recommended). | `terminal` becomes declared-artifacts-plus-read-only. P0.1. |
| 4 | Ordering? | **Best order to guarantee each capability is actually added and tested.** | Order below is chosen for *verifiability*, not ambition. |

### Why this order maximises verified capability

The sequence is deliberately **not** "business features first". Two reasons, both measured:

1. **Every unverified primitive makes downstream work unverifiable.** P3 (research) and P7 (business) both end in "produce a verified artifact". If a count can be fabricated (P0.2) and a shell write can escape the contract (P0.1), then a research deliverable is unfalsifiable — and an unverifiable deliverable is worse than none, because it looks like progress.
2. **GUI is the bottleneck for everything visible.** P2 unlocks cross-app, browser missions, and the interactive half of business work. Skipping it makes every later item land as headless-only, which is the substitution defect this system has already produced twice.

So: **close the honesty holes (P0) → make missions trustworthy (P1) → complete the GUI (P2) → then breadth (P3–P6) → business lifecycle (P7)**, where each stage inherits verified guarantees from the last.

**Business lifecycle is last on purpose.** It is ~6–10 weeks of work that consumes research, GUI, cross-app and persistence. Starting it earlier means building it on foundations that lie. That ordering is the recommendation, and it is reversible at any checkpoint.

## 6. What I have NOT done

- Not built any roadmap item.
- Not killed any process — PID 16820 is alive and is the OpenCode desktop service.
- Not touched `Documents` permissions or the filesystem allowlist.
- Not created any spend or external resource.
- Not pushed beyond the commits already approved.

---

## Appendix — measured results this session

- mission-engine: **1060/1060** pass (from 1027 before this work)
- all packages: **1277/1281** — the 4 failures confirmed pre-existing by stashing the work and re-running
- typecheck: **1 error**, the orphaned `run-browser-gui-workflow.ts`
- NAKIVO: **413 files**, 941,398,388 bytes, byte-total match, 5/5 spot-checks, sha256 `cf47c84a…`
- Protected through a failed mission: **byte-identical**
- Zeus RSS: **56 MB**; machine has ~1 GB free shared with a browser and the OpenCode desktop app
- Registered capabilities: **11** · live harnesses: **34** · test files: **83**