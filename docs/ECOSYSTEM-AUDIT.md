# Ecosystem / tooling audit

Date: 2026-10-08. Scope: decide where AIOS should adopt mature infrastructure instead of
maintaining custom code. **No architectural change was made as a result of this audit.** Every
version below was read from the live registry, not from memory.

Method note, because it changed a conclusion: an early pass concluded "onnxruntime-genai has no
cp314 wheel" from a truncated page listing. That was wrong. The full PyPI metadata shows 0.17.1
**does** publish `cp314-win_amd64`. I corrected it by querying the JSON API and then installing.
A registry listing read by eye is not a measurement.

---

## A. Local inference

### Measured

| Question | Answer | How |
|---|---|---|
| Does `onnxruntime-genai` run on this interpreter? | **Yes** — 0.17.1, cp314 win_amd64 | `pip install`, imported |
| Is it WDAC-compatible? | **Yes** — both binaries `Valid`, `CN=Microsoft Corporation` | `Get-AuthenticodeSignature` |
| Can it load the M9 model? | **No** — no `genai_config.json` present | dir listing |
| Does it expose a logit-processor callback? | **No** public one | `dir(onnxruntime_genai)` |
| Does it expose guided/grammar decoding? | **Yes** — `TurnOptions.set_guidance` | `dir()` |
| Does it expose a manual decode loop? | **Yes** — `Generator.generate_next_token` + `get_logits`/`set_logits` | `dir()` |
| Does plain `onnxruntime` (current path) expose any of these? | **No** — measured `NONE` in M10 | `dir(InferenceSession)` |

### Verdict: **ADOPT the runtime as a future target; DO NOT migrate now**

The migration is not a dependency swap. GenAI needs models in its *own* format
(`genai_config.json` + renamed tensor outputs); the M9 weights are a plain ONNX export. Adopting it
means re-exporting the model, then re-measuring every number in M9/M10 because none of them carry
over. That is a real cost with no proven payoff yet.

Two things make it the right long-term destination rather than a maybe:

1. It is Microsoft-signed and passes WDAC, which the current path only does by virtue of onnxruntime
   being signed. That is not a property of *my* code, and a future dependency could break it.
2. My hand-written constrained decode **has a measured defect GenAI would not have** — see below.

### The defect this audit surfaced

The M10 grammar has **no backtracking**. It masks logits against a prefix; if the model commits to a
prefix that cannot complete, generation deadlocks.

Measured, unconstrained-decoding text: the model emitted the key prefix
`outputFilePathCSharpCodeExample123456789` — 40 characters, hitting the key-length cap, and not a
prefix of any field in the schema. At that state **0 of 34,192 candidate tokens were acceptable**,
and generation aborted with `GrammarExhausted`.

This is not a cosmetic bug. A constrained decoder that can deadlock is a denial of service on
whoever asked for a plan: the caller waits, then gets an error instead of a refusal. The correct
behaviour is to detect that the grammar has no live continuation and *refuse cleanly*.

**Consequence for the plan:** M10's grammar must gain (a) prefix viability checking, or (b)
backtracking, or (c) a hard "this prefix is dead, refuse" path — before it can be called a working
constraint mechanism. Recorded as a known defect. This is now the concrete, measurable argument for
eventually moving to a maintained implementation.

### What is explicitly not changing

`PlanProvider`, `parse.ts`, the compiler, governance, the router and the verifier interface are all
untouched. Nothing in the audit justifies changing them, and the audit's whole point was to look
for a reason to.

---

## B. Desktop application

Measured: `control-core` is **6 `.cs` files + 1 `.ps1`**. There is no existing UI of any kind.

| | WinUI 3 + Windows App SDK | Tauri 2 |
|---|---|---|
| Latest | `Microsoft.WindowsAppSDK` **2.5.1** | `@tauri-apps/cli` **2.12.1** |
| New language | **C#** — matches `control-core` | Rust (backend) + web frontend |
| New runtime | WinAppSDK + Windows 10 1809+ | WebView2 (**already on Windows**) + Rust toolchain |
| Integration with control core | **Native — same language, same process** | IPC bridge across a language boundary |
| Deployment | MSIX or self-contained | Per-platform bundler |
| Licence | MIT | Apache-2.0 OR MIT |

**Verdict: WinUI 3 / Windows App SDK.**

The deciding factor is not aesthetics, it is that `control-core` is C# and holds the one component
that must not be compromised. A Rust/IPC boundary in front of the takeover and stop controls adds a
second language, a second runtime, and a new failure mode to the most safety-critical code in the
project, in exchange for a webview.

Tauri would be defensible for a greenfield app with no native core. This is not one.

