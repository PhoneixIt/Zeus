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
| 24b | Recovery bounded, no inherited evidence | **PROVEN** | ecovery.test.ts, 3 unresolvable-world cases |
| 24c | Objective reconciliation | **PROVEN** | planner/reconcile.ts, refuses ambiguity |
| 25 | Browser mode | **NOT STARTED** | package empty |
| 26 | API mode | **NOT STARTED** | no tool |
| 27 | **Model / provider layer** | **NOT STARTED** | **there is no AI in AIOS yet** |
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
| **H3** | Model provider | §zero-new-spend. Free/local options exist but choosing one is a product and privacy decision, not a technical default. |
| **H4** | Whether to fix the mouse sentinel by changing injection internals | It is in the injection layer, deliberately untouched so far, and the fix weakens nothing but does change a proven component. |

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

### M8 — The first AI planning provider — NEXT

Selected on evidence, not on milestone number. AIOS can now plan, execute, recover, verify and
govern consequences — but every plan still comes from a hand-written `INTENTS` table, so the
capability it unlocked is only reachable if a human anticipated the phrasing.

The highest-value next step is not another capability. It is making the EXISTING capabilities
reachable from ordinary language, which is the gap between a working engine and a usable product.
Concretely: an `ObservationProvider` that reports what is actually on the machine (workspace
contents, available programs, git state) so the planner selects from real options rather than a
guess, and a `PlanProvider` implementation that can be driven without a model.

Browser observation (M4) stays queued: valuable, but its interactive half is blocked behind H1
and read-only DOM work is largely covered by the terminal capability now in place.
One 123-line file is thin for the role it plays. Add approval requirements for consequential
actions (`Purchase`, `Delete`, `ExternalSend`, `CredentialUse` evidence kinds already exist but
nothing produces them), and prove a consequential step cannot execute without authorisation.

*Unblocked.*

### M4 — Browser mode, observation first
`packages/browser` is empty. Start with **read-only** browser observation — enumerate tabs,
read the DOM, extract text — which needs no injection and no arming. That alone unlocks real
research capability safely. Interaction comes later, behind the release/resume blocker.

*Unblocked for the read-only half. Interaction needs H1.*

### M5 — Terminal mode
`cli` observation is proven but there is no terminal *tool*. A terminal capability is the
highest-leverage addition for real work and needs no injection (spawn a process, capture
output). Must be sandboxed to the workspace and must never bypass credential prompts.

*Unblocked.*

### M6 — Release/resume — BLOCKED ON H1 + H2
The single largest blocker to the Definition of Done. Cannot start without a human arming
decision, because every candidate design must be validated against a real takeover.

### M7 — Mouse attribution — BLOCKED ON H4
P0. The sentinel does not survive the Windows mouse path, so operator clicks are classified as
human. Conservative but wrong. Must not be attempted while `mouseTaggedSeen` is 0.

### M8 — Model layer — BLOCKED ON H3
`PlanProvider` exists precisely so this is a substitution rather than a rewrite. Blocked only on
the provider decision.

### M9 — Desktop application
Only once M2, M3 and M5 give it real capability to present. Per the specification: no
decorative UI before the underlying capability is ready.

### M10 — Long-running missions, history, completion reporting

### M11 — Tool discovery and safe installation
Provenance, version, licence, purpose, dependencies, security implications, rollback — all
established before any install.

---

## Standing rules

1. A milestone is complete only with implementation, passing tests, **biting** negative
   controls, real verification where appropriate, and documented defects.
2. Every negative control must be shown to fail when its protection is removed.
3. Never convert a failed proof into a success by weakening the test.
4. Never claim `PROVEN` without evidence on the real system.
5. Report as status, not as a request for instructions.
