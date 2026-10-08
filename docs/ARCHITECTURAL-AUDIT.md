# Architectural audit â€” AIOS against the full destination

Date: 2026-10-08. This is a classification of **current truth**, not intent. Every row was checked
against the code, and where a check disproved an assumption the assumption is recorded rather than
quietly dropped.

Legend: **READY** works and is evidenced Â· **PARTIAL** works, with a stated limit Â· **MISSING** not
built Â· **WRONG DIRECTION** built the wrong way Â· **DEFERRED** deliberately postponed, with a reason.

---

## 0. Source-of-truth checkpoint (recorded before any implementation choice)

| Question | Answer | How verified |
|---|---|---|
| Exact working directory | `C:\Users\Samer\Projects\AIOS` | `Resolve-Path` |
| Git repository | Yes | `git rev-parse --is-inside-work-tree` |
| Branch | `master` | `git rev-parse --abbrev-ref HEAD` |
| HEAD | `6fcf982` "M10: constrained decodingâ€¦" | `git log --oneline -1` |
| Working tree | **Clean** â€” 0 dirty, 0 staged | `git status --porcelain` |
| Remotes | **NONE** | `git remote` empty |
| Commits | 19, single branch, no tags | `git rev-list --count` |
| Ignored-but-present | `node_modules/`, `packages/control-core/host.json` | `git status --ignored` |

**Independent from the older web application: yes, completely.**

- No `.gitmodules`, no gitlinks, no shared history. First commit is `a7a8291`, AIOS-specific.
- The only textual overlap is the *name* `PortAi`, and it lives **inside `control-core`**, which is
  inherited code from the previous project: `PORTAI_OPERATOR_DIR`, `PortAiOperator.Program`,
  `portai-operator-syntaxcheck.dll`, "PortAi Operator" window title.
- No AIOS identifier (`InjectionRoutes`, `ControlSurface`, `MayInject`, `PlanProposal`, `beginReview`)
  appears anywhere in the other repositories. Verified by search.

**GitHub: contains only the previous application.**
`https://github.com/PhoneixIt/ai-distribution-platform`, public, last push 2026-10-03, 80+ branches.
**Zero branches mention AIOS** (`git log --all --grep=AIOS -i` â†’ none). AIOS has never been pushed.

**Vercel: connected to the previous application only.**
The old repo carries a `vercel/install-vercel-web-analytics-*` branch. AIOS has no remote at all, so
no Vercel project can be attached to it. The workspace-root `my-app` is not a git repo and has no
`.vercel` link.

**Conclusion: no external resource is at risk.** No push, merge, rename or delete is required or
performed. A deliberate GitHub synchronisation decision remains open and is a **human decision** â€”
it is explicitly *not* taken here.

> âš ï¸ `docs/architecture/` existed as an **empty directory**. PROJECT_VISION, ARCHITECTURE,
> GOVERNANCE CONTRACT and DEVELOPMENT RULES did not exist at all. The most safety-critical knowledge
> in this project lived only in conversation. That is the finding that shaped this milestone.

---

## 1. Area-by-area classification

### Application shell

| Area | Status | Why |
|---|---|---|
| Windows-native desktop shell | **MISSING** | No UI exists. Only headless `.mjs`/`.ts` harnesses. |
| WinUI 3 / Windows App SDK | **DEFERRED** | Not a framework question yet â€” no shell exists to justify one. Audit measured WinAppSDK 2.5.1 and chose it over Tauri because `control-core` is C#. |
| WebView2 where useful for rich UI | **DEFERRED** | Legitimate for a diff/evidence viewer; must not become the *control* path. |
| Packaging / install / update | **MISSING** | No manifest, no installer, no updater, no code signing. See Â§6. |

### Runtime

