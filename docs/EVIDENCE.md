# Evidence ledger

What was actually measured, on the real machine, and how to reproduce it. A claim not in this
file is not evidence.

Reproduce everything from the repo root with `npm test` plus the commands below. The operator
host must be running for the live missions (`npm run control:up`).

---

## Proven

### Structural injection gate — every route
```
npm run control:audit-routes
```
Parses `OperatorHost.cs` and `Hooks.cs`, resolves every input primitive transitively through
helper methods, and fails if any route that can change the machine is not declared.

```
declared injection  11 routes
declared authority   1 route  (grants permission without injecting)
injection helpers    4        (TypeText, KeyVk, Mouse, Hooks.MoveAbsolute)
=== PASS ===
```

Live host, `mayInject=false`, valid visible target supplied:

```
/scaninput       guard=true   state is OBSERVING; the operator must be ARMED to inject input
/wmchar          guard=true   (same)
/click-absolute  guard=true   (same)
/vstype          guard=true   (same)
/uiainvoke       guard=true   (same)
```

Four negative controls bite: drop `/scaninput`, drop `/wmchar`, add an undeclared injecting
route, drop `/vstype` from `PermissionRoutes`.

### Passive vs active hook observation
```
6 reads of /hooks-passive  ->  operatorEvents delta 0    probeFired=false
6 reads of /hooks          ->  operatorEvents delta 6    probeFired=true
```
`/hooks` calls `Hooks.Report()`, which sends a real sentinel-tagged F24 keystroke. There is
**no background probe timer**.

### Injection audit, keyboard attribution — the accept path
```
npm run mission:gui-accept
```
```
operatorEvents  72 -> 75      humanEvents 8515 -> 8515  (delta 0)
step 2  gui  operator-self-test  verified
evidence  input-attributed, actor=operator, proven=true
          "class instrumentation; input yes; attribution operator-proven"
mission complete
```
Uses the control layer's own F24 liveness probe via `GET /hooks`. No control-core change, no
permission bypass, no sentinel read by the caller.

Anchored baseline: the verifier holds an `operatorEvents` count captured by the harness before
the step, so a tool that fabricates its audit cannot verify. Removing that check → 2 unit
failures and a live failure.

### First user-driven end-to-end mission
```
npm run mission:folder
```
```
THE USER SAID
  "Summarise the contents of the folder "<tmp>\reports" and write a summary file"

PROPOSED PLAN (5 steps, shown before anything runs)
  read-folder     filesystem  independent-source  abort-mission
  inspect-folder  filesystem  independent-source  abort-mission   dependsOn read-folder
  compose-summary filesystem  must-contain        abort-mission   dependsOn inspect-folder
  write-report    filesystem  must-exist          abort-mission   dependsOn compose-summary
  confirm-report  filesystem  must-read-back      abort-mission   dependsOn write-report

EXECUTION
  read-folder      verified  {"kind":"directory-present",...}
  inspect-folder   verified  {"kind":"folder-contents","entries":5,...}
  compose-summary  verified  {"kind":"summary-composed","bytes":457,"provenance":"deterministic"}
  write-report     verified  {"kind":"file-written","bytes":457,...}
  confirm-report   verified  {"kind":"file-read-back",...}

mission state complete   complete=true
integrity no violations

ON DISK (read independently of the mission)
  # Contents of <tmp>\reports
  - 5 entries total: 4 file(s), 1 folder(s)
  - by extension: md (2), csv (1), txt (1)
```

Seven negative controls, all biting: unrecognised objective → no plan; nonexistent folder → no
plan; unregistered tool → step fails with no substitution; a write claimed without a file →
rejected; verification removed → step cannot complete; output aimed outside the output root →
refused and no file created; a failed prerequisite → later steps `skipped`.

No injected input. No armed operator. Everything under one disposable directory, removed at the
end.

### Execution substrate
```
npm test                                        148 pass / 0 fail
npm run mission:live                            PASS
npm run mission:two-step                        PASS
npm run mission:filesystem                      PASS
npm run mission:gui-audit                       PASS
npm run mission:gui-accept                      PASS
npm run mission:folder                           PASS
npm run mission:recovery                          PASS
npm run mission:approval                         PASS
```

