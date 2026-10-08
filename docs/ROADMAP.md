# AIOS ROADMAP

Autonomously maintained. The agent selects the next milestone from this file plus the evidence
ledger; it does not ask.

Status vocabulary: `PROVEN` · `PARTIAL` · `NOT STARTED` · `BLOCKED` · `DECISION REQUIRED`

---

## Definition of Done (the finish line)

Not "tests pass". The system is genuinely usable by a real person for meaningful computer
missions. Concretely, all of the following with evidence:

- [ ] A desktop application a person opens
- [ ] Natural-language mission entry
- [ ] An AI layer that understands the objective and emits a structured plan
- [ ] Tool routing across GUI / UIA / browser / filesystem / terminal / API
- [ ] Real application, browser, file and terminal operation
- [ ] Governance enforced on every action
- [ ] Human takeover, immediately effective
- [ ] Emergency stop
- [ ] **Explicit, trustworthy release/resume** ← currently the hardest blocker
- [ ] Re-observation and replanning after an interruption
- [ ] Authentication boundaries respected (never bypassed)
- [ ] Independent verification of meaningful results
- [ ] Recovery from ordinary failures
- [ ] Multi-step missions with retained state
- [ ] Auditable history
- [ ] Missions long enough to be substantial
- [ ] An accurate completion report

Broad practical capability across: Windows applications, browser workflows, files, terminal,
software projects, research, multi-step business/productivity tasks. Universal compatibility is
**not** required; strong adaptive capability with safe failure on the unsupported is.

---

## Capability ledger

