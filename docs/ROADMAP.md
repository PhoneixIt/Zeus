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

### M5 — Terminal mode — NEXT

Selected over M4 on evidence. Governance now blocks consequential actions, so the
next capability added should be the one with the widest legitimate use and the least
consequence: running a process. A terminal capability needs no injection, no arming and no
human decision, and it unlocks real work immediately - whereas browser OBSERVATION (M4) is
valuable but narrower, and its interactive half is blocked behind H1 anyway.

Concretely: a cli/	erminal tool that spawns a process inside the workspace, captures
stdout/stderr and the exit code, refuses to run outside the workspace, refuses interactive
programs and anything that could prompt for a credential, and is verified by re-running
independently or by checking the exit code against the filesystem. Sandbox first, breadth second.
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
