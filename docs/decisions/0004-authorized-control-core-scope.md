# Architecture Decision Record 0004 — Authorised scope for `control-core` changes

**Date:** 2026-10-09
**Status:** Accepted
**Supersedes:** no ADR. It does supersede **the rule** in `docs/DEVELOPMENT-RULES.md` §1.1 and
`docs/safety/GOVERNANCE-CONTRACT.md` §3 that `packages/control-core` is not modified.

---

## Context

Two documents have said, consistently, that the inherited control core is not to be edited:

- `DEVELOPMENT-RULES.md` §1.1 — *"`packages/control-core` is not modified. It is inherited, proven
  code holding takeover, the latched stop and no-self-release. A change needs an ADR **and** a human
  decision."*
- `GOVERNANCE-CONTRACT.md` §3 — *"**It is not modified by this project.** Any change to it requires
  the same evidence as an ADR plus a human decision, because 'improve the trusted component' is
  exactly how a proven property gets lost without anyone noticing."*

That rule was written when there was no green baseline to edit against. That absence *was* the
finding (`ROADMAP.md:736-747`). A human decision has now been taken, so the precondition the rule
asked for has been supplied, and this ADR records it.

### The scope that was authorised

- Commit `2abc2f6` (the `/show`, `/restore`, `/focus` authorisation fix) is **retained**. Its
  predecessor `1c39887` contained six out-of-scope files and was reverted.
- Future edits to `packages/control-core/src/*.cs` are permitted.
- Four decisions were taken **in principle**; see §2.

### Decision H4 is resolved

`ROADMAP.md:130` recorded **H4** — *"Whether to fix the mouse sentinel by changing injection
internals… it is in the injection layer, deliberately untouched so far."* It is resolved: **yes**.

This defect was already known to the project and recorded, not discovered by the current
investigation:

> `GOVERNANCE-CONTRACT.md:121-123` — *"Known defect carried with it: **`dwExtraInfo` does not survive
> the Windows mouse path.** Measured 0 tagged vs 5,476 untagged mouse events. Conservative-biased —
> the system refuses rather than acts — so it is safe, but it is wrong."*

---

## Decision

### 1. Scope of authorisation

Edits to `packages/control-core/src/*.cs` are authorised. **Nothing else is** by this ADR.

### 2. Decisions in principle are NOT implementation approval

Five decisions were taken **in principle** — four route-security decisions (D1, D2, D4, D5) and D3.
Recording them here does **not** authorise implementing any of them. Each requires separate, explicit
approval at the time it is attempted.

| id | Decision taken in principle | Implementation status |
|---|---|---|
| D1 | Sensitive observation endpoints must not remain unauthenticated in v1 | **NOT APPROVED** |
| D2 | The sentinel must not be exposed through an ordinary public diagnostic route (`/sentinel-probe`) | **NOT APPROVED** |
| D3 | A capability and its functioning tool, verification path and tests must be delivered together | **NOT APPROVED** |
| D4 | `/arm` must remain an explicitly human-controlled authority transition | **NOT APPROVED** |
| D5 | A process restart must not silently restore AI authority after emergency stop or takeover | **NOT APPROVED** |

**"In principle" means the direction is settled and the alternative has been rejected. It does not
mean the change is scheduled, scoped or safe to implement.** In particular D1/D2 do not authorise an
IPC redesign; D4/D5 do not authorise a change to `Guard` or to any state machine.

### 3. Route-security changes are independently reviewable

D1, D2, D4 and D5 touch **different** code and defend **different** properties. They are separate
milestones and separate commits. **Fixing the sentinel does not close any of them, and closing any
one of them does not close the others.**

Ordering note: D2 becomes *more* urgent if the sentinel is repaired, because a working sentinel
published on an unauthenticated route defeats itself.

### 4. The sentinel must not be weakened to make anything pass

An earlier working note recommended narrowing the sentinel from 64 bits to 32 so that the
comparison would match. **That recommendation is withdrawn.** It was made before the cause was
established, and it would reduce the entropy of a security primitive in order to accommodate an
unexplained behaviour. Per `GOVERNANCE-CONTRACT.md` §2, conflicts are recorded rather than resolved by
weakening.

