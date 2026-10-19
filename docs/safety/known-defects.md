# Known defects

## M9 — THE MODEL IS NOT GOOD ENOUGH (open, and the binding constraint on usefulness)

**This is the most important entry in this file.** It is a capability gap, not a safety gap, and the
distinction is the whole point of recording it separately.

| | status |
|---|---|
| A real local model plans, is reviewed, compiles, executes and is verified | **NOT PROVEN** |
| The model is connected behind `PlanProvider` with zero boundary changes | **PROVEN** |
| Every model output was rejected at the correct layer, with a precise reason | **PROVEN — 15/15** |
| Nothing unsafe reached execution, the compiler, or a tool | **PROVEN** |

Measured on this machine: **Qwen2.5-0.5B produced 0 valid plans in 9 attempts; Qwen2.5-1.5B produced 0
in 6.** The 1.5B came close — structurally correct steps, real capabilities, real paths, correct
`verification` — and failed on token truncation and plan-envelope discipline.

### The temptation this creates, and why it must be refused

A system that rejects every plan is safe and useless. The pressure that creates is obvious: relax the
parser, default the missing verifier, snap the near-miss capability, accept the truncated JSON. **Every
one of those is a governance hole**, and each is a change that would make the validity rate look better
while making the system worse.

The boundary that holds here is a rule, and it is worth stating as one: **fix the model, never the
validator.** A prompt may be rewritten on evidence. `parse.ts` may not, and its single normalisation is
asserted by a test so that adding a second one fails.

### What is genuinely a defect, and what is a fact about the machine

- **A prompt defect, fixed:** the request's keys mirrored the response's, so the model echoed it. Fixed
  by nesting the request under one key, with a unit control so it cannot recur.
- **A machine limit, not a defect:** ~0.8 tok/s on 2 CPU cores. A 7B-class model would emit correct
  plans routinely and take 20–40 minutes to do it here. **Generation latency, on this hardware, is now
  a binding constraint on the product** — separate from whether the model is capable.
- **Not yet decided:** constrained decoding (JSON-schema-guided generation) would make malformed output
  impossible, but it would mean the grammar rather than the validator is what rejects bad structure.
  That may be acceptable *if* the grammar is treated as a security boundary and the adversarial suite
  is rerun against it. It is **not** a way to make a metric look good.

## M8 — the model boundary: what is proven, and what is not

**The single most important entry in this file, because the gap is easy to misread as a strength.**

| | status |
|---|---|
| A reasoner can be introduced without weakening any M1–M7 property | **PROVEN**, live |
| Model output that is malformed/unsafe/contradictory/unverifiable is rejected, not repaired | **PROVEN** |
| The model cannot name an approval, a verifier result, a step status, or a tool | **PROVEN** — byte-identical digest |
| The model cannot reach a tool, the control surface, or the filesystem | **PROVEN** by import graph |
| **That a language model works** | **NOT PROVEN — no model ran** |
| **That a model's output distribution is usable** | **NOT PROVEN** |
| Any specific provider | **NOT CONNECTED** — none available; see H5 |

This machine has **no model runtime, no weights and no credentials** — measured by probing, recorded in
`EVIDENCE.md` §M8. The peer used in the proofs is an **adversarial deterministic HTTP server**, which
defeats far less than a real model would find. It proves the substrate; it says nothing about a model.

### The risks that remain, stated as risks

- **Silent narrowing by repetition.** A real model will be tuned — prompted, given examples, given a
  retry — until it emits plans the parser accepts. Every one of those adjustments is a chance to
  *weaken the parser to fit the model*, which is exactly the failure this milestone refuses. The
  strictness must be defended as a property, and the acceptance test for a provider must include the
  24 refusal scenarios, not just the valid one.
- **Over-trust in a low refusal rate.** "The model only misbehaves 2% of the time" is not a safety
  property. What matters is that the 2% cannot act, and that is what the boundary proves.
- **Prompt-driven authority creep.** The system instructions forbid self-authorisation, and the parser
  enforces it. But a future "helpful" change — auto-adding a missing verifier, retrying with a
  corrected capability — would be a repair. There is one normalisation, it is named in
  `TRANSPORT_NORMALISATIONS`, and a test asserts the list has exactly one entry.
- **The basis could drift into decoration.** `toProposal` attaches it from the `WorldState` this
  process holds. If anyone ever lets the model's own claim through, a plan could claim grounding it
  never had. Two tests assert a peer-supplied `basis` is reported and ignored.

### Why the peer is adversarial rather than a stub

A stub that returns a valid plan proves nothing about untrusted input. A stub that returns garbage
proves only that the parser dislikes garbage it was written to dislike. The peer is engineered to find
holes — and two controls exist specifically so the suite cannot pass trivially: `lawful-terminal`
(shows the refusals discriminate rather than refuse everything) and verifier suppression (shows
completion is earned). Every scenario also declares the layer that must stop it, so one stopped for the
wrong reason is a failure.

## M7 — review: what a reviewer still cannot tell

| absent | consequence |
|---|---|
| a UI | the review surface is text; a person reads it in a terminal, not on a dialog |
| a way to reject a plan *in the system* | `commit()` returning a refusal is the only path; nothing records "a human said no" |
| plan-to-plan provenance | a reviewer's amendments are in the session, not in the mission's history |
| a preview of the FINAL artifact | a dry run reports dispatch and consequence, never the content a step would produce |

