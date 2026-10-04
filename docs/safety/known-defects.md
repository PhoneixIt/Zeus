# Known defects and honest limitations

Nothing here is a surprise. Each was measured, not suspected.

## P0 — the ownership sentinel does not survive the mouse path

**Measured:** `mouseTAGGED +0`, `mouseUNTAGGED +2`, for clicks the operator itself injected.

`dwExtraInfo` is set on injected mouse events, but the hook does not see it matching the
sentinel for the mouse path. The same stamping works for keyboard.

**Consequence:** the operator's own mouse input can be counted as *human* input by the guard.
Human takeover therefore fires partly for the wrong reason. This is **conservative-biased** —
it stops more often than it should, never less — so it is safe, but it is wrong.

**Why it matters beyond accuracy:** §15 requires the human's input to win. That still holds,
because an untagged operator click is treated as human. But the converse is not true: a genuine
human click cannot yet be *positively* distinguished from the operator's own.

**Status:** unfixed. Fixing it means changing the injection layer's sentinel handling, which
must not weaken the keyboard path that demonstrably works.

**Re-measured 2026-10-04 by the mission-level injection audit** (`npm run mission:gui-audit`),
against the live host, reading only the control core's own counters:

```
mouseEventsSeen     6772
mouseTaggedSeen        0   <- events that carried the ownership sentinel
mouseUntaggedSeen   5476   <- events that did not
panelInjectedSeen      0
panelTaggedSeen        0
```

Still exactly zero tagged mouse events against 5476 untagged ones. The audit classifies this
path as `attribution-defective` - deliberately distinct from `attribution-unproven`, because
this is a *measured* broken control rather than missing information. The mission engine now
**reports** the defect rather than working around it; nothing in the audit guesses the true
actor to make a test pass.

For contrast, the keyboard path over the same interval, with no forging by the audit:

```
livenessProbes  21 -> 22
livenessHits    21 -> 22
operatorEvents  21 -> 22
humanEvents   6977 -> 6977
verdict: operator-proven
```

A real `SendInput` keystroke carrying the real sentinel, observed by the real
`WH_KEYBOARD_LL` hook, attributed to the operator, with `humanEvents` unmoved. So the
keyboard ownership proof works and the mouse one does not. That asymmetry is now measured on
demand rather than assumed.

## P1 - `/scaninput` injects WITHOUT consulting the guard, and with no sentinel

Found 2026-10-04 while looking for an existing self-test that could close the gui verifier's
accept path. Not fixed. Not exploited.

`/scaninput` calls `Win.SendInput` with `dwExtraInfo = IntPtr.Zero`. It checks the target
window and foreground focus, but its block contains **no `Guard.MayInject()` call**, unlike
`/click`, `/type`, `/scroll`, `/key`, `/move` (one compound gate) and `/click-absolute`.

Empirical confirmation, without injecting anything: with `mayInject=false` in
`HUMAN_TAKEOVER`, `/scaninput` refused with `target window is not visible` - a target failure,
not a guard failure. `/click-absolute` refused with `human takeover detected; input suspended`.
The difference in refusal reason is the proof: `/scaninput` never reached the guard.

**Consequence:** if a caller supplies a valid visible foreground window, `/scaninput` injects
real keystrokes into it while the operator is paused or emergency-stopped. Because
`dwExtraInfo` is zero, the hook classifies those events as **human**, so the guard would also
record a takeover it did not cause.

**Why it was not fixed here:** it is in the injection layer, which is out of scope for the
mission-engine milestones, and it needs its own bounded change.

**Suggested invariant for that milestone:** every route that reaches `SendInput` must pass
through exactly one gate, and the gate must be structural rather than a convention that each
route remembers to call.

## P1 - `/hooks` INJECTS, so it cannot be used as a passive observation

Found 2026-10-04 by measurement. Characterised, worked around in the mission layer, not fixed.

`GET /hooks` calls `Hooks.Report()`, which signals the hook thread to send a real
sentinel-tagged F24 keystroke through `SendInput` and waits up to 400ms for it to return.

Measured on this host: eight reads of `/hooks` advanced `livenessProbes` by 7. Six reads of
`/guard` advanced `operatorEvents` by 0.

**Consequence:** an instrument that changes what it measures. The mission audit's first
version bracketed actions with `/guard` *and* `/hooks` together, so it was partly observing its
own side effect - and would have reported `operator-proven` for a keystroke it caused itself.
`readRecord()` now reads only `/guard`, and hook diagnostics are fetched separately through
`readHookDiagnostics()`, which reports how far the probe counter moved across its own call.

