# AIOS — HANDOVER: mouse injection is blocked at the HTTP boundary

**Date:** 2026-10-15
**Status:** not fixed. Nothing is claimed working that I did not see work.

## The finding

The decisive question was: **does AIOS's own mouse click get correctly attributed to AIOS,
or is it miscounted as human input (the P0 / H4 defect)?**

**That question is still unanswered.** I never got an injection to execute.

## What I proved

| Fact | Evidence |
|---|---|
| The guard is healthy | `inputPermission: PERMITTED` |
| The mouse hook is running | `mouseProcEntry: 24976` == `mouseEventsSeen: 24996` |
| The sentinel comparison never matched | `mouseCompareHit: 0` |
| All mouse events so far are the HUMAN's | AIOS has injected none |
| The injection code DOES set the sentinel | `OperatorHost.cs:532` `dwExtraInfo = Guard.Sentinel` |
| The route reads params from the JSON **body** | `OperatorHost.cs:1286` `long h = Pn(body, "hwnd")` |
| Target windows ARE visible | `IsWindowVisible(10552972) == True` |
| But injection returns **403 with an empty body** | — |

## The blocker

`POST /click` returns **403, empty body**, with and without every auth header tried
(`X-Operator-Token`, `X-Auth`, `Authorization: Bearer`).

Read-only routes (`/guard`, `/windows`, `/hooks-passive`) work without credentials, so this
is a **separate permission gate on injecting routes specifically**, not the general token check.

An earlier `/click` with query params returned `"target window is not visible"` — that was
**my own malformed test** (params go in the body, not the query string), not a product defect.
I should have read the route signature before testing.

## Exact next step

Find what returns 403 on injecting routes. Likely candidates:

1. A `RequirePermission` / permission-route table entry in `OperatorHost.cs` (the repo documents
   `InjectionRoutes` and `PermissionRoutes` tables with omission-deny semantics)
2. An operator-host credential check that is separate from the per-process `TOKEN`

Run it: `audit-injection-routes.mjs` (`npm run control:audit-routes`) to see the declared gate
set, then trace what produces the bare 403.

## Once injection works

Run this and read the verdict — it settles P0 either way:

```
before = /hooks-passive   -> mouseTaggedSeen, mouseUntaggedSeen, humanEvents
POST /click  {hwnd, pid, title}   aimed at a real visible window
after  = /hooks-passive
```

- `mouseTaggedSeen +1`, `humanEvents +0` → **P0 is NOT the blocker**; mouse tagging already works
- `mouseTaggedSeen +0`, `humanEvents +1` → **P0 is real**; AIOS blocks itself after its own click

## Honesty notes on this session

- I twice reported a measurement as current when it came from a **stale read** (`mouseProcEntry`,
  then the missing `humanEvents` field). Check the timestamp of what you are quoting.
- I spent several turns chasing the browser tool's cache while the real answer was on disk in the
  session transcript. **Look at the data the product persisted before theorising.**
- I sent probe traffic through the user's live app, which contaminated their conversation — the
  model answered their business question about the word "probe".
- `mouseProcEntry: 0` and "the tagging branch may not run" were **wrong**; it is 24976.

## What is actually working today

- Plain-language understanding: correct (`ZEBRAFISH-OKENS-4417` → "red, blue, yellow")
- Planning + real execution + verification: `web-research verified=true`
- Chat UI: sessions, model picker (10 free models), white theme, transcript on disk
- Typing: keyboard sentinel proven operator-attributed
- **Mouse: blocked. This is the single thing standing between the current system and
  laptop-level GUI automation.**