The last row is the real limit of a dry run and it is deliberate: predicting an artifact's contents
requires doing the work. So the dry run answers "would this run, and would it need a human", and
verification answers "did it work". It never answers "what exactly will it say" - because that is
what the execution is for.

## M6 — world-aware planning: what the observation does not see

| absent | consequence |
|---|---|
| content hashing | the fingerprint detects adds, removes, renames and resizes — NOT a same-length in-place edit |
| junction containment in the observer | a junction out of the observed root is recorded as a symlink and not followed (measured, verified by test) |
| a process, window, registry, network or clipboard view | "world state" means exactly what the read-only observer could establish, and nothing more |
| a universal Windows picture | this is situational awareness over the filesystem and the executable allowlist, not computer vision |

The observer is read-only **by construction** — it imports `node:fs` and nothing that can act, and
that is asserted by reading its import graph rather than by a comment. What it cannot do is *stop*
another component from acting on what it reports; the tools re-check containment for themselves, which
is why a junction finding is a limit of the observation and not a way past the tools.

## M5 — terminal mode: what it does not do

Recorded here because the failure mode is a *claim* rather than a crash. Nothing below is a bug to
be fixed later; it is the boundary of the capability, and the risk is describing it as a sandbox.

| absent | consequence |
|---|---|
| OS-level isolation (Job Object, AppContainer, restricted token) | a permitted process runs as the user and is not contained |
| child-process validation | a permitted process may spawn anything; children are reaped on timeout, not validated |
| network restriction | no permitted program is a network client by design, but nothing stops one becoming one |
| a sealed environment | the Windows loader injects 8 variables the parent cannot suppress |

The allowlist bounds **which program runs**. It does not bound **what that program then does**.
Running a workspace script is therefore classified consequential and gated — the mitigation is
governance, not containment, and it is honest to say so. and honest limitations

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

## RESOLVED - `/scaninput` and `/wmchar` injected without consulting the guard

Found 2026-10-04. Fixed 2026-10-04. There were two ungated routes, not one.

`/scaninput` called `Win.SendInput` with `dwExtraInfo = IntPtr.Zero`, and `/wmchar` called
`PostMessage(WM_CHAR)`. Neither block contained `Guard.MayInject()`, unlike `/click`, `/type`,
`/scroll`, `/key`, `/move` (one compound gate) and `/click-absolute`.

Confirmation without injecting anything: with `mayInject=false`, `/scaninput` refused with
`target window is not visible` (a target failure) where `/click-absolute` refused with
`human takeover detected` (a guard failure). Different refusal reason, so the guard was never
consulted.

**THE FIX IS STRUCTURAL, NOT A PATCH.** Governance was a convention - each injecting route
remembered to call the guard - and a convention is a boundary that exists only in the author's
memory. Now:

- One `InjectionRoutes` table and one `RequiresPermission()` check at the DISPATCH HEAD, before
  any route body. A route cannot be live-and-ungated, because no body runs until the gate has.
- Omission DENIES. A route absent from the table is not injectable, and adding an injecting
  route without declaring it fails the audit.
- `PermissionRoutes` is a separate table for routes that GRANT authority without injecting.
  `/vstype` forced it: it sends no input at all, but mints the scoped, expiring authorization
  that `/type` physically depends on. Conflating "can act" with "can authorise" is how a
  permission-granting route ends up ungated because nobody thought of it as an injection.
- `audit-injection-routes.mjs` parses the source and proves completeness transitively through
  helper methods, so `/click-absolute -> Click -> Mouse -> SendInput` is seen.

Measured on the live host after the fix, `mayInject=false`, with a valid visible target:

```
/scaninput       guard=true   state is OBSERVING; the operator must be ARMED to inject input
/wmchar          guard=true   (same)
/click-absolute  guard=true   (same)
/vstype          guard=true   (same)
/uiainvoke       guard=true   (same)
```

**The audit found four bugs in itself before it could be trusted**, and every one reported in
the wrong direction - which is the dangerous direction for a governance check:

1. It counted braces inside C# string literals. The hand-built JSON payloads are full of `{` and
   `}`, so route depths were wrong and `/restore` read as nested inside the UIA group.
2. It truncated the compound gate at its own first nested `if (path == "/type")`, so `/click`,
   `/scroll` and `/move` appeared to inject nothing.
3. It could not distinguish a nested route check from a sibling route, and treated `Handle`
   (the dispatcher) as an injection helper - producing 41 phantom violations.
4. Dropping `/vstype` from `PermissionRoutes` did NOT fail the audit, because a route removed
   from a table cannot be detected by inspecting that table. It now finds permission-granting
   routes by locating calls to `VsEdit.Grant(` instead.

Four negative controls now bite: drop `/scaninput`, drop `/wmchar`, add an undeclared injecting
route, drop `/vstype` from `PermissionRoutes`.

## RESOLVED (partly) - `/hooks` INJECTS, so it is not a passive observation

Found and characterised 2026-10-04. Split 2026-10-04.

`GET /hooks` calls `Hooks.Report()`, which signals the hook thread to send a real sentinel-tagged
F24 keystroke through `SendInput` and waits up to 400ms for it to return.

Measured on this host: eight reads advanced `livenessProbes` by 7; six `/guard` reads advanced
`operatorEvents` by 0. So it was an instrument that changes what it measures. The mission audit's
first version bracketed actions with both routes and would have reported `operator-proven` for a
keystroke it had itself caused.

