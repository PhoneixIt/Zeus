# Architecture Decision Record 0001 — Project shape

**Date:** 2026-10-03
**Status:** Accepted
**Supersedes:** nothing

## Context

The vision (§1–§45) defines a general-purpose AI operating layer for Windows. §36 requires
reusing the existing proven operator rather than starting again. §35 forbids a monolith.
§27 requires every change to be recorded and reversible.

## Decision

The project lives at `C:\Users\Samer\Projects\AIOS`, under git, with one package per layer.

### The proven operator was in `%TEMP%` — this is the blocker this ADR exists to record

The control core and its proofs lived in:

```
C:\Users\Samer\AppData\Local\Temp\opencode\operator
```

`%TEMP%` is cleaned by Windows Disk Cleanup, by low-disk-space pressure, and by any process
that chooses to clear it. A safety-critical control layer that can be deleted without warning
cannot satisfy §27 (change history, reversibility) or §41 (long-running missions that survive
interruption).

The core was migrated to `packages/control-core/` with a `PROVENANCE.json` recording a
SHA-256 per file, so the migration is auditable and reversible.

**Verification, not assumption:** after migration the six C# sources were recompiled with
`/warnaserror+` against the same GAC references. Result: **compiles cleanly**. The proven
artefact survived the move; it was not merely copied and hoped for.

## Layer mapping

| §34 layer | Package | Status |
|---|---|---|
| 1 Desktop UI | `apps/desktop` | not started |
| 2 Mission engine | `packages/mission-engine` | **state model + 12 tests** |
| 3 Tool router | `packages/tool-router` | not started |
| 4 Computer control | `packages/control-core` | **migrated, compiles, proven** |
| 5 Direct system tools | `packages/toolkit` | not started |
| 6 Governance | `packages/governance` | **contract defined** |
| 7 Audit/state | `packages/audit` | not started |
| 8 AI providers | `services/local` | not started |

### Governance is a CONTRACT, not a service

`packages/governance/contract.ts` defines `Permission` as something *returned*, never
*asserted*. The caller cannot construct permission — it can only be told.

`InputPermission` is separate from `ControlState` because a real observed condition had
`state: ARMED` with `mayInject: false`. Reporting them as one field is precisely how a human
reads a green "ARMED" while input is blocked.

### `ControlSurface` is the ONLY route to input

One interface. No second path. That is what makes governance enforceable independently of the
AI's intentions (§35): there is nothing else to bypass.

## Consequences

- **Accepted:** work in the old temp directory is no longer authoritative. Anything still
  running from there is a stale host and must be restarted from the package.
- **Accepted:** the desktop app cannot begin until the mission engine has a working executor,
  because §43 orders foundation → governance → mission engine → router → UI.
- **Rejected:** building the UI first. §43 explicitly forbids reversing that order, and §37
  warns against decorative work before the execution foundation is trustworthy.

## Resolved after writing

The migration copied `Win.cs` conditionally; it does not exist as a separate file. `Win` is a
class declared inside `OperatorHost.cs:43`. Verified: `grep 'class Win'` matches only there,
and the source does not exist in the original directory either.

Six C# sources is the complete set. The provenance manifest covers all of them.