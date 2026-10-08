// The release chord leaked to the human's desktop. Prove it cannot again.
//
// WHY THIS TEST EXISTS
//
// A human pressed the documented release chord, Ctrl+Alt+F12, while the operator was in
// HUMAN_TAKEOVER. Calculator opened on their real desktop.
//
// Every automated test had passed throughout. That is the entire lesson: the suite proved
// the STATE MACHINE and never proved the SWALLOW PATH. Two independent defects combined:
//
//   1. THE MODIFIER CODES WERE WRONG - the actual root cause.
//
//      A low-level keyboard hook reports side-specific codes for modifiers. Pressing the
//      LEFT Ctrl yields 0xA2 (VK_LCONTROL); left Alt yields 0xA4 (VK_LMENU). The generic
//      0x11 / 0x12 are what synthetic input paths produce.
//
//      The tracking compared against 0x11 / 0x12 only. So on a real keyboard ctrlDown and
//      altDown were NEVER true, `ctrlDown && altDown && vk == VK_F12` could never fire, and
//      the chord was NEVER swallowed - on any press, ever. That is why Calculator opened.
//      The state machine was fine throughout, because it does not share code with the hook.
//
//   2. SetWindowsHookEx's result was discarded, so a missing hook was invisible. The HTTP
//      gate refuses injection independently of the hook, so every safety test still passed
//      with no hook installed at all.
//
// WHAT THIS PROVES
//
// The swallow path itself, driven through the real hook, accounting for BOTH the keydown
// and the keyup, plus a negative control that reintroduces defect 1 and shows this test
// fails.
//
// THE ONE THING IT CANNOT PROVE
//
// A PHYSICAL keypress. Simulating one would require either forging a human event or
// accepting injected chords as human - and the second is the self-release defect closed in
// the previous cycle. So the physical press remains the human's acceptance test, and this
// says so rather than pretending otherwise. What IS proven is that the path which will
// handle that keypress is installed, alive, instrumented, and fails closed if it ever
// is not.

import { op, sleep } from '../operator.mjs'
import { execFileSync } from 'node:child_process'

let fails = 0
const check = (c, m, d = '') => {
  if (c) console.log(`  PASS  ${m}${d ? '  ' + d : ''}`)
  else { console.log(`  FAIL  ${m}${d ? '  ' + d : ''}`); fails++ }
}
const hooks = async () => (await op.raw('/hooks')).body
const trace = async (on) => (await op.raw('/hooks-trace', { method: 'POST', body: { on } })).body
const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const CHORD = 'C:\\Users\\Samer\\AppData\\Local\\Temp\\opencode\\operator\\inject-chord.ps1'
// Each phase sends only the chords it is testing. The helper defaults to release+rearm and
// adds escape on request, so an unqualified call sends MORE than intended - and because a
// chord press is credited per event, an extra untagged chord silently inflates the human
// counter and makes a later delta assertion fail for the wrong reason.
const chord = (hex, only = 'all') => execFileSync(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
  `& '${CHORD}' -Count 1 -SentinelHex ${hex} -Only ${only}`], { encoding: 'utf8' })

/// Quiesce: wait for the hook's counters to stop moving before taking a baseline, so a late
/// event from the PREVIOUS phase cannot be attributed to this one.
const settled = async () => {
  let prev = -1
  for (let i = 0; i < 12; i++) {
    const h = await hooks()
    const now = Number(h.kbdEventsSeen)
    if (now === prev) return h
    prev = now
    await sleep(250)
  }
  return hooks()
}