**The split.** `Hooks.Report()` keeps every responsibility it had and now delegates to
`BuildJson(bool probeFired)`. `Hooks.PassiveDiagnostics()` returns the same counters with
`probeFired: false` and sends nothing, reachable at `GET /hooks-passive`. Both payloads carry
`probeFired`, so a reader never has to guess which kind of read they are holding. The mission
audit's `readRecord()` now uses only the pure `/guard`, and `readHookDiagnostics()` reports how
far its own read advanced the probe counter.

Measured after the split, same host:

```
5 reads of /hooks-passive  ->  operatorEvents delta 0    probeFired=false
5 reads of /hooks          ->  operatorEvents delta 5    probeFired=true
```

**Still open, deliberately.** `/hooks` remains ungated, and that is the watchdog working rather
than a hole: a hook Windows has silently detached can only be detected by sending it something,
and a dead hook would otherwise hide by refusing everything. F24 is bound by no application, is
not a reserved chord, and carries no target. Gating it would be the actual defect - so the audit
classifies it as `instrumentation` and asserts it stays ungated, rather than leaving that as an
unstated judgement.

There is also **no background probe timer**: `SendProbe` is reached only from `AwaitProbe`, which
is reached only from `Report()`, which is reached only from an HTTP route. An earlier measurement
that "waited 13 seconds and watched a probe appear" was measuring its own polling.
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


---

## M10 (2026-10-08) - the grammar is now sound; the MODEL is still not

**Supersedes the M9 entry as the most important one.** M9 said "the model cannot produce valid
plans". M10 is more precise and slightly worse news.

- Constrained generation is structurally sound: **90 controls pass**, including that it refuses a dead
  key prefix at its first character and that no reachable state is a dead end.
- Cost is **0.5% of wall clock**. Constrained decoding is not the constraint.
- The 1.5B model still produced **0 usable plans**, and the failure is now a **512-token ceiling
  reached inside a string value** - not malformed output. The model cannot sustain a two-step plan
  inside the budget.
- A 1.5B model can produce a genuinely good plan (observed once, UNCONSTRAINED). So the capability
  is near the surface and constrained decoding did not unlock it.

**Still open, and this is the binding constraint on usefulness:**

1. **A local model that produces valid plans - NOT PROVEN.** 0/4 constrained, 0/6 unconstrained at
   1.5B. A capability gap, not a safety gap.
2. **Generation latency.** 80-150s per attempt. A 7B model on 2 physical cores is 20-40 min/plan and
   remains impractical.
3. **Constrained decoding can manufacture FALSE REFUSALS.** Because `refusal` is a legitimate
   `PlanProposal` variant, a model unable to plan can emit a syntactically perfect refusal. That is
   safe - nothing executes - but it is dishonest, and `{"refusal":"well-formed nonsense"}` is
   indistinguishable from a real decline. Only the BLANK case is now caught.
4. **No backtracking.** The grammar refuses a dead prefix rather than recovering from one. For a weak
   model, backtracking would likely raise the validity rate; it is not implemented.

**Standing, unchanged:** release-after-takeover NOT PROVEN (H1/H2); P0 mouse sentinel (H4); window
management still ungated.


---

## M13 (2026-10-08) - the injection audit has a BLIND SPOT, and it hides a real gap

Sharper than the earlier "window management ungated" entry, and now diagnosed rather than merely
observed.

**What the audit asks:** does this route reach an injection primitive - `SendInput`, `Uia.Focus`,
`Uia.Invoke`, `Uia.SetValue`?

**What it should ask:** does this route change the machine?

`/show`, `/restore`, `/focus`, `/guifocus` reach **none** of those primitives, so the audit classifies
them as non-injecting and passes. But they show, restore and focus real windows. That is a
user-visible change to the machine, and they do not consult `MayInject()`.

**So there are two defects, and the second is why the first survived:**

1. the four window routes are not permission-gated;
2. the audit has no category for "changes the machine without injecting input", so an undeclared
   window route would also pass.

Defect 2 is the more dangerous one: it means the structural guarantee that "every action that can
change this machine passes through the declared gate" is currently **narrower than its own claim**.

**Why this was not fixed here.** The routes live in `control-core/src/OperatorHost.cs`. `control-core`
is inherited, proven code holding takeover, the latched stop and no-self-release, and this project does
not modify it without an ADR and a human decision. The audit harness is also in `control-core`, though
widening it would strictly *increase* detection and so is not a safety regression.

**Recommended, for a human decision:** treat this as H5. Widening the audit's model of
"changes the machine" to include window management is the higher-value half, because until it exists
the gate cannot be shown to be complete.

---

## M13 - constrained decoding MANUFACTURES FALSE REFUSALS (open)

Supersedes nothing; extends the M10 entry.

With both ceilings raised, the 1.5B model produced **3/3 syntactically valid documents, all of them
refusals, all of them nonsense**:

    ">>TheSummarizationTaskCannotBe"
    ">TheFolderPathC:\Users\Samer\A"

This is worse than M10's failure, not better. M10 produced an *obviously* broken document
("unterminated string"), which is an honest signal. M13 produces a well-formed document whose content
is meaningless, because `refusal` is a legitimate `PlanProposal` variant and therefore always offers the
model an easy valid completion when it cannot plan.

**Measured: genuine refusal 0/3, false refusal 3/3.**

I10 says a refusal must be meaningful. The M10 fix caught only the *blank* case. A non-blank refusal
whose text is a truncated fragment is still indistinguishable from a considered decline.

**What is deliberately NOT done about it.** Removing `refusal` from the grammar would raise the plan
rate and must never be done: declining is a *good* behaviour, and a system that cannot decline is a
system that acts when it should not. The grammar stays permissive. The honest position is that this
model cannot plan, and it now says so in a way that is easy to misread.