| # | capability | status | evidence |
|---|---|---|---|
| 1 | Windows observation (windows, screen, UIA tree) | **PROVEN** | `mission:live`, `mission:two-step` |
| 2 | Keyboard injection, sentinel-tagged | **PROVEN** | `mission:gui-accept` accept path |
| 3 | Human takeover | **PROVEN** | `mission:gui-audit` control D |
| 4 | Emergency stop (latched, no self-release) | **PROVEN** | `control-core` Guard.cs |
| 5 | Structural injection gate, all routes | **PROVEN** | `control:audit-routes` |
| 6 | Independent verification | **PROVEN** | executor gate + 5 folder verifiers |
| 7 | Mission engine (deps, gating, replan, audit) | **PROVEN** | 116 unit tests + 6 live missions |
| 8 | Filesystem execution mode | **PROVEN** | `mission:filesystem` |
| 9 | UI Automation (read) | **PROVEN** | `mission:two-step` |
| 10 | Injection audit, keyboard attribution | **PROVEN** | `mission:gui-accept` |
| 11 | Passive vs active hook observation | **PROVEN** | `/hooks-passive`, delta 0 vs N |
| 12 | Tool router (generic, refuses substitution) | **PROVEN** | `tool-router`, 6 tests |
| 13 | Plan contract (`PlanProposal`) | **PROVEN** | `planner/plan.ts` |
| 14 | Planner boundary (`PlanProvider`) | **PROVEN** | `planner/provider.ts` + import test |
| 15 | Deterministic planner | **PROVEN** | `mission:folder` |
| 16 | **User-driven end-to-end mission** | **PROVEN** | `mission:folder` |
| 17 | Plan inspection ("what I intend to do") | **PROVEN** | `planner/inspect-plan.ts` |
| 18 | Step-to-step data flow (`ctx.prior`) | **PROVEN** | compose → write |
| 19 | Governance contract | **PROVEN** | governance/approval.ts, exact 5-part key |
| 19b | Consequential-action approval, enforced | **PROVEN** | mission:approval, 6 controls both layers |
| 19c | Approval ≠ verification | **PROVEN** | control F |
| 19d | Approval does not survive a replan | **PROVEN** | plan epoch, control E |
| 19e | Emergency stop outranks approval | **PROVEN** | control G |
| 33 | Terminal: allowlisted programs, no shell | **PROVEN** | 36 live checks, 2 refusal layers |
| 34 | Terminal: workspace boundary, junction-proof | **PROVEN** | controls E, E2; a junction test that FAILS if it cannot set up |
| 35 | Terminal: bounded lifetime, tree reaped | **PROVEN** | control D — grandchild wrote nothing |
| 36 | Terminal: exit code 0 is not evidence | **PROVEN** | controls A, A2 |
| 37 | Terminal: consequence from ARGS, not a flag | **PROVEN** | `effectOf`; git status vs git push |
| 38 | Terminal: environment reduced | **PARTIAL** | 7 requested, 8 injected by the loader |
| 39 | Terminal: OS-level isolation | **ABSENT** | no Job Object / AppContainer / restricted token |
| 40 | Terminal: child processes governed | **ABSENT** | reaped on timeout, not validated |
| 41 | ObservationProvider, read-only by construction | **PROVEN** | import-graph test; control D |
| 42 | WorldState: known vs assumed, no methods | **PROVEN** | deep structural walk |
| 43 | Plan must name its observation | **PROVEN** | compiler refuses 4 broken bases |
| 44 | Freshness: age AND re-observation | **PROVEN** | `too-old` / `world-changed` / `cannot-verify` |
| 45 | Plan changes when the world changes | **PROVEN** | scenario C: same folder, different plan |
| 46 | Stale plan cannot complete | **PROVEN** | control G |
| 47 | Abstract capabilities, one tool each | **PROVEN** | router refuses ambiguity |
| 48 | Unavailable capability, no substitution | **PROVEN** | compiler + router, two layers |
| 49 | Distinct planning failure codes | **PROVEN** | 8 codes, asserted by name |
| 50 | Planner cannot read or write | **PROVEN** | one `realpathSync`, asserted |
| 51 | Fingerprint detects same-size edits | **ABSENT** | listing metadata only; documented |
| 52 | Junction containment in the observer | **ABSENT** | a junction is followed; tools re-check |
| 53 | PlanProposal inspected before execution | **PROVEN** | `renderProposal` names every field a reviewer needs |
| 54 | Amendment yields a NEW proposal | **PROVEN** | original byte-identical; arrays not aliased |
| 55 | Superseded mission refused at execution | **PROVEN** | `proposalDigest`; control B |
| 56 | Dry run: zero side effects | **PROVEN** | byte-identical world; a control that acts IS caught |
| 57 | Stale world blocks execution | **PROVEN** | `too-old` / `world-changed` / `cannot-verify` |
| 58 | Diff classifies behavioural vs cosmetic | **PROVEN** | `materialChanges` |
| 59 | Review ≠ authorisation | **PROVEN** | no `approvePlan`; approval events still raised |
| 60 | Injected approval fields are inert | **PROVEN** | digest unchanged; compiler ignores them |
| 61 | Compiler carries the declared effect | **PROVEN** | **repaired in M7** — see below |
| 62 | Defensive clone in `amend` | **REDUNDANT** | control showed every path already maps |
| 20 | Mouse injection + attribution | **BLOCKED** | P0: `dwExtraInfo` lost on mouse path |
| 21 | GUI, mission-chosen action | **BLOCKED** | needs 20, and an arming decision |
| 22 | **Release / resume after takeover** | **BLOCKED** | NOT PROVEN, no trustworthy mechanism |
| 23 | Window management governance | **PARTIAL** | `/show`,`/focus` ungated (no injection needed) |
| 24 | Recovery / replanning, live | **PROVEN** | mission:recovery, genuine divergence, 2 attempts |
| 24b | Recovery bounded, no inherited evidence | **PROVEN** | 
ecovery.test.ts, 3 unresolvable-world cases |
| 24c | Objective reconciliation | **PROVEN** | planner/reconcile.ts, refuses ambiguity |
| 25 | Browser mode | **NOT STARTED** | package empty |
| 26 | API mode | **NOT STARTED** | no tool |
| 27 | **Model / provider layer** | **PROVEN (boundary)** | `packages/model/` — HTTP transport, strict accept-or-reject parsing, zero import routes to anything actionable. A real local model now runs behind it. |
| 27a | Model output parsed without repair | **PROVEN** | `model/parse.ts`, one named normalisation; 44 unit controls |
| 27b | Untrusted-reasoner boundary, live | **PROVEN** | 24 adversarial scenarios over a real socket, each stopped at a declared layer |
| 27c | Model cannot grant authority | **PROVEN** | approval-shaped fields produce a **byte-identical digest** |
| 27d | **Local inference runtime** | **PROVEN** | `packages/model/local/`: ONNX Runtime + HF tokenizers, local weights, no egress. Blocked once by WDAC unsigned-binary policy; onnxruntime is signed and loads. |
| 27e | Real model connected to the planner | **PROVEN** | Qwen2.5-0.5B and 1.5B, 127.0.0.1, zero changes to any boundary |
| 27f | **A model that produces valid plans** | **NOT PROVEN** | **0 of 15 attempts across two model sizes.** Rejected correctly every time. See M10 — this is the binding constraint on being useful. |
| 28 | Desktop application | **NOT STARTED** | |
| 29 | Integrated chat | **NOT STARTED** | |
| 30 | Long-running missions | **NOT STARTED** | |
| 31 | Tool discovery / install | **NOT STARTED** | |
| 32 | Authentication handling | **NOT STARTED** | |

