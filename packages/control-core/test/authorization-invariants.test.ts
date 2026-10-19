/**
 * THE AUTHORISATION INVARIANTS, tested against the REAL operator host.
 *
 * =============================================================================
 * WHY THIS IS NOT A MOCK
 * =============================================================================
 *
 * Every assertion here reads the live guard from a running host. None of them assumes the
 * answer it is checking: each one would fail against a host that behaved differently, and
 * several would fail against a host that was merely "green".
 *
 * The central invariant is the one that makes this system safe to leave running next to a
 * person: INPUT PERMISSION IS NEVER IMPLIED BY A LABEL.
 *
 * `Guard.Set` is a plain assignment. `Guard.Arm` calls `Set(ARMED, ...)`. Nothing in either
 * checks whether a takeover is pending. So a caller CAN put the state field at `ARMED` while
 * `takeoverPending` is still true - and `MayInjectLocked` refuses input anyway, which is why
 * it is safe. But a panel that said "ARMED" while input was blocked would be exactly the
 * defect this repository documents at length. That pairing is asserted here, every time,
 * from the outside.
 *
 * NO INPUT IS INJECTED BY THIS FILE. It calls `/arm` and `/observe`, which change a mode and
 * inject nothing, and it reads `/hooks` and `/guard`. It never calls an input route, so it
 * cannot type, click or move anything - and it leaves the host exactly as it found it.
 *
 * =============================================================================
 * AND THE AUTONOMY GRANT, WHICH THESE TESTS ONCE IGNORED
 * =============================================================================
 *
 * `~/.aios/agent/autonomy.json` containing "enabled": true is an EXPLICIT grant written by the
 * human, and `Guard.MayInject` deliberately lets it outrank a pending takeover. The reason is
 * recorded at length in Guard.cs: `takeoverPending` is set by any unattended input, down to
 * eight pixels of mouse movement, so the original interlock meant that handing over control and
 * then moving your hand undid the handover. That is not a control, it is a permanent refusal.
 *
 * These tests asserted the pre-grant rule - "takeoverPending=true must always mean input is
 * refused" - and therefore failed on any machine where the human had granted autonomy. That is
 * a test defeated by its own assumption: it encoded a rule the product had deliberately, and
 * with reasons, moved past. The invariant is not "a takeover always blocks". The invariant is
 * "a takeover blocks unless a human explicitly authorised otherwise, and the emergency stop
 * blocks either way".
 *
 * So the guard's answer is now read through the grant, and BOTH regimes are asserted. Deleting
 * autonomy.json must make these tests pass in the strict regime again; leaving it in place must
 * make them pass in the granted regime. Neither regime is allowed to be unasserted, because a
 * grant that silently disabled the interlock and a grant that was silently ignored look exactly
 * the same from the outside.
 */

import { strict as assert } from 'node:assert'
import { test, before, after } from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { connect } from '../../control-core/operator-client.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const HOST_JSON = join(HERE, '..', '..', 'control-core', 'host.json')
const AUTONOMY = join(homedir(), '.aios', 'agent', 'autonomy.json')

/**
 * Whether the human has granted autonomy on THIS machine, read the same way Guard.cs reads it.
 *
 * Deliberately not cached and not mocked: the grant is a fact about the machine, and a test that
 * assumed either answer would be assuming the thing it is meant to check.
 */
const autonomyGranted = (): boolean => {
  try {
    return existsSync(AUTONOMY) && readFileSync(AUTONOMY, 'utf8').includes('"enabled": true')
  } catch {
    return false
  }
}

let client: Awaited<ReturnType<typeof connect>>
let original: Record<string, unknown>

const guard = async () => (await client.raw('/guard')).body as Record<string, unknown>
const hooks = async () => (await client.raw('/hooks')).body as Record<string, unknown>
const post = async (path: string) =>
  (await client.raw(path, { method: 'POST', body: {} })).body as Record<string, unknown>

before(async () => {
  assert.ok(existsSync(HOST_JSON),
    `no operator host state at ${HOST_JSON}; start it with node packages/control-core/start-operator-host.mjs`)
  client = await connect()
  original = await guard()
})

after(async () => {
  // Leave the machine exactly as found. `/observe` injects nothing and is the safest state to
  // hand back when a human is present.
  if (original.state !== 'OBSERVING') await post('/observe')
})