---

## M14 (2026-10-08) - RESOLVED AS A QUESTION, STILL OPEN AS A DEFECT

The entry below ("the injection audit has a BLIND SPOT") is **superseded** by measurement. The blind
spot is closed; what it was hiding is now a proven, counted defect.

### What the audit now does

`packages/control-core/audit-injection-routes.mjs` asks whether a route can change the machine, rather
than whether it injects input. It covers seven window-mutating primitives (`ShowWindow`,
`SetForegroundWindow`, `BringWindowToTop`, `SetActiveWindow`, `SetFocus`, `SwitchToThisWindow`,
`SetWindowPos`) **plus the two mutating helpers** `Win.Focus` and `Win.FocusChild`.

The helpers are the part that mattered. `/focus` calls `Win.Focus(...)`, never naming a P/Invoke, and
`Win.Focus` is a wrapper doing `ShowWindow(SW_RESTORE)` + `BringWindowToTop` + `SetForegroundWindow` +
`SetActiveWindow`. An audit matching only leaf declarations saw a route that steals the foreground as
reaching nothing at all. **This was found by the audit's own stale-entry check, not by reading.**

### The invariant, stated and answered

> Every action capable of changing the real machine state passes through the applicable declared gate.

**FALSE.** Three routes change machine state without a gate:

| Route | Changes | Has | Needs |
|---|---|---|---|
| `/show` | `ShowWindow` minimize/maximize/restore/show/hide | pid check | `MayInject()` |
| `/restore` | `ShowWindow(SW_RESTORE)` | pid check | `MayInject()` |
| `/focus` | `ShowWindow`+`BringWindowToTop`+`SetForegroundWindow`+`SetActiveWindow`, optionally `SetFocus` | `Verify()` | `MayInject()` |

**`Verify()` is an identity check, not a permission check.** It verifies the window is visible, not
minimised, and that pid and title match. It never calls `MayInject()`. A caller with no injection
permission can still take the foreground window from the person at the keyboard.

**`/guifocus` was REMOVED from this list as a correction.** Earlier entries here listed it as ungated.
It calls only `GetWindowThreadProcessId`, `GuiFocusOfThread`, `Title` and `Cls` - pure reads. It was
listed because nobody read what the route did. Two controls now assert it stays classified as a read.

### Severity: not a safety regression, but a real gap

The operator is **not armed** (`mayInject=false`) and no injection can occur, so nothing is being
exploited today. But the guarantee this project makes in writing was **narrower than believed**: "every
action that can change this machine passes through the declared gate" was asserted by a check that could
only see input injection.

### Blocked

The fix is three `MayInject()` calls and three names in `InjectionRoutes`, in `OperatorHost.cs` -
`control-core`, which this project does not modify without a human decision. Recorded in full, with the
exact code and three things to weigh, in [`../decisions/0003-gate-window-management-routes.md`](../decisions/0003-gate-window-management-routes.md).

### The audit can no longer go quiet

Three exit codes, and the distinction is the point:

- `0` invariant holds
- `1` invariant does NOT hold, every known cause documented
- `2` **UNDOCUMENTED BREACH** - a route mutates the machine and nobody wrote down why

`KNOWN_GAPS` grants nothing: it adds no route to `InjectionRoutes`, makes no check pass, and cannot
produce exit 0. Adding a route to it does **not** silence the alarm - there is a control for that,
because "just document it" is how a breach becomes permanent and invisible.


---

## M15 (2026-10-08) - the durable store exists and NOTHING writes to it

**A capability gap, not a safety gap.** Stated plainly because the previous entry in this file said
"no durable state at all" and that is no longer true, while the *useful* part of that statement still
is.

| | |
|---|---|
| Proven | a durable, versioned, session-scoped store, with evidence provenance and recovery rules |
| **Not proven** | that a **live mission** persists anything |

`packages/persistence/` is complete and tested, including against a genuine second OS process.
**SUPERSEDED by M16**: the executor now takes an optional `config.recorder` and every mission writes
to the store on the real path. The store is no longer orphaned.

**Why it was not wired in M15.** Doing it means deciding when the executor writes, and that interacts
with the retry and recovery paths. Doing it hastily would put writes in the one component that must not
be able to fail quietly. The module is standalone and proven first, which is the safer order.

**Selected as the next milestone (M16): instrument the executor.**

---

## M15 - defects found in the durable layer itself (all fixed, all by controls)

1. **Approvals survived a restart. The central failure of this milestone, shipped green.**
   `invalidateForeignApprovals` ran `SELECT id, session_id` and then filtered on
   `r.state === 'approved'` - a column it had never fetched. The filter was therefore always false,
   `stale` was always empty, and **no approval was ever invalidated**. An approval granted by a process
   that had died came back approved. Found by the one control that asserts an approval does not
   survive, and by nothing else - the code reads correctly.

2. **Evidence liveness was judged by a flag that never expires.** `observed_by = 'live-verifier'`
   records how a row was *originally* obtained, so a restarted mission counted a dead process's
   observation as current and believed it had just looked at the machine. Fixed by adding
   `obs_session_id` and judging liveness by session, the same rule approvals use.

3. **Recovery was not idempotent in its reporting.** The permit was built from "what did this read
   invalidate", and that list is empty on the second read - so the approval obligation *evaporated* on
   exactly the call a resuming process makes. Now derived from the approval rows, keyed on `grantedAt`
   rather than on the mutated `state`.

