# AIOS vs AI Work OS — Comparative Architecture and Reuse Audit

**Date:** 2026-10-12
**Subject:** `https://github.com/joomtheme/ai-work-os` (Apache-2.0, 194 files)
**Compared against:** `C:\Users\Samer\Projects\AIOS` @ `2abc2f6` (branch `master`)
**Type:** Audit and recommendation. **No merge, migration, or rewrite was performed or is authorised.**

---

## A. Executive verdict

**AI Work OS is a documentation-and-scaffolding skeleton, not an implementation.** It is
approximately **3.5 hours of repository-creation activity that has never been touched since**.

Decisive, reproducible evidence — all measured directly against the GitHub API and
`raw.githubusercontent.com` on 2026-10-12:

| Measurement | AI Work OS | AIOS (ours) | Ratio |
|---|---|---|---|
| Total source bytes (`.ts`/`.tsx`) | **28,817** | **2,704,526** | 1 : 94 |
| Source files | 102 | 170 | — |
| Files larger than 1 KB | **0** | **169** | — |
| **Test files anywhere in the repo** | **0** | **47** | — |
| Dependencies declared | **0** | many (all local/`node:`) | — |
| Browser / desktop automation | **none found** | CDP client, UIA, WinForms app | — |
| Dependencies in root `package.json` | none | — | — |

Every single source file in AI Work OS is under 1 KB. Not one exceeds 700 bytes. This is not a
matter of degree; it is a categorical difference between a scaffold and a system.

**The `packages/mission-engine/src/index.ts` placeholder is not an outlier — it is representative.**
The entire repo is that file:

```ts
export async function executeMission(mission: Mission): Promise<MissionResult> {
  return { success: true, summary: `Mission initialized: ${mission.title}`,
           evidence: { stage: 'planning' } };
}
```

It returns `success: true` unconditionally, performs no work, and is 292 bytes. This is precisely
the failure mode this audit was instructed to watch for — *a function returning `success: true`*
listed as an anti-pattern that must not be equated with capability.

**CI validates nothing.** `.github/workflows/ci.yml` runs `npm install` then
`echo "AI Work OS CI ready"`. There is no build step and no test step.

**Repo metadata:** created `2026-09-18T07:00:27Z`, last push `2026-09-18T10:51:47Z` (same day,
~3.7 hours later), **1 star, 0 forks, 0 remotes of our own**, 3 open issues, not archived.

**Verdict on the three questions asked:**

1. **How similar are the two projects?** Similar only in *vocabulary and documented intent*. Both
   describe missions, agents, tools, trust and evidence. At the level of executable behaviour
   they have no overlap worth comparing.
2. **What is genuinely implemented vs aspirational?** In AI Work OS: **nothing beyond type
   declarations.** Every documented layer exists as a directory, an interface, or a `README.md`.
   In AIOS: the mission engine, persistence, governance, planner, control core and desktop app are
   implemented and (mostly) exercised.
3. **Does any component accelerate AIOS?** **No.** There is no component mature enough to reuse,
   and nothing that is not already present in AIOS in a far more complete form.

**Recommendation: REJECT for reuse. ADOPT DESIGN IDEAS ONLY. Learn from naming and layering, not
code.** Nothing here should be merged, and nothing here justifies slowing the delivery work.

---

## B. Architecture comparison (component-by-component)

Confidence key: **V** = verified by direct source inspection / command output in this audit;
**I** = interpretation. "AIWOS" = AI Work OS.

