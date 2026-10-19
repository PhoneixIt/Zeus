---

## PHASE 4 ENTRY PLAN (proposed - not authorised, not started)

Authored 2026-10-11 immediately after Phase 3 (orchestrator convergence) reached
validation-complete. **Nothing in this section has been implemented.** It is an entry plan, and it
deliberately reuses this roadmap's existing milestone grammar, ledger and standing rules rather than
creating a second plan.

### The gap this enters through

Two proven halves exist and neither knows about the other.

| half | what it proves | where |
|---|---|---|
| **Mission engine** | every *step* verified against declared evidence | M1-M7, M15-M16 |
| **Orchestrator** | an *independent model* reviewed the evidence and returned a verdict | Phase 3, `packages/agent/` |

`packages/agent/` is **absent from this roadmap entirely** - it appears only as an audit citation in
`docs/model-provider-contract.md`, and in no `package.json` script. It is proven (35 agent tests,
18 convergence, type-check clean) and orphaned. That is the opportunity and the risk.

The missing third thing is the one the Definition of Done actually asks for:

> **Independent verification of meaningful results** - and **An accurate completion report**

Step verification proves the *steps* ran. Reviewer verification proves *a model looked*. Neither
establishes that the **objective** was met, and nothing today can say so in a sentence a person can
act on.

### Proposed vertical slice: M18 - OBJECTIVE-LEVEL VERIFICATION

**One natural-language objective, end to end, with an independent verdict on the objective itself.**

```
objective (natural language)
  -> planner (PROVEN: deterministic + world-aware)   [model slot optional, NOT required]
  -> compiler + governance gate (PROVEN)
  -> executor acts within permissions (PROVEN)
  -> step verifiers check declared evidence (PROVEN)
  -> OBJECTIVE VERIFIER: independent model judges objective vs accumulated evidence   <-- NEW
  -> divergent  -> supervisor replans (PROVEN, M2)
  -> restart    -> resume from durable store (PROVEN, M15/M16)
  -> accurate completion report naming the objective verdict and its evidence           <-- NEW
```

This is **integration of two proven systems plus one genuinely new judgement**, not a connector
collection and not a development-only agent. It advances every axis the long-term goal names:
understand objectives (the verdict is about the objective), plan, coordinate capabilities, act within
permissions, verify independently, recover.

### Why this and not the alternatives

| candidate | why not |
|---|---|
| **Model that produces usable plans** (M9) | Roadmap already measured this twice: 0/15 plans, and constrained decoding did not help (M10). A larger model is **explicitly not justified** until a model-agnostic route exists. Re-proposing it now would contradict standing evidence. |
| **Fix `control:proofs` RED** | Requires editing `control-core/src`. Rule 1 and H5: ADR + human decision. Cannot be planned around. |
| **Release/resume after takeover** (H1/H2) | Largest blocker to Definition of Done, and **human-blocked**. Not ours to schedule. |
| **Browser observation / reproducibility** | Real, but narrow. Roadmap already measured that it "does nothing for the binding constraint". |
| **A desktop application** | Roadmap rule: "no decorative UI before the underlying capability is ready". The capability is not ready. |

M18 is the highest-value item that is **neither blocked on a human decision nor already proven**. It
also sits at the roadmap's own priority position - *integration* - which is exactly where a
convergence-proven orchestrator belongs.

### Entry criteria (measured, not assumed)

| # | criterion | state | evidence |
|---|---|---|---|
| E1 | Orchestrator parses, type-checks, 35/35 agent + 18/18 convergence | **MET** | Phase 3 record, `docs/EVIDENCE.md` |
| E2 | Mission engine: compiler, governance, router, verifiers, supervisor | **PROVEN** | M1-M7 ledger rows 6,7,12,13,24 |
| E3 | Durable store proven; executor persistence proven | **PROVEN** | M15/M16 rows 30a-31h |
| E4 | A model that emits a valid `PlanProposal` | **NOT MET** | M9/M13, 0/15 |
| E5 | `control:proofs` green | **NOT MET** | M17, RED |
| E6 | Release-after-takeover (H1/H2) | **NOT MET** | roadmap, still blocked |

**Gating rule:** M18 MUST complete with E4, E5 and E6 unmet. Any design that needs a real planner,
a green proof gate, or release-after-takeover is out of scope and is a different milestone. The
deterministic and world-aware planners (PROVEN) must be sufficient to carry it.

### Scope

1. An **objective verdict** type, structurally distinct from step verification. It cannot be
   synthesised from step results.
2. The orchestrator supervises the mission engine as an **outer loop**: rounds, review budget,
   persisted state, terminal statuses. Reuse the convergence-proven loop unchanged where possible.
