# CAPABILITY MATRIX

What AIOS can actually do, as measured on this machine — not as described in a tool registry.

Every status below is backed by an observation or a test, and the evidence is named. Where a
capability is **not** proven, it says so. A capability listed as "implemented" here means a registry
entry exists, which is a claim about code and nothing else.

## The statuses, and what each one obliges

| Status | Means |
|---|---|
| **Not implemented** | No code path exists. |
| **Implemented, unverified** | Code exists and nothing has exercised it. A registry entry is not evidence. |
| **Verified in isolation** | A test exercises the real code and asserts a real outcome. No live machine involved. |
| **Verified end to end** | Run through the real chat-to-executor path on this machine, with independent evidence. |
| **Reliable across repeated runs** | End to end, repeatedly, with the same result. The count is stated; there is no "reliable" without one. |
| **Blocked** | Cannot be done here. The reason is given. |

---

## P0 — Real computer operation

| # | Capability | Status | Evidence |
|---|---|---|---|
| 1 | Launch an application, get a real window handle | **Verified end to end** | `launch-app` → Notepad, host-confirmed hwnd + pid. Live, repeatedly. |
| 2 | Type text into a window; verify by reading the window back from the OS | **Reliable across repeated runs** | "hello world from aios" confirmed present via `/uiasurvey` on the target hwnd. 3+ live runs. |
| 3 | Distinguish an empty document from a written one | **Verified end to end** | UIA exposes `0 characters` / `21 characters`; used to confirm both directions. |
| 4 | Launch a browser at a URL; verify the real page by OCR | **Verified end to end** | Chrome search page read from pixels: `nakivo - Google Search - Google Chrome`. |
| 5 | `window-shows-text` postcondition satisfied only by OCR evidence | **Verified in isolation** | `plan-completion.test.ts`, `objectiveVerdict` grading tests. |
| 6 | Screen-diff verification | **Verified in isolation** | Executor/verifier suite. **Not** exercised on a live mission in this session. |
| 7 | Accessibility-tree inspection | **Verified end to end** | `/uiasurvey` drove the typing verification above. |
| 8 | Will not type into a document it was not asked to change | **Verified in isolation** | `adopted-window-safety.test.ts` (11 tests). See *Known limits*. |
| 9 | A window titled `<document> - <app>` is recognised as that app | **Verified end to end** | Fixed a live failure: `"Untitled - Notepad"` was rejected as `"Notepad"`, skipping 6 dependent steps. |
| 10 | Save a typed document to a file, driven through the GUI | **Verified end to end** | "open notepad, type aios save proof, then save it to the desktop as aios-save-proof.txt" → Notepad created and saved the file, AIOS read it back from disk: `aios save proof`. Also fixed the report, which had called this mission a failure — see *Known limits* #8. |
| 11 | Scroll, click, right-click, menu navigation | **Implemented, unverified** | Routes exist (`/scroll`, `/click`, `/uiainvoke`). No end-to-end mission observed using them. |
| 12 | Cross-application transfer (application → disk → AIOS) | **Verified end to end** | Notepad wrote the file; AIOS independently read it back and graded the objective on it. The reverse direction (browser → document) is still unverified. |
| 12b | Browser → document transfer | **Not implemented as a verified flow** | Both halves work independently; no observed mission joins them. |
| 13 | Reliable focus and input routing under a changing desktop | **Verified in isolation** | `live-control` + host routing tests. Focus under contention is unproven. |

---

## P1 — Autonomous multi-step goal completion