### Consequential-action governance
```
npm run mission:approval
```
```
BLOCKED (no approval)
  mission state      blocked-on-human   complete=false
  step 2 outcome     needs-human
  reason             awaiting human authorisation for delete on <ws>\alpha.txt: ...
  tool-selected      0            <- the tool was never even SELECTED
  approval-required  1
  journal entries    +0           <- nothing happened
  probe still exists true

APPROVED (explicit human decision)
  key   m-approval|remove-probe|delete|<ws>\alpha.txt|#0
  state approved   by test-human
  step 2 outcome   verified        mission complete
  tool-selected    1
  journal          ["deleted <ws>\alpha.txt"]
  probe exists     false
```

Negative controls, both layers:

| removed protection | result |
|---|---|
| the entire approval gate | live: **8 FAILURES** — the UNAPPROVED delete executed and the mission reported `complete` |
| gate keyed on the declaration only | unit 147 / **1 FAIL** |
| `decide()` accepts any key | unit 147 / **1 FAIL** |
| epoch dropped from the key | unit 146 / **2 FAIL** |
| restored | unit **148 / 0**, live **PASS** |

The `decide()` refusal is what makes "the planner grants itself approval" impossible: the planner
has no reference to the store, and even if it could, a decision for a key nobody requested is
rejected.

The declaration/tool mismatch check closes a hole found while building this: keying the gate only
on the plan's DECLARATION let a planner omit it and act unapproved. A property of the
implementation cannot be established by a property of the request.

---
### Recovery from a genuine environmental change
```
npm run mission:recovery
```
A folder is renamed on disk between two steps by ordinary filesystem calls. No flag is set.

```
ATTEMPT 1   plan  read-folder -> inspect-folder -> compose-summary -> write-report -> confirm-report
           state recovering   complete=false   verified 1  failed 0  skipped 3
           invalidation  environment-changed: the folder this step was told to list is gone
           observed      "...\reports no longer exists; ...\ now contains [out, archive]"

WORLD       "reports" exists: false    "...\archive\reports" exists: true

ATTEMPT 2   amended objective  Summarise the folder "...\archive\reports"
           substitutions      1
             ...\reports -> ...\archive\reports
             why: no longer exists; exactly one directory named "reports" was observed
           state complete   verified 5
           evidence  directory-present · folder-contents · summary-composed
                     · file-written · file-read-back

recovered: true   attempts: 2
```

Two extra scenarios exist specifically so the negative controls can bite:

```
R2  the world moves TWICE          -> 3 attempts, 2 substitutions, recovered
R3  a correct replan, retry fails  -> ok=false, reported as NOT recovered
```

Nothing carries forward without evidence: a replanned attempt starts a fresh mission and
re-runs every step, because a verification true of the old world says nothing about the new one.

### Recovery negative controls — both layers

| removed protection | unit | live |
|---|---|---|
| fresh re-observation (stale observation reused) | **130 / 1 FAIL** | **1 FAILURE** |
| detection treated as recovery (`replan-required` → `ok`) | **126 / 5 FAIL** | **5 FAILURES** |
| restored | **131 / 0** | **PASS** |

Exact failing assertions, so it is clear each failed for its own reason and not because an
unrelated guard tripped:

```
fresh re-observation removed:
  "attempt 3: the planner refused the objective - the folder \"...\" ..."
  chain: stale observation -> amended objective names a dead folder -> planner refuses

detection treated as recovery:
  "with no recovery budget the mission must not complete"
  "a world that cannot be reconciled must fail"
  "invalidated, invalidated, recovered"
  "a correct replan is not recovery"
  attempts.length 1, expected 2
```

The first two of these initially did **not** bite at all, in either layer. A single
mid-mission change recovers on attempt 2, so a supervisor that reused its observation, or that
treated "we replanned" as recovery, behaved identically to a correct one. The suite reported
129/0 with either defect present. R2 and R3 were built to close that.