### 5. Milestone boundaries

`A0` ADR · `A1` keyboard-parity diagnostic · `A2` mouse root cause (conditional on A1's result) ·
`A3` DPI conversion (independent) · `A4` proofs · `A5` frozen assertions · `A6` gate repair ·
`B1`–`B4` route security · `C*` capability work gated on A4 green and B1–B4 closed.

**A2 must not begin until A1's evidence establishes the cause.**

### 6. The x64 structure layout is not a defect

A prior analysis claimed `MSLLHOOKSTRUCT.dwExtraInfo` was mispositioned. **That claim is withdrawn.**
Measured via an in-memory CLR layout probe: `MSLLHOOKSTRUCT` compiles to size 32 with `dwExtraInfo` at
offset 24; `KBDLLHOOKSTRUCT` to size 24 with `dwExtraInfo` at offset 16. Both match the x64 ABI for a
`ULONG_PTR` field. The "documented layout" it was compared against was a DWORD hypothesis constructed
by the analysis itself, not the SDK header. **No structural fix is to be attempted.**

### 7. The truncation site is not established

Four candidate sites remain open: Windows-side truncation; a 32-bit-coincidence sentinel; a
last-event-register artefact (`LastMouseExtra` is overwritten by every event, and the mouse
measurement is therefore weaker evidence than it appeared); and — excluded by evidence — a `cbSize`
mismatch, which would have prevented events arriving at all.

---

## Consequences

- **Accepted:** the rule that control-core is unmodifiable is retired. Provenance risk is now managed
  by per-commit review and single-commit reversibility instead.
- **Accepted:** capability ledger item 2 (*"Keyboard injection, sentinel-tagged | PROVEN"*) is
  **PARTIALLY SUPPORTED, not certified.** A1 measured that a sentinel-tagged `SendInput` **keyboard**
  event arrives at `WH_KEYBOARD_LL` with `dwExtraInfo` **intact at full 64 bits**, matching
  `Guard.Sentinel` exactly, reproducibly across three samples with `livenessProbeHits ==
  livenessProbes`. That is enough to retire the sentinel-narrowing recommendation (§4) and the
  layout claim (§6) **for the keyboard path**, and enough to show the defect is mouse-specific.

  **The complete keyboard-injection path remains UNVERIFIED**, and item 2 must not be read as proven
  until it is. Specifically not established:
  - all three A1 samples used **one sentinel value in one process**, so the "32-bit coincidence
    sentinel" hypothesis is not eliminated — repeating one observation three times adds nothing to it;
  - the event measured was the **liveness probe**, not an operator-sent keystroke;
  - `KBDLLHOOKSTRUCT.dwExtraInfo` at offset 16 is exercised, but the tagged branch at
    `Hooks.cs:725` has **never been observed executing** during real typing — and if it were not to
    execute, operator keystrokes would fall into the `else` branch and be recorded as a **human
    takeover** (`Hooks.cs:842-843`);
  - modifiers held, and the reserved chords themselves, were not tested.
  Closing this requires a **multi-process** sentinel sample plus a real injection, which needs
  separate authorisation.
- **Accepted:** the three frozen assertions in `audit-widening.test.ts` (`:95`, `:108`, `:133`) are
  known to encode the pre-fix state and will block any correct future fix. Correcting them is A5 and
  is separately approved. The alarm control at `:134` must remain unchanged.
- **Not accepted, not scheduled:** any change to sentinel width, to the sentinel comparison, to any
  gate, to any state machine, to DPI handling, to route security, or to any browser or model
  component.

---

## Evidence discipline

This ADR is a scope record. It asserts **no** safety property. Every technical claim above is
labelled by status in the M19 review: *Measured*, *Verified by source inspection*, *Inferred*, or
*Unknown — requires experiment*.

The governing rule is unchanged and remains `GOVERNANCE-CONTRACT.md` §2: **a control is not believed
until it has been shown to fail.** A red gate that says why is worth more than a green one that means
nothing.