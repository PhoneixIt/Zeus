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
npm test                                        181 pass / 0 fail
npm run mission:live                            PASS
npm run mission:two-step                        PASS
npm run mission:filesystem                      PASS
npm run mission:gui-audit                       PASS
npm run mission:gui-accept                      PASS
npm run mission:folder                           PASS
npm run mission:recovery                          PASS
npm run mission:approval                         PASS
npm run mission:terminal                         PASS
```

### Terminal mode
```
npm run mission:terminal
```
The real mission: inspect the workspace → run a deterministic node script over it → write a report
→ **independently verify the report** → read it back. 3 steps verified, mission complete.

The two computations that matter are deliberately different code. The child reads the input files
and writes an answer; the verifier reads the same inputs and derives the answer again, in-process,
with its own arithmetic. Neither can vouch for the other.

```
EXPECTED (computed before anything ran)
  "alpha:3\nbeta:7\ndelta:0\ngamma:11\nTOTAL:21\n"

APPROVED run
  step inspect      verified
  step tally        verified      node.exe 1 arg(s)
  step read-report  verified
  process state     completed  exit=0  signal=null  timedOut=false
  report content    "alpha:3\nbeta:7\ndelta:0\ngamma:11\nTOTAL:21\n"
  events            approval-satisfied=1  tool-selected=3
  complete          true
```

Process lifecycle, all measured on this machine:

| situation | result |
|---|---|
| exit 0, artifact present, content matches | `verified` |
| exit 0, **nothing produced**, stdout claims success | `rejected` — control A |
| exit 0, artifact present, **content wrong** | `rejected` — control A2 |
| non-zero exit | `failed`, stderr reaches the human — control B |
| asks for a password | `needs-human` in 77ms, no credential supplied — control C |
| hangs with a live grandchild | `failed` at 1.4s, **grandchild reaped, wrote nothing** — control D |
| script outside the workspace / `..` / shell / `node -e` | refused — controls E, E2 |
| executable missing | `failed`, never `nothing-found` — control F |
| consequential, unapproved | `needs-human`, 0 `tool-selected` — control G |
| approved + executed, verification suppressed | cannot complete, action DID run — control H |

36 live checks, 0 failures.

**What is enforced, and what is not** — four distinct things, kept apart because conflating them is
how "we set the working directory" becomes "sandboxed":

- **Executable allowlist — real.** Absolute paths only; a bare name is refused, so a PATH entry
  cannot substitute a program. Measured: `node.exe` on PATH resolves to the same file the allowlist
  names, and `where.exe` is refused even though it exists, so the refusal is a policy decision and
  not "file not found".
- **Argv / path validation — real.** Resolved through `realpath` on both sides, so a **junction**
  out of the workspace is caught; a textual prefix test would pass it. The test FAILS if it cannot
  create the junction, so it cannot pass vacuously.
- **Working directory — set, and weak.** It controls where relative paths resolve. It restricts
  nothing else, and a program wanting to read `C:\` does not have to try hard.
- **OS-level isolation — ABSENT.** No Job Object, no AppContainer, no restricted token, no
  container. A permitted process runs as the user and is not contained.

Not restricted: reading or writing any file the user can reach · network egress · spawning children
(they are reaped on timeout, not validated) · registry, services, scheduled tasks, WMI · DLL
loading, so code this policy never saw. `LIMITATIONS` in `terminal-policy.ts` says all of this, and
a unit test asserts the list still contains it so the documentation cannot quietly drift.

Environment, measured rather than assumed: requested 7 names, the child received those **plus 8
injected by the Windows loader** (`HOMEDRIVE, HOMEPATH, LOGONSERVER, SYSTEMDRIVE, USERDOMAIN,
USERNAME, USERPROFILE, WINDIR`) which the parent cannot suppress. A secret in the parent
environment did not arrive. A real reduction, not a sealed set.

Consequences are read from the **arguments**, not a static flag — because one flag cannot express
`git status` (read) and `git push` (sends). `effectOf` lets the tool classify the specific step, and
the executor gates on the tool's answer. A plan that *misdescribes* its own command is a plan
defect that fails the step, not one to be corrected silently.

#### Controls, both layers

| protection removed | live | unit |
|---|---|---|
| the whole approval gate | — | 171 / **10 FAIL** |
| the tool supplies no `effectOf` | — | 176 / **5 FAIL** |
| `..` traversal check | — | 148 / **1 FAIL** |
| timeout never fires | — | 148 / **1 FAIL** |
| preflight refusal skipped | **6 FAILURES** | 180 / 1 |
| absolute-path-outside check | **2 FAILURES** | 179 / 2 |
| content comparison dropped | **1 FAILURE** | 180 / 1 |
| all three refusal layers | **6 FAILURES** | 177 / 4 |
| restored | **PASS** (36) | **181 / 0** |

Two controls initially did not bite, and both were my measurement failing rather than the protection
being absent:

1. **"verifier trusts exit code 0" reported live PASS.** Removing only the `existsSync` guard left
   the content comparison to catch the same case — the existence check is redundant *for rejection*
   and its unique contribution is the error message. Removing the whole filesystem comparison made
   control A2 fail. So the honest statement is: rejection rests on the content comparison; the
   existence check is a clearer message, not a second wall.
2. **"shell refusal table not consulted" reported live PASS.** The control removed
   `REFUSED_PROGRAMS` but `cmd.exe` is *also* on the allowlist, whose own `classify()` refused it —
   so the control proved nothing. It only bit with all three layers gone (refusal table, allowlist
   entry, and the tool's own re-check in `run()`). Defence in depth was real; my first measurement
   of it was not.

#### Two defects found in my own code while building this

- **The verifier threw ENOENT instead of rejecting** when the existence check was removed. A
  verifier that crashes on a missing file can be broken by *deleting the thing it verifies*, so the
  absence of evidence destroyed the evidence. The read is now inside a `try`; the existence check
  remains for the message but is no longer load-bearing.
- **The live harness's "outside" directory was inside the workspace.** Control E created
  `join(w, 'outside')` and passed `workspace: w`, so the policy was correct to *allow* it and the
  control reported a governance failure that had not happened. A control whose setup contradicts
  its own assertion is worse than no control, because it looks like evidence.

Plus the recurring harness defect: five crashes on the reporting path (`approved.r` vs
`approvedRun.r`), each after the evidence had already been collected. A harness that dies while
reporting destroys evidence it already holds.

---
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
| Control F disabling verification mission-wide | showed `"nothing happened`" rather than `"approved but unverified`" |
| Verifier threw ENOENT on a missing file | deleting the artifact destroyed the evidence instead of reporting it |
| A control's "outside" directory was inside the workspace | it reported a governance failure that had not happened |
| A negative control removed one of three refusal layers | it PASSED and proved nothing; only removing all three bit |
| A control removed only the existence check | PASSED, because the content comparison caught the same case |

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
