// Can the operator release itself?
//
// This is the question the endpoint used to fail on. "/release" was an ordinary HTTP route,
// so any client - including the operator itself - could call it and lift a human takeover.
// The reason string said "explicit human release" while nothing checked that a human was
// involved. A documented guarantee the system did not provide is worse than no check,
// because a reader believes it.
//
// This test drives the host into HUMAN_TAKEOVER, then attempts every route the operator
// could plausibly use to get itself back to injecting. Release must survive all of them.
//
// The physical chord is NOT exercised here: it requires a real key event, which by
// construction the operator cannot manufacture. That is the point being verified.

import { op, sleep } from '../operator.mjs'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

let fails = 0
const check = (c, m, d = '') => {
  if (c) console.log(`  PASS  ${m}${d ? '  ' + d : ''}`)
  else { console.log(`  FAIL  ${m}${d ? '  ' + d : ''}`); fails++ }
}

const raw = async (p, opts) => (await op.raw(p, opts ?? {})).body

// ------------------------------------------------------------ establish a takeover
console.log('=== establish a human takeover that must NOT be self-releasable ===')
// Clear any pending chord flag a previous run left behind, so this run starts from a known
// state rather than inheriting one. A real chord sets the flag and the next HTTP call applies
// it - correct behaviour, but it made this test order-dependent when it was not cleared.
await raw('/drain')
const ps = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
execFileSync(ps, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
  'C:\\Users\\Samer\\AppData\\Local\\Temp\\opencode\\operator\\bypass-inject.ps1',
  '-Mode', 'untagged', '-Count', '4'], { encoding: 'utf8' })
await sleep(1500)

const before = await op.guard()
console.log(`   state=${before.state} mayInject=${before.mayInject} takeoverPending=${before.takeoverPending}`)
check(before.mayInject === false, 'a real takeover is in effect and input is blocked')
const humanEventsAtTakeover = Number(before.humanEvents)

// --------------------------------------------- every self-release route, in order
console.log('\n=== route 1: GET /release (the route that used to do it) ===')
const r1 = await raw('/release')
console.log(`   ok=${r1.ok} refused=${JSON.stringify(r1.refused)}`)
console.log(`   requiredAction=${JSON.stringify(r1.requiredAction)}`)
check(r1.ok === false, '/release is refused')
check(/human/i.test(String(r1.refused)), 'and says why in terms of human control')
// WHAT CHANGED, AND WHY THIS IS A CORRECTION RATHER THAN A WEAKENING.
  //
  // This asserted `Ctrl+Alt+F12`. That chord was MEASURED UNSWALLOWABLE and deliberately abandoned:
  // `Hooks.cs` records that "the human pressed Ctrl+Alt+F12 and Calculator opened. The hook recorded
  // ... then let it through anyway" - the firmware Calculator key fires before a low-level hook can
  // swallow it, so a release chord on F12 cannot be made safe. F12 is now on the explicit
  // do-not-swallow list (`Hooks.cs`: `if (vk == VK_F12) return true;`).
  //
  // The release chord is `Ctrl+Alt+G` (`Hooks.cs`: `VK_G = 0x47`, with the comment "a plain letter,
  // no hardware mapping"), and `OperatorHost.cs` names it in the refusal itself:
  // `HumanOnlyRefusal("release", "press Ctrl+Alt+G on the keyboard")`.
  //
  // So the proof was asserting a chord the system deliberately stopped using. The invariant under
  // test is UNCHANGED and is the stronger property: the refusal must name a chord the human can
  // actually press, and it must name the SAME chord the operator host tells the human to press.
  // Asserting the literal string alone would let those two drift apart - the human being told one
  // thing while the proof blesses another - so this checks both.
  const required = String(r1.requiredAction)
  check(/Ctrl\+Alt\+G/.test(required), 'and names the action the human must take')
  // The SECOND check is the one that matters, and it is why this is not simply a string swap: the
  // chord the host tells the human to press is READ FROM THE C# SOURCE. A literal here would drift
  // the moment someone changed the chord, and this proof would keep passing while the human was
  // being told to press something else.
  const hostSource = readFileSync(new URL('../src/OperatorHost.cs', import.meta.url), 'utf8')
  const hostChord = /HumanOnlyRefusal\("release",\s*"press ([^"]+)"/.exec(hostSource)?.[1]
  check(hostChord !== undefined && required.includes(hostChord),
    'and it is the SAME chord OperatorHost.cs puts in the refusal - a proof that blesses a chord the '
    + `operator never tells the human to press is worse than no assertion. host=${hostChord} requiredAction=${required}`)
