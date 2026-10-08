# AIOS — architecture (current truth)

Describes what is built. Where something is a limitation rather than a feature, it says so. Where a
package is empty, it says that too. Last reconciled: 2026-10-08, commit `6fcf982`.

Read with [`PROJECT-VISION.md`](../PROJECT-VISION.md) for the destination and
[`safety/GOVERNANCE-CONTRACT.md`](../safety/GOVERNANCE-CONTRACT.md) for the invariants.

---

## 1. Shape

TypeScript carries the mission runtime and all governance logic. A **C# control core** carries the
only code permitted to touch the desktop. A **Python subprocess** carries local model inference,
deliberately as a separate OS process. They meet over loopback HTTP with an auth token in an untracked
`host.json`.

```
                 objective (natural language)
                            |
                            v
   +---------------------------------------------------------------+
   |  MODEL BOUNDARY   PlanProvider  ->  PlanProposal (data only)   |
   |  model-agnostic; local / peer / cloud all satisfy this shape   |
   +---------------------------------------------------------------+
                            |
                            v
            parse.ts (strict; accept or refuse, never repair)
                            |
                            v
      compilePlan()  --->  Mission            refuses rather than repairs
       stamps proposalDigest                      |
                            |                    v
                            |            governance / effect policy
                            |            Permission is RETURNED, never asserted
                            v                    |
              review / amendment (data, recompiled from scratch)
                            |                    |
                            +--------+-----------+
                                     v
                          Executor (mission state machine)
                                     |
             +-----------------------+-----------------------+
             v                       v                       v
        Tools (registry)       Verifiers (separate)     Control-core (C#)
        router resolves       a tool CANNOT verify      the ONLY path that may
        capability->tool        itself                 touch the desktop
             |                       |                       |
             +-----------------------+-----------------------+
                                     v
                          evidence / events (IN-MEMORY - see §6)
```

## 2. Packages

| Package | Lines | Role | State |
|---|---|---|---|
| `control-core` | 5,980 | C# operator host, UIA/Win32 hooks, guard, 5 proof harnesses | **Proven. Do not modify.** |
| `mission-engine` | 16,499 | Executor, modes, live harnesses, `model.test.ts` | Working |
| `model` | 3,190 | `PlanProvider`, strict parser, local Python inference, grammar | Working |
| `planner` | 1,581 | Narrow deterministic planners incl. world-aware | Working |
| `review` | 1,059 | Digest, amendment, diff, dry run, session | Working |
| `observation` | 524 | `ObservationProvider` (read-only by construction), world state | Narrow |
| `tool-router` | 253 | Capability → implementation; refuses ambiguity | Working |
| `governance` | 321 | Permission, effect classification | Working |
| `audit` | 0 | — | **EMPTY** |
| `browser` | 0 | — | **EMPTY** |
| `toolkit` | 0 | — | **EMPTY** (tool-router holds the router) |

Totals: 21,283 TypeScript · 3,861 C# · 1,932 Python · 2,276 `.mjs` · 55 PowerShell.
**Zero npm dependencies declared** — see §7.

## 3. The control core is inherited and proven

`packages/control-core` came from the previous project and carries that project's name
(`PORTAI_OPERATOR_DIR`, `PortAiOperator.Program`). That is naming debt, recorded and not acted on:
renaming the single most safety-critical component would be a large, risky refactor for cosmetics.

It is kept because it is the **only** candidate with *proven* takeover, latched emergency stop,
no-self-release and fail-closed hooks. Those are evidenced by five proof harnesses in
`control-core/test/`. `PROVENANCE.json` records its origin.

**The operator is not armed.** `mayInject=false`. No real injection can occur.

### Four routes exist, and that is the entire authority surface

`/show` · `/restore` · `/focus` · `/guifocus`

`audit-injection-routes.mjs` proves that every action able to change the machine passes through the
declared gate, and that omission denies. Run it: `npm run control:audit-routes`.