| # | Capability | Status | Evidence |
|---|---|---|---|
| 14 | Natural-language goal → plan → mission → governed execution | **Verified end to end** | Every live run in this document went through this path. |
| 15 | Model output cannot bypass the permission system | **Verified end to end** | Guard `PERMITTED` / `BLOCKED` read live, per step, at the moment of the action. |
| 16 | Goal classification (show / produce / information / act / conversational) | **Verified in isolation** | `goal-intent.test.ts`. |
| 17 | Quiet reporting for show-goals, full audit for file-goals | **Verified end to end** | Observed in live transcripts both ways. |
| 18 | **Replanning with execution results fed to the model** | **Verified end to end** | Observed trace: promise gate held `s2 ("To be populated")` → research ran → "Replanning with execution results..." → real 13-row CSV. |
| 19 | **Detecting a deliverable that is a promise, not data** | **Verified end to end** | Before: `ok=true` beside a file reading `To be populated from the research results`. After: `ok=false`, named, with the reason. |
| 20 | Replan receives the *content* earlier steps produced | **Verified end to end** | The brief's quoted facts are in the prompt; the replanned sheet contains those facts. This is what made #18 work. |
| 21 | Attempt bound | **Verified in isolation** | `MAX_PLAN_ATTEMPTS = 2`; `shouldReplan` cannot exceed it. |
| 22 | A mission record preserves every attempt, not just the last | **Verified end to end** | `attempts=2` with `s1,s2` and `a2-s3,a2-s4` in one record. |
| 23 | Objective postcondition derives from the plan and is graded independently | **Verified in isolation** | `state.ts` verdict tests; observed live as `artifact-exists` + `artifact-read-back`. |
| 24 | Model-free path for trivial deterministic requests | **Partial** | Conversational replies bypass the model. Most tool work still routes through the model. |
| 25 | **Cross-mission operational memory** | **Verified end to end** | Mission 1 (data protection companies) recorded a lesson. Mission 2 (cloud storage providers) - a **different question of the same shape** - was planned with it and produced a 1072-byte real sheet. |
| 26 | **Memory cannot weaken any check** | **Verified in isolation, and structural** | Memory reaches exactly one place: the planner prompt. It is not on the path any verifier, permission check or postcondition reads. assertMemoryCannotWeakenChecks takes no arguments, and the suite asserts no permission-shaped API is exported. |
| 27 | A hostile or corrupt memory file degrades safely | **Verified in isolation** | Undeclared outcomes, non-objects, invalid JSON and oversized files are all rejected or ignored. A mission never fails because a cache could not be read. |
| 29 | **Zeus V1.0 - one name for the whole free pool** | **Verified end to end** | The pool is addressed by one name; the concrete model that answered is disclosed every time. Live: 8 distinct models answered planning calls, one each, and no model was reused until throttled. |
| 30 | **Routing by request type** | **Verified end to end** | `plan` and `correct` are scored separately. Observed: `beam-free` answered a plan in 3.2s while `deepseek` answered a correction in 25.0s, each recorded against its own type. |
| 31 | **The pool does not run dry** | **Verified in isolation + observed live** | N consecutive routes spread across N models. Live baseline after the change: 8 models used once each, **zero cooldowns** - against a measured baseline where 5 missions exhausted the allowance. |
| 32 | A fully-throttled pool still yields a model | **Verified in isolation** | The least-recently-failed model is returned rather than nothing. "The one that failed least recently" beats a dead mission. |
| 33 | A hand-edited routing state cannot introduce a paid model | **Verified in isolation** | `isFreeModel` is applied when the state file is read, not only when a model is chosen. The $0 constraint holds on the way back in as well as out. |
| 28 | Failures are remembered, not only successes | **Verified end to end + in isolation** | All four outcomes persist. A memory that stores only wins teaches a system what to keep doing rather than what to stop doing. |

---

## P2 — Research, files and evidence