---

## Blocked

### P0 — mouse attribution
`dwExtraInfo` does not survive the Windows mouse path.

```
mouseEventsSeen 6772   mouseTaggedSeen 0   mouseUntaggedSeen 5476
```

An operator mouse click is classified as **human**. Conservative — it halts rather than acts —
but wrong. Not fixed. Blocked on decision **H4**.

### Release / resume — NOT PROVEN
No trustworthy mechanism exists for a human to return control to the operator after a takeover.
The operator therefore stays paused, which is safe and which blocks every real-injection
milestone. Blocked on **H1** + **H2**.

### Window management is ungated
`/show` (can hide a window), `/restore`, `/focus`, `/guifocus` change the user's machine without
consulting `MayInject()`. They do require `Verify()` — the caller must name hwnd, pid and title,
and the pid must own the window — so they are not arbitrary, but they are not permission-gated
either. Found while building the injection gate; the gate's scope is injection, and
`ShowWindow` is not an injection primitive. **Not fixed.**

---

## Defects found by running things

Every one of these looked correct until it was executed. Listed because the pattern matters more
than any individual entry.

| defect | consequence if unnoticed |
|---|---|
| A `Proxy` used as the injection oracle | measured intent, not events; a missed injection still counted |
| `windows()` response shape assumed to be an array | silent empty observation that verified against itself |
| `uia` step verified by the `cli` verifier | plausible evidence from the wrong mechanism |
| Dependency-blocked step recorded as `failed` | a gate misdescribed as a failure |
| Containment test asserting a globally-named path | flaky test wearing a safety claim |
| Negative control whose lie had become true | control passed while proving nothing |
| `/scaninput` and `/wmchar` ungated | real keystrokes into a foreground window while paused |
| `/hooks` injecting on read | the audit partly measuring its own side effect |
| A refused action scored `verified` | a mission whose click never happened read `complete` |
| `recordResult` hardcoding `output: undefined` | no data flow between steps at all |
| Verifier keyed on a tool name instead of a step id | a verifier that silently claimed nothing |
| `/g`-flagged regex used with `.test()` | intermittent refusal of valid objectives |
| Two missions asserting a machine state | proofs that were snapshots, not invariants |
| `/hooks` self-measurement | the audit partly observing its own side effect |
| `recordResult` hardcoding `output: undefined` | no data flow between steps at all |
| Verifier keyed on a tool name instead of a step id | a verifier that silently claimed nothing |
| `/g`-flagged regex used with `.test()` | intermittent refusal of valid objectives |
| Renaming a folder *during* a step | invalidated that step's own verification — harness bug, system right |
| Scenario reusing another scenario's verifier | containment check correctly refused, wired to the wrong world |
| Observation depth hardcoded | a folder moved too deep became invisible and unreconcilable |
| A harness that crashed under its own controls | could not show the controls failed for the right reason |
| Two recovery controls that could not fail | suite reported 129/0 with either protection removed |
| Approval gate keyed only on the plan's declaration | a planner could omit it and act unapproved |
| Gate reading the approval twice with a non-null assertion | removing the gate crashed the harness instead of failing it |
| A control sharing one probe file across scenarios | later controls failed at the dependency gate, never reaching the one under test |
| Control F disabling verification mission-wide | showed "nothing happened" rather than "approved but unverified" |

---

## Environment notes

- Repository files are **LF only**. CRLF anchors in scripts silently match nothing.
- Negative-control scripts must abort if the source did not actually change.
- `execFile` cannot spawn `.cmd`/`.ps1` npm shims.
- `git commit -F -` gets no piped stdin in PowerShell — write a message file.
- `screen()` takes a bare filename. Host `windows()` returns `{ok, windows}`, not an array.
- `[IO.File]` resolves relative paths against the process CWD, not PowerShell's.
- The host must be started with `$env:PORTAI_OPERATOR_DIR` set to `packages/control-core`.
- The operator may come up in `OBSERVING` after a restart. That is a safe state, not a fault.
