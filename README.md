# AIOS / Zeus

AIOS (also called **Zeus** in the older documents) is a general-purpose agent that turns a request
into a **governed, independently verified mission** on a real Windows machine - and, over time, on
other platforms too.

It is not a chatbot wrapper. The execution contract is the product:

```
proposal -> validated/compiled mission -> authorisation -> executor -> independent verifier -> evidence and persistence
```

Model-written prose can never grant permission, approve a step, or mark work verified. Every step is
checked again by a verifier that looks at the world, and every mission keeps a durable record of what
was attempted and what actually happened.

## What works today (measured, not promised)

| Area | State |
|---|---|
| Chat server, sessions, free-model rule | Working; sessions persist across restarts |
| Conversation history and follow-ups | **Working through the real chat handler**; session-scoped, secret-redacted, with retention |
| Write-ahead mission ledger + recovery | Working; `GET /recovery`, `POST /recover` (human-initiated only) |
| Independent verification / evidence | Working; success is never inferred from "no errors" |
| Prompt-injection / hostile-content defenses (Stage E) | 6/6 deterministic tests pass |
| Gap C before-launch observation | 5/5 deterministic tests pass |
| Stage F history/verdict semantics | 6/6 tests pass |
| Typecheck | **0 errors** (`npx tsc --noEmit`) |
| Live browser mission (Mission B) | Implementation present; **pending live verification** (needs the operator host) |
| Live reversible laptop action (Mission C) | Implementation present; **pending live verification** (needs the operator host) |

Known limitations are listed in [`docs/CONVERSATION-HISTORY.md`](docs/CONVERSATION-HISTORY.md) and
[`docs/MISSIONS-B-C-READINESS.md`](docs/MISSIONS-B-C-READINESS.md). A test that needs the operator
host fails honestly when the host is not running; it is not reported as a product success.

## Quick start

Requirements: Windows 11, Node.js >= 22, PowerShell 5.1+, and the free OpenCode CLI for model calls.
No paid API, subscription, or hosted service is required or configured.

```powershell
# 1. Install dependencies
npm install

# 2. Start the operator host (the only process allowed to touch the desktop)
npm run control:up

# 3. Start AIOS with the window
.\launch-aos.ps1
```

The chat server binds to `127.0.0.1` only and requires a per-process bearer token written to
`~/.aios/agent/server.json`. That file is a credential: it is git-ignored and must never be committed.

Run the server without the window:

```powershell
node --experimental-strip-types --no-warnings packages/mission-engine/live/agent/chat-server.ts
```

## Verify the repository

```powershell
npx tsc --noEmit                                  # must be 0 errors
node --experimental-strip-types --no-warnings --test "packages/*/test/*.test.ts"
npm run control:proofs                            # safety gate; needs the operator host
npm run control:audit-routes                      # must not exit 2
```

Focused conversation-history gate:

```powershell
node --experimental-strip-types --no-warnings --test `
  "packages/mission-engine/test/session-history.test.ts" `
  "packages/mission-engine/test/conversational-history.test.ts"
```

The suite contains tests that require the live operator host (`packages/control-core/test/*`,
`packages/mission-engine/test/chat-authorization.test.ts`). With the host stopped they fail with
`ECONNREFUSED`; that is an environment result, not a code regression. See
[`docs/MISSIONS-B-C-READINESS.md`](docs/MISSIONS-B-C-READINESS.md) for the live procedure.

## Repository map

| Path | Responsibility |
|---|---|
| `packages/mission-engine/` | Planning, execution, verification, recovery, chat server, session/history |
| `packages/control-core/` | C# operator host; the only desktop input boundary |
| `packages/governance/` | Permission and approval contracts |
| `packages/persistence/` | SQLite write-ahead ledger (`aios.db`) |
| `packages/model/` | Model boundary, local model service, planner adapters |
| `packages/planner/`, `packages/review/`, `packages/tooling/` | Planner, review pipeline, repository gates |
| `packages/*/test/` | Unit, integration, regression, security and live-host tests |
| `docs/` | Architecture, roadmap, safety, decisions, and this project's evidence |
| `apps/`, `services/` | Window/UI and local service entry points |

Runtime state lives outside the repository under `~/.aios/agent/` (sessions, conversations, mission
ledger, server token). It is machine-local and never committed.

## Documentation

- [`docs/PROJECT-VISION.md`](docs/PROJECT-VISION.md) - the long-term destination
- [`docs/ROADMAP.md`](docs/ROADMAP.md) - stages, priorities, and current status
- [`docs/architecture/ARCHITECTURE.md`](docs/architecture/ARCHITECTURE.md) - what is built
- [`docs/CONVERSATION-HISTORY.md`](docs/CONVERSATION-HISTORY.md) - persistent chat context, retention, security
- [`docs/safety/GOVERNANCE-CONTRACT.md`](docs/safety/GOVERNANCE-CONTRACT.md) - the invariants
- [`docs/MISSIONS-B-C-READINESS.md`](docs/MISSIONS-B-C-READINESS.md) - live verification procedure for Missions B and C

## Budget

Hard **$0**. Free models only; `isFreeModel` refuses any model that is not in the `opencode` namespace
with a `-free` suffix. No paid API, hosting, subscription, or potentially billable resource is started.

## Safety, stated plainly

Allowlists and working-directory restrictions are **not a complete sandbox**. The system relies on the
operator host, the approval gate, independent verification, and an honest refusal to claim more than
was measured. Self-modification remains disabled until the reliability and security gates pass.