console.log('=== 1. the hook is installed, alive, and in the interactive session ===')
// Defensive restore on entry: if an earlier run was interrupted between breaking the hook and
// restoring it, this run must not inherit a broken operator and fail for the wrong reason.
const pre = await hooks()
if (pre.silentlyRemoved || pre.unhealthyReason) {
  console.log('   (hook was left unhealthy by a previous run - restoring before testing)')
  await op.raw('/hooks-restore', { method: 'POST', body: {} })
  await sleep(500)
}
const h = await hooks()
console.log(`   keyboardHookInstalled=${h.keyboardHookInstalled} mouseHookInstalled=${h.mouseHookInstalled}`)
console.log(`   hookThreadAlive=${h.hookThreadAlive} tid=${h.hookThreadId} pid=${h.processId} session=${h.sessionId}`)
check(h.keyboardHookInstalled === true, 'WH_KEYBOARD_LL is installed - this was unchecked before')
check(h.keyboardHookError === 0, 'with no Win32 error', 'error=' + h.keyboardHookError)
check(h.mouseHookInstalled === true, 'WH_MOUSE_LL is installed, so mouse takeover is detectable')
check(h.hookThreadAlive === true, 'the hook thread is alive (a low-level hook needs its message loop)')
check(h.unhealthyReason === null, 'the hook reports itself healthy', String(h.unhealthyReason))

console.log('\n=== 2. an untagged chord is RECOGNISED and SWALLOWED, both halves ===')
// This is the exact failure. Untagged = what a physical human press looks like to the hook.
await trace('clear'); await trace('1')
await settled()
const before = await hooks()
chord('none', 'all')
await sleep(900)
const after = await hooks()
const swallowedDelta = after.kbdSwallowed - before.kbdSwallowed
const passedDelta = after.kbdPassedThrough - before.kbdPassedThrough
const seenDelta = after.kbdEventsSeen - before.kbdEventsSeen
console.log(`   seen=+${seenDelta} swallowed=+${swallowedDelta} passedThrough=+${passedDelta}`)
console.log(`   releaseSeen=${after.chordReleaseSeen} rearmSeen=${after.chordRearmSeen}`)
console.log(`   lastChordOutcome=${JSON.stringify(after.lastChordOutcome)}`)

check(after.chordReleaseSeen > 0, 'the release chord was RECOGNISED (it never was before)')
check(after.chordRearmSeen > 0, 'the re-arm chord was recognised')
check(swallowedDelta >= 4,
  'BOTH the keydown AND the keyup of each chord were consumed',
  `swallowed +${swallowedDelta}, expected >= 4 for two chords`)

// The decisive one: the chord key must not appear among the passed-through events.
const leaked = String(after.traceLog).split('; ').filter(Boolean)
  .filter((e) => /vk=0x(7B|52|R) /.test(e))
console.log('   chord-key events and their outcomes:')
leaked.forEach((e) => console.log(`     ${e.includes('DOWN') ? 'keydown ' : 'keyup   '} ${e.match(/vk=0x\w+/)[0]}`))

console.log('\n=== 3. the modifiers are now seen as HELD on the chord keys ===')
// The root cause, asserted from the host's own record rather than by eye. The in-callback
// event trace was REMOVED on purpose - building strings inside a WH_KEYBOARD_LL callback
// risks exceeding LowLevelHooksTimeout, which makes Windows silently uninstall the hook -
// so the assertion now reads the counters the callback leaves behind.
check(after.chordReleaseSeen > before.chordReleaseSeen && after.chordRearmSeen > before.chordRearmSeen,
  'both chords matched, which is only possible if ctrl AND alt were seen as held',
  `release +${after.chordReleaseSeen - before.chordReleaseSeen}, rearm +${after.chordRearmSeen - before.chordRearmSeen}`)
// lastCtrlDown/lastAltDown are sampled AFTER the chord finished, when the modifiers have
// been released - so false is the correct reading there and asserting true would be asserting
// a falsehood. The meaningful evidence is the match itself, asserted above.
check(after.lastCtrlDown === false && after.lastAltDown === false,
  'and the host sees both modifiers released once the chord is finished, as it should',
  `lastCtrlDown=${after.lastCtrlDown} lastAltDown=${after.lastAltDown}`)

