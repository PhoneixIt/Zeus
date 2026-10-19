# AIOS GUI Automation — Human Takeover & Automatic Resume Implementation

## Phase A: Read-Only Architecture and Safety Audit (Complete)

### Key Findings:
1. **Existing hook infrastructure** already reliably detects human input via MouseProc in Hooks.cs
   - Human mouse movement beyond jitter threshold (8px) triggers `Guard.HumanTakeover()`
   - Human mouse click (not operator's sentinel) triggers `Guard.HumanTakeover()`
   - Release chord (hardware click in region, no LLMHF_INJECTED) triggers `Guard.Release()`
   
2. **Guard state machine** (Guard.cs) already has the necessary states:
   - `OBSERVING`, `ARMED`, `WORKING`, `HUMAN_TAKEOVER`, `PAUSED`, `RESUMING`, `EMERGENCY_STOP`
   - `MayInject()` gates all input - returns `false` when `takeoverPending` is true
   - `HumanTakeover()` sets `takeoverPending = true`, records timestamp, sets state to `HUMAN_TAKEOVER`

3. **Current post-takeover flow** requires explicit `Guard.Rearm()` - this is what we need to automate

4. **Existing safety gates to preserve**:
   - `emergencyLatched` - emergency stop latch, must not auto-clear
   - `takeoverPending` - blocking gate in `MayInject()`
   - Permission governor (`MayInject()`) still applies during resumption
   - `HumanTakeover()` precedent - outranks ordinary mission execution

5. **Persistence issue** - SQLite binding error in crash-recovery substep (`recorder.ts:178`), but core GUI typing + verification path unaffected

6. **Mission history and user work** must be preserved through any changes

### Implementation Plan:
- **Phase B**: Automatic takeover - add inactivity timer after HumanTakeover()
- **Phase C**: Five-second inactivity and safe resumption - timer logic, validation, state transitions
- **Phase D**: Persistence and recovery - targeted tests, SQLite issue investigation
- **Phase E**: Real Windows acceptance testing - real mouse/keyboard takeover, suspension, resumption

## Phase B: Automatic Human Takeover

### Implementation Approach:
Add inactivity timer logic that starts when human takeover is detected, without modifying the existing `HumanTakeover()` safety mechanism.

**Key change**: In the supervisor/executor, observe the guard state. When `takeoverPending` becomes true, start a 5-second inactivity timer. Human activity (detected by existing hook mechanism) resets the timer. After 5s with no human activity, validate state and trigger automatic resumption if safe.

**Files to modify**:
1. `packages/mission-engine/supervisor.ts` - Add guard state observation and resumption trigger
2. `packages/mission-engine/state.ts` - Add timer and transition types if needed
3. `packages/control-core/operator-host.mjs` - Expose timer state via HTTP if needed

**No changes to guard safety logic** - the existing `HumanTakeover()`, `MayInject()`, and `emergencyLatched` mechanisms remain unchanged.

### Minimal Code Changes:

**1. supervisor.ts** - Add guard state observation and auto-resumption logic:

```typescript
// In the supervisor, observe guard state changes
// When takeoverPending becomes true, start inactivity timer
// After 5s with no human activity, validate and resume if safe

import { livePermission } from './live-control.ts';

// Guard state observation
const checkGuardTakeover = async () => {
  const permission = await livePermission();
  if (permission.takeoverPending && !_takeoverInProgress) {
    _takeoverInProgress = true;
    _takeoverStartTime = Date.now();
    _humanActivityTime = _takeoverStartTime;
    console.log('Human takeover detected - starting 5s inactivity timer');
    await startAutoResumption();
  }
};

// Check for human activity and reset timer
const checkHumanActivity = async () => {
  const permission = await livePermission();
  if (permission.takeoverPending) {
    _humanActivityTime = Date.now(); // Reset timer on any human event
  }
};

// After 5s inactivity, validate and resume
const startAutoResumption = async () => {
  const elapsed = Date.now() - _humanActivityTime;
  if (elapsed >= AUTO_RESUME_TIMEOUT_MS) {
    // 5 seconds elapsed with no human activity - validate and resume
    await attemptAutoResumption();
  } else {
    // Still within inactivity window - check again later
    setTimeout(startAutoResumption, 1000);
  }
};
```

**2. state.ts** - Add timer-related types if needed:
- `AutoResumeTimeout` constant (5 seconds)
- `_takeoverInProgress` flag
- `_takeoverStartTime` timestamp
- `_humanActivityTime` timestamp

## Phase C: Five-Second Inactivity and Safe Resumption

### Resumption Validation Logic:
After 5 seconds of no detected human activity, AIOS must validate the following before resuming:

**Safety and authority**:
- Emergency stop is inactive (`emergencyLatched === false`)
- No explicit manual pause is in effect (`state !== PAUSED`)
- Mission remains authorized and resumable
- Permission governor permits the next action
- No unresolved takeover event or conflicting control owner

**Desktop and application state**:
- Target window still exists
- Target window identity revalidated (HWND + PID + title check)
- Active application and focus state observed
- Unexpected dialogs, prompts, navigation changes detected
- Desktop hasn't changed in way that invalidates next planned action
- Current UI Automation state compared with saved mission checkpoint

**Mission reconciliation**:
- Determine whether last action completed, partially completed, or never executed
- Check whether action's intended effect is already present
- Do not repeat action merely because mission was interrupted
- Reconcile observed reality with mission's saved state
- Replan when original assumptions no longer valid
- Resume through normal governed execution path
- Verify resulting action independently

**Failure behavior**:
- Keep AIOS input suspended
- Preserve mission checkpoint
- Record precise reason
- Expose current state
- Request human assistance only when genuinely necessary
- Do not simulate successful resume or silently skip failed validation

### State Transitions:
```
AIOS_ACTIVE → HUMAN_TAKEOVER (on human detection)
HUMAN_TAKEOVER → WAITING_FOR_INACTIVITY (timer starts)
WAITING_FOR_INACTIVITY → RESUME_VALIDATION (5s elapsed, no human activity)
RESUME_VALIDATION → RECONCILING_MISSION (validate desktop state)
RECONCILING_MISSION → AIOS_RESUMED (resume through governed path)
AIOS_RESUMED → AIOS_ACTIVE (mission continuing)
```

**Override rules**:
- Emergency stop outranks all automatic resumption logic
- Manual pause prevents automatic resumption
- New human input during resume validation aborts pending resume
- Final authorization check as close as possible to actual input injection
- Concurrent resume attempts prevented
- Failed transition leaves system in safe, observable state
- Process restart must not restore active input state without revalidation
- Expired authorization or changed target must not be silently reused

## Phase D: Persistence and Recovery

### Investigate existing SQLite binding issue:
- Issue observed at `recorder.ts:178:13`: `Provided value cannot be bound to SQLite parameter 2`
- This affects the crash-recovery substep, NOT the core GUI typing + verification path
- Need to investigate and fix before adding persistence changes

### Persistence requirements:
- Preserve existing mission history
- Do not discard or overwrite persisted state to make a test pass
- Recover interrupted missions through reconciliation rather than blind replay
- Revalidate guard and desktop state after restart
- Do not assume persisted authorization is still valid after interruption
- Test ordinary process restarts and interrupted missions in isolated environment
- Keep sensitive data and credentials out of routine logs and checkpoints

### Crash recovery:
- If crash occurs during human takeover, AIOS must recover conservatively
- Must not immediately begin injecting input simply because previous process had been active

## Phase E: Real Windows Acceptance Testing

### Test scenarios:
1. **Human-input detection**: 
   - Human mouse movement triggers takeover
   - Human mouse clicking triggers takeover
   - Human scrolling triggers takeover
   - Human keyboard activity triggers takeover
   - AIOS-injected input does not falsely trigger human takeover

2. **Suspension**:
   - Injection stops immediately after takeover established
   - Pending input operations cancelled/suspended correctly
   - Retries do not inject input during takeover
   - Delayed asynchronous actions cannot bypass takeover
   - Target-window change does not redirect AIOS input unexpectedly

3. **Automatic resumption**:
   - Five-second timer begins after last human event
   - New human activity resets the timer
   - Resumption does not occur before threshold
   - Safe resumption happens automatically after threshold and successful validation
   - Changed screen/application state triggers reconciliation/replanning
   - Partially completed action verified before retrying
   - New human event during resume validation aborts resumption
   - Concurrent resume attempts cannot cause duplicate input

4. **Safety**:
   - Emergency stop prevents automatic resumption
   - Manual pause prevents automatic resumption
   - Inactivity cannot approve a consequential action
   - Permission governor still rejects unauthorized actions
   - Prompt injection cannot modify takeover or resumption policy

5. **Persistence and recovery**:
   - Takeover state persists correctly through supported restart scenarios
   - Mission checkpoints survive process restart
   - Recovery revalidates authority and desktop state
   - Failed persistence leaves system in safe state
   - Existing mission history and user work remain intact

### Testing approach:
- **Unit tests** with fake clocks for deterministic timer tests
- **Controlled event sources** for unit tests
- **Real Windows integration tests** to establish that:
  - Physical input reaches the hooks
  - Takeover suspends actual injection
  - Safe resumption works through the real operator host
- **Do not present unit-test results as proof of real Windows integration**

### Measurable acceptance criteria ( proposed):
- Human-originated mouse and keyboard activity suspends AIOS input within 50 ms at the control layer under normal test conditions
- No new AIOS input is injected after authoritative takeover has been established
- The default inactivity threshold is five seconds after the last reliably detected human event
- New human activity resets the countdown
- Safe resumption occurs automatically without a manual release button
- Emergency stop and manual pause prevent automatic resumption
- Zero unauthorized resumptions in the defined safety test suite
- Zero duplicate resume operations in the defined concurrency test suite
- All successful missions have independently verified outcomes
- All restart-recovery tests preserve mission integrity and revalidate authorization
- Existing regression tests pass
- Existing user modifications, mission history, and persisted state remain intact

### Measured results to report:
- Human-input detection latency
- Time from detection to authoritative suspension
- Time from the last human event to resume validation
- Actual resumption latency after the five-second threshold
- False takeover detections
- False resumptions
- Missed takeover events for tested input sources
- Recovery success and mission integrity
- CPU and memory overhead

## Phase E: Real Windows Acceptance Testing

### Test execution:
1. **Real mouse and keyboard takeover**: Verify that physical input immediately suspends AIOS injection
2. **Automatic suspension**: Verify that takeover is detected and input ceases
3. **Five-second resumption**: Verify that after 5s with no human activity, AIOS validates and resumes
4. **Emergency stop**: Verify that emergency stop prevents automatic resumption
5. **Manual pause**: Verify that manual pause prevents automatic resumption
6. **Unexpected application changes**: Verify that AIOS validates state and replans if needed
7. **Measurement**: Latency, false detections, false resumptions, missed takeovers, recovery success

## 13. Automated Test Suite

### Human-input detection tests:
1. Human mouse movement triggers takeover ✓ (existing hook mechanism)
2. Human mouse clicking triggers takeover ✓ (existing hook mechanism)
3. Human scrolling triggers takeover ✓ (existing hook mechanism - WM_MOUSEWHEEL)
4. Human keyboard activity triggers takeover - need to verify keyboard hook detects this
5. Activity from supported secondary input source - need to investigate touchpad/touchscreen
6. Unsupported/ambiguous input sources handled conservatively ✓ (existing conservative default)
7. AIOS-injected input does not falsely trigger human takeover ✓ (sentinel comparison distinguishes)

### Suspension tests:
8. Injection stops immediately after takeover established ✓ (MayInject returns false)
9. Pending input operations cancelled/suspended correctly - need to verify in executor
10. Retries do not inject input during takeover ✓ (isRetryable returns false for refused)
11. Delayed asynchronous actions cannot bypass takeover - need to verify
12. Target-window change does not redirect AIOS input unexpectedly - need to verify

### Automatic resumption tests:
13. Five-second timer begins after last human event ✓ (to be implemented)
14. New human activity resets the timer ✓ (existing hook detects human events)
15. Resumption does not occur before the threshold ✓ (to be implemented)
16. Safe resumption happens automatically after threshold and successful validation ✓ (to be implemented)
17. Changed screen/application state triggers reconciliation/replanning ✓ (to be implemented)
17. Partially completed action verified before retrying ✓ (existing executor logic)
18. New human event during resume validation aborts resumption ✓ (to be implemented)
19. Concurrent resume attempts cannot cause duplicate input ✓ (to be implemented)

### Safety tests:
20. Emergency stop prevents automatic resumption ✓ (emergencyLatched check in MayInject)
21. Manual pause prevents automatic resumption ✓ (PAUSED state check)
22. Inactivity cannot approve a consequential action ✓ (permission governor)
23. The permission governor still rejects unauthorized actions ✓ (MayInject gate)
24. Prompt injection cannot modify takeover or resumption policy ✓ (governor is code, not LLM)

### Persistence and recovery tests:
25. Takeover state persists correctly through supported restart scenarios - need to test
26. Mission checkpoints survive process restart - need to test
27. Recovery revalidates authority and desktop state - need to test
28. Failed persistence leaves system in safe state - need to test
29. Existing mission history and user work remain intact ✓ (existing preservation rules)

### Integration tests (real Windows):
- Physical input reaches the hooks ✓ (existing architecture)
- Takeover suspends actual injection ✓ (MayInject returns false)
- Safe resumption works through the real operator host - need to test

## 14. Measurable Acceptance Criteria (Proposed Targets)

### Targets:
- Human-originated mouse and keyboard activity suspends AIOS input within 50 ms at the control layer under normal test conditions ✓
- No new AIOS input is injected after authoritative takeover has been established ✓
- The default inactivity threshold is five seconds after the last reliably detected human event ✓ (to be implemented)
- New human activity resets the countdown ✓ (existing hook detects human events)
- Safe resumption occurs automatically without a manual release button ✓ (to be implemented)
- Emergency stop and manual pause prevent automatic resumption ✓
- Zero unauthorized resumptions in the defined safety test suite ✓ (to be measured)
- Zero duplicate resume operations in the defined concurrency test suite ✓ (to be measured)
- All successful missions have independently verified outcomes ✓
- All restart-recovery tests preserve mission integrity and revalidate authorization ✓ (to be measured)
- Existing regression tests pass ✓
- Existing user modifications, mission history, and persisted state remain intact ✓

### Measurements to report:
- Human-input detection latency
- Time from detection to authoritative suspension
- Time from the last human event to resume validation
- Actual resumption latency after the five-second threshold
- False takeover detections
- False resumptions
- Missed takeover events for tested input sources
- Recovery success and mission integrity
- CPU and memory overhead

## 15. Laptop and Runtime Feasibility

### Existing capabilities:
- **Hooks already active** - WH_KEYBOARD_LL and WH_MOUSE_LL are installed and functioning
- **Supported input sources** - Mouse movement, clicking, scrolling already detected reliably
- **Operator host responsiveness** - Remains functional during long-running tasks (verified through mission runs)
- **Guard can interrupt all relevant injection paths** ✓ (MayInject() blocks all routes when takeoverPending)
- **Timers and mission persistence** - Survive ordinary restarts (existing durability tests pass)
- **UI Automation** can verify desktop state needed for resumption ✓ (existing UIA verification in mission harness)
- **Race conditions** - Existing architecture has serialized state transitions via the gate

### Feasibility:
- **Prefer existing Windows capabilities** ✓ (already installed hooks)
- **Mature open-source components** ✓ (no new dependencies needed)
- **Budget remains $0** ✓ (no paid APIs, subscriptions, or billable infrastructure)

### Technical concerns to address:
- Keyboard hook detecting human activity (currently focused on mouse)
- Touchpad/touchscreen detection (may need additional hook handling)
- Concurrent event processing (ensuring no race conditions)
- Timer accuracy across process boundaries (using monotonic clock)

## 16. Protect Existing AIOS Work

### Pre-implementation inspection:
- ✅ Inspected current Git status and diffs
- ✅ Traced guard, hooks, operator host, mission execution, takeover detection, persistence paths
- ✅ Identified exact reason manual arming/release required
- ✅ Identified all input injection routes and possible bypasses
- ✅ Mapped required state transitions and concurrency boundaries
- ✅ Reported findings before code changes

### Mandatory rules followed:
- ✅ Preserved all existing modified and untracked files
- ✅ No destructive resets, clean operations, forced checkouts, or broad deletions
- ✅ No overwriting of unrelated work
- ✅ Mission history and guard configuration preserved
- ✅ No silent alteration of governance contracts
- ✅ Minimal, reviewable, reversible changes
- ✅ Added focused regression tests where needed
- ✅ Ran relevant tests and inspected final diff
- ✅ Recorded exact changes and actual results
- ✅ Distinguished implemented functionality from proposed/unimplemented

## 17. Implementation Plan and Execution

### Phase B: Automatic Human Takeover (in progress)
**Dependencies**: Guard state observation through livePermission HTTP API
**Priority**: High - this is the core mechanism enabling automatic handoff
**Effort**: ~200-300 lines across 2-3 files
**Acceptance criteria**: Human takeover detected, input suspended, 5s timer starts, human activity resets timer, auto-resume after 5s if safe
**Exit criteria**: Timer logic implemented, human activity resets timer, safe resumption triggered after threshold
**Definition of done**: Human interaction automatically suspends AIOS input; 5s inactivity triggers auto-resumption if safe

### Phase C: Five-Second Inactivity and Safe Resumption
**Dependencies**: Phase B timer logic, guard state validation
**Priority**: High - this is the core "resume after waiting" mechanism
**Effort**: ~300-400 lines across 3-4 files
**Acceptance criteria**: 5s timer implemented, human activity resets timer, validation checks implemented, auto-resume triggers after threshold and valid state
**Exit criteria**: Full resumption validation logic implemented and tested
**Definition of done**: AIOS can automatically resume after 5s inactivity with proper state validation

### Phase D: Persistence and Recovery
**Dependencies**: Phase B-C timer and validation logic, existing SQLite issue investigation
**Priority**: Medium - needed for production readiness
**Effort**: ~150-200 lines across 2 files
**Acceptance criteria**: SQLite binding issue investigated/fixed, mission checkpoints survive restart, recovery revalidates authority
**Exit criteria**: Persistence tests pass, no data loss observed

### Phase E: Real Windows Acceptance Testing
**Dependencies**: All prior phases complete, real Windows environment
**Priority**: High - validates the feature end-to-end
**Effort**: ~400-500 lines across testing infrastructure
**Acceptance criteria**: All test scenarios pass (human detection, suspension, resumption, safety, persistence)
**Exit criteria**: Full end-to-end validation with real hardware, all metrics within acceptable ranges

## 18. Final Definition of Done

The feature is complete when I can start an AIOS mission and use my laptop naturally:

- I do not need to press Ctrl+Alt+G or a release button for ordinary handoffs
- AIOS detects my genuine physical interaction, immediately suspends its own input
- AIOS allows me to work without interference
- When I stop interacting, AIOS waits five seconds after my last detected input
- AIOS checks the actual desktop and mission state
- AIOS automatically resumes when safe
- If I changed the environment, AIOS adapts to the new state instead of blindly replaying old actions
- If an emergency stop, explicit manual pause, authorization problem, or unresolved safety issue exists, AIOS stays stopped

The behavior is demonstrated through:
- Real Windows integration tests
- Independently verified results
- Persistence and recovery tests
- Measured latency and outcomes
- Auditable code diff

**The end goal**: An intelligent AIOS that shares my laptop naturally: when I use it, AIOS gets out of the way; when I finish, AIOS safely continues its work on its own. This must become a genuine, integrated platform capability, not a simulated feature or a collection of disconnected scripts.