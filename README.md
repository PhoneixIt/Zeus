# AIOS — General-Purpose AI Operating Layer for Windows

> Give the AI the objective. Let it figure out how to operate the computer to achieve it.

## Status

| | |
|---|---|
| **Foundation** | computer control — **proven**, migrated from a battle-tested session |
| **Governance** | contract defined; human takeover + latched stop + no-self-release **proven** |
| **Mission engine** | state model + 12 tests, with a verified negative control |
| **Desktop app** | not started — deliberately, per §43 ordering |
| **Release after takeover** | **NOT PROVEN** — see `docs/safety/known-defects.md` |

## The vision

A user gives a mission. The system understands the goal, observes the real computer, chooses
tools, acts, verifies, recovers from failure, and keeps working — while the human can seize
control at any instant.

Full specification: §1–§45 of the product vision. Architecture: `docs/architecture`.

## Layers

```
  apps/desktop        Layer 1   Desktop UI                (not started)
  packages/mission-engine  L2   Mission engine           (state model + tests)
  packages/tool-router      L3   Tool router/registry    (not started)
  packages/control-core     L4   Computer control         (PROVEN, migrated)
  packages/toolkit          L5   Files, terminal, git     (not started)
  packages/governance       L6   Governance contract      (defined)
  packages/audit            L7   Audit and state          (not started)
  services/local            L8   AI providers             (not started)
```

Governance is a **contract**, not a service. A caller cannot assert that input is safe — it can
only be told. There is exactly one route to input (`ControlSurface`), so there is no second
path to bypass.

## Design commitments

These are not aspirations; each exists because its absence caused a real defect.

**Verified results, not executed ones.** A mission step completes only with independent
evidence — a file that exists, a process that exited, an exit code. Three production bugs in
the previous repository were the same shape: a failure became an empty value, and empty was
indistinguishable from success. One run where *every* agent threw was recorded `completed` in
the database. `isComplete()` cannot infer success from steps having run, and a negative control
proves it still catches that bug.

**Failure is visible.** `failed`, `legitimately-empty` and `needs-human` are distinct outcomes
and never render identically. When a mechanism is unreliable the answer is `INCONCLUSIVE` —
there is deliberately no inconclusive path that counts as progress.

**Fail closed.** An unidentifiable target is a refusal, never a guess. A missing or
unresponsive hook stops all injection and says why. A green "ARMED" never appears while input
is blocked; control state and effective input permission are separate fields.

**Honest limitations.** Unsupported environments fail safely and transparently. The claim is
"highly adaptive, broad coverage through multiple mechanisms" — never "controls every
application".

## Quick start

```bash
npm test                    # mission-engine tests
npm run control:start       # launch the control host
npm run control:syntax      # verify the C# core compiles clean
```

## Documentation

- `docs/architecture/` — layer contracts
- `docs/decisions/` — ADRs, including why the proven operator was moved out of `%TEMP%`
- `docs/safety/known-defects.md` — **read this first.** What is broken, measured.
- `packages/control-core/PROVENANCE.json` — SHA-256 per file, for audit and rollback