**Deferred regardless.** No UI is built now. The execution foundation is not trustworthy enough to
put a window on top of it, and the standing rule is that the desktop app must not start until that
is true.

---

## C. Windows UI automation

Measured: `FlaUI.Core` / `FlaUI.UIA3` **5.0.0**, 50–51 versions, active. `FlaUI.WinUI` does **not
exist on NuGet**.

**Verdict: DEFER. Do not adopt as the authoritative path.**

FlaUI is a wrapper over `System.Windows.Automation` — the same COM API the current native
`IUIAutomation` implementation calls. Its value is ergonomic (pattern objects, wait helpers), not
functional. It cannot observe anything the current implementation cannot.

Adopting it would swap a direct, auditable COM call for an abstraction layer **inside the injection
authority**, which is the one place where "I read this wrapper's source and it looks right" is the
weakest possible assurance. Convenience APIs are not worth a layer inside the control path.

If the native implementation later needs to *drive* rather than *read* patterns, FlaUI becomes a
reasonable option for the driving half specifically, and that decision should be made when the
need exists rather than in advance.

---

## D. Browser

Measured: `playwright` **1.64.0**, Apache-2.0.

**Intended hierarchy, and it is not negotiable:**

```
Playwright                      deterministic browser control
  -> DOM + accessibility tree   observation (read-only)
    -> deterministic actions   click/fill/navigate via Playwright
      -> AI fallback           only for what the above cannot express
```

**Verdict: ADOPT Playwright as the foundation. Stagehand and Browser Use are REJECT as foundation,
and at most an optional adapter far above them.**

The reason is structural, not a quality judgement. Stagehand and Browser Use are *model-in-the-loop*
browser agents: they take natural language and produce actions. AIOS has the same capability already
and needs it strictly *below* deterministic control, as a fallback. Putting an LLM agent at the
foundation inverts the order and makes every browser action non-deterministic and un-auditable —
which is the opposite of what the governance layer exists to guarantee.

If either is ever adopted, it is behind the same tool/governance boundary as any other adapter, and
it cannot be the only path to a state change.

---

## E. MCP

Measured: TS SDK **1.32.1** (there is **no published v2**); .NET SDK `ModelContextProtocol`
**2.2.0**, MIT.

**Verdict: INTEGRATE as an optional adapter. MCP must never become a governance authority.**

The architecture reason, stated as an invariant: an MCP server is *another process asserting that
it performed something*. AIOS's central guarantee is that a plan cannot execute without passing
through its own compiler, governance and verification layers. If MCP became the authority, an MCP
server could assert completion and AIOS would have to believe it — which is precisely the "fake
verified status" failure the adversarial suite spends 24 scenarios trying to rule out.

So: MCP is a *protocol* for exposing AIOS tools outward, and an optional *adapter* for calling
outside tools inward. Neither direction grants authority. An MCP-exposed AIOS tool must still be
governed; an MCP-imported tool must still be vetted through the registry.

---

## F. Benchmarks

Measured: OSWorld 2.0 and Windows Agent Arena exist as external benchmark suites. Neither is
adopted, neither is run now.

**Verdict: DESIGN a minimal subset; DEFER running anything large.**

The point of a subset is to measure the transition from *"architecture works"* to *"the agent is
actually good at computer tasks"*. Today those are separated by a genuine gap — M9 recorded **0 valid
plans in 15 attempts** — and no external benchmark run on a 1.5B model on this hardware would be
informative. It would mostly measure the hardware.

A proposed subset is deferred until there is a model that can complete a task at all. Designing it
against a capability that is not yet present would build a harness around a number that cannot move.

---

## G. Summary

**Keep unchanged:** `PlanProvider`, `parse.ts`, compiler, governance, router, verifiers,
review/amendment layer, `control-core`, the injection gate, the grammar's *scope* (structure only).

**Replace:** nothing yet.

**Study:** `onnxruntime-genai` as the eventual home of inference + constrained decoding.

**Deferred:** desktop UI, browser interaction, benchmarks.

**Security implications:** none introduced — nothing was changed. The standing risks are unchanged:
release-after-takeover unproven (H1/H2), P0 mouse sentinel (H4), window management still ungated.

**Licensing:** all recommended components are MIT or Apache-2.0. No copyleft in the recommended set.

**Hardware:** unchanged. The binding constraint remains generation latency on 2 physical cores, not
library choice.

**Should M10 continue on the current inference path?** **Yes — but not unchanged.** The audit found
no reason to abandon the path, and found a concrete defect that must be fixed before M10 can claim
success: the grammar can deadlock on a dead prefix instead of refusing.