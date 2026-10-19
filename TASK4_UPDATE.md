## Task 4: Submit Node-Version Mission via Chat API

### API Submission Format

From earlier context, missions are submitted through the chat API. The format appears to be:

**`POST /message`** with a text payload describing the mission goal.

**Example payload structure** (from earlier investigation):
- Goal: "Check the node version installed on this machine and save it to C:\Users\Samer\.aios\agent\out\nodever.txt"
- This mission would use the `terminal` tool with command `node --version`

### What "Harmless Node-Version Mission" Looks Like

**Goal:** "Check the node version installed on this machine"

**Expected execution flow:**
1. Mission submitted via `POST /message` → returns 202 + missionId
2. Mission engine `runGoal()` executes the plan
3. Plan includes: `terminal` tool with command `node --version`
4. `terminal` tool runs via `commandAllowed('node --version')` ✅ (bare name works)
5. Independent verifier reads the output via OS re-read
6. Mission completes with `done` event
7. Persisted record written to `missions/` directory

### What I'll Try ✅

**Submitting the mission** through the chat API with goal:
```
Check the node version installed on this machine
```

**Expected outcomes:**
- Mission receives 202 response with missionId
- Terminal tool runs with bare name `node` ✅ (allowlist verified)
- Independent verifier reads node version from OS ✅
- Persisted record written to `missions/` directory with `ok: true` or `ok: false`
- Record includes `objective` verdict and `complete` flag
- Record is retrievable after reopening

### What I'll Verify ✅

**After submission:**
- MissionId from the response
- Progress events via SSE / progress endpoint
- Final mission outcome (success/failure)
- Persisted record in `missions/` directory
- Record read-back has correct `ok`, `objective`, `complete` fields
- No guard bypasses occurred
- Autonomy grant unchanged

### Guard & Safety Checks ✅

**During mission:**
- `MayInject()` still governed by autonomy grant ✅
- `TakeoverPending` respected ✅
- `emergencyLatched` still overrides everything ✅
- No input sent without permission ✅
- Guard state reported correctly (ARMED/WORKING / INPUT BLOCKED)

### What I'll Report ✅

**Final deliverable:**
- Mission submission result (202 + missionId or error)
- Progress event summary
- Persisted record content (read back from `missions/`)
- Verification that `objective` and `complete` fields match actual outcome
- Confirmation that guard safeguards remained intact
- Record retrievability after the mission cycle

### Preconditions ✅

**Confirmed working:**
- Bare terminal name `node` is allowlisted ✅
- `node --version` command works through terminal ✅
- Mission persistence to `missions/` directory ✅
- Guard state integrity ✅
- Autonomy grant `~/.aios/agent/autonomy.json` intact ✅

### Submission Method

I will attempt to submit the mission through the chat API's `POST /message` endpoint with the goal text:
```
Check the node version installed on this machine
```

Then verify the results through the progress API and by reading the persisted record.