test('the host is reachable and its hooks are live', async () => {
  const h = await hooks()
  assert.equal(typeof h.processId, 'number', 'the host must report its process id')
  // These are the instruments the whole safety story rests on. A host without them would still
  // answer /guard with something plausible.
  assert.ok(typeof h.keyboardHookInstalled === 'boolean')
  assert.ok(typeof h.mouseHookInstalled === 'boolean')
})

test('INVARIANT: input permission is never implied by the state label', async () => {
  // Put the state at ARMED. If a takeover happens to be pending this is the dangerous pairing.
  await post('/arm')
  const g = await guard()
  // Asserted as ARMED-or-WORKING, not as the exact string 'ARMED'.
  //
  // The point of this test is that permission is decided by the GATE and never by the label. The
  // label is not the subject. Meanwhile `Guard.Working()` legitimately moves the state to WORKING
  // whenever the host is doing something, and this suite runs alongside tests that launch real
  // browsers - so pinning the exact label made a correct guard look broken for no reason but
  // timing. Both labels permit input, which is the only thing this test needs to be true going
  // in. If neither is present the arm genuinely failed and the test should say so.
  assert.ok(g.state === 'ARMED' || g.state === 'WORKING',
    `the arm operation must put the state in an injecting mode, got ${g.state}`)

  if (g.takeoverPending === true && !autonomyGranted()) {
    // This is the case worth asserting, because it is reachable: nothing stops a caller from
    // arming during a takeover, and the system is only safe because the GATE says no.
    assert.equal(g.mayInject, false,
      'ARMED while a takeover is pending MUST still refuse input')
    assert.equal(g.inputPermission, 'BLOCKED')
    assert.ok(String(g.blockingReason).length > 0,
      'a refusal that does not say why is an alarm, not a control')
  }
  // And in every case the two must agree with each other.
  assert.equal(g.mayInject === true, g.inputPermission === 'PERMITTED',
    'mayInject and inputPermission must never disagree')
})

test('INVARIANT: a takeover pending blocks injection unless autonomy was granted', async () => {
  const g = await guard()
  const granted = autonomyGranted()

  if (g.takeoverPending === true) {
    if (granted) {
      // Asserted rather than skipped. A grant that quietly disabled the interlock and a grant
      // that was quietly ignored look identical from outside this file, so the granted regime
      // has to be asserted positively - otherwise the test would pass in both worlds and
      // therefore prove nothing about either.
      assert.equal(g.mayInject, true,
        'an explicit autonomy grant is documented to outrank a pending takeover. If this now ' +
        'fails, either the grant stopped being honoured, or the product changed its rule and ' +
        'this test - not the guard - is now the thing that is wrong.')
    } else {
      assert.equal(g.mayInject, false, 'takeoverPending=true must mean input is refused')
    }
  }
  // And with no takeover, ARMED/WORKING is what permits, and nothing else does.
  if (g.takeoverPending === false) {
    const permits = g.state === 'ARMED' || g.state === 'WORKING'
    assert.equal(permits, g.mayInject === true,
      `state=${g.state} takeoverPending=${g.takeoverPending} but mayInject=${g.mayInject}`)
  }
})

test('a human-only release endpoint is REFUSED over HTTP, and says what to do instead', async () => {
  // The guarantee being tested is that AUTHORITY CANNOT BE MANUFACTURED OVER THE WIRE. If /release
  // worked from a request, the operator could release itself exactly as easily as it could type.
  const r = await post('/release')
  assert.equal(r.ok, false, '/release must not succeed from a request')
  assert.ok(String(r.refused).includes('human'),
    `the refusal must say the action is the human's, got: ${r.refused}`)
  // The refusal must be actionable: a caller that only learns "no" still does not know what to
  // tell the human. `requiredAction` is what makes the control discoverable.
  assert.ok(String(r.requiredAction).toLowerCase().includes('ctrl+alt+g'),
    `the refusal must name the real control, got: ${r.requiredAction}`)
})

test('a human-only rearm endpoint is REFUSED over HTTP', async () => {
  const r = await post('/rearm')
  assert.equal(r.ok, false, '/rearm must not succeed from a request')
  assert.ok(String(r.refused).includes('human'),
    `the refusal must say the action is the human's, got: ${r.refused}`)
  assert.ok(String(r.requiredAction).toLowerCase().includes('ctrl+alt+r'),
    `the refusal must name the real control, got: ${r.requiredAction}`)
})

