# 0002 — Persistent project memory before new capability

Date: 2026-10-08 · Status: **accepted** · Supersedes nothing

## Context

A repository checkpoint against the full vision was run before choosing the next milestone
(`docs/ARCHITECTURAL-AUDIT.md`). It found that four of the seven required authoritative documents did
not exist:

| Document | State found |
|---|---|
| `PROJECT-VISION.md` | **absent** |
| `ARCHITECTURE.md` | **absent** — `docs/architecture/` existed as an *empty directory* |
| `safety/GOVERNANCE-CONTRACT.md` | **absent** |
| `DEVELOPMENT-RULES.md` | **absent** |
| `ROADMAP.md`, `EVIDENCE.md`, `known-defects.md` | present |

The safety-critical reasoning — why the injection gate is a table and not a prompt, why the grammar
must stay permissive, why `control-core` must not be modified, why release-after-takeover is not
implemented — existed only in conversation. `EVIDENCE.md` and `known-defects.md` carried parts of it
in prose, scattered across 773 and 304 lines respectively, and the invariants themselves were nowhere.

## Decision

Write the four missing documents before adding any capability.

## Rationale

**Every other available gap was either blocked or cheap-but-second-order:**

- release-after-takeover, the mouse sentinel and window-management gating are blocked on human
  decisions (H1, H2, H4);
- durable state, Job Objects and browser reproducibility are real gaps but add behaviour;
- the model-ceiling experiments are worth running and are next.

**This one is a precondition for all of them.** A project sold on a safety contract must ship the
contract. And a contributor — including a future session of mine with no memory of this one — could
weaken a boundary without any record of why it existed. `docs/architecture/` being an *empty
directory* is the sharpest version of that risk: something was intended there and never written.

The cost is one milestone of documentation. The alternative is that the next thirty milestones are
built by someone who cannot tell a deliberate limit from an oversight.

## Consequences

- `PROJECT-VISION.md` states the destination, the explicit refusals, and the discipline.
- `ARCHITECTURE.md` states current truth, including the three empty packages, the absent durable
  state, and the absence of any OS-level isolation.
- `safety/GOVERNANCE-CONTRACT.md` gives each of the 14 invariants **the control that enforces it** and
  **the proof that it bites**.
- `DEVELOPMENT-RULES.md` records the environment traps and the recurring defect class, so they are not
  rediscovered.
- `ARCHITECTURAL-AUDIT.md` files the classification and this decision.

The model-ceiling experiments requested alongside this are numbered **M13**, so that "M12" in the
roadmap refers to one milestone rather than two. They are next, and unblocked.

## Alternatives rejected

- **Write docs at the end.** Rejected: the end is when context is gone and the reasoning has been
  compressed into a paragraph that reads like a preference.
- **Fold everything into `README.md`.** Rejected: a 57-line README cannot carry a safety contract, and
  mixing vision with commands makes both harder to maintain.
- **Only fill the empty directory.** Rejected: an `ARCHITECTURE.md` without a governance contract
  describes structure without the rules that constrain it, which is the least useful of the two.