| # | Capability | AIWOS documented claim | AIWOS implementation evidence | AIWOS class | AIOS evidence | Gap / duplication | Reuse | Cost | Security | $0 | Next action | Confidence / open Q |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Mission lifecycle | "missions transformed into coordinated workflows" | `mission-runner.ts` (354 B) pushes 3 hardcoded events; `executeMission` returns `success:true` | **DOCUMENTED ONLY** | `executor.ts` 66 KB; 30 test files in mission-engine | AIOS supersedes entirely | **Reject** | n/a | Would import a false-success path | yes | None | **V** |
| 2 | Planning / DAG | "AI systems create execution plans" | `planner.ts` 321 B | **DOCUMENTED ONLY** | `planner/` 13 files, 167 KB, 3 test files | AIOS supersedes | **Reject** | n/a | n/a | yes | None | **V** |
| 3 | Agent orchestration | "AI teams", 5 agent roles in ASCII diagram | `apps/api/src/agents/execution-runner.ts` = **286 bytes** | **DOCUMENTED ONLY** | `agent/` 12 files, 141 KB, real OpenCode CLI round trip (session `ses_ecf88504…`) | AIOS supersedes | **Reject** | n/a | n/a | yes | None | **V** |
| 4 | Model selection / providers | "Intelligence Layer" | `providers/openai.ts` 429 B, `anthropic.ts` 325 B | **DOCUMENTED ONLY** (and **paid**) | `model/` 9 files, free-provider boundary, `space-bunny-free` in use | AIOS supersedes | **Reject** | n/a | Would add billable keys | **NO** | None | **V** |
| 5 | Tool discovery / routing | "Tool Layer (MCP)" | `mcp-registry.ts` 294 B, `registry.ts` 294 B | **DOCUMENTED ONLY** | `tool-router/router.ts` (12 KB) + live missions | AIOS supersedes | **Reject** | n/a | n/a | yes | None | **V** |
| 6 | Permission enforcement | "Trust Layer", human approval | `tool-registry/src/approval.ts` **187 bytes** | **DOCUMENTED ONLY** | `executor.ts:193` `permission(): Promise<Permission>`; host gate refuses at dispatch head; live guard verified | AIOS supersedes | **Reject** | n/a | **Replacing ours would be a downgrade** | yes | None | **V** |
| 7 | Browser automation | (not in vision docs) | **zero** files matching playwright/puppeteer/selenium/cdp/uia/screenshot | **MISSING** | `cdp.mjs` 340+ lines, `waitForLoad`/`scroll`/`clickAt`/`goBack` proven live | AIOS far ahead | **Reject** | n/a | n/a | yes | None | **V** |
| 8 | Desktop / UI Automation | (not in vision docs) | **zero** files | **MISSING** | `control-core/src/*.cs` (C#, 212 KB), low-level hooks, UIA, live guard | AIOS far ahead | **Reject** | n/a | n/a | yes | None | **V** |
| 9 | Research / extraction | (not in vision docs) | **zero** | **MISSING** | `web-research.ts`, `web-extract.ts`, verified live on iana.org + RFC 9110 | AIOS far ahead | **Reject** | n/a | n/a | yes | None | **V** |
| 10 | Independent verification | "evidence, history" | `executeMission` embeds `evidence:{stage:'planning'}` — a literal | **FAILED by inspection** | `executor.ts:1051` "no verifier is registered for this step… cannot be claimed complete"; verifier re-reads from disk | AIOS supersedes | **Reject** | n/a | **Adopting theirs would let an executor self-certify** | yes | None | **V** |
| 11 | Evidence provenance | "provide evidence" | literal object literal | **FAILED by inspection** | SHA-256 digest + fresh re-scan; tamper tests | AIOS supersedes | **Reject** | n/a | n/a | yes | None | **V** |
| 12 | Durable persistence | `database/prisma/schema.prisma`, `docker-compose.yml` | 2 models (Mission, Execution); `status String` free-text; **requires Postgres + Redis** | **PARTIAL / INOPERABLE** | `persistence/` 8 files 141 KB, SQLite, survives reopen, 3 test files incl. `durability-defects.test.ts` | AIOS supersedes; AIWOS needs infrastructure AIOS does not | **Reject** | Very high | Requires daemon services | yes | None | **V** |
| 13 | Recovery / resumability | "history" | **zero** occurrences of resume/recovery logic found | **MISSING** | `resumeMission`, obligations, `requiresFreshObservation`, regression-tested | AIOS supersedes | **Reject** | n/a | n/a | yes | None | **V** |
| 14 | Task queues / scheduling | `queue-engine/` + BullMQ/Redis adapters | `bullmq-adapter.ts` 182 B; **requires Redis** | **DOCUMENTED ONLY** | in-process executor + durable store; no daemon | AIOS simpler and sufficient | **Reject** | Medium | Adds an always-on service | yes | None | **V** |
| 15 | Memory / knowledge | `MEMORY_SYSTEM.md`, `memory-engine/` | 6 files, 258–617 B, `index.ts` 258 B | **DOCUMENTED ONLY** | durable history + evidence store | AIOS has working equivalent | **Reject** | n/a | n/a | yes | None | **V** — *AIOS memory/knowledge retrieval is itself thin; see §E* |
| 16 | OpenCode integration | (not claimed) | **zero** | **MISSING** | `agent/opencode-adapter.ts` — real CLI, real sessions | AIOS supersedes | **Reject** | n/a | n/a | yes | None | **V** |
| 17 | ChatGPT integration | (not claimed) | **zero** | **MISSING** | **UNVERIFIED** — no mechanism found; explicitly labelled UNVERIFIED in our code | Both absent | n/a | n/a | n/a | yes | Keep labelled UNVERIFIED | **V** |
| 18 | User-facing app | `apps/web/` — many `.tsx` and matching `.md` files | `MissionDashboard.tsx` **176 B**; `index.ts` files of **99 B** (empty) | **DOCUMENTED ONLY** | `run-research-desk.ts` + real WinForms window, **verified visible** (hwnd 7472532) | AIOS far ahead | **Reject** | n/a | n/a | yes | None | **V** |
| 19 | Logging / observability | "history" | ad-hoc event objects | **PARTIAL** | audit JSONL, `/hooks` diagnostics, append-only history | AIOS supersedes | **Reject** | n/a | n/a | yes | None | **V** |
| 20 | Prompt-injection defence | "Trust" | **none found** | **MISSING** | `web-extract.ts` scanner, 9 adversarial cases, findings recorded `actedOn:false` | AIOS supersedes | **Reject** | n/a | n/a | yes | None | **V** |
| 21 | Testing / CI | docs imply quality | **0 test files**; CI step is `echo "AI Work OS CI ready"` | **FAILED** | 47 test files; 811 tests; typecheck gate 156 files | AIOS supersedes | **Reject** | n/a | n/a | yes | None | **V** |
| 22 | Cross-platform | Node 20 target | Node-only stubs | **DOCUMENTED ONLY** | Node + C#/Win32, Windows-first | AIOS | **Reject** | n/a | n/a | yes | None | **V** |
| 23 | Self-improvement governance | none claimed | none | **MISSING** | none | Both absent | n/a | n/a | n/a | yes | Defer | **V** |

---

## C. Reuse shortlist

**Empty. There is no component worth reusing.** This is not a judgement call about taste; it
follows from the measurements: 0 test files, 0 files >1 KB, 0 dependencies, and a mission engine
whose entire implementation is `return { success: true }`.

The only defensible reuse is non-code:

| Idea | Source | Action | Rationale |
|---|---|---|---|
| Layer vocabulary (Mission / Orchestration / Intelligence / Execution / Trust) | `ARCHITECTURE.md` | **Adopt naming only, in docs** | Clean, memorable, and it is a *documentation* nicety, not a capability. Cost: minutes. |
| "Every important AI action should provide evidence, history, and human approval" | `VISION.md` | **Already implemented in AIOS — cite it** | AIOS enforces this with code (`executor.ts:1051`, host dispatch gate). The statement matches our behaviour, which is a point in favour of our design, not theirs. |
| Monorepo `workspaces: ["apps/*","packages/*"]` layout | `package.json` | **Consider for AIOS layout only** | Cheap and conventional. But this is a repo-organisation preference, not an audit finding, and it would churn a working tree. **Defer.** |

---

## D. Rejection list

| Candidate | Why rejected |
|---|---|
| `packages/mission-engine/*` | `executeMission` returns `success:true` unconditionally. Importing it would inject a false-success path into a system whose central property is that executors cannot self-certify. |
| `apps/api` / `services/backend-foundation` | Every file <1 KB; `index.ts` files are 99 bytes (empty). |
| `apps/web` UI | `.tsx` files of 133–471 B; each paired with a `.md` of the same name — the UI appears to be **markdown stand-ins**, not a running app. |
| `queue-engine` (BullMQ/Redis) | Requires an always-on Redis daemon. On a 4-thread / 7.8 GB machine this is a real cost for capability we already have in-process. |
| Prisma + Postgres stack | Requires a Postgres daemon. Our SQLite store already survives reopen and is regression-tested. |
| `providers/openai.ts`, `anthropic.ts` | **Violates the $0 constraint** — both are billable. |
| `docker-compose.yml` | Postgres + Redis on 7.8 GB RAM. Unnecessary. |
| Wholesale merge | No component is mature enough to justify integration risk against a working tree with 277 pending changes. |

**Licence note:** Apache-2.0 is clear and permissive, so there is **no legal obstacle** to reuse.
The rejection is entirely on maturity and evidence, not licensing.

---

## E. Gap analysis

**What AIOS already has (measured this session):**

- Mission execution with an **independent-verifier requirement** (`executor.ts:1051` refuses a step with no verifier).
- Durable SQLite persistence with write-ahead recorder and obligations-based recovery (`persistence/`, 141 KB, 3 test files).
- A governed desktop-control boundary with a live authorization guard, human-takeover, and emergency stop (`control-core/`).
- A real CDP browser client with **proven** scroll, link-click and back-navigation.
- A working OpenCode handoff with a **matching correlation ID** that is enforced, not assumed.
- A **visible WinForms desktop application**, independently confirmed on screen.

**What AIOS lacks or has not verified** (these are the real gaps — none are closed by AIWOS):

1. **ChatGPT integration — UNVERIFIED.** No mechanism found. Correctly labelled.
2. **The GUI mission — blocked.** Guard reads `takeoverPending=true`. Needs one human release click.
3. **Memory / knowledge retrieval — thin.** Our durable history is an audit log, not a retrieval system. *This is the one area where AIWOS's ambition is ahead of our implementation — but its code is a 258-byte `index.ts`, so there is still nothing to borrow.*
4. **Self-improvement governance — absent in both.** No change-proposal → independent review → approval → rollback pipeline.
5. **Cross-platform — unaddressed.** Windows-first throughout.
6. **Test flake observed.** `process-containment.test.ts:561` failed once under full-suite load, then passed 3/3 isolated and 2/2 in full-suite reruns. Timing-sensitive; I did not modify it.

**Duplication:** none worth acting on. The vocabularies overlap; the implementations do not.

---

## F. Recommended architecture (unchanged; validated)

The audit does **not** justify redesign. AIOS's existing boundaries are the right ones and are
the most mature part of the comparison:

```
ACQUISITION → EXTRACTION (untrusted, inert) → PERSISTENCE → VERIFY (fresh read) → RECOVER
     separately governed: PERMISSION GATE · AUTHORIZATION GUARD · EVIDENCE DIGEST
```

Keep: the permission gate separate from the executor; verification always via a fresh read path;
web content structurally unable to reach a tool or a permission.

---

## G. Prioritized next actions

The immediate priority remains **a working end-to-end application**, not architecture research.

| Priority | Action | Depends on | Effort | Acceptance | Risk | Rollback |
|---|---|---|---|---|---|---|
| **P0** | Human releases the guard (one click at 1463,112) | human | minutes | `takeoverPending=false`, `mayInject=true` | operator clicks into the wrong place | none needed |
| **P0** | Run `run-gui-mission.ts`; read text back via UIA; reopen store; test recovery | P0 gate | 1–2 h | action + read-back + persistence + recovery all verified | guard relatch | stop; app unaffected |
| **P1** | Second research target + `verify-research-state.ts` after restart | — | 30 min | 2 distinct correlation IDs, both verified post-restart | flaky test | n/a |
| **P1** | Promote `verify-research-state.ts` into the test suite | P1 | 30 min | suite covers durable-state integrity | EPERM on Windows handles | revert the test file |
| **P2** | Memory/retrieval design (the genuine gap) | — | 1–2 d | retrieval beats grep on a real question | scope creep | keep additive |
| **P3** | Self-improvement governance proposal format | P2 | 2–3 d | proposal → review → approve → rollback, all audited | **highest** — touches the governance model | design behind a flag, off by default |

**MVP ≠ product.** MVP is: one research mission + one GUI mission, both independently verified
after restart. The product is P2/P3 plus cross-platform.

---

## H. End-to-end validation missions

1. **Development mission** — *VERIFIED.* `node typecheck-gate.mjs` → exit 0, 156 files, 0 errors;
   `node --experimental-strip-types --no-warnings --test "packages/*/test/*.test.ts"` → exit 0,
   811/811. Working tree preserved throughout this audit (see §K).
2. **Browser/research mission** — *VERIFIED.* `research-engine.ts` → exit 0. Real navigation to
   iana.org and RFC 9110; **scroll 0→18**, **click hit a real link and the URL changed**,
   **back returned**. Artifacts verified from a **fresh process** after exit
   (`verify-research-state.ts` → exit 0, 4 artifacts).
3. **Cross-agent mission** — *VERIFIED (OpenCode only).* `desk-handoff.ts` → exit 0. Real session
   `ses_ecf88504cffeBWUQEtiuO6WBxx`; acceptance checked from the **filesystem**; a result with a
   **mismatched correlation ID was rejected**. **This does NOT prove ChatGPT integration.**
   ChatGPT handoff remains **UNVERIFIED**.

---

## I. Feasibility and cost

Machine re-measured this session: **4 logical CPUs, 7.8 GB RAM, 86.1 GB free of 237.2 GB,
Node v24.21.0**.

- **AIWOS as written cannot run here** — `build`/`test`/`dev` are `echo` placeholders; there is
  nothing to start.
- **AIWOS as intended could not run well here** — Postgres + Redis + a Node API + a web app on
  7.8 GB RAM. Not a $0-and-small-machine fit.
- **AIOS runs here today** — headless Chromium, SQLite, Node stdlib only. $0 confirmed: the only
  model used is `opencode/space-bunny-free`. **No paid service was introduced by this audit or
  any prior work.**
- Local model inference on 4 threads / 7.8 GB: small models only; concurrency must stay at 1–2
  workers. Free hosted endpoints must be treated as **unreliable and possibly withdrawn** — no
  paid fallback is authorised.

---

## J. Security findings

1. **CRITICAL (upstream): `executeMission` returns `success:true` unconditionally.** Any adoption
   would inject a self-certifying executor into a system whose core property is that executors
   *cannot* self-certify. **This is the single strongest reason to reject reuse.**
2. **HIGH (upstream): CI validates nothing** (`echo "AI Work OS CI ready"`), so nothing upstream
   would ever catch a regression.
3. **HIGH (upstream): no prompt-injection defence exists**, and no web-content handling at all.
4. **MEDIUM (upstream): `database/prisma/schema.prisma` uses `status String`** — free-text state,
   no enforced transitions.
5. **LOW (upstream): hard-coded credentials in `docker-compose.yml`** (`aiworkos/aiworkos`).
   Acceptable for a local dev stack, but it is a pattern to avoid copying.

**Our safeguards confirmed intact during this audit (read-only, nothing modified):**
guard `HUMAN_TAKEOVER`, `takeoverPending=true`, `mayInject=false` — unchanged and still
blocking. No credentials, cookies, tokens or user files were read. No external service received
AIOS data. The audit made **no** request to any host other than `raw.githubusercontent.com` and
`api.github.com`, both read-only public endpoints.

---

## K. Evidence and remaining uncertainty

**Commands run (read-only), with exit codes:**

| Command | Exit | Result |
|---|---|---|
| `git status/log/rev-parse` (AIOS) | 0 | baseline recorded |
| `node typecheck-gate.mjs` | 0 | 156 files, 0 errors |
| `fetch api.github.com/…/git/trees/main?recursive=1` | 200 | 194 files enumerated |
| `fetch raw.githubusercontent.com/…/package.json` | 200 | placeholder scripts confirmed |
| `fetch raw.githubusercontent.com/…/mission-engine/src/index.ts` | 200 | `success:true` confirmed |
| `fetch raw.githubusercontent.com/…/.github/workflows/ci.yml` | 200 | `echo` validate confirmed |
| `Get-CimInstance` (machine facts) | 0 | 4 CPU / 7.8 GB / 86.1 GB free |

**UNVERIFIED claims, explicitly:**

- Whether AIWOS's *aspirational* design, if fully built, would be good. Not assessed on
  implementation evidence, because none exists.
- Whether AIWOS's authors intended to continue. Unknown; the repo has been untouched since
  creation day.
- Our own GUI mission (blocked), ChatGPT handoff (UNVERIFIED), and memory/retrieval (thin).

---

## L. Final decision

- **Reuse now:** nothing.
- **Investigate further:** nothing — the evidence is conclusive, not merely incomplete.
- **Learn from design only:** layer vocabulary and the "evidence, history, human approval"
  principle. Both are already reflected in AIOS in stronger, tested form.
- **Reject/defer:** the entire codebase, on maturity and evidence grounds.
- **Licence:** Apache-2.0 permits reuse; maturity forbids it.

**Does this repository accelerate the delivery objective? No — it would slow it down.** The
single highest-value next action is unchanged and is not architectural:

> **Press `Ctrl+Alt+G` / click the release control at screen (1463, 112), then run
> `run-gui-mission.ts`** so the guarded desktop path is demonstrated end to end with real typed
> text read back through UI Automation and verified after a store reopen.

Evidence supporting this: the guard is the *only* remaining blocker on the GUI mission
(`takeoverPending=true`, everything else passing); and the same architectural questions this audit
raises about evidence, recovery and independent verification are already answered by code and
tests in AIOS.