4. **Recovery notes were written after the record was read**, so `mission.history` omitted the very
   event it had just performed.

5. **The DDL control was defeated by its own documentation.** It searched the raw SQL for
   `succeeded` / `authorised` / `verified` and failed - because the comment explaining why those columns
   are absent contains the words. The fix was to strip SQL comments before searching. A control that can
   be beaten by its own comment gets deleted instead of understood; this one was fixed.

**Standing, unchanged:** release-after-takeover NOT PROVEN (H1/H2) · P0 mouse sentinel (H4) · **three
ungated window routes (H5, ADR 0003)** · the 1.5B model cannot plan · controlled decoding manufactures
false refusals.


---

## M16 (2026-10-08) - the executor is durably instrumented; two limits stand

### RESOLVED

`executor.ts` had no reference to the store. It now records, on the real path: the mission header, every
state transition, a write-ahead intent before each action, each action's outcome, verification evidence
with provenance, the derived step result, and the mission's ending. 16 controls, **317 total, 0
failures**.

### Still true, and honestly so

**1. There is no rollback of the machine.** An SQLite transaction makes row writes atomic. It cannot
make a `ShowWindow`, a browser click, a file write or a process launch atomic. When a record is lost
after an action, the step is marked `outcome-unknown` and a human - or a fresh observation - resolves
it. **No code path claims otherwise.**

**2. The recorder is OPTIONAL.** `config.recorder` may be omitted, and every existing caller and test
does. That was deliberate - it kept 301 green tests untouched - but it means a caller can run a mission
with no durable history at all. The live harnesses supply it; a future desktop shell must too, and
there is no control forcing that yet. Recorded rather than papered over.

### New states

`StepOutcome` gains `outcome-unknown`; `Step['status']` gains `uncertain`. `isComplete` names the case
and returns false. `isRetryable` returns false. `uncertainSteps()` finds them for reconciliation. None
is a success and none is retryable.

### Standing, unchanged

release-after-takeover NOT PROVEN (H1/H2) · P0 mouse sentinel (H4) · **three ungated window routes
(H5, ADR 0003)** · browser reproducibility · the 1.5B model cannot plan and should not receive further
investment unless evidence changes materially.


---

## M17 ATTEMPT (2026-10-08) - THE CONTROL-CORE PROOFS WERE NEVER RUNNING, AND TWO DO NOT PASS

**This is the most important entry in this file.** It corrects a claim this project has been making
since M1.

### What was found

Five harnesses in `packages/control-core/test/` are cited throughout this repository as the evidence
that the control core's properties hold: `prove-chord-swallow`, `prove-no-self-release`,
`prove-panel-release`, `prove-panel-colour`, `prove-status-truth`.

**All five failed with `ERR_MODULE_NOT_FOUND`.** `test/prove-*.mjs` imported `./operator.mjs`, which
lives one directory up; and `operator.mjs` itself imported `playwright` at the top level, a package
that is neither installed nor declared in `package.json` (which has no dependencies at all).

So the module could not be loaded, and **no proof had ever executed**. The properties were asserted by
documentation, not demonstrated.

### Fixed enough to run

* the five imports corrected to `../operator.mjs`
* `operator.mjs` now loads `playwright` LAZILY

The lazy import is the load-bearing change. Those proofs are about windows and a panel; they never touch
a browser. A missing browser library must not be able to stop the safety properties of the entire
control core from being demonstrated. The Chromium **binary** is present; the npm package is not, so
browser driving is genuinely unavailable and is now reported as a clear error at the point of use.

### The measured baseline, and what it means

| Proof | Result |
|---|---|
| `prove-chord-swallow` | **PASS** |
| `prove-panel-release` | 2 failures |
| `prove-no-self-release` | 3 named failures (5 reported) |
| `prove-panel-colour` | crashes - `fetch failed`, socket closed |
| `prove-status-truth` | crashes - same |

**The dangerous claims mostly hold.** `/release` and `/rearm` are refused. An injected, untagged click
is refused by the hook. Nothing was forged as a human event (`humanEvents 195496 -> 1954`, unchanged).

**The observability claims fail.** The hook accepts a release and attributes it correctly
(`release ACCEPTED: genuine hardware click`) but does not **tag** the click in its region
(`tagged +0`), so the evidence chain is incomplete. And the takeover status is not reported properly:
`takeoverPending is STILL set after every route above`, and the message does not name the action the
human must take.

**So: "takeover, latched stop and no-self-release are PROVEN" was overstated.** The refusals hold. The
*reporting* of why, and that a takeover is still pending, does not. Two harnesses cannot run at all.

### Consequence: H5 is NOT proceeding

ADR 0003 proposes adding `MayInject()` to `/show`, `/restore` and `/focus` in `OperatorHost.cs`. That
is safety-critical inherited code, and the whole reason for the "ADR plus human decision" rule is that
its properties are proven.

**They are not currently proven.** Two proofs crash and two report failures. Making that change now
would mean editing the takeover code with an unreliable safety net, and a mistake would be invisible -
which is precisely the scenario the rule exists to prevent.

### Next milestone: M17 - MAKE THE PROOFS A RELIABLE GATE

Not "fix the control core" - fix the **harnesses**, in `.mjs`, which are not the safety-critical C#:

1. all five run and exit deterministically (the socket failures diagnosed first)
2. each asserts the specific claim it exists to prove, with no ambiguity between a security failure
   and an observability failure