3. An **independent reviewer** judges the objective against accumulated evidence, using the already
   measured-free model path (`nemotron-3.5-lightning-free`, 31.7s, $0) and the existing
   `normalizeModelId` independence derivation.
4. Divergence routes into the **existing** supervisor replanner.
5. Restart resumes from the **existing** durable store; never `done` without evidence.
6. A **completion report** that states the objective verdict and the evidence behind it.

### Reuse-first

**Reuse, unchanged:** mission-engine executor/compiler/governance/router/verifiers/supervisor;
`node:sqlite` durable store (M15); the orchestrator loop, `evidenceFingerprint`, `readVerdict`,
`normalizeModelId`; `materialChanges` for evidence diffing.

**Add no dependencies.** The repository has **zero npm dependencies** and that is load-bearing
(ECOSYSTEM-AUDIT). No new runtime: H5 chose local inference and it already works. No network egress.

**Do not** make MCP an authority - ECOSYSTEM-AUDIT E is explicit: an MCP server is another process
asserting it did something, which is the exact "fake verified" failure the 24-scenario adversarial
suite exists to prevent. Optional adapter only, if at all.

**Study-only, already audited, no action now:** `onnxruntime-genai` (future inference home),
MCP adapter, desktop stack (deferred until the capability is ready).

### Acceptance criteria (measurable)

Each is a control that must be **shown to fail** when its protection is removed, per standing rule 2.

| # | criterion | proof required |
|---|---|---|
| A1 | An objective verdict exists and is **not** derivable from step verification | type + construction test |
| A2 | A mission whose steps all verify but whose **objective is unmet** is reported not-done | real mission, this machine |
| A3 | Removing the objective verifier flips A2 to done | negative control that bites |
| A4 | Independence is **derived**, never supplied by a caller | control fails if one model can claim independence |
| A5 | Restart mid-mission resumes from the store; never `done` without evidence | real second process |
| A6 | The completion report names the objective verdict; `outcome-unknown` never reads as success | control on the report text |
| A7 | `$0`: zero npm deps added, zero egress, free/local models only | dependency + network diff |
| A8 | No regression: 683/683 unit, 35/35 agent, 18/18 convergence, type-check 0 errors | full gates re-run |
| A9 | `control-core` byte-identical | hash before/after |

### Definition of done for M18

- Implementation, passing tests, **biting** negative controls, one real unattended run on this machine.
- Objective verdict documented in `docs/EVIDENCE.md` with a reproduction command.
- New capability-ledger rows in this file.
- Zero new dependencies; zero egress; `control-core` untouched.
- No human decision required to complete it.

### Effort estimate (estimates, not measurements)

| part | estimate | note |
|---|---|---|
| Objective verdict type + A1 | 0.5 day | small, well-bounded |
| Orchestrator supervises mission engine (A2) | 1-2 days | the real integration work |
| Independence + negative controls (A3, A4) | 1 day | pattern already exists in `reviewer.ts` |
| Restart + store integration (A5) | 1 day | store and recovery both PROVEN |
| Completion report (A6) | 0.5 day | |
| Gates, evidence, ledger (A7-A9) | 0.5 day | |
| **total** | **~4-6 days** | excludes the live-run latency, which is measured not guessed |

### Risks

1. **The objective verdict could become a rubber stamp.** This is the real risk: a check that always
   passes is worse than none because it manufactures confidence. Mitigation: refusal-by-default, and
   A3 must fail loudly when the check is removed. If A3 cannot be made to bite, **stop and record it**
   rather than ship a soft check.
2. **Latency compounding.** An orchestrator round plus a mission plus an objective verdict is
   materially slower than either half. Report measured numbers; do not hide them behind the budget.
3. **Scope creep into "AI maintains AIOS".** Explicitly out of scope. M18 verifies *objectives the
   human set*; it does not generate its own objectives or edit the repository's own governance.
4. **Orchestrator provenance.** `packages/agent/` is untracked in git; the Phase 3 repair is
   hash-proven and execution-proven but has no authoritative pre-tear source. Carried forward from
   the Phase 3 record, not resolved here.
5. **Two proven systems, one integration.** Integration is where this project's recorded defect class
   lives ("plausible-looking code that is wrong when executed"). Assume A2 will fail first and treat
   that as the milestone working, not breaking.

### Deliberately NOT in scope

- No new capability: browser, desktop, API mode. M11-M14 remain queued as written.
- No model planner. E4 stays unmet and the slice must not need it.
- No `control-core` change, no H1/H2/H4/H5 work.
- No connector framework as an end in itself.

### Status

**PROPOSED. Not authorised. Not started.** Phase 4 proper begins only when a human accepts this entry
plan or substitutes a different milestone. Per standing rule 5, this is reported as status, not as a
request for instructions.