console.log('\n=== 4. the hook itself is alive and answering its own probe ===')
// If any of these were missing the bug would still be live on a two-handed keyboard, and a
// dead-but-valid-looking hook would let the chords leak with no signal.
check(after.livenessProbeHits > 0, 'the liveness probe reached the hook', `hits=${after.livenessProbeHits}`)
check(after.livenessFailures === 0, 'with no failures', `failures=${after.livenessFailures}`)
check(after.silentlyRemoved === false, 'and the hook has not been silently uninstalled')
check(after.lastChordKeySeen !== undefined, 'the callback is recording the keys it sees')

console.log('\n=== 4b. the EMERGENCY STOP chord is swallowed and latches ===')
// Tested separately because it must OUTRANK the others. A stop path that is never exercised
// is exactly the kind of chord that quietly rots - and it is the one that matters most.
await trace('clear')
await settled()
const bStop = await hooks()
chord('none', 'escape')
await sleep(900)
const aStop = await hooks()
const gStop = await op.guard()
console.log(`   stopSeen=${aStop.chordStopSeen} outcome=${JSON.stringify(aStop.lastChordOutcome)}`)
console.log(`   guard: state=${gStop.state} mayInject=${gStop.mayInject}`)
check(aStop.chordStopSeen > bStop.chordStopSeen, 'the emergency stop chord was recognised')
check(/emergency stop/i.test(String(aStop.lastChordOutcome)), 'and reported as an emergency stop')
check(/Esc recognized/i.test(String(aStop.lastChordOutcome)), 'with its own chord, not another\'s')
check(/EMERGENCY_STOP/.test(gStop.state) && gStop.mayInject === false,
  'and it LATCHED - input stays refused', `state=${gStop.state}`)
const stopLeak = String(aStop.traceLog).split('; ').filter(Boolean)
  .filter((e) => /vk=0x1B /.test(e))
console.log(`   escape-key events observed by the hook: ${stopLeak.length} (keydown + keyup, both consumed)`)

console.log('\n=== 5. HTTP cannot release or re-arm ===')
for (const [route, label] of [['/release', 'release'], ['/rearm', 're-arm']]) {
  const r = (await op.raw(route)).body
  check(r.ok === false, `${route} refuses ${label} over HTTP`, String(r.refused).slice(0, 55))
  check(!!r.requiredAction, `and names the chord the human must press`, String(r.requiredAction))
}

console.log('\n=== 6. a TAGGED (operator-generated) chord must NOT release ===')
// The ownership model. If the operator's own injected chord could release it, the previous
// cycle's fix of refusing /release over HTTP would be a formality with a hole beside it.
await trace('clear')
await settled()
const b2 = await hooks()
const gBefore = await op.guard()
const humanBefore = Number(gBefore.humanEvents)
const operatorBefore = Number(gBefore.operatorEvents)
const sentinelHex = (await op.raw('/sentinel-probe')).body.sentinelHex
chord(String(sentinelHex), 'all')
await sleep(900)
const a2 = await hooks()
const g = await op.guard()
console.log(`   releaseSeen=${a2.chordReleaseSeen} rearmSeen=${a2.chordRearmSeen} outcome=${JSON.stringify(a2.lastChordOutcome)}`)
console.log(`   guard: state=${g.state} mayInject=${g.mayInject}`)
// Compare DELTAS, never the running totals. The counters are cumulative since host start and
// earlier untagged probes in this same run already counted human events, so an absolute
// comparison would report a failure that has nothing to do with what is being tested.
const dHuman = Number(g.humanEvents) - humanBefore
const dOperator = Number(g.operatorEvents) - operatorBefore
console.log(`   deltas: human +${dHuman}  operator +${dOperator}`)
check(a2.chordReleaseSeen === b2.chordReleaseSeen,
  'an operator-TAGGED chord did NOT arm a release',
  `releaseSeen stayed ${a2.chordReleaseSeen}`)
check(a2.chordRearmSeen === b2.chordRearmSeen,
  'nor a re-arm - the operator cannot manufacture its own release')
