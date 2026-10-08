# 0003 — Gate the window-management routes (HUMAN DECISION REQUIRED)

Date: 2026-10-08 · Status: **proposed — awaiting human decision** · Milestone: M14

## What was found

The injection audit asked one question: *does a route reach an input-injection primitive?* Three routes
change the real machine and reach none of them, so they were never examined:

| Route | What it actually does | Gate it has | Gate it needs |
|---|---|---|---|
| `/show` | `Win.ShowWindow(hw, cmd)` with `action=minimize\|maximize\|restore\|show\|hide` — hides and un-minimises **real windows** | pid match only | `Guard.MayInject()` |
| `/restore` | `Win.ShowWindow(hw, 9)` — `SW_RESTORE` | pid match only | `Guard.MayInject()` |
| `/focus` | `Win.Focus(h)` → `ShowWindow` + `BringWindowToTop` + `SetForegroundWindow` + `SetActiveWindow`; optionally `Win.FocusChild` → `SetFocus` | `Verify()` — **an identity check** | `Guard.MayInject()` |
| `/guifocus` | `GetWindowThreadProcessId`, `GuiFocusOfThread`, `Title`, `Cls` — **pure reads** | none needed | none needed |

`Verify()` is worth naming precisely, because it is the thing that made `/focus` look protected. It
checks the window is visible, is not minimised, that the pid matches and that the title matches. It is
a check that the caller is talking about the window it thinks it is. **It never calls `MayInject()`**, so
a caller with no injection permission can still take the foreground window away from the person using
the computer.

**Correction to the project's own records.** Earlier `known-defects.md` entries listed `/guifocus`
alongside the other three as ungated. That was wrong — it mutates nothing. It was listed because nobody
read what the route did. Corrected here and in `known-defects.md`.

## The invariant

> Every action capable of changing the real machine state passes through the applicable declared safety
> or control gate.

**This is FALSE today**, and until M14 it was *untestable* — the tooling could not express the question.
`npm run control:audit-routes` now reports it as false and exits `1`.

## The exact change required in control-core

Three additions to `packages/control-core/src/OperatorHost.cs`, at the head of each route body, in the
same form the already-gated routes use:

```csharp
// /show, before Win.ShowWindow(hw, cmd)
if (!Guard.MayInject()) return Json("{\"ok\":false,\"refused\":true,\"error\":\"" + Esc(Guard.RefusalReason) + "\"}");

// /restore, before Win.ShowWindow(new IntPtr(h), 9)
if (!Guard.MayInject()) return Json("{\"ok\":false,\"refused\":true,\"error\":\"" + Esc(Guard.RefusalReason) + "\"}");

// /focus, immediately after `if (!t.ok) return ...`
if (!Guard.MayInject()) return Json("{\"ok\":false,\"refused\":true,\"error\":\"" + Esc(Guard.RefusalReason) + "\"}");
```

and the three route names added to `InjectionRoutes`:

```csharp
"/show", "/restore", "/focus",
```

**`/guifocus` is deliberately NOT added.** It reads. Adding it would gate a diagnostic route for no
reason and would teach the table that "window route" means "window route".

### Why this needs a human decision

`control-core` is inherited, proven code holding human takeover, the latched emergency stop and
no-self-release, with five proof harnesses. This project does not modify it without an ADR and a human
decision — because "improve the trusted component" is exactly how a proven property is lost without
anyone noticing.

Three specific things a human should weigh before approving:

1. **Fail-closed behaviour on a live route.** `/show` and `/restore` are used to recover a target
   window before acting on it. Adding a gate means those calls now fail when input is blocked. That is
   the correct outcome — but it changes the behaviour of existing live missions, and `run-live-mission`
   and `run-gui-accept` must be re-run to confirm nothing depended on ungated focus.
2. **`MayInject()` is the *input* permission.** Gating focus on it is conservative and correct — a
   takeover should stop the system stealing focus — but it is a slightly coarser gate than "may manage
   windows". A dedicated `Guard.MayManageWindows()` would be more precise. **Recommendation: start
   with `MayInject()`**, because it is already proven, latched and fail-closed, and add a narrower
   predicate only if a mission genuinely needs to manage windows while input is blocked.
3. **Proof harnesses must be re-run**, and a new one added asserting that a blocked operator refuses
   `/show`, `/restore` and `/focus` while still permitting `/guifocus`.

## What was done without waiting

Everything that does not touch the safety-critical core:

- The audit was widened to seven window-mutating primitives plus the two mutating **helpers**
  (`Win.Focus`, `Win.FocusChild`).
- A `READ_ONLY` set was added so the audit does not simply flag everything.
- A `KNOWN_GAPS` registry records these three with their exact fix. **It grants nothing** — it adds no
  route to `InjectionRoutes`, makes no check pass, and cannot cause exit 0.
- Three exit codes now distinguish *invariant holds* (0), *documented gap* (1) and *undocumented
  breach* (2).
- Eight regression controls, including one that injects an undeclared `BringWindowToTop` route and
  asserts exit 2.

## The part that would have been easy to get wrong

An audit that flags every route as ungated passes nobody's review and protects nothing. So the widening
also had to be able to say *no*: `/guifocus` is asserted to be classified as a **read**, and `/type` — which
reaches `Win.SetFocus` and *is* declared — is asserted to still be reported **governed**. Both controls
exist so that the next person cannot widen the audit into something that cries wolf.

## Consequences if approved

- The stronger invariant becomes **true and continuously enforced**, with exit 0.
- `KNOWN_GAPS` empties, and the audit reports the stale entry if it is not removed.
- Live GUI missions that relied on ungated focus must be re-verified.

## Consequences if declined

The audit keeps reporting exit 1 and names three routes. That is the correct steady state for a known
gap: visible, counted, and unable to hide a fourth one.

---

## RESOLVED (2026-10-08, M17)

The three routes this ADR was written about are now gated. The decision it proposed - put
`MayInject()` at the dispatch head - was implemented as the EXISTING central gate rather than as
per-route checks, because that gate already exists and already runs first:

    if (RequiresPermission(path) && !Guard.MayInject())

`/show`, `/restore` and `/focus` are declared in `InjectionRoutes`. `/guifocus` is deliberately not:
it reads focus and never sets it, and gating an observation behind an authorisation it does not need
would make observation unavailable exactly when acting is forbidden.

INVARIANT ENFORCED: no route may change a window's real machine state - minimise, hide, restore, or
take foreground focus - unless the guard permits injection, which itself fails closed on a latched
emergency stop, a pending human takeover, and an unhealthy or absent hook.

PROVEN BY: `test/prove-window-gate.mjs` (live, 22 assertions) and `control:audit-routes` exiting 0,
with the audit's undocumented-breach alarm verified still to fire (exit 2) when a mutating route is
ungated and undeclared.

The one thing this ADR did not anticipate: `/click-absolute` and the hook's release-region test use
different screen-coordinate conventions. That is unresolved and is described in
`docs/safety/known-defects.md`.