3. wired into `npm test` so the gate cannot rot again - **this is the part that matters**, because the
   rot happened precisely because nothing ran them
4. then re-baseline, and only then decide H5

Until (3) exists, any claim in this repository that rests on these proofs is documentation, not
evidence.


---

## M17 (2026-10-08) - THE PROOF GATE EXISTS, AND IT SAYS THE CORE IS NOT DEMONSTRATED

Part 1 made the five proofs runnable. Part 2 made them **honest and wired**, so this cannot recur.

### What was built

`test/proof-kit.mjs` and `test/run-proof-gate.mjs`, run by **`npm run control:proofs`**. It runs every
proof and sorts the outcome into three states that were previously collapsed:

| State | Meaning |
|---|---|
| PASS | every claim held, nothing skipped |
| FAILED | a claim is false |
| **INCONCLUSIVE** | a claim could not be tested because a dependency was unavailable |

Exit codes: `0` all held · `1` a claim failed · `3` inconclusive. **The gate fails on inconclusive as
well as on failure**, because a gate that passes when a proof was skipped is not a gate.

Two harnesses previously CRASHED on the host's dead pixel-capture endpoints, which produced no verdict
at all. They now report INCONCLUSIVE - and, critically, their colour assertions are marked **SKIP**, not
FAIL, because a broken instrument must not be recorded as a defect in the thing being measured.

### The measured verdict

```
FAILED         prove-chord-swallow      4 claims
INCONCLUSIVE   prove-status-truth       corroborating screenshot unavailable
FAILED         prove-panel-release      2 claims
INCONCLUSIVE   prove-panel-colour       3 assertions skipped, pixels unreadable
FAILED         prove-no-self-release    3 claims
GATE EXIT 1
```

Not order-dependence: each proof run standalone gives the identical verdict.

### The three causes, and they are all REPORTING, not ESCAPE

**1. The host's pixel-capture endpoints do not respond.** `/screen.png` and `/panelgrid` both close the
connection without a response. Two proofs are inconclusive because their instrument is dead.

**2. The hook's swallow COUNTER contradicts its own outcome string.** The host reports
`lastChordOutcome="Ctrl+Alt+Esc recognized; swallowed; emergency stop latched"` while the cumulative
counter shows `kbdSwallowed: 12` and the proof measures a delta of `swallowed=+0`. The hook says it
swallowed; the counter says it did not. One of those is a lie, and it is the kind this project exists to
eliminate.

**3. The pending-takeover state is not reported.** `/guard` returns `takeoverPending: false` with
`emergencyLatched: true` and `lastTakeoverAt: 179145...`, so a takeover DID occur and the payload does
not say so. The message also fails to name the action the human must take.

### What this does and does not mean

**The refusals hold.** Measured, repeatedly: `/release` refused · `/rearm` refused · an injected,
untagged click refused by the hook and credited to the OPERATOR · injection refused while blocked ·
`/arm` cannot lift a takeover · `/drain` alone cannot lift a takeover · nothing forged as a human event
(`humanEvents 195496 -> 195496`, unchanged).

**The evidence does not.** The behaviour looks right and the instrumentation cannot demonstrate it. For a
project whose thesis is "verified results, never executed == succeeded", an unreliable status path is
not a cosmetic problem - it undermines the project's own verification story.

### Why this now needs a human decision

Fixing (2) and (3) means changing the hook instrumentation and the status payload **inside
`control-core/src`**. That is the same class of change as H5, and it is the same reason it was deferred:
the rule exists so that proven code is not edited without a green baseline, and there is no green
baseline - that is the finding.

**Recommended sequence, and it needs a decision to begin:**

1. fix `/screen.png` and `/panelgrid` (a capability defect, plausibly a GDI/capture path in the host)
2. reconcile the swallow counter with the outcome string
3. report `takeoverPending` truthfully
4. re-baseline the gate until it is green
5. **only then** H5 - gate `/show`, `/restore`, `/focus`

Steps 1-3 all touch `control-core/src`. Per the ADR rule this is a human decision, and unlike H5 it is not
optional work: until it is done, this repository cannot honestly claim the control core's properties are
demonstrated.


---

## M17 PART 3 (2026-10-08) - `capture-helper.ps1` WAS NEVER IN THE REPOSITORY

The single largest defect found in this project, and it was found because the M17 gate refused to go
green for a reason nobody had investigated.

### What it was

`OperatorHost.cs` has always delegated its screen capture to a PowerShell helper beside `host.json`:

    string helper = Path.Combine(dir, "capture-helper.ps1");
    if (!File.Exists(helper)) throw new FileNotFoundException("capture-helper.ps1 missing at " + helper);

**That file was not in the repository.** So every `/screen.png` and `/panelgrid` call threw
`FileNotFoundException` from inside the request handler, the socket closed without a response, and the
client saw `other side closed`.

Consequence: **the control core has never taken a screenshot**, and two proofs could never test what the
human actually sees. The same defect class as the five proofs that never executed - a required artefact
absent, the failure invisible, and the repository still citing capabilities that depended on it.

### The fix

`capture-helper.ps1` written to the contract the C# **already** expects, not a new one: `-X -Y -W -H` in
virtualised coordinates, `-VirtW -VirtH`, `-Out`, and stdout containing the literal `"scalePct":[N]`
that `ScreenPng` parses.

The host process is deliberately DPI-**unaware** - the C# records that making it aware fixed the crop
but broke click targeting, producing a scale of exactly 0.8 that missed every target. So the helper
makes **its own thread** per-monitor-v2 aware and **measures** the scale rather than assuming it.