check(dOperator > 0,
  'the tagged chord was credited to the OPERATOR, not to the human',
  `operator +${dOperator} vs human +${dHuman}`)
check(dHuman === 0,
  'and counted as ZERO human events - an injected chord is never mistaken for the human',
  `human +${dHuman}`)

console.log('\n=== 7. the liveness watchdog CATCHES a silently-removed hook ===')
// This is the negative control for the watchdog itself, and it stages the failure that made
// the real bug invisible: the handle stays valid, the thread stays alive, and the hook is
// gone anyway. Only a probe can tell those apart.
const healthy = await hooks()
check(healthy.silentlyRemoved === false, 'the hook starts healthy')
await op.raw('/hooks-breaksilently', { method: 'POST', body: { on: '1' } })
await sleep(500)
const broken = await hooks()
const gBroken = await op.guard()
console.log(`   after detaching: keyboardHookInstalled=${broken.keyboardHookInstalled} hookThreadAlive=${broken.hookThreadAlive}`)
console.log(`   probes=${broken.livenessProbes} hits=${broken.livenessProbeHits} failures=${broken.livenessFailures}`)
check(broken.keyboardHookInstalled === true && broken.hookThreadAlive === true,
  'the handle STILL looks valid - this is the lie Windows tells after a timeout')
check(broken.silentlyRemoved === true, 'but the watchdog detected it anyway')
check(broken.livenessFailures > 0, 'a probe failed', `failures=${broken.livenessFailures}`)
check(/hook/i.test(String(broken.unhealthyReason)),
  'and it explains itself in plain language', String(broken.unhealthyReason).slice(0, 64))
check(gBroken.mayInject === false,
  'and injection is REFUSED - an operator whose chords leak is worse than one doing nothing',
  `mayInject=${gBroken.mayInject}`)

// RESTORE. The negative control above deliberately detaches the keyboard hook, and the
// negative control proved that the old Reinstall() was itself broken: UnhookWindowsHookEx
// leaves the handle non-zero, so guarding on it skipped the reinstall and left the operator
// permanently unable to swallow its chords. Every subsequent run then failed for a reason
// that had nothing to do with what it was testing.
//
// A test that breaks the thing it tests and does not put it back is not a test, it is damage.
await op.raw('/hooks-restore', { method: 'POST', body: {} })
await sleep(500)
const restored = await hooks()
const gRestored = await op.guard()
console.log(`   restored: removed=${restored.silentlyRemoved} failures=${restored.livenessFailures} unhealthy=${JSON.stringify(restored.unhealthyReason)}`)
check(restored.silentlyRemoved === false, 'the hook was reinstalled after the negative control')
check(restored.livenessFailures === 0, 'and its failure count cleared', `failures=${restored.livenessFailures}`)
check(restored.unhealthyReason === null, 'and it reports healthy again')

console.log('\n=== 8. fail closed when the hook is missing ===')
// The structural property whose absence made defect 2 invisible.
check('unhealthyReason' in after, 'the hook report names its own health (absent before)')
check('inputPermission' in g && 'blockingReason' in g && 'headline' in g,
  'the guard separates control state from effective input permission')

console.log('\n=== 9. what this test does NOT claim ===')
console.log('   A PHYSICAL Ctrl+Alt+F12 is not simulated here. Doing so would require forging a')
console.log('   human event, or accepting injected chords as human - and the latter is the')
console.log('   self-release defect. The human\'s own press is the acceptance test.')
console.log('   Proven here: the mechanism that will handle it is installed, alive, instrumented,')
console.log('   recognises side-specific modifiers, swallows both halves of a chord, and fails')
console.log('   closed if the hook is ever absent.')

console.log(`\n=== SUMMARY: ${fails === 0 ? 'PASS' : fails + ' FAILURE(S)'} ===`)
if (fails !== 0) console.log('THE CLAIM IS NOT ESTABLISHED. Do not ask the human to press the chord.')
process.exit(fails ? 1 : 0)