---

## Blocked on a human decision

These cannot be resolved by engineering judgement. Each needs a person.

| id | decision | why it cannot be inferred |
|---|---|---|
| **H1** | Arm the operator for real injection | Arming means the automation may act on the user's live desktop. The automation arming itself is the failure mode this project exists to prevent. Every real-injection milestone needs a human to arm, deliberately. |
| **H2** | Release/resume design | Blocked behind H1. A human cannot currently return control to the operator after a takeover, so no real mission can be interrupted and resumed. |
| **H3** | Model provider | **RESOLVED IN PART by M8.** The instruction was to use an available zero-new-spend provider; measurement showed **none is available** — no runtime, no weights, no credentials. So the provider *boundary* was built and proven against an out-of-process adversarial peer, and the remaining choice is now **H5** (install local weights vs. use a hosted free tier). H3 remains open in the sense that no provider is connected. |
| **H4** | Whether to fix the mouse sentinel by changing injection internals | It is in the injection layer, deliberately untouched so far, and the fix weakens nothing but does change a proven component. |
| **H5** | **How to obtain a real reasoner** (new, from M8) | Installing a third-party runtime plus several hundred MB of weights, or sending prompts and folder contents to a third party. Both are human-authority decisions: supply chain, disk, network, and data leaving the machine. The code is done and the seam is one URL; nothing here is an engineering problem. |