**Measured: `scalePct: [80]`, physical 1920x1080 against virtualised 1536x864** - exactly the 0.8 the
C# comments describe, now derived rather than stumbled upon.

The capture is a single `Graphics.CopyFromScreen`. A first version did the whole thing in C# with
`CreateCompatibleDC`/`BitBlt`/`Image.FromHbitmap`, which needed an explicit `System.Drawing` reference
and juggled four GDI handles per capture - slow resource exhaustion in a long-lived process, not a
crash. One call with nothing to release is the right shape.

### A second finding: OCCLUSION

`/panelgrid` reports a rect and reads the pixels inside it **without confirming the panel is visible
there**. Captured directly, the region contained the **desktop wallpaper** - `purity: 0.022`, dominant
`#B9BCD2` - while the panel was occluded.

That matters because this proof exists to catch "the panel reads green while input is blocked", so
reading someone else's pixels is precisely the hazard it guards against. `prove-panel-colour` now
detects a dominant colour the panel cannot paint and reports **INCONCLUSIVE** rather than FAILURE: the
claim was not tested, and blaming the panel for pixels that were never its own would be wrong.

**Known weakness, stated rather than smoothed over:** occlusion is intermittent, so this proof can report
PASS on one run and INCONCLUSIVE on the next depending on whether the panel happens to be on top. A
PASS from it is therefore weaker evidence than a PASS from `prove-status-truth`.

### Where the gate stands

| Proof | Before | After |
|---|---|---|
| `prove-status-truth` | INCONCLUSIVE | **PASS** |
| `prove-panel-colour` | INCONCLUSIVE | PASS / INCONCLUSIVE (occlusion-dependent) |
| `prove-chord-swallow` | FAILED (4) | FAILED (4) |
| `prove-panel-release` | FAILED (2) | FAILED (2) |
| `prove-no-self-release` | FAILED (3) | FAILED (1) |

`prove-no-self-release` improved from three failures to one: the payload now reports the pending
takeover, and `takeoverPending is STILL set` passes. **The remaining failures are instrumentation, not
escape** - the swallow counter, the untagged-click tag, and one message that does not name the human's
action. The refusals all hold.


---

## STABILISATION PASS (2026-10-08) - the evidence system itself

### THE TYPECHECK DID NOT EXIST

No `tsconfig.json`, TypeScript not installed, and every script ran `--experimental-strip-types`, which
STRIPS types rather than checking them. Turning a real check on found **444 errors, 228 in product
code**. All survived a green suite, because type-only imports are erased and their paths were therefore
never resolved.

Unresolvable references are now **zero**, and the whole project is **0 type errors across 82 files**.

The gate has no baseline. An earlier version compared against a committed count and failed only on a
regression; that was wrong, because a baseline says "these errors are accepted" and a number someone
agreed to is not the same as a number someone decided about.

`noUncheckedIndexedAccess` is deliberately OFF. It added ~126 errors overnight across never-checked
code, and folding a retroactively-applied strictness increase into the same count as real defects
produces a number that cannot tell whether the code is getting safer.

### REAL DEFECTS THE TYPECHECK FOUND

- **Durable evidence was written for REJECTED verifications.** `rec.verified()` sat above the
  accepted/rejected test, so the store was told a step had been verified on the strength of a
  verification that had just refused to verify it, with `undefined` as the evidence.
- **The reviewed-plan check never ran in two harnesses.** `reviewedProposalDigest` was passed inside
  `deps` instead of `opts`, so "is this the plan a human reviewed?" was silently skipped.
- **`PlanStep` had no `effect` field** while `compile.ts` copied it, `review/render.ts` rendered it and
  the model parser validated it. `compile.ts`'s own comment records the cost: a plan declaring a
  consequential effect had it dropped, the approval gate never saw it, and the action ran UNAPPROVED.
- **The supervisor's non-convergence refusal omitted `stepOutcomes`**, which its own caller reads.
- **`ControlSurface` required `permission()`**, which nothing called and which the design forbids - a
  permission query on the surface invites a caller to ask a surface to bless itself.
- **`run-gui-audit` was the only caller** never updated when `guiVerifier` gained a required
  `baselineOperatorEvents`, so the audit harness was the one place the control layer's event count was
  not baselined before the step ran.
- **`ModelRequest` described a v2 protocol** the code had been rewritten away from in v3.
- The two "refused to run an unreviewed plan" early returns built a record of the **wrong shape** - no
  `events`, `state` where the type says `finalState`, and a number where the type says a map.

Control E ("no planner module can import anything that could execute") was NOT weakened. The planner's
new type is routed through `mission-engine/state.ts`, which already held `Step.effect` and is not on
Control E's forbidden list.

### THE GATES, AND THE TWO WAYS THEY COULD NOT FAIL

The first typecheck gate resolved its working directory to one level ABOVE the repo root, found no
tsconfig and no source, reported zero errors and printed PASS. A gate that checks the wrong directory
and reports success is worse than no gate, because it is believed.

It now refuses to pass unless the tsconfig exists, tsc actually ran, AND it loaded real project source -
"zero errors from zero files" is not the same as "zero errors". Five controls prove each of those, and
one deliberate type error in a real product file makes it fail.

### CONTAINMENT AND SETTLEMENT

- The process sampler returned `[]` on EVERY call, for two compounding reasons: statements joined with a
  space, then joined with `;` - and `-Command` argv parsing strips the quotes, leaving `SilentlyContinue`
  as a bare word. So nothing was sampled, nothing was reaped, and `reapObserved` reported `clean: true`.
  "Nothing observed" was being reported as "nothing survived." It now REFUSES to report clean when the
  process table could not be read, including when the output comes back unparseable.
