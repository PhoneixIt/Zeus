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