| # | Capability | Status | Evidence |
|---|---|---|---|
| 25 | Web research → cited brief with quoted facts | **Verified end to end** | Multiple live runs; `verifyBrief` re-parses from disk in a fresh pass. |
| 26 | Spreadsheet with real rows, quoted cells, rectangular | **Reliable across repeated runs** | 3 runs of "data protection companies" → 3 real CSVs (984 B, ~2 KB, 507 B). |
| 27 | Spreadsheet rows as an array of arrays | **Verified in isolation** | `spreadsheet-rows-form.test.ts` (5 tests). Motivated by unparseable inline CSV. |
| 28 | Unsourced URLs are dropped, never substituted | **Verified end to end** | Observed: `Source URL` column present but empty, with the count reported in the summary. |
| 29 | File read-back with size + SHA-256 evidence | **Verified end to end** | Spreadsheet verifier emits real `file-read-back` with `bytes`/`sha256`. |
| 30 | A read-back reads the file the plan actually wrote | **Verified end to end** | Fixed a live mismatch: write went to the output folder, read-back looked in a temp folder. |
| 31 | Write paths confined to the agent output directory | **Verified in isolation** | `confineTo` defeats `..` traversal; **verified end to end** on every live write. |
| 32 | Ragged rows padded, and the padding reported | **Verified in isolation** | Asserted that the summary says so — padding must not be silent. |
| 33 | Google blocks automated search | **Blocked** | Returns a CAPTCHA with zero facts. Search URLs are transparently rewritten to DuckDuckGo. The rewrite is logged, never hidden. |

---

## P3 — Governance

| # | Capability | Status | Evidence |
|---|---|---|---|
| 34 | Guard blocks desktop input while a human is present | **Verified end to end** | `input BLOCKED` / `PERMITTED` read live per mission. |
| 35 | Preferences cannot weaken checks | **Verified in isolation** | `assertPreferencesCannotWeakenChecks` throws at runtime; both grant regimes asserted. |
| 36 | Writes confined; reads restricted to declared roots | **Verified in isolation + end to end** | Live refusal: reading outside the roots is refused with the list of allowed ones. |
| 37 | Model, memory, page text and tool output treated as untrusted data | **Verified in isolation** | Page text claiming authority cannot change a classification; injection in a class attribute cannot promote content. |
| 38 | Human takeover cancels automated input | **Verified end to end** | Guard flips to `WORKING` on real machine contact. |
| 39 | Emergency stop | **Verified in isolation** | Route and executor tests. **Not** exercised live in this session. |
| 40 | Only free models are used | **Verified end to end** | Re-checked at the layer that actually spawns the process, not only at the HTTP route. |

---

## Acceptance tests (mandate §13)

| Test | Status | Note |
|---|---|---|
| **A — Live GUI** | **Partial** | Launch, type, save, and read back through the OS: verified end to end. Click, scroll, menu navigation and form entry: implemented, not observed live. |
| **B — Autonomous goal execution** | **Verified end to end** | "data protection companies" needed no method-selection question. |
| **C — Research and deliverable** | **Verified end to end** | Research → real sourced rows → saved → read back → digest-verified. |
| **D — Multi-application workflow** | **Partial** | Application → disk → AIOS read-back is verified end to end. Browser → document is not. |
| **E — Failure recovery** | **Verified end to end** | The placeholder defect was detected, diagnosed, and repaired within the same mission. |
| **F — Novel-task generalisation** | **Partial** | The same architecture handled a research goal and a GUI goal without per-task code. Not measured across a wide task set. |
| **G — Takeover and governance** | **Verified in isolation + end to end** | Live guard flips; block/permit both observed. Emergency stop not exercised live. |
| **H — Self-improvement** | **Verified in isolation** | Each defect in this document was found by observing real behaviour, fixed with a regression test that reproduces it, and re-verified on the machine. The loop is proven; its *repeatability* is not measured. |

---

## Layer audit - model, agent runtime, environment

AIOS is judged here against the three-layer shape a capable agent product actually has. This is a
statement about what is on this machine, not about what an architecture diagram could hold.