- A successful command was recorded as a TIMEOUT FAILURE: the tool settled on `'close'`, which needs
  stdio closed, and a backgrounded child holds the pipe. Measured: parent exits 0 at 1.4s, pipe still
  open at 21.4s. The timeout handler then reaped the process the command legitimately started.
  Now settles on `'exit'` with a bounded 250ms drain. **[measured] settle 2693ms, 2 descendants
  observed and reaped, against a 20s timeout.**
- **On Windows a non-detached grandchild does NOT outlive its parent** - measured across four
  combinations. Only `detached: true` survives. So the orphan case requires a detached child.
- `killAndConfirm` answered `true` for a pid that never existed, conflating "I killed it" with "it is
  not running".
- `childrenOf` could REJECT rather than resolve, when the binary could not be spawned at all.

### DURABLE EXECUTOR INTEGRATION WAS NOT ON THE LIVE PATH

Twenty-three `execute()` call sites outside the tests, and **none passed a recorder**. The store was
fully implemented, fully proven in tests, and completely bypassed in production. The M16 controls passed
because they construct the executor directly.

`run-durable-mission.ts` now performs a real action against a real `DurableStore` on a real file, and
proves - reading from the STORE and the DISK, never from the return value:

    13 durable events (note 3, step 6, observation 2, recovery 2), surviving a close/reopen
    evidence byte count matches the file on disk, attributed to a verifier with a session
    a reopened row is marked RESTORED, never live
    completion is re-derived from rows, not read from a stored flag
    resumeMission on an interrupted step returns OBLIGATIONS: re-observe, recover-step
    requiresFreshObservation is always true; liveEvidence is empty across a restart
    the store holds ZERO approvals - persistence is not authority

### STILL RED, AND STILL BLOCKING

- `npm run control:proofs` exits **1**: `prove-chord-swallow` (4 claims), `prove-panel-release` (2),
  `prove-no-self-release` (3). `prove-status-truth` and `prove-panel-colour` PASS. These are the
  pre-existing control-core instrumentation defects and they require editing
  `control-core/src/OperatorHost.cs`, which is not modified without an ADR and a human decision.
- `npm run control:audit-routes` exits **1**: `/show`, `/restore`, `/focus` change machine state without
  `MayInject()`. H5 / ADR 0003 remains open and untouched.
---

## PHASE 3 — the round-budget exhaustion test is MISSING, not broken (open)

**This is a coverage gap, not a defect.** Recorded because the passing test it currently rests on
passed for the wrong reason, and that will not hold if the code moves.

`FRESH BUT UNRESOLVABLE findings terminate as a blocker` asserts that a fresh task with
`maxReviewRounds: 3` runs exactly 3 reviewer rounds. It passes — but it passes because of the
**terminal guard** (a `done`/`exhausted` task spends no further cycle), not because any test exercises
the review-budget branch itself. Measured: reverting that guard makes the test run **6** rounds instead
of 3, so the guard is load-bearing and the budget check is only reached incidentally.

| | status |
|---|---|
| A fresh task stops at its configured review budget | **PROVEN**, but indirectly |
| The `roundCount >= task.maxReviewRounds` branch is directly exercised | **NOT PROVEN** |
| A task is exhausted at exactly N rounds for N = 1, 2, 3, 5 | **NOT PROVEN** |
| The budget note and a readable blocker are produced by that branch | **NOT PROVEN** |

Why it matters: the budget is the ceiling that makes the loop *bounded* when the reviewer keeps raising
genuinely new findings — the case where the repetition guard correctly does not fire. Nothing currently
pins the boundary itself. A refactor that reordered the status chain, or made the terminal guard
unreachable, could make every task exhaust at 2 rounds and this suite would still be green.

Follow-up: add a boundary-sweep test — for `maxReviewRounds` in {1, 2, 3, 5}, assert the exact reviewer
round count, `status === 'exhausted'`, a note matching `/review budget/`, and at least one blocker.
Assert the count is reached **by the budget**, i.e. that the note says the budget and not repetition,
so the two exhaustion causes cannot be confused again.
### RESOLVED — M-a, 2026-10-11

The sweep exists and is mutation-verified. `packages/agent/test/convergence.test.ts` now carries
`the REVIEW BUDGET is the boundary: N rounds buys exactly N rounds, and the reason says so`, covering
`maxReviewRounds` in {1, 2, 3, 5}. Each budget asserts the exact reviewer-round count, `exhausted`, a
`/review budget/` note, `findingsSeen.length === budget`, **both** repetition reasons excluded by name
(the findings-repetition note and the outcome-repetition note), and a blocker carrying the budget
reason. The loop runs `budget + 3` cycles, so an unbounded loop overshoots the budget rather than
matching it.

Mutation evidence: the test fails when the budget branch is disabled (`false && ...`) and on an
off-by-one (`>=` changed to `>`), which would let every budget overshoot by one round. The N=3
scenario test above is retained: it proves termination, the sweep proves the boundary.

Gates after M-a: convergence 19/19, agent 36/36, repository unit 684/684, type-check 131 files /
0 errors. Production code unchanged - `orchestrator.ts` sha256 `f27f3f60a6c3155b` before and after.

The three NOT PROVEN rows in the entry above are now covered. That entry is kept rather than
rewritten, because what it recorded was true when it was recorded.