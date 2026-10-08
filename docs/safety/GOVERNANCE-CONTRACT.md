# AIOS â€” governance and safety contract

The non-negotiables, each with **the control that enforces it** and **the proof that it bites**.

Two rules govern this document:

1. **No invariant here may be weakened to improve a metric.** Not for a validity rate, not for
   latency, not for a milestone. If enforcing an invariant makes something fail, that is the finding.
2. **A control is not believed until it has been shown to fail.** Every "proof" column below names a
   test that *detects* a violation, not merely a test that passes. A control that cannot fail is not
   a control; it is decoration, and is treated as a defect in itself.

---

## 1. The authority chain

```
model intent  ->  proposal (data)  ->  compiled mission  ->  permission  ->  executor  ->  evidence
     no                no                 no                    no            no           no
  authority          authority          authority             authority     authority    authority
```

Every arrow is a place where authority can be *lost*, which is the point. Each is enforced
structurally â€” by a type, a table, or a check at a dispatch head â€” never by asking a model to behave.

## 2. The invariants

### I1 â€” The model cannot authorise execution
**Control:** the model emits `PlanProposal`, which carries no permission field of any kind. Approval
lives in an approval store the model cannot write.
**Digest is a WHITELIST.** `proposalDigest` covers named semantic fields only. Injected `approved`,
`authorized`, `confirmed` and `override` fields are never read â€” they are not part of the digest, so
adding them changes nothing.
**Proof:** adversarial scenarios inject a fake approval field; the plan is rejected and the field is
shown to be ignored rather than honoured.

### I2 â€” The model cannot execute tools
**Control:** `compilePlan` is the only route from proposal to mission, and it *refuses* rather than
repairs. There is no direct modelâ†’tool path.
**Proof:** the import-graph control asserts no module both produces a proposal and dispatches a tool.

### I3 â€” Approvals are external to model output
**Control:** an approval is bound to a specific command. An approval for one command does not
authorise another.
**Proof:** *an approval for a DIFFERENT command does not authorise this one*.

### I4 â€” Verification is separate from execution
**Control:** `Verifier` is a different interface from `Tool`. A tool cannot verify itself, by type.
**Proof:** suppression control â€” a verifier that reports nothing causes the step's dependants to be
**skipped**, which is stronger than "produced but unverified".

### I5 â€” Fresh observation is required where it matters
**Control:** targets carry observation timestamps; a stale target is refused.
**Proof:** the stale-target adversarial scenario.

### I6 â€” Stale approvals are invalidated
**Control:** approvals do not survive the state that justified them.
**Proof:** the approval-mismatch control in `mission:approval`.

### I7 â€” Emergency stop outranks approval
**Control:** the stop is **latched** and checked before approval dispatch.
**Proof:** *EMERGENCY STOP outranks an approved terminal command*.

### I8 â€” The injection gate is structural and fails closed
**Control:** one `InjectionRoutes` table plus `RequiresPermission()` at the dispatch head.
**Omission denies** â€” an unknown route is refused, not passed.
**Proof:** `npm run control:audit-routes` reports "grants authority, undeclared: none".

### I9 â€” The grammar is not semantic authorisation
**Control:** `capability` and `tool` are free strings; `args` is free-form. The grammar knows no
capability or tool vocabulary.
**Proof:** `test_grammar_does_not_filter_semantics` **fails if the grammar is tightened.** The control
protects the design from being "helpfully" completed.

### I10 â€” Refusal must be meaningful
**Control:** a blank refusal is **not** a refusal. M10 measured the model emitting
`{"steps":[],"refusal":""}`, which was logged as "the model declined to plan this objective" â€” a
considered decision, with an empty reason. A blank refusal now falls through and is rejected as the
zero-step plan it is.
**This makes the parser stricter, never more permissive**, so it cannot be a way of raising an
acceptance rate.
**Known limit:** a *non-blank but meaningless* refusal is still indistinguishable from a real decline.
Recorded in [`known-defects.md`](known-defects.md), not papered over.

### I11 â€” No invented resources, no invented success
**Control:** outcomes come from verifiers reading the real machine. A step that did not happen cannot
be reported as having happened.
**Proof:** *status truth* proof harness in `control-core/test/`.

### I12 â€” No false evidence
**Control:** evidence records what a verifier observed, not what a model asserted.
**Proof:** the raw model output is retained separately from the parsed proposal, so the two can be
compared.

### I13 â€” No fallback that silently expands authority
**Control:** on any internal failure the system refuses. There is no "best effort" path that widens
permissions, substitutes a tool, or skips a gate.
**Specific instance:** `GrammarExhausted` â€” a constrained decoder hitting its own limit â€” was an HTTP
500. It now stops cleanly and names the state, because "the model wanted something forbidden" is a
refusal, not a server fault, and must never be laundered into a fallback.

### I14 â€” Human takeover is always available and never self-released
**Control:** the operator can take over at any time; the process cannot release itself.
**Proof:** `prove-no-self-release.mjs`, `prove-panel-release.mjs`.

> **As of M17 those two proofs had never executed** - a module import did not resolve, so the harness
> failed before running a check. With that fixed, the refusals they assert **pass**, but the reporting
> they assert **fails**: the hook does not tag the click it observed, and the pending takeover is not
> reported in the payload. So I14's behaviour holds and I14's *evidence* is incomplete. Treat this
> invariant as implemented-and-partly-demonstrated, not as proven.

## 3. Held by inherited code, and therefore under a stricter rule

`control-core` is the previous project's code, kept because it is the only candidate with *proven*
takeover, latched stop, no-self-release and fail-closed hooks.

**It is not modified by this project.** Any change to it requires the same evidence as an ADR plus a
human decision, because "improve the trusted component" is exactly how a proven property gets lost
without anyone noticing.

Known defect carried with it: **`dwExtraInfo` does not survive the Windows mouse path.** Measured
0 tagged vs 5,476 untagged mouse events. Conservative-biased â€” the system refuses rather than acts â€”
so it is safe, but it is wrong and it is blocked on human decision H4.

## 4. Things AIOS will not do

- Solve or bypass MFA, OTP or CAPTCHA.
- Read, store, log or transmit a credential.
- Substitute a tool for one that does not exist.
- Describe working-directory confinement, a filesystem boundary or a command allowlist as a
  **sandbox**. There is no OS-level isolation in this codebase.
- Describe any local model as capable of more than it has demonstrated.
- Resume a mission after human takeover without a proven mechanism. It does not have one.

## 5. When an invariant and a milestone conflict

The invariant wins, and the conflict is recorded in
[`known-defects.md`](known-defects.md) rather than resolved by weakening the invariant. M9 is the
worked example: 0 valid plans out of 15 attempts, and the correct response was to report that
honestly â€” not to relax the parser.

**Every prior milestone produced at least one of these, and every one was found by running the code,
not by reading it.** That record is in [`../EVIDENCE.md`](../EVIDENCE.md).