| Layer | What it is | Status in AIOS |
|---|---|---|
| **1. Model** | Trained intelligence that interprets and reasons | **Present, by choice.** Eleven free models, rotated with a 10-minute failure cooldown, and re-checked for "free" at the layer that actually spawns the process. AIOS does not train a foundation model; the section below says why that is the right call here. |
| **2. Runtime - tools** | Capabilities the model may call | **Present.** 11 registered capabilities (10 available at the time of writing), each with declared arguments, required-ness, and its own independent verifier. A capability with no verifier cannot be registered. |
| **2. Runtime - orchestration** | Goal to plan to mission to execution | **Present.** interpret to validatePlan to toMission to execute, with permission re-read at the moment of each action rather than at plan time. |
| **2. Runtime - state** | Mission and step state, durable records | **Present.** Mission summaries retaining every attempt, per-step outcomes, objective verdicts. |
| **2. Runtime - execution feedback** | Results returning to the model | **Present, and recently fixed.** Step outcomes plus the *content* earlier steps produced now reach the next attempt. Without the content the model re-plans from the same empty context and repeats the same failure. |
| **2. Runtime - recovery** | Detect failure, choose a corrective action, retry | **Present, bounded.** Two attempts maximum. An unbounded loop is a hang with extra steps. |
| **2. Runtime - MEMORY** | What carries across missions | **Present - this was the gap.** Added and verified this session. See rows 25 to 28. |
| **3. Environment** | Desktop, browser, files, terminal, permissions | **Present.** Real windows, real typing, real saving, real OCR - and a guard that blocks input whenever a human touches the machine. |
| **3. Guardrails** | Refusal, approval, takeover, confinement | **Present.** Governance is the most heavily tested component in the system, and the one component memory is deliberately kept away from. |

### On training a model

Not now, and the reason is specific rather than ideological: **product and agent improvement can be
built by a small software team on top of an existing model; model improvement requires data,
specialised expertise and compute this project is not authorised to spend.**

Every defect fixed so far was an agent-layer defect - a plan parsed wrong, a verifier too literal, a
read-back pointed at the wrong path, a deliverable that was a promise, a mission record that erased
its own recovery. Not one was fixed by a better model, and each would have survived a model upgrade
unchanged. That is the empirical argument for where the effort belongs, and it is stronger than an
architectural argument because it was measured rather than assumed.

The honest counterpoint: a stronger model *would* have produced fewer malformed plans. The parser
repairs were worth making and they were not the highest-value work available - the replan loop was.
Where the two overlap, the deterministic fix was chosen, because it survives the next model.

---
## Known limits — stated, not buried

1. **The adoption refusal has never fired on a live mission.** The property it protects *is* verified
   live: with `DECOY-DO-NOT-TOUCH.txt` open in Notepad, a typing mission left that document
   byte-identical and created its own window instead. But the refusal branch itself is only
   unit-tested, because Windows 11 Notepad created new windows rather than activating the existing
   one on every attempt. It is a guard that has not yet been seen to catch a real event.

2. **A mission can verify every step and still be wrong.** This was demonstrated, not theorised:
   "open notepad and type hello world" reported both steps verified while the text landed in a
   document the mission was never given. Verification proves the steps did what they said. It does
   not prove the steps were the right steps. This is the strongest argument in the system for
   keeping the objective verdict separate from the step verdicts.

3. **Replanning costs a model call.** A plan that declares no objective postcondition is treated as
   defective and replanned, even when every step verified. For a GUI goal that legitimately produces
   no artifact this is wasted latency. The bound is 2 attempts, so the cost is bounded, but it is
   real.

4. **Not every research run produces a sheet.** With 2 free attempts, a model that writes placeholders
   twice leaves an empty file — honestly reported, but empty. There is no third attempt, by design.

5. **Free-model latency and rate limits dominate wall-clock time.** A 2-attempt mission costs two
   model calls; failover across 9 free models adds more. This is a resource limit, not a design
   choice.

6. **`process-containment.test.ts` flakes under full-suite load** — 13/13 in isolation, intermittently
  under parallel load. A timing sensitivity in untouched code, not a regression, and not yet fixed.

7. **A successful mission was reported as a failure — and an old test was defending the bug.**
   "open notepad, type aios save proof, then save it to the desktop as aios-save-proof.txt" wrote
   the file correctly and reported `ok=false`, because the goal's destination was recovered as the
   bare FOLDER `C:\Users\Samer\Desktop`, which then became the postcondition
   `artifact-exists C:\Users\Samer\Desktop`. A directory can never satisfy a file postcondition.

   The instructive half is what unblocking it exposed. A long-standing test asserted that a goal
   naming Documents should put the output there — and that destination is neither writable nor
   readable, so the step it certified could never have succeeded. It had been checking that a
   folder name was echoed into an argument, which is a different question from "can this mission
   produce a file". It now asserts the property that actually matters: the destination is writable,
   and inside the confinement.