## 4. The model boundary

`PlanProvider` is model-agnostic by construction, and that was demonstrated rather than asserted:
M10's grammar rode the **pre-existing** `endpoint.headers` field without changing the interface.

Runtimes are replaceable behind this boundary: the current Python/`onnxruntime` path,
`onnxruntime-genai`, Foundry Local, Windows ML, and cloud providers are all implementation choices.
**The safety architecture is not designed around any one of them.**

### Local inference, measured

Microsoft-signed `onnxruntime` runs as a Python subprocess — chosen because WDAC on this machine
enforces an Enterprise signing level and refuses unsigned native binaries. `node-llama-cpp` was
blocked by exactly that and removed entirely.

The repo has **zero npm dependencies**. onnxruntime/tokenizers wheels load fine.

### Constrained generation

`model/local/grammar.py` masks logits against a JSON schema for `PlanProposal`. Measured: 90 controls,
**0.5% of wall-clock overhead**, and it refuses a dead key prefix at its *first* character.

**The grammar constrains syntax and never semantics.** `capability` and `tool` are free strings and
`args` is entirely free-form, precisely so the compiler's capability check and the router's tool check
remain *reachable*.
`test_grammar_does_not_filter_semantics` asserts that permissiveness and **fails if anyone tightens
it** — a control that protects the design from helpfulness.

## 5. Four execution modes

`filesystem` · `cli` (allowlisted) · `gui` (UIA/Win32) · two-step orchestration.

Terminal capability is **only PARTIALLY PROVEN**; `LIMITATIONS` is exported and asserted by test
rather than hidden. The static `consequential` flag cannot express `git status` versus `git push`, so
`ToolRegistration.effectOf` classifies the specific step.

## 6. What is genuinely absent

Stated plainly, because a reader finding these later should not have to infer them:

- **No durable state.** No SQLite, no database, no file-backed event log. Mission state, evidence and
  history are **in-memory**. A crash loses all of it. This blocks long-running missions and is the
  next structural gap.
- **No process-tree containment.** Zero Job Objects. Nothing guarantees a spawned process tree dies
  with its mission.
- **No OS-level isolation of any kind.** The string "Sandbox" does not appear in product code. What
  exists is *working-directory confinement*, a *filesystem boundary* in tool policy, and a *command
  allowlist*. **None of those is a sandbox**, and nothing here may be called sandboxed, isolated or
  virtualised. Untrusted code does not run anywhere yet.
- **No desktop shell.** No UI at all.
- **No signed build, installer, updater, SBOM or licence.**
- **No MCP.** Correctly so — see the governance contract.
- **Window management is not permission-gated.** `/show`, `/restore`, `/focus`, `/guifocus` require
  `Verify()` but do not consult `MayInject()`. **Unfixed and recorded.**
- **No release-after-takeover.** Not proven; blocked on human decisions H1/H2.

## 7. Two defects worth naming

- **`playwright` is imported with zero declared npm dependencies.** `package.json` declares neither
  `dependencies` nor `devDependencies`, and `operator.mjs` hardcodes
  `ms-playwright/chromium-1243/chrome-win64/chrome.exe`. The browser path works on this machine by
  accident of layout and **is not reproducible**.
- **No durable state**, as above — the most consequential omission for a product sold on auditability.

## 8. Verifying this architecture

```
npm test                        # 274 unit tests, 0 failures
npm run control:audit-routes    # every machine-changing action passes the declared gate
python packages/model/local/test-grammar.py   # 90 grammar controls
```

Live harnesses (`npm run mission:live | two-step | filesystem | gui-audit | gui-accept | folder |
recovery | approval | terminal | world-aware | review | model | local`) require the operator host
running: `npm run control:up`.

**Harness discipline:** a harness that cannot run reports *why* and exits non-zero. A partial run is
never reported as a pass — this caught a stale model server answering a measurement request with
results from the wrong configuration.