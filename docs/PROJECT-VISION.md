# AIOS â€” project vision

This is the destination. It is written once, here, so that no other document has to restate it and
no future contributor has to infer it from code.

---

## 1. What AIOS is

A **governed AI operating layer for Windows**. A person states an objective in plain language. AIOS
observes the real machine, plans, selects appropriate execution methods, operates Windows â€” GUI,
browser, filesystem, terminal, processes, APIs, applications â€” verifies what actually happened,
recovers when reality diverges from the plan, and keeps working. The human retains absolute control
at every point, and the system is built so that control does not depend on the model's intentions.

It is a **desktop product on the user's own machine**. Not a web app, not a service. Local-first.

## 2. The property that defines it

**AIOS may only act on authority it can prove, never on authority it was told about.**

Everything below follows from that. The model is a planner, not an authority. It emits a proposal;
a compiler turns a proposal into a mission or refuses; governance decides what may happen; the
executor performs only what governance permitted; a verifier â€” structurally separate from the tool
that acted â€” decides whether it worked.

A model cannot authorise execution. A model cannot execute. A model's claim that something succeeded
is not evidence that it succeeded. If the chain from intent to effect cannot be traced to a human-
authorised permission, the action does not happen.

## 3. What it must do

- Accept a natural-language objective.
- Observe the real machine and world, read-only, without pretending to more perception than it has.
- Plan, including choosing *how* to act â€” not only *what*.
- Operate Windows: filesystem, terminal, processes, APIs, browser, arbitrary desktop applications.
- Verify outcomes independently, and record evidence.
- Recover and replan when the environment diverges from the plan.
- Support human takeover and a latched emergency stop at any moment.
- Route consequential actions through governance and explicit approval.
- Run long missions without losing the thread.
- Maintain a durable, legible history.
- Be model-agnostic and locally runnable by default.
- Be commercially distributable, signed, updatable, and licensed.

## 4. What it must refuse â€” stated, not implied

Universal capability is not claimed. These refusals are features.

- **MFA, OTP, CAPTCHA, security challenges.** Never solved, never bypassed, never worked around.
  Hand off to the human and record the hand-off.
- **Credentials.** The human types them. AIOS never reads, stores, logs or transmits a secret.
- **Unknown tools and capabilities.** Refuse, naming what *does* exist. Never substitute something
  adjacent.
- **Consequential effects without a current approval.** Refuse at the effect gate.
- **Work it cannot verify.** If there is no honest way to check an outcome, the action is not taken.
- **Tasks beyond the model's competence.** A model that cannot plan says so. M10 showed how easily a
  constrained decoder emits a *syntactically perfect false refusal*, so this refusal must be
  meaningful rather than merely well-formed.

## 5. Principles

1. **Governance is a contract, not a service.** `Permission` is returned, never asserted.
2. **Fail closed.** Omission denies. A missing route is a refusal, not a pass.
3. **A tool may not verify itself.** `Verifier` is a separate interface from `Tool`.
4. **Structure over intention.** The injection gate is a table and a check at the dispatch head, not
   a prompt asking a model to behave.
5. **A proposal is data, never authority.** `PlanProposal` is reviewable data; compiling it stamps a
   digest; execution re-checks that digest.
6. **Reuse proven components.** Keep what is measured to work; do not rewrite it to adopt a framework.
7. **Measure, then decide.** Prefer the cheapest intervention, measure it, and escalate only after
   the cheap ones have been evaluated and recorded.
8. **Say what is not proven.** A limitation recorded honestly is more useful than a claim that reads
   well.
9. **Local-first.** The core ability to observe and operate the user's machine is local to the
   desktop product. Verified: every network call in the product path targets `127.0.0.1`.
10. **Zero new spend.** Free-first. No paid service is an architectural dependency.

## 6. Non-negotiable safety invariants

These are restated in full, with the control that enforces each one, in
[`safety/GOVERNANCE-CONTRACT.md`](safety/GOVERNANCE-CONTRACT.md). They are not negotiable under
time pressure, and no milestone may weaken one to improve a metric.

## 7. What exists today

Honest summary: a **proven execution and governance foundation with a weak planner**. Filesystem,
terminal, observation, planning, strict plan review, recovery, human takeover and latched emergency
stop are built and evidenced. A local model cannot yet produce a usable plan, so end-to-end AI
missions do not yet succeed.

See [`ARCHITECTURE.md`](architecture/ARCHITECTURE.md) for the current build,
[`ARCHITECTURAL-AUDIT.md`](ARCHITECTURAL-AUDIT.md) for the area-by-area classification, and
[`EVIDENCE.md`](EVIDENCE.md) for what was measured.

## 8. The discipline this project runs on

A validation that cannot fail is not a validation. A control is only believed once it has been shown
*to bite* â€” with its protection removed, in both the unit and live layers. Negative controls that
quietly cannot fail are treated as defects in themselves.

The recurring class of defect found in this codebase is **plausible-looking code that is wrong when
executed** â€” and not one of them was found by reading it. They were found by running, and by refusing
to accept a number that looked fine until something was checked underneath it.

That is why every claim here is a measurement with a reproduction command.