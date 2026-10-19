# Model provider contract

How AIOS selects a planning provider, what it may talk to, and what may never be reported as a model.

Every claim below cites a file that exists in this repository, with a line number where the claim is
about a specific line. Where a claim could not be traced to code, that is stated explicitly rather
than smoothed over.

---

## 1. The interface everything is written against

There is one interface between "something that decides what to do" and everything that executes:

`packages/planner/provider.ts:34-48` — `export interface PlanProvider`

```ts
export interface PlanProvider {
  readonly name: string
  capabilities(): readonly string[]
  plan(objective: string, ctx: PlanContext): Promise<PlanResult>
}
```

Three members. `packages/planner/provider.ts:13-21` lists what a provider is structurally forbidden
from doing — execute a tool, touch the filesystem, reach a `ControlSurface`, inject input, decide
permission, mark a step complete — and `:23-26` gives the reason they are "enforced by construction
rather than by convention": the provider receives an objective and a `PlanContext` and returns data,
holding no reference to the executor, to `ControlSurface`, or to any tool.

`plan()` **never throws** (`packages/planner/provider.ts:46`). The reasoning is in the module header
of `packages/model/provider.ts:34-38`: a provider that threw would take the decision out of the
recorded history, and a timeout or a 500 from a remote endpoint is an ordinary event rather than a
programming error.

### Implementations that exist today

| Class | File | `name` it reports |
|---|---|---|
| `ModelPlanProvider` | `packages/model/provider.ts:122` | `model:<model or host>` |
| `DeterministicWorldAwarePlanProvider` | `packages/planner/world-aware.ts:128` | `deterministic-world-aware` (`:129`) |
| `DeterministicPlanProvider` | `packages/planner/deterministic.ts:806` | `deterministic-phrase-matching` (`:807`) |

These three are the complete set: a repository-wide search for `implements PlanProvider` matches only
those three declarations.

`ModelPlanProvider` is a **class**, not an interface. It is declared at `packages/model/provider.ts:122`
as `export class ModelPlanProvider implements PlanProvider`. Any statement below that calls it "the
interface" means "the model-backed implementation of `PlanProvider`".

---

## 2. `ModelPlanProvider` — what it is given and what it can reach

`packages/model/provider.ts` is the whole contract. Its configuration type is `ProviderDeps`
(`:77-105`):

| Field | Line | Purpose |
|---|---|---|
| `endpoint` | `:78` (`ModelEndpoint`, `:56-62`) | URL + headers + optional timeout + model name |
| `availableCapabilities` | `:80` | Which capabilities the router can serve; the model may only choose from these |
| `options.retainRaw` | `:81` (`ProviderOptions`, `:65-68`) | Whether the raw response is retained for audit |
| `fetchImpl` | `:83` | Injected for tests; defaults to global `fetch` |
| `outputFileName` | `:91` | The caller's actual request, so the worked example names the right file |
| `correction` | `:104` | ONE bounded corrective attempt carrying the exact parser error |

`ModelEndpoint` is deliberately minimal — `url`, `headers?`, `timeoutMs?`, `model?`. The comment above
it (`packages/model/provider.ts:50-54`) states the intent: "Any HTTP-speaking model server works -
llama.cpp's server, vLLM, ollama, or an OpenAI-compatible endpoint - because the only thing required
of it is that it accept a chat-style message and return text."

### What it cannot reach

The module header in `packages/model/provider.ts:6-17` states that it imports no executor, no
governance contract, no `ApprovalStore`, no `ControlSurface`, no tool, no `child_process`, and no
filesystem module, so "there is no code path by which a model - however persuasive its output - can
call a tool, reach the control layer, record an approval, mark a step complete, or declare that
something succeeded."

**What asserts it, and what does not.** There is no single test covering that claim for the model
provider, and it would be wrong to imply otherwise. What exists:

- `packages/mission-engine/test/planner.test.ts:66-88` — the test `'the planner cannot execute,
  because it does not import anything that can'`. Its file list (`:70-81`) is
  `packages/planner/{deterministic,plan,provider,summarizer,world-aware,compile}.ts` and
  `packages/observation/{world,world-provider}.ts`. It asserts those files do not import
  `mission-engine/executor`, `governance/contract` or `control-core`. **`packages/model/provider.ts`
  is not in that list**, so this test does not cover the model provider.
- `packages/mission-engine/test/model.test.ts:660-673` — `'the provider's CODE - not its prose -
  references no approval, control surface or spawn'`. This does read
  `packages/model/provider.ts`, but its predicate is weaker than an import-graph assertion: it strips
  comments and string literals and then checks for six forbidden identifiers.
- `packages/mission-engine/live/run-model-mission.ts:583-607` (CONTROL 7) — the actual import-graph
  check over `packages/model/{provider,parse,protocol}.ts`. It matches only `import`/`export ... from`
  statements, precisely because these files *discuss* the executor at length. This runs under
  `npm run mission:model`, not under `npm test`.

### Timeout

`DEFAULT_TIMEOUT = 200_000` (`packages/model/provider.ts:120`). The comment at `:107-119` records
that it is a ceiling set above the measured worst case rather than an expectation, and that
`ModelEndpoint.timeoutMs` overrides it per call site.

### The request it sends

`buildRequest` (`packages/model/provider.ts:341-383`) produces a single `input` object containing
`task`, `mayUse`, `mayWriteHere` and `observed`. The nesting under one top-level key is deliberate;
the comment at `:348-361` records three successive attempts and what each was measured to cause. This
changes only what the model is **shown** — the acceptance contract in `packages/model/parse.ts` is
unchanged.

### The response it accepts

`packages/model/parse.ts` enforces **accepted or rejected, never repaired**. Its only normalisation
is `TRANSPORT_NORMALISATIONS = ['strip an outer markdown code fence']`, declared as an exported
constant at `packages/model/parse.ts:62` so that adding a second one is a deliberate act. Unknown
fields are reported through `ignoredFields` (`:43`, `:360`), never honoured.

The wire format is declared in `packages/model/protocol.ts` as `ModelStep` / `ModelPlan`.

---

## 3. How a provider is selected

**There is no automatic provider registry, no scoring, and no fallback chain.** Selection happens at
construction time, and the choice is explicit in the source at each call site.

The supervisor receives an already-built provider as a required dependency:
`packages/mission-engine/supervisor.ts` — `SupervisorDeps.provider`, consumed by the attempt loop.
Selection is therefore **the caller constructing one provider or the other**.

### Every construction site, by provider

`new ModelPlanProvider(` — 5 files:

- `packages/mission-engine/live/run-local-model-mission.ts:151`
- `packages/mission-engine/live/run-model-mission.ts:69`
- `packages/mission-engine/live/run-model-folder-mission.ts:129`
- `packages/mission-engine/test/model.test.ts` (8 sites)
- `packages/model/test/plan-schema-seam.test.ts:59`

`new DeterministicWorldAwarePlanProvider(` — 6 files:

- `packages/mission-engine/live/run-local-model-mission.ts:399`
- `packages/mission-engine/live/run-review.ts:42`
- `packages/mission-engine/live/run-world-aware.ts:41`
- `packages/mission-engine/test/observation.test.ts` (10 sites)
- `packages/mission-engine/test/planner.test.ts:59`
- `packages/mission-engine/test/review.test.ts:68`

`new DeterministicPlanProvider(` — 10 files:

- `packages/mission-engine/live/run-browser-mission.ts:187`
- `packages/mission-engine/live/run-dev-mission.ts:239`
- `packages/mission-engine/live/run-folder-mission.ts:86`
- `packages/mission-engine/live/run-navigation-mission.ts:168`
- `packages/mission-engine/live/run-repo-mission.ts:407`
- `packages/mission-engine/live/run-recovery.ts:65`
- `packages/mission-engine/live/run-summary-mission.ts:63`
- `packages/mission-engine/live/run-world-aware.ts:42`
- `packages/mission-engine/test/file-summary.test.ts:198`
- `packages/mission-engine/test/observation.test.ts:580`