There is **no background probe timer**: `SendProbe` is reached only from `AwaitProbe`, which is
reached only from `Report()`, which is reached only from an HTTP route. An earlier measurement
that "waited 13 seconds and watched a probe appear" was measuring its own polling.

**Suggested fix for that milestone:** split the passive diagnostics from the active self-test -
a route that reports hook state without emitting anything.

## Release control - NOT PROVEN

The operator has no proven way for a human to resume it after takeover.

Measured outcomes, honestly reported:

- `Ctrl+Alt+F12` — opened Calculator. **Root cause identified:** this keyboard maps F12 to
  Calculator in firmware. A firmware hotkey is consumed before Windows sees it, so a
  `WH_KEYBOARD_LL` hook cannot intercept it. Structurally unswallowable.
- `Ctrl+Alt+G` — `human +0`, `releaseSeen +0`, `swallowed +0`. **INCONCLUSIVE.** The hook
  observed nothing, but the evidence cannot distinguish "never saw it" from "saw it and did
  not recognise it".
- Panel RELEASE control — refused every injected click (`panelInjectedSeen +1`,
  `panelReleaseAccepted +0`). A **physical** click has not been verified.

**Why synthetic tests could not settle it:** `SendInput` produces a *Windows-level* key or
click, which is interceptable. Real firmware intercepts first. Synthetic tests measure a
different thing from real hardware and cannot detect this failure class.

**Recorded state:**

```
RELEASE CONTROL  = NOT PROVEN
HUMAN TAKEOVER   = PROVEN
EMERGENCY STOP   = PROVEN (latched)
NO SELF-RELEASE  = PROVEN
```

That is a safe degraded mode. §16's explicit-resume requirement is **not yet met**, and the
product is honest about that rather than training the human to work around it.

## What the control core has NOT been proven to do

- No browser control via CDP/DOM. UIA is structurally blind inside Chromium.
- No OCR or on-screen text finding.
- No drag-and-drop primitive (click, scroll and type only).
- No multi-monitor capture.
- No persistent state across restarts.

## Migration defect caught by running it, not by compiling it

The control core moved from `%TEMP%` into `packages/control-core/`. After the move the C#
**compiled cleanly** — and the host **did not start**. Three separate reasons, all invisible
to a compile check:

1. `start-operator-host.mjs` globbed `readdirSync(DIR)` for `*.cs`. The sources were in
   `src/`, so it found **zero**, and printed `compiling 0 sources` / `source compiles cleanly`
   — a green result for compiling nothing.
2. `operator-host.ps1` had the same `Get-ChildItem -LiteralPath $dir -Filter '*.cs'` bug. Its
   own `if (-not $sources) { throw }` guard is what stopped it, and that guard is worth
   keeping.
3. `operator-host.ps1` was not migrated at all — the copy was conditional and the file did not
   match its pattern.

Fixed by pointing both scripts at `src/` and by **asserting the source count is non-zero**, so
"compiled cleanly" can never again mean "compiled nothing".

**The lesson generalises past this bug:** a compile check verifies the code is valid. It says
nothing about whether the program *starts*, whether its inputs were found, or whether it
speaks to anything real. Every migrated component must be **executed** and observed, not
merely compiled. This is the same failure class as the negative controls that silently did
nothing: an instrument reporting success without having tested the thing.

## Layer-boundary finding

`operator.mjs` imports `playwright` for browser work; `operator-client.mjs` is the pure
control protocol and has no such dependency. The client is the correct boundary for Layer 4 —
the control core should not depend on a browser-automation library. `operator.mjs` belongs to
the browser package and should move there when that package exists.

## Engineering-process defects

Recorded because they are the ones most likely to recur:

1. **Negative controls that silently did nothing.** Several attempts to restore a defect
   "succeeded" because the anchor text never matched — CRLF against an LF file, a wrong line
   index. The scripts now abort if the source did not actually change.
2. **Instruments that reported conclusions they did not test.** A chord injector omitted
   `MOUSEINPUT`, so `SendInput` failed silently while printing "sent"; a `-SentinelHex ''`
   argument was dropped by PowerShell so the test skipped instead of running; `op.raw` sent no
   auth token so a refusal looked like a missing endpoint.
3. **A test that printed its conclusion unconditionally**, so a failing run still asserted the
   property.
4. **Order-coupled tests** — a real chord leaves a pending flag the next HTTP call applies, so
   results depended on run order until the flag was cleared explicitly.

The governing lesson: *an instrument that cannot fail is not evidence.* Every claim in this
repository cites an assertion count from a run, not a description of intended behaviour.