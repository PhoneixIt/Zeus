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

## Release control — NOT PROVEN

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