8. **The confinement does not extend to applications the user asked to drive.** AIOS's own
   `write-file` and `spreadsheet` write only under `~/.aios/agent/out`. Notepad, saving to the
   Desktop because the person said so, is allowed. That is not an inconsistency: one is the system
   reaching for the disk on its own initiative, the other is the user asking their own application
   to write where they said. It is stated here because it looks like one from a distance.

9. **A goal can name a folder and no filename**, and then the output goes to the agent directory
   under the model's own name, with the user told. The alternative — inventing a filename for a
   folder they named — would be guessing where their work belongs.

10. **A multi-word filename is refused rather than guessed.** "save it as quarterly report.txt"
    could mean either name; taking the last word produces a *different* file that looks like
    success. AIOS declines, falls back, and says so.

11. **Saving through the GUI is now verified, and it was the last thing standing between "types
    text" and "produces a file".** Type → Ctrl+S → read back from disk → graded on the file. That
    chain is observed end to end.

12. **The terminal verifier rejects non-idempotent commands.** "list the files on my desktop"
    failed with "re-running the command produced different output" - correct reasoning, wrong
    requirement: listing a directory is not idempotent while the mission is creating files in it.
    The verifier's idempotence rule needs a declared exception for commands whose output is
    legitimately time-varying. Found by running Zeus's spread test with real goals, not by a test.

13. **There is no clock.** "what time is it" cannot be answered: no capability reports the time, and
    the terminal allowlist refuses `powershell -Command "Get-Date"`. A genuine capability gap,
    surfaced by the same run.

14. **Clicking, scrolling and menu navigation still exist but have never run in a mission.** Zeus
    changed which model answers a request; it did not change what the request can do.

---

## Measured, not asserted
Counts here are from real runs on this machine and are reproducible from the transcripts and the
mission records under `~/.aios/agent/`.

| Measure | Value | Basis |
|---|---|---|
| Unit + integration tests, mission-engine | **938 passing, 0 failing** | `node --test packages/mission-engine/test/*.test.ts` |
| Unit + integration tests, control-core | **53 passing, 0 failing** | `node --test packages/control-core/test/*.test.ts` |
| End-to-end missions observed this session | 9 | Transcripts in this session |
| "data protection companies" → real CSV | 3 of 3 | 984 B, ~2 KB, 507 B; all with real companies |
| Replan triggered and recovered | 1 of 1 observed | Promise gate → replan → 13-row real sheet |
| Save-through-the-GUI → real file, correctly reported | 1 of 1 after the fix | The first attempt produced the file and reported failure; the second reported both |
| A decoy document left unmodified under live typing | 1 of 1 | `DECOY-DO-NOT-TOUCH.txt` byte-identical after a typing mission |
| Live defects found by observation | 7 | See below |
| Defects fixed with a reproducing test | 7 of 7 | Each test names the live run it came from |

The seven live defects, each found by looking at what the machine actually did rather than at what
the system reported:

1. A read-back looked in a temp folder while the write went to the output directory.
2. A deliverable reading `To be populated from the research results` was reported as `ok=true`.
3. `"Untitled - Notepad"` was rejected as not-`"Notepad"`, skipping six dependent steps.
4. Typing landed in a document the mission was never given — single-instance adoption.
5. A replanned mission's record kept only the last attempt, erasing the recovery.
6. A goal naming a folder produced a postcondition on a directory, so success read as failure.
7. (Latent, found by a contract test) `inferReadPath` returned `undefined` where its signature
   promised `null`.

**No completion rate is claimed here.** A rate needs a fixed task set run many times, and that set
does not exist yet. The three-run CSV figure above is a count of three, not a percentage, and it is
reported as three.