`packages/mission-engine/live/run-world-aware.ts:41-42` constructs **both** deterministic providers
and runs them side by side — that comparison is how the repository demonstrates the difference
between the two planners.

### Does a provider need a `WorldState`? It depends, and the difference is explicit

This is the rule most easily overstated, so it is stated per provider rather than as a general claim.

A provider **may** declare `readonly requiresObservation = true`. `requiresWorld` at
`packages/mission-engine/supervisor.ts:207-210` reads exactly that field and compares it to `true`;
`:289-297` then refuses when no `WorldState` was configured. Two comments in the repository give the
reason, and they are worded differently, so both are quoted rather than merged:

- `packages/mission-engine/supervisor.ts:286-288` — "A provider that needs a world and was not given
  one is a REFUSAL, not a fallback to the old recipe-based planning. Falling back would make the
  world's presence optional, which is exactly the optionality M6 removed from the planner."
- `packages/planner/world-aware.ts:131-137` — "Read by the supervisor, which then REFUSES rather than
  calling `plan()` with no observation. That matters because the alternative is a fallback to
  recipe-style planning, and a fallback here would make the world's presence optional in exactly the
  component that decides whether to look."

**Per provider:**

| Provider | `requiresObservation` | With no `WorldState` |
|---|---|---|
| `DeterministicWorldAwarePlanProvider` | `true` — `packages/planner/world-aware.ts:138` | Supervisor refuses before `plan()` is called; the provider would also return `observation-missing` (`world-aware.ts:167-174`) |
| `DeterministicPlanProvider` | `false` — `packages/planner/deterministic.ts:837` | **Plans anyway.** It reads `ctx.world?.observationId ?? ''` and does not require a world. `deterministic.ts:825-836` states the distinction: it *names* an observation but does not *plan from* one |
| `ModelPlanProvider` | field not declared | Returns `ok: false, code: 'observation-missing'` — `packages/model/provider.ts:171-180` |

So: **a provider does not universally need a `WorldState` "or it refuses".** The refusal is a property
of the two providers that declare or enforce it, and the phrase-matching planner is a working
counter-example in this repository.

### The name is the audit record

`PlanProvider.name` is documented at `packages/planner/provider.ts:35` as "Recorded in the audit, so
a mission states which planner produced it." `ModelPlanProvider` computes it in its constructor at
`packages/model/provider.ts:150`:

```
`model:${deps.endpoint.model ?? deps.endpoint.url.replace(/^https?:\/\//, '').slice(0, 40)}`
```

So a mission's own output distinguishes `model:qwen2.5-0.5b-instruct` from
`deterministic-phrase-matching`.

---

## 4. The two endpoint families

### Family 1 — the local ONNX server

**Implementation:** `packages/model/local/server.py`, a Python process that imports
`onnxruntime` (`server.py:64`).

**Why Python and not Node** — recorded in the module header of `packages/model/local/server.py:32`:
this machine enforces a WDAC Enterprise signing level policy (Policy ID `0283ac0f`) that refuses
unsigned native binaries, which killed the Node-native route (`node-llama-cpp`). onnxruntime's wheels
are signed by Microsoft and load fine. `docs/architecture/ARCHITECTURE.md:114-118` records the same
finding and notes the repo has zero npm dependencies.

**Route:** `packages/model/local/server.py:687-695`. `do_GET` answers `/describe` with the loaded
engine and 404 otherwise; `do_POST` accepts exactly `/v1/chat/completions` and 404s everything else.

**Weights:** `packages/model/local/fetch-model.py:30-36` defines the two supported models —
`onnx-community/Qwen2.5-0.5B-Instruct` (`onnx/model_quantized.onnx`) and
`onnx-community/Qwen2.5-1.5B-Instruct` (`onnx/model_q4f16.onnx`), written under
`%LOCALAPPDATA%\AIOS\models\<name>` (`fetch-model.py:45`).

**Authority:** the header of `packages/model/local/server.py:10-14` is explicit that the process has no
authority — it never imports AIOS code, so "there is no path from here to a tool".

**Independent wall-clock ceiling:** `MAX_WALL_SECONDS = 150.0` at `packages/model/local/server.py:103`,
exposed as `--max-seconds` at `:765`. This binds independently of the provider's own timeout.
`docs/EVIDENCE.md:880-882` records the measured consequence: 79-150s per attempt at ~0.8 tok/s, with
the finding that "Constrained decoding is NOT the bottleneck; the model is."

#### Port: what the code actually says

The port is **configurable**, not fixed. Traced values:

| Location | Value |
|---|---|
| `packages/model/local/server.py:762` (`--port` argparse default) | `8792` |
| `package.json:46` script `model:serve` | `--port 8792` |
| `packages/mission-engine/live/with-local-model.mjs:26` | `AIOS_LOCAL_MODEL_PORT ?? '8792'` |
| `packages/mission-engine/live/run-local-model-mission.ts:63` | `AIOS_LOCAL_MODEL_PORT ?? 8792` |
| `packages/mission-engine/live/run-local-model-adversarial.ts:60` | `AIOS_LOCAL_MODEL_PORT ?? 8792` |
| `packages/mission-engine/live/probe-request-shape.ts:30` | `AIOS_LOCAL_MODEL_PORT ?? 8792` |
| `packages/mission-engine/live/run-model-folder-mission.ts:75` | `args.port ?? AIOS_LOCAL_MODEL_PORT ?? '8795'` |
| `bridge.js:230` | sets `AIOS_LOCAL_MODEL_PORT: '8795'` |

**Correction to a common misstatement.** The endpoint `http://127.0.0.1:8793/v1/chat/completions` is
**not** the repository's configured local endpoint. A repository-wide search for `8793` returns
matches in exactly two places outside this document, and neither is code that configures a server:

1. `model-plan-failure.txt:2` — an untracked failure-record artifact logging
   `server : 127.0.0.1:8793   Qwen2.5-0.5B-Instruct, grammar ON, eos=151645, ready=true`. It records
   one specific run on a port that run was given.
2. The task prompt text at `packages/agent/run-orchestrator.ts:46`, and the copy of that prompt in
   `.aios/orchestrator-state.json:9`.

The default in code is **8792**. Any port is reachable by setting `AIOS_LOCAL_MODEL_PORT` or passing
`--port`; the local-model family is defined by *what serves it* (Python + onnxruntime +
`packages/model/local/server.py`), not by a number. `docs/EVIDENCE.md:935` also records a real
incident: "Four stale model servers were all bound to 8792; the oldest answered."

For completeness, a third port exists in the repository for a **different, non-model** peer:
`packages/model/adversarial-peer.ts` on `AIOS_PEER_PORT ?? 8791` (see §6).

### Family 2 — any OpenAI-compatible HTTP endpoint

**There is no hosted planning endpoint configured in this repository.** The capability is a property
of the interface, not of a deployment. `ModelEndpoint` in `packages/model/provider.ts:56-62` is a URL
plus headers, and the comment above it names the family: "llama.cpp's server, vLLM, ollama, or an
OpenAI-compatible endpoint." `docs/ROADMAP.md:129` records the same finding for the roadmap item:
measurement showed "none is available - no runtime, no weights, no credentials".

The only OpenAI-compatible *client* in the repository is on the review side, not the planning side:

- `packages/agent/reviewer.ts:171` — `export class OpenAICompatibleReviewer`, which POSTs to
  `` `${baseUrl}/chat/completions` `` (`:198`) with `authorization: Bearer ${apiKey}` (`:200`) and a
  `temperature: 0` body (`:203`).

That class is a `Reviewer`, not a `PlanProvider`, and it implements a different interface. It is
cited here as evidence that the OpenAI-compatible request shape is the one AIOS speaks, not as a
planning endpoint that exists today. Its header comment at `:166` states it is "HONESTLY CONFIGURED
OR HONESTLY ABSENT": with no API key it returns `unavailable` and says so, rather than silently
falling back to the implementer and calling the result a review. That behaviour is asserted by
`packages/agent/test/orchestrator.test.ts`
(`'an unconfigured hosted reviewer reports unavailable and does NOT invent a verdict'`).

#### The three response shapes

`ModelPlanProvider.call` in `packages/model/provider.ts:332` reduces the response to text by accepting
three shapes, with the comment at `:327-328` "Three response shapes, because three server families":

```
json?.choices?.[0]?.message?.content   // OpenAI-compatible
?? json?.content                       // Ollama
?? json?.response                      // llama.cpp
```

If none is a string it throws internally (`:333-335`) and `plan()` converts that into an `ok: false`
result (`:216-224`), so the provider still never throws. It additionally reads an optional
`local_inference` object for `grammar_exhausted` / `grammar_stop_reason` (`:322`, `:329-331`), which
is specific to the local ONNX server.

#### What is identical across both families

`ModelPlanProvider` sends `temperature: 0` and a chat-shaped `messages` list (`:276-308`): the system
instructions plus capability rule plus a worked example, the compact single-line JSON request, and an
optional corrective turn. Swapping the local server for a hosted endpoint is described in
`packages/model/provider.ts:270-272` as "a change to this function and nothing else" — a change to the
`ModelEndpoint` passed in, not to the provider, the compiler, the router or any verifier.
`docs/ROADMAP.md:280` states it as "Connecting weights is a change to **one URL**."

---

## 5. The deterministic planner is NOT a model

**This is the load-bearing statement of this document.**

`DeterministicPlanProvider` (`packages/planner/deterministic.ts:806`) and
`DeterministicWorldAwarePlanProvider` (`packages/planner/world-aware.ts:128`) are **not models**. They
are ordinary TypeScript code that reads an observed state and emits a plan. They have no weights, no
sampler, no endpoint and no network call. They must never be described, reported or audited as a
model, a reasoner, or a language model.

The repository states this in its own words, and these are citations rather than inferences:

- `packages/planner/provider.ts:6-7` — "TODAY: `DeterministicPlanProvider`. No model, no network, no
  API key."
- `packages/planner/deterministic.ts` — the header calls it "THE ORIGINAL PHRASE-MATCHING PLANNER"
  and records that it "recognises a phrase and emits a fixed recipe."
- `packages/planner/deterministic.ts:807` — `readonly name = 'deterministic-phrase-matching'`.
- `packages/planner/world-aware.ts:129` — `readonly name = 'deterministic-world-aware'`.
- `packages/planner/world-aware.ts:8-10` — the previous planner "was a lookup table that happened to
  be written in TypeScript, and its only claim to being a planner was that its output happened to
  typecheck."
- `docs/architecture/ARCHITECTURE.md:105-110` — `PlanProvider` is model-agnostic by construction, and
  "The safety architecture is not designed around any one of them."

Note the distinction the repository draws carefully: the world-aware planner *does* reason from an
observed state, but it is still deterministic TypeScript. Reasoning from facts is not the same claim
as being a model, and this document is only about the second.

### Why the distinction has to be maintained

Reporting a deterministic run as a model run would be a confident wrong answer, which is the failure
mode this repository treats as most serious. Two files make the argument directly:

- `packages/mission-engine/live/run-repo-mission.ts` — "fallback is exactly how a deterministic
  result gets reported as something it is not."
- `packages/model/adversarial-peer.ts` — the same principle applied to the test peer: "It is NOT a
  language model, and nothing in this repository claims it is."

Concretely, a run is model-backed only if its `PlanProvider.name` begins with `model:` — that string
is built in the `ModelPlanProvider` constructor (`packages/model/provider.ts:150`) from the endpoint's
model name, and it is what lands in the audit. A mission whose provider name is
`deterministic-phrase-matching` or `deterministic-world-aware` planned with code, not weights.

### What is genuinely known about model-backed planning

The connection is proven; the usefulness is not, and both facts belong in any report:

- `docs/safety/known-defects.md:15-16` — "Qwen2.5-0.5B produced 0 valid plans in 9 attempts; Qwen2.5-1.5B
  produced 0 in 6."
- `docs/ROADMAP.md:112` — row 27f, "A model that produces valid plans", **NOT PROVEN**, "0 of 15
  attempts across two model sizes. Rejected correctly every time."
- `docs/ROADMAP.md:111` — row 27e, "Real model connected to the planner", **PROVEN**, "Qwen2.5-0.5B
  and 1.5B, 127.0.0.1, zero changes to any boundary".
- `model-plan-failure.txt` — a later recorded run on port 8793 in which the model returned a refusal
  on both attempts and no plan was produced.

---

## 6. The third peer, which is also not a model

`packages/model/adversarial-peer.ts` is a real HTTP server in a real process on a real socket, on
`AIOS_PEER_PORT ?? 8791` (`packages/mission-engine/live/run-model-mission.ts:61`). It is the peer
`ModelPlanProvider` talks to during the M8 proofs, and it emits attacker-chosen JSON on request.

It is **not** a language model and not evidence that a model works. Its own header says so, and
`docs/EVIDENCE.md:555` independently states it is "not a model and is not claimed to be one. It is
strictly harder to defeat than a cooperative [one]". `docs/ROADMAP.md:131` records what remains open:
whether to install local weights or use a hosted free tier is "a human-authority decision".

It is listed here because it occupies the same seam and shares the same "do not call this a model"
obligation. `package.json:45` starts it alone (`model:peer`); `package.json:38` runs the mission
against it (`mission:model`).

---

## 7. Summary

| Question | Answer | Source |
|---|---|---|
| What is the interface? | `PlanProvider` — `name`, `capabilities()`, `plan()` | `packages/planner/provider.ts:34-48` |
| Is `ModelPlanProvider` an interface? | No — it is a class `implements PlanProvider` | `packages/model/provider.ts:122` |
| How is a provider selected? | By the caller constructing it and injecting it as `SupervisorDeps.provider`. No registry, no fallback | `packages/mission-engine/supervisor.ts:253` |
| Must a provider have a `WorldState`? | **It depends, and the doc does not generalise.** `DeterministicWorldAwarePlanProvider` declares `requiresObservation = true` and the supervisor refuses; `ModelPlanProvider` returns `observation-missing`; **`DeterministicPlanProvider` declares `false` and plans without one** | `world-aware.ts:138`, `deterministic.ts:837`, `model/provider.ts:171-180`, `supervisor.ts:207-210` |
| Endpoint family 1 | Local ONNX server, `packages/model/local/server.py`, `POST /v1/chat/completions` | `server.py:693-695` |
| Family 1 default port | **8792**, overridable via `AIOS_LOCAL_MODEL_PORT` / `--port`. Not 8793 | `server.py:762`, `package.json:46` |
| Endpoint family 2 | Any OpenAI-compatible HTTP endpoint; a configured capability, but no hosted planning endpoint exists in this repo | `packages/model/provider.ts:56-62`, `docs/ROADMAP.md:129` |
| Response shapes accepted | `choices[0].message.content`, `content`, `response` | `packages/model/provider.ts:332` |
| Is a parsed plan repaired? | Never. One normalisation: strip a markdown fence | `packages/model/parse.ts:62` |
| Is the deterministic planner a model? | **No.** Code, not weights. Never report it as one | `deterministic.ts:807`, `world-aware.ts:129`, `planner/provider.ts:6` |
| Has a real model produced a usable plan here? | **No.** 0/9 at 0.5B, 0/6 at 1.5B; 0 of 15 combined | `docs/safety/known-defects.md:15`, `docs/ROADMAP.md:112` |

### A note on what verifies this document

The repository's `verify` and `test` scripts (`package.json:47`, `:49`) both run `node verify-gate.mjs`,
and the test command recorded for this task is
`node --experimental-strip-types --no-warnings --test "packages/agent/test/*.test.ts"`. **None of them
read this file.** There is no documentation or citation linter in this repository. A green verification
run is therefore evidence that the repository is intact, not evidence that anything written above is
true — every claim here rests on the cited file and line, and is checkable by opening it.