**H5 in one line:** do you want AIOS to run a model locally (nothing leaves the machine, needs a
~0.5–4 GB download and a Python/llama.cpp runtime), or call a hosted free-tier API (no local
footprint, better plans, but the user's objective and folder contents leave the machine)?

---

## Milestone queue

Ordered by the autonomous prioritisation rule: safety-critical blockers → architectural
prerequisites → capability gaps → integration → reliability → product.

### M1 — Planner and the first user-driven mission ✅ COMPLETE
Plan contract, planner boundary, deterministic planner, tool router, operand safety,
summarizer boundary, plan inspection, step data flow, 7 negative controls, real end-to-end run.

### M2 — Recovery and replanning, exercised for real ✅ COMPLETE
A genuine mid-mission environmental change, detected from observation, reconciled against a fresh
observation, replanned, recompiled and re-executed to verified completion. Plus two scenarios
built specifically so the negative controls could bite: a world that moves twice, and a correct
replan whose retry then fails. Supervisor added, bounded at 3 attempts, carrying nothing forward
without evidence.

### M3 — Governance depth: consequential-action approval ✅ COMPLETE

Selected over M5 on evidence: recovery exposed that a mission can now plan, recover and write a file
while the governance contract is still a single 123-line file with no approval path for consequential
actions. The Purchase/Delete/ExternalSend/CredentialUse evidence kinds exist and NOTHING
produces them, so a mission has no way to require authorisation even in principle. That is a
gap between what the engine claims to model and what it can enforce, and it is load-bearing for every
capability added after it.

Delivered: an exact five-part approval key (mission, step, kind, target, plan epoch), an
executor gate placed before the tool is even SELECTED, an approval store that refuses any key
never requested, a disposable consequence simulator that travels the same gate, and six negative
controls biting in both the unit suite and on real hardware. A governance hole was found
while building it: the gate keyed only on the plan's DECLARATION, so omitting it would have
acted unapproved. Registrations now carry consequential and a mismatch is a plan defect.

### M5 — Terminal mode ✅ COMPLETE

`run-process`: an allowlisted program, an explicit argument vector, captured output, bounded
lifetime, a reaped process tree, and a reduced environment. Classified **PARTIALLY PROVEN** — see
the isolation section below for exactly what is and is not enforced.

**It is not a sandbox.** Four boundaries, kept apart:

| | enforced? | what it actually does |
|---|---|---|
| executable allowlist | **yes, real** | absolute paths only, so PATH cannot substitute a program |
| argv / path validation | **yes, real** | resolved through `realpath` (a junction cannot smuggle a path out) |
| working directory | set, **weak** | controls where relative paths resolve; restricts nothing else |
| OS-level isolation | **absent** | no Job Object, AppContainer, restricted token, or container |

Not restricted, because nothing here can restrict it: reading or writing any file the user can
reach, network egress, spawning children, the registry, services, scheduled tasks, DLL loading.
The allowlist bounds **which program runs**, not **what that program then does** — so running a
workspace script is classified consequential and requires authorisation rather than treated as
routine.

Env scrubbing measured, not assumed: with a 7-name allowlist the child received those **plus 8 the
Windows loader injects** and the parent cannot suppress. A secret in the parent environment did not
arrive. It is a real reduction, not a sealed set.

`taskkill /T /F` genuinely reaps grandchildren — measured on a live tree, after an earlier probe
gave a false negative by letting the parent exit first.

### M6 — World-aware planning ✅ COMPLETE

`DeterministicWorldAwarePlanProvider` plans from an observed `WorldState` and **refuses to produce a
plan without one**. The compiler rejects any proposal that names no observation, no fingerprint, no
observed facts, or an incomplete one — so "the planner is world-aware" is enforced at the boundary
rather than asserted in a comment.

`ObservationProvider` is read-only by construction: it imports `node:fs` and nothing that can act,
which the tests check by reading the import graph. A `WorldState` is plain data with no methods.

**Three scenarios on the real machine, one objective:**

| | folder | plan chose | completed |
|---|---|---|---|
| A | 5 files, nested 2 deep, 4 extensions | `terminal.run` (node observed present) | yes |
| B | 2 files, no nesting, different extensions | `terminal.run` | yes |
| C | **the same folder as A**, node reported absent | `filesystem.transform` | yes |

A and B differ in their plan text (file counts, extensions, depth, output name) while the phrase
planner emits **byte-identical step intents and expected results** for both. C is the load-bearing
one: identical objective, identical folder, different observation, **different plan**.

### M7 — Plan review, amendment, and dry run ✅ COMPLETE

A `PlanProposal` is **reviewable data**, not executable authority. `packages/review/` shows it,
amends it, diffs it, dry-runs it, and compiles the result — and imports no executor, no
`child_process`, no filesystem (in the dry run) and no governance, which the tests check by reading
the import graph.

**Amendment is a new plan, never an in-place mutation.** `compilePlan` stamps a `proposalDigest` on
the mission; `execute()` re-checks it against whatever the caller says the user reviewed. Amend,
then run the mission that was already compiled, and the executor refuses with
`amended after compilation`.

**The dry run has a real no-action boundary.** It is not "execute and ignore": the module cannot
reach a tool's `run` at all, and it says nothing about whether a step would *succeed* — only whether
it could be dispatched. A control writes the same report through an implementation that *does* call
the tool, to show the check is load-bearing.

### M8 — The first AI planning provider ✅ BOUNDARY COMPLETE · WEIGHTS NOT CONNECTED

Selected on evidence, not on milestone number. AIOS could plan, execute, recover, verify and govern
consequences, but every plan came from hand-written logic, so the capability was only reachable if a
human anticipated the phrasing.

**What is proven.** A reasoner can be introduced with **zero changes** to the compiler, the executor,
the governance contract, the router, the verifiers or a single tool. `packages/model/` is a
`PlanProvider` that sends an observation over HTTP and returns a `PlanProposal`. Its output is parsed
**strictly: accepted or rejected, never repaired.** It imports no executor, no governance, no
`ControlSurface`, no tool, no `child_process` and no `node:fs` — so "the model cannot act" is a
property of the import graph, checked by reading it.

The real proof is an **out-of-process adversarial peer** on a real socket
(`packages/model/adversarial-peer.ts`), driven through 24 scenarios. Each declares the layer that must
stop it, so a scenario stopped for the wrong reason is reported as a failure rather than counted as a
pass. 24/24 stopped where intended; 42 live checks pass; 43 new unit tests; 270 total, 0 fail.

Required controls, and where each is actually proven:

| Control | Stopped at |
|---|---|
| malformed output | parser |
| unknown tool | **router**, not the parser |
| missing verifier | parser/compiler |
| dangling + forward dependency | parser |
| consequential plan | **approval gate** |
| fake approval in output | digest whitelist — produces a **byte-identical digest** |
| direct tool invocation | **import graph**, machine-checked |
| stale target | tool containment + freshness contract |
| model claims success | compiles to `pending`; verifiers are the only route to `verified` |

**Two controls were built specifically so they could fail.** A `lawful-terminal` scenario proves the
policy discriminates rather than refusing everything — it passes preflight and stops at the approval
gate. And suppressing the verifiers fails the *first* step, so every dependent is **skipped**: an
unproven step is not a usable one, which is stronger than "produced but unverified". The same plan
with real verifiers completes, so suppression is demonstrably what changed the answer.

**What is NOT proven, and is not claimed.** No language model ran. This machine has **no model
runtime, no weights and no credentials** — measured, not assumed (`EVIDENCE.md` §M8). The peer is
adversarial and deterministic; it defeats far less than a real model would find. Whether a real
model's output distribution is *usable* — well-formed often enough to be worth having — is
untested. Connecting weights is a change to **one URL**.

### M9 — A REAL LOCAL MODEL ✅ ARCHITECTURE HELD · **THE MODEL WAS NOT GOOD ENOUGH**

H5 resolved: **local inference only**. Nothing leaves the machine.

**The chain is unchanged.** `ModelPlanProvider` → `PlanProposal` → review/digest → compiler →
governance → executor → tools → independent verification. Zero changes to the compiler, the executor,
the governance contract, the router, the verifiers, or any tool. The only new thing is a peer at the
far end of the same HTTP seam: `packages/model/local/server.py`, a Python process that does text in and
text out and has no route to a tool, an approval, a status, or the machine.

**The answer to the milestone's question, measured: no, not at this size.**

| model | params | throughput | plans produced that survived the parser |
|---|---|---|---|
| Qwen2.5-0.5B-Instruct | 0.5B | ~7 tok/s | **0 / 9** attempts |
| Qwen2.5-1.5B-Instruct | 1.5B | ~0.8 tok/s | **0 / 6** attempts |

Both are locally coherent — the 0.5B answers "capital of France" correctly, which is what proves the
decode loop is sound rather than the harness. Neither produces a plan.

**What each actually did, which is more useful than the rate:**

- **0.5B — echoed the request.** With request keys `objective`/`availableCapabilities`/`outputRoot`/
  `world`, it returned an object with *those keys*. It was transcribing.
- **1.5B — copied the example.** It emitted `"path": "<the observed root>"` — the placeholder, verbatim.
- **1.5B, after three measured prompt fixes — got close.** Structurally correct steps, real capability
  names, real paths, proper `verification` objects. It failed on *truncation* at the token ceiling, and
  once on emitting a step where the plan envelope belonged.

**Three model-facing changes were made, each forced by a measurement, and none touched acceptance:**

1. **Request keys renamed, then nested under one key.** Measured twice: v1 keys were echoed back; v2's
   `task` key was adopted as the container for its own *answer*. One top-level key cannot be mistaken for
   a three-key response, so the mechanism is gone rather than an instance of it. A unit control asserts
   the request has *exactly one* top-level key, because this failed twice and will fail again silently.
2. **The schema description became a real, filled-in example.** The old "schema" put English
   descriptions in the *key position*, so the model copied them as data.
3. **The example was compressed** from ~450 to ~254 tokens. The 1.5B copied the example's verbosity and
   ran out of tokens mid-JSON.

`parse.ts` is byte-for-byte unchanged and still has exactly one normalisation. A prompt that produces
better plans is legitimate; a parser that accepts worse plans is not, and no validity rate justifies it.

**What this milestone did prove, which is the part that matters:**

Every single model output — across 15 attempts, two model sizes, five request renderings, and a dozen
truncation and echo modes — was **rejected at the correct layer with a precise reason**, and **nothing
unsafe reached execution, the compiler, or a tool**. The architecture did its job on every input,
including hostile and malformed ones. A reasoner was introduced and no property weakened.

**Honest conclusion:** AIOS now has a real local model and it is not yet good enough to plan with. The
next step is a model that is, or a genuinely different approach to structured output — not a weaker
parser. Recorded as a defect, not smoothed over.

### M10 — A larger local model, or a structured-output mechanism

Options, in order of preference:

- **A 3B–4B local model.** The 1.5B failed on truncation and envelope discipline, not on reasoning.
  7B-class models emit correct plans routinely. Cost: 3–8 GB download and roughly 0.1–0.2 tok/s on this
  2-core machine, which is a 20–40 minute plan. **A machine that cannot generate a plan in reasonable
  time is itself the binding constraint** — so this is gated on hardware, not just on appetite.
- **Constrained decoding (grammar/JSON-schema-guided generation).** llama.cpp and GGML support it, and it
  makes malformed output impossible. It would change the threat model: the validator would no longer be
  the thing that rejects bad structure, the grammar would be. That may be a fine trade *provided* the
  grammar is itself treated as a security boundary and the adversarial suite is rerun against it. It is
  explicitly **not** a way to make the validity rate look good.
- **A hosted provider.** Better models, no local footprint, but data leaves the machine — a human
  decision, and H5 chose local.

### M11 — Read-only browser observation (was M4)
`packages/browser` is empty. Enumerate tabs, read the DOM, extract text — no injection, no arming.
Interaction comes later, behind H1.

*Unblocked for the read-only half. Interaction needs H1.*

### M12 — Desktop application
Only once the execution foundation is trustworthy — which is now the case for a bounded, supervised
subset. Per the specification: no decorative UI before the underlying capability is ready.

### M13 — Long-running missions, history, completion reporting

### M14 — Tool discovery and safe installation
Provenance, version, licence, purpose, dependencies, security implications, rollback — all
established before any install.

---

## Superseded, kept so the numbering does not drift

- **M4** read-only browser observation → **M10**.
- **M5** terminal mode → **complete**.
- **M6** release/resume → still blocked on H1 + H2 (unchanged).
- **M7** mouse attribution → still blocked on H4 (unchanged).
- **M8** model layer → **boundary complete**, weights → **M9**.

**Release/resume (H1 + H2) remains the single largest blocker to the Definition of Done**, and mouse
attribution (H4) remains the largest *correctness* defect. Neither is worked on without its human
decision.

---

## Standing rules

1. A milestone is complete only with implementation, passing tests, **biting** negative
   controls, real verification where appropriate, and documented defects.
2. Every negative control must be shown to fail when its protection is removed.
3. Never convert a failed proof into a success by weakening the test.
4. Never claim `PROVEN` without evidence on the real system.
5. Report as status, not as a request for instructions.


---

## M10 - CONSTRAINED DECODING: COMPLETE, AND IT DID NOT SOLVE THE PROBLEM

Authorised 2026-10-08 in preference to a larger model. Status: **complete, honest, negative.**

### Capability ledger additions (M10)

| # | Capability | Status | Evidence |
|---|---|---|---|
| 28a | Structural grammar over `PlanProposal` | **PROVEN** | 90 controls; 0.5% overhead |
| 28b | Logit masking in the decode loop | **PROVEN** | constrained output parses where unconstrained does not |
| 28c | Grammar rejects dead prefixes rather than wedging | **PROVEN** | refused at the FIRST character of the measured dead prefix |
| 28d | `capability`/`tool`/`args` stay unfiltered by the grammar | **PROVEN (deliberate)** | `test_grammar_does_not_filter_semantics` fails if tightened |
| 28e | Exhaustion is a refusal, not a 500 | **PROVEN** | was HTTP 500; measured and fixed |
| 28f | Constrained 1.5B produces a usable plan | **NOT PROVEN** | 0/4; ceiling reached inside a string |

### What changed and what did not

Changed: a new grammar + masking (additive), two harness bugs, one strictly-stricter parser rule.
Unchanged: `PlanProvider`'s contract (the grammar rides the existing `headers` field), the compiler,
governance, router, verifiers, review layer, `control-core`.

### The answer to the question that was actually asked

> Can constrained local inference produce genuinely useful plans while every M1-M9 safety property
> remains intact?

**The safety half: yes, and that is now proven rather than assumed** - 274 TS tests, 90 grammar
controls, route audit PASS, `control-core` byte-identical, zero executions from four attempts.

**The usefulness half: no.** The grammar made output well-formed and did not make it right. That is
the finding, and reporting "more outputs parse" as progress would have been the trap.

### Next milestone, selected from the evidence

**M12 - TOKEN BUDGET AND DECODING SHAPE**, chosen because it is now the only cheap thing left to try
before a bigger model: the binding failure is the 512-token ceiling reached inside a string value.
Three testable interventions, none of which touches a validator:

1. **Raise the ceiling** and confirm whether plans complete at all. (Cheapest possible test; may be
   all that is needed.)
2. **Constrain free-form string LENGTH** in `args` and prose fields - a structural bound, sanctioned,
   and it removes the model's ability to ramble. Directly targets the measured failure.
3. **Backtracking on a dead prefix**, if (1) and (2) are insufficient.

Only if all three fail is a larger model justified - and by then the decision would rest on a
measured ceiling rather than a benchmark score.

### Deliberately NOT selected

- **M11 browser observation** stays queued: valuable, narrower, and does nothing for the binding
  constraint.
- **Desktop app, release/resume (H1/H2), mouse sentinel (H4)**: all blocked on human decisions.
- **Pivoting inference to `onnxruntime-genai`**: see `docs/ECOSYSTEM-AUDIT.md`. It is the right long
  term target and the wrong move now - it cannot load the M9 model without a re-export, so it is a
  model-conversion project, not a dependency swap.


---

## M13 - MODEL CEILING EXPERIMENTS: COMPLETE, NEGATIVE

Both cheap interventions measured and both failed. Recorded rather than discarded.

| Experiment | Change | Useful plans | Latency | Verdict |
|---|---|---|---|---|
| E1 | tokens 512->2048, **wall clock 150->900s** | 0/3 | 105-156s | syntax 3/3, semantics 0/3, **false refusals 3/3** |
| E2 | E1 + string cap 400->120 chars | 0/3 | **307-309s** | no gain, 2.3x slower |
| E3 | grammar backtracking | not built | — | **no failing case remains to fix** |

**M10's diagnosis was wrong and is corrected in EVIDENCE.md.** The binding constraint was the
150-second `MAX_WALL_SECONDS`, not the 512-token ceiling. Raising tokens 4x changed nothing because
generation was never token-bound - it stopped at 398 tokens.

**The finding that outranks all three experiments:** raising the ceiling turned an obviously-broken
document into a well-formed one containing nonsense. Constrained decoding made a failure *harder to
see*, because `refusal` is always available as a valid completion. Genuine refusal 0/3, false
refusal 3/3.

### Escalation decision

A larger model is **still not justified**. The stated bar was: syntax no longer dominant, task quality
insufficient, performance acceptable, hardware able to support it. Two of four are unmet.

The honest read is that 1.5B cannot plan a two-step mission. Constrained decoding removed the
*structural* obstacle and exposed the *capability* one, which is the real finding of M8-M13 taken
together.

### Next milestone, selected from the evidence: M14 - THE INJECTION AUDIT BLIND SPOT

**Why this outranks everything else.** It is a safety defect, not a capability gap, and it makes a
guarantee the project actually makes in writing narrower than believed:

> the injection audit asks whether a route reaches an injection **primitive**; it should ask whether a
> route changes the **machine**.

`/show`, `/restore`, `/focus`, `/guifocus` reach no primitive, so they pass unexamined - yet they
show, restore and focus real windows, and they do not consult `MayInject()`.

Until the audit's model is widened, "every action that can change this machine passes through the
declared gate" is an assertion the tooling cannot actually support. Every other candidate is blocked
(H1, H2, H4), second-order (durable state, browser reproducibility), or measured to be dead
(backtracking).

**Blocked on a human decision (H5):** the routes are in `control-core`, which this project does not
modify without an ADR and a human decision. Widening the *audit harness* would strictly increase
detection and is not itself a regression, so it is separable and is the recommended first half.

### Queued after M14

durable state (SQLite) - evidence currently dies with the process · browser reproducibility -
`playwright` undeclared and the Chromium path hardcoded · M15 model escalation, only if a
model-agnostic route is found that does not depend on this hardware.


---

## M14 - INJECTION AUDIT WIDENED: COMPLETE

Authorised 2026-10-08. The first half - widen the audit, do not touch the core - is done.

### What changed

The audit now asks whether a route can change the machine, not whether it injects input. It resolves
mutating **helpers** as well as primitives, carries a `READ_ONLY` set so it does not flag everything, and
returns three exit codes that distinguish *known gap* from *undocumented breach*.

### The answer

**The stronger invariant is FALSE**, and it was previously untestable. Three routes change real machine
state without a gate: `/show`, `/restore`, `/focus`. A fourth, `/guifocus`, was wrongly listed in this
project's own records as ungated - it performs pure reads.

`/focus` is the substantive one: `Verify()` checks the window is the right window, not that the caller is
permitted. A caller with no injection permission can still take the foreground from the person at the
keyboard.

### Ledger

| # | Capability | Status | Evidence |
|---|---|---|---|
| 29a | Audit detects machine mutation without input injection | **PROVEN** | 7 window primitives + 2 helpers |
| 29b | Mutating helpers resolved, not just primitives | **PROVEN** | `/focus` via `Win.Focus` |
| 29c | Read-only routes not flagged | **PROVEN** | `/guifocus` asserted a read |
| 29d | New ungated route raises exit 2 | **PROVEN** | injected `BringWindowToTop` route, CLI-verified |
| 29e | `KNOWN_GAPS` cannot silence the alarm | **PROVEN** | control fails if used that way |
| 29f | Stale entries detected | **PROVEN** | check fires on an invented entry |
| 29g | All machine-state routes gated | **NOT PROVEN** | 3 gaps; needs control-core (ADR 0003) |

### Blocked: H5

Three `MayInject()` calls and three `InjectionRoutes` entries in `OperatorHost.cs`. Full code and the
three things to weigh are in [`decisions/0003-gate-window-management-routes.md`](decisions/0003-gate-window-management-routes.md).
`control-core` is not modified without a human decision.

### Recommended next milestone: M15 - DURABLE STATE

Selected because it is the highest-value item that is **not** blocked and **not** safety-critical.

Evidence for it, from the M12 audit: there is **no SQLite, no database, no file-backed event log**.
Mission state, evidence and history are **in-memory**. A crash loses all of it. For a product whose
selling point is an auditable history, "the history dies with the process" is a structural defect, and it
also blocks long-running missions outright.

Scope: durable event/evidence store, schema, migration story, and the read path that renders it. **No
safety invariant changes** - the store records what verifiers already observed; it grants nothing.

After that: browser reproducibility (`playwright` undeclared, Chromium path hardcoded), then model
escalation only if a model-agnostic route exists that does not depend on this hardware.

### Still human-blocked

H1/H2 release-after-takeover (I will not ask you to press anything) · H4 mouse sentinel · **H5 window
routes (ADR 0003)** · G6/G7 on the other repository.


---

## M15 - DURABLE STATE: COMPLETE (store proven; not yet on the mission path)

| # | Capability | Status | Evidence |
|---|---|---|---|
| 30a | SQLite-backed durable store, zero npm deps | **PROVEN** | `node:sqlite`, WAL, FKs |
| 30b | Versioned forward-only migrations | **PROVEN** | idempotent across three opens |
| 30c | Mission/step/evidence/history survive restart | **PROVEN** | 19 controls |
| 30d | Approvals invalidated on restart | **PROVEN** | incl. a real second OS process |
| 30e | In-flight steps recover to `pending` | **PROVEN** | never `done`, never `verified` |
| 30f | Corrupt / future / inconsistent stores fail safely | **PROVEN** | refuse, or quarantine |
| 30g | Persisted evidence ≠ live observation | **PROVEN** | session-scoped, counted separately |
| 30h | Persistence grants no authority | **PROVEN** | `ResumePermit` has no permission field |
| 30i | A **live mission** persists anything | **NOT PROVEN** | `executor.ts` does not call the store |

### The defect that mattered most

Approvals survived a restart. `invalidateForeignApprovals` selected `id, session_id` and then filtered
on `state` — a column it never fetched — so `stale` was always empty and **nothing was ever
invalidated**. The exact outcome this milestone exists to prevent, shipped green, caught by the control
that asserts the dangerous property rather than the intended one.

### Next milestone: M16 - INSTRUMENT THE EXECUTOR

Chosen from the evidence, not for convenience. The store is proven and unwired; that gap is now larger
than anything else on the list that is not blocked on a human decision.

Scope: the executor writes mission transitions, step results and evidence through the store; the live
harnesses gain a restart-recovery proof; `resumeMission` gates the *resume* path only — never the
governance path.

**Explicit constraint:** writing must not be able to fail quietly, and must not be able to block or
alter an action. If persistence fails mid-mission the correct behaviour is to fail the step loudly, not
to continue as though it were recorded. There is a control for that in M16's scope.

### Queued after that

* **Browser reproducibility** — `playwright` is imported with **zero declared npm dependencies** and the
  Chromium path is hardcoded to `ms-playwright/chromium-1243`. It works on this machine by accident of
  layout and is not reproducible.
* Model escalation — only if a model-agnostic route exists that does not depend on this hardware.

### Still human-blocked

H1/H2 release-after-takeover · H4 mouse sentinel · **H5 window routes (ADR 0003)** · G6/G7 on the other
repository.