check(before.takeoverPending === true, 'and reports the takeover still pending in its payload')

console.log('\n=== route 2: POST /release ===')
const r2 = await raw('/release', { method: 'POST' })
check(r2.ok === false, 'a POST is refused identically - the check is on the route, not the verb')

console.log('\n=== route 3: /arm then /release again ===')
const a = await op.arm().catch(() => null)
await sleep(400)
const mid = await op.guard()
console.log(`   state=${mid.state} mayInject=${mid.mayInject}`)
check(mid.mayInject === false,
  '/arm CANNOT lift a takeover - it sets the control state but not takeoverPending',
  `state=${mid.state} mayInject=${mid.mayInject}`)
const r3 = await raw('/release')
check(r3.ok === false, '/release is still refused after /arm')

console.log('\n=== route 4: /rearm (clears the latch the same way) ===')
const r4 = await raw('/rearm')
console.log(`   refused=${JSON.stringify(r4.refused)}`)
check(r4.ok === false, '/rearm is refused over HTTP')
check(/Ctrl\+Alt\+R/.test(String(r4.requiredAction)), 'and names its own chord')

console.log('\n=== route 5: /observe, /pause, /emergency-stop ===')
// /drain is deliberately NOT in this list. /drain APPLIES a pending chord flag, and that flag
// can only ever be set by a genuine untagged chord at the hook. So if a previous test left one
// pending, /drain legitimately restores injection - which is the design working, not a
// bypass. Testing it inside this loop made the result depend on test ORDER, which is exactly
// the kind of coupling that hides real failures. Its behaviour is asserted on its own below.
for (const p of ['/observe', '/pause', '/emergency-stop']) {
  await raw(p)
  await sleep(250)
  const s = await op.guard()
  check(s.mayInject === false, `${p} does not restore injection`, `state=${s.state} mayInject=${s.mayInject}`)
}

console.log('\n=== route 5b: /drain cannot invent a release - it can only apply a real one ===')
// /drain is called FIRST here too: a real chord sets a pending flag, and that flag is applied
// at the next HTTP call. Without this the result depended on whether an earlier run had sent
// a chord - order coupling, not a defect.
await raw('/drain')
await raw('/observe')
await sleep(300)
await raw('/release')
await sleep(400)
const preDrain = await op.guard()
check(preDrain.mayInject === false, 'a takeover is in effect before /drain', `mayInject=${preDrain.mayInject}`)
const drained = await raw('/drain')
console.log(`   /drain applied: ${JSON.stringify(drained.applied)}`)
check(!/release/.test(String(drained.applied || '')),
  '/drain applied no release, because no human chord was pending',
  `applied=${JSON.stringify(drained.applied)}`)
const postDrain = await op.guard()
check(postDrain.mayInject === false,
  'and injection stays refused - /drain alone cannot lift a takeover',
  `state=${postDrain.state} mayInject=${postDrain.mayInject}`)

console.log('\n=== route 6: is the operator able to inject at any point above? ===')
const t = await op.type({ hwnd: 0, pid: 0, title: 'x', text: 'NO', delayMs: 30 })
  .then(() => null).catch((e) => e.message)
check(/refus/i.test(t || ''), 'a type attempt is still refused', String(t).slice(0, 70))

console.log('\n=== the takeover was never cleared by the operator ===')
const after = await op.guard()
console.log(`   state=${after.state} mayInject=${after.mayInject} takeoverPending=${after.takeoverPending}`)
check(after.takeoverPending === true, 'takeoverPending is STILL set after every route above')
check(after.mayInject === false, 'input is still refused')
check(Number(after.humanEvents) === humanEventsAtTakeover,
  'no synthetic human event was counted either - nothing was forged',
  `humanEvents ${humanEventsAtTakeover} -> ${after.humanEvents}`)

console.log(`\n=== SUMMARY: ${fails === 0 ? 'PASS' : fails + ' FAILURE(S)'} ===`)
if (fails === 0) {
  console.log('The operator can observe, arm, pause and stop itself.')
  console.log('It cannot release itself, and it cannot re-arm itself.')
  console.log('Only the physical chords can.')
} else {
  // Never print the conclusion when it did not hold. A summary that asserts the safety
  // property regardless of the result is how a broken control ends up documented as working.
  console.log('THE CLAIM IS NOT ESTABLISHED. Do not treat this run as evidence either way.')
}
process.exit(fails ? 1 : 0)