| Area | Status | Why |
|---|---|---|
| TypeScript mission/runtime core | **READY** | 21,283 lines across 9 packages; 274 unit tests green. |
| C# `control-core` | **READY** | 3,861 C# lines + `PROVENANCE.json` + 5 proof harnesses. Proven takeover, latched stop, no-self-release, fail-closed hooks. **Must not be modified.** |
| Authenticated local IPC | **PARTIAL** | `host.json` carries a live port + auth token; loopback only. But `operator-client.mjs` calls `fetch(base + path)` with no bearer header on the read paths â€” the token is present but its *use* is inconsistent and unverified by a negative control. |
| SQLite / durable state | **MISSING** | Zero occurrences of SQLite or any persistence. Mission state is **in-memory only**. A crash loses all evidence. |
| Process lifecycle / Job Objects | **MISSING** | Zero occurrences of `CreateJobObject` / `AssignProcessToJob`. Nothing guarantees a spawned process tree dies with the mission. |
| Stronger isolation (Sandbox / VM) | **MISSING** | **No occurrence of "Sandbox" in product code** (only in a test's policy string). There is *no* OS-level isolation whatsoever. See the terminology warning below. |

> **Terminology, enforced.** The system has *working-directory confinement*, a *filesystem boundary*
> in tool policy, and a *command allowlist*. It has **no sandbox**. Nothing in this repository may be
> described as sandboxed, isolated, or virtualised. Untrusted code does not yet run anywhere.

### Model and planning

| Area | Status | Why |
|---|---|---|
| `PlanProvider` abstraction | **READY** | Model-agnostic by construction. M10's grammar rode the pre-existing `headers` field without changing the interface â€” evidence the abstraction is real. |
| Local inference path | **PARTIAL** | Python subprocess on Microsoft-signed `onnxruntime` (WDAC `Valid`). Works, but 1.5B produces 0 usable plans. |
| Constrained generation | **READY (as a mechanism)** | 90 grammar controls; 0.5% overhead; refuses dead prefixes. It does not make the model useful. |
| Future GenAI / Foundry Local / Windows ML | **DEFERRED** | `onnxruntime-genai` 0.17.1 is WDAC-`Valid` and has `set_guidance` + `get_logits`/`set_logits`, but **cannot load the M9 model** (no `genai_config.json`). Migration is a model re-export, not a dependency swap. Must stay a replaceable choice. |
| Grammar â†” semantic authority | **READY** | `capability`/`tool` are free strings, `args` is free-form. `test_grammar_does_not_filter_semantics` fails if tightened. Compiler and router refusals stay reachable. |

### Capability surface

| Area | Status | Why |
|---|---|---|
| Filesystem | **READY** | Read + transform + write, with path containment. |
| Terminal / process | **PARTIAL** | Allowlisted commands only. **M5 recorded terminal capability as only PARTIALLY PROVEN**, and `LIMITATIONS` is exported and asserted. No process-tree containment. |
| Observation / world state | **PARTIAL** | `ObservationProvider` read-only by construction; `WorldState` plain data. Narrow: folder + summary tools only. |
| Freshness / replanning | **READY** | Observations carry timestamps; stale targets are rejected. |
| Verification | **READY** | Separate `Verifier` interface from `Tool` â€” a tool cannot verify itself. |
| Recovery | **PARTIAL** | Proven against genuine divergence, but only for the cases built. |
| Browser automation | **PARTIAL, and FRAGILE** | `operator.mjs` already drives real Chromium over CDP with Playwright. **But `playwright` is imported while `package.json` declares NO dependencies at all**, and the Chromium path is hardcoded to `ms-playwright/chromium-1243`. The browser foundation is therefore **not reproducible** â€” a real defect, not a style issue. |
| AI browser adapters (Stagehand / Browser Use) | **REJECTED as foundation** | They are model-in-the-loop agents. Using them as the foundation inverts determinism and destroys auditability. At most an optional adapter above Playwright. |
| Windows UI Automation / Win32 | **READY (inherited)** | `Uia.cs`, `Hooks.cs`, `VsEdit.cs`, `Guard.cs` â€” real `IUIAutomation` + Win32. **P0 defect: `dwExtraInfo` does not survive the Windows mouse path.** |
| FlaUI | **DEFERRED** | A wrapper over the same COM API already in use. Convenience does not justify a layer inside the injection authority. |
| Tool registry / router | **READY** | Ambiguity is refused, never silently substituted. |
| MCP | **MISSING, and must stay an adapter** | Zero occurrences. Correct by design: an MCP server is another process *asserting* it acted. As authority it would make fake-verified-status trivial. |

### Trust, governance, operations

| Area | Status | Why |
|---|---|---|
| Governance / effect policy | **READY** | `Permission` is returned, never asserted. `ToolRegistration.effectOf` classifies the *specific* step, so `git status` â‰  `git push`. |
| Injection gate | **READY** | Structural: one `InjectionRoutes` table + `RequiresPermission()` at the dispatch head; **omission DENIES**. Route audit passes. |
| Human takeover | **READY (proven)** | Chords, panel release, status truth â€” five proof harnesses. |
| Emergency stop | **READY (latched)** | Outranks approval, proven by test. |
| Window management gating | **WRONG DIRECTION** | `/show`, `/restore`, `/focus`, `/guifocus` change the machine without consulting `MayInject()`. They require `Verify()` but are not permission-gated. **Unfixed and recorded.** |
| Release after takeover | **MISSING** | **Not proven, and blocked on human decisions H1/H2.** No trustworthy resume exists. Operator stays paused. |
| Evidence / history | **PARTIAL** | Events and evidence records exist, but **in-memory**. Nothing survives a crash. |
| Privacy / local-first | **READY** | Every network call in the product path targets `127.0.0.1`. Zero outbound. Local-first is verified, not asserted. |
| Credentials | **PARTIAL** | Terminal policy *refuses* credential use â€” it is a policy, not a credential store. Nothing reads or stores secrets. |

---

## 2. Vision gap analysis

Capabilities the vision requires that the architecture does **not** yet represent. Grouped by
whether they are safe to build next.

### Blocked on human decisions â€” cannot be autonomously resolved

| Gap | Blocker |
|---|---|
| Resuming a mission after human takeover | **H1/H2.** No trustworthy resume mechanism. The operator stays paused. **Do not ask the user to press anything.** |
| Reliable mouse-injection attribution | **H4.** `dwExtraInfo` does not survive the Windows mouse path. Measured 0 tagged vs 5,476 untagged â€” conservative-biased (safe) but wrong. |
| G6 legal decision Â· G7 merge/deploy PR #74 | Human gates on the *other* repository. |

### Requires a real capability that does not exist yet

| Gap | Current state |
|---|---|
| **Building software from an objective** | No compiler, test-runner, or repo tool. Terminal is allowlisted only. |
| **Modifying / debugging existing software** | Absent. Depends on the above. |
| **Installing trusted tools** | Absent, and deliberately so â€” it is a consequential effect with no provenance story. |
| **Tool provenance / licence / version / rollback** | Absent. M5's terminal `LIMITATIONS` is the only acknowledgement. |
| **Research / document workflows** | Absent. No network egress by design, so any such capability must be explicitly bounded. |
| **GUI fallback when APIs/DOM are unavailable** | Inherited UIA/Win32 exists; the *planner* never selects it. No strategy layer for "DOM failed â†’ use UIA". |
| **Model routing (local vs cloud)** | Absent. `PlanProvider` is model-agnostic, which is the precondition â€” but no router exists. |
| **Long-running missions** | Partial. No durable state, no Job Objects, no resume. |
| **Commercial packaging** | Absent: no signing, no SBOM, no licence, no updater, no installer. |

### Present and genuinely usable

Filesystem work Â· terminal/process work (allowlisted) Â· observation â†’ planning â†’ verification for
folder missions Â· human takeover Â· latched emergency stop Â· consequential-action approval Â· recovery
for the cases built Â· strict plan review and amendment Â· evidence records.

### Where AIOS must refuse gracefully â€” stated, not implied

- **MFA / OTP / CAPTCHA** â†’ never solved, never bypassed. Hand to the human, record the hand-off.
- **Credential entry** â†’ the human types it. AIOS never reads or stores a secret.
- **Unsupported or unknown tools** â†’ refuse with the real vocabulary named, never substitute.
- **Consequential effects without approval** â†’ refuse at the effect gate.
- **Tasks beyond a model's competence** â†’ refuse. A model that cannot plan must say so rather than
  improvise â€” and M10 showed this is easy to get wrong, because a constrained decoder can emit a
  *syntactically perfect false refusal*.

**No claim of universal capability is made anywhere in this repository.**

---

## 3. The three findings that should change what happens next

1. **The repository could not be rebuilt from.** PROJECT_VISION, ARCHITECTURE, GOVERNANCE CONTRACT
   and DEVELOPMENT RULES were absent, and `docs/architecture/` was an empty directory. A future
   contributor â€” or a future session of mine â€” could weaken a safety boundary without any record of
   why it existed. **This is the highest-value work available and it needs no human decision.**

2. **No durable state.** Evidence, mission history and approval state are in-memory. For a product
   whose selling point is an auditable history, "the history dies with the process" is a structural
   gap, and it also blocks long-running missions.

3. **The browser foundation is unreproducible.** `playwright` is imported with **zero declared
   dependencies** and a hardcoded Chromium build number. It works on this machine by accident of
   layout. That is a defect in the one capability area the vision leans on hardest.

---

## 4. Milestone selected: **M12 â€” PERSISTENT PROJECT MEMORY**

**Why this is the highest-value step.** Every other gap is either blocked on a human decision, or
depends on a model that cannot plan yet. This one is unblocked, cheap relative to its value, and it
converts safety knowledge from conversation into repository fact. It is also a precondition for
honest commercial distribution: a product sold on a safety contract must ship that contract.

Scope, deliberately narrow and additive:

1. `PROJECT-VISION.md` â€” the destination, stated once, with the explicit refusals.
2. `ARCHITECTURE.md` â€” the current truth, package by package, with the empty packages named.
3. `safety/GOVERNANCE-CONTRACT.md` â€” the non-negotiables, each with the control that enforces it and
   the proof that it bites.
4. `DEVELOPMENT-RULES.md` â€” how to work here, including the traps that have cost real defects.
5. This audit, filed as the dated record.

**Explicitly not in M12:** no safety change, no new capability, no framework adoption, no GitHub
push. M12 writes down what is true. It changes nothing about behaviour.

**Queued behind it, in order:** durable state (SQLite) Â· process-tree containment (Job Objects) Â·
window-management gating fix Â· browser reproducibility Â· M13 model-ceiling experiments.

---

## 2026-10-08 - M17: control-core authorisation boundary

The authority boundary changed is the EXISTING dispatch-head gate, not a new one:

    if (RequiresPermission(path) && !Guard.MayInject())

Three route paths were added to `InjectionRoutes`. No new component, no new IPC layer, no new
dependency, no renamed type. `control-core/src/OperatorHost.cs` is the only C# file touched and the
change is 17 added lines with nothing removed.

Why this is the correct boundary: it already fails closed on all three conditions that must block
action - latched emergency stop, pending human takeover, unhealthy or absent hook - and it already runs
before any route body, so an omission denies by default. Adding per-route checks would have created a
second, weaker enforcement mechanism that could drift from the first.

What it enforces: a window cannot be minimised, hidden, restored, or focused without permission.

Limitation now on the record: `/shutdown` is ungated, and a host restart clears the in-memory
emergency-stop latch. Unreachable by the operator through the governed terminal path (no shell is
permitted), but real.