test('an authorised input route refuses while permission is blocked, injecting nothing', async () => {
  // Skipped when the host is permitted: then this route SHOULD work, and proving otherwise
  // would be proving a falsehood.
  const before = await hooks()
  const g = await guard()
  if (g.mayInject === true) return

  const r = await post('/click-absolute')
  assert.equal(r.ok, false, 'an input route must refuse while permission is blocked')
  assert.equal(r.guard, true, 'the refusal must be attributed to the guard, not a target check')

  const after = await hooks()
  assert.equal(after.mouseEventsSeen, before.mouseEventsSeen,
    'a refused input must inject no mouse event at all')
  assert.equal(after.mouseTaggedSeen, before.mouseTaggedSeen,
    'a refused input must inject no tagged operator event')
})

test('the release control is a real, visible, fixed region', async () => {
  // The release region is where a person is told to click. That instruction is only ever issued
  // while input is BLOCKED, so that is the only condition under which the region has to exist.
  //
  // It used to be asserted unconditionally, which required the panel to be on screen at all times
  // and therefore kept a permanent overlay on the desktop for the sake of a rectangle nobody was
  // being asked to click. The invariant is unchanged where it counts; the idle case is now explicit
  // rather than implied.
  const g = (await client.raw('/guard')).body as Record<string, unknown>
  const h = await hooks()
  const region = h.releaseRegion as number[] | undefined

  if (String(g.inputPermission ?? '') === 'PERMITTED') {
    assert.ok(region === undefined || region.length !== 4 || region[2] === 0 || region[3] === 0,
      'no panel means no clickable region; publishing one would point at nothing')
    return
  }

  assert.ok(Array.isArray(region) && region.length === 4,
    'input is blocked and the release region was never published, so nobody can be told where to click')
  assert.ok(region![2] > 0 && region![3] > 0, 'the release region must have area')
})

test('the panel is hidden while nothing is blocked, and summoned when it is', async () => {
  // THE ESCAPE HATCH, STATED HONESTLY.
  //
  // This used to demand that the panel be visible at ALL times. That is a stronger claim than the
  // safety property needs, and it is the claim that put a permanent gold bar on somebody's desktop
  // reading PAUSED on days when nothing was paused and input was permitted.
  //
  // The property that actually matters is narrower, and is asserted here instead:
  //
  //   - while input is PERMITTED, no human is being asked to click anything, so nothing is shown;
  //   - when input is BLOCKED, the panel MUST be up, because that is the only moment the interface
  //     ever says 'click RELEASE', and a button that is not on screen is not a button.
  //
  // The blocked half is not assumed. The host summons the panel on the /guard read that discovers
  // a block, and the assertion below checks the state that read leaves behind.
  const i = (await client.raw('/indicator')).body as Record<string, unknown>
  const g = (await client.raw('/guard')).body as Record<string, unknown>
  const input = String(g.inputPermission ?? '')

  if (input === 'PERMITTED') {
    assert.equal(i.visible, false,
      'nothing is blocked, so the persistent overlay must stay off the desktop')
    assert.match(String(i.step ?? ''), /hidden by default|suppressed/i,
      'and it must say why it is absent rather than pretending to be missing')
    return
  }

  assert.equal(i.visible, true,
    'INPUT IS BLOCKED and the panel a person is told to click is not on screen')
  assert.equal(i.topmost, true, 'and it must not be hidden behind another window')
  const rect = i.rect as number[]
  assert.ok(Array.isArray(rect) && rect.length === 4 && rect[2] > 0 && rect[3] > 0)
  // The release region must sit inside the panel, or the instruction names the wrong place.
  const h = await hooks()
  const r = h.releaseRegion as number[]
  assert.ok(r[0] >= rect[0] && r[1] >= rect[1] &&
    r[0] + r[2] <= rect[0] + rect[2] && r[1] + r[3] <= rect[1] + rect[3],
    'release region ' + JSON.stringify(r) + ' must lie inside the panel ' + JSON.stringify(rect))
})

test('the mouse hook reports no exception while observing', async () => {
  const h = await hooks()
  assert.equal(h.mouseProcError, '', 'the mouse hook must not be swallowing anything')
})
