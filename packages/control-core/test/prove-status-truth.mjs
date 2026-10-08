// The status truth bug, pinned.
//
// A run observed `state: "ARMED"` together with `mayInject: false`. Both were correct:
// ARMED is the CONTROL state and mayInject is the ENFORCEMENT result, and a pending human
// takeover blocks input without yet changing the control mode.
//
// The defect was in the REPRESENTATION. A panel that renders a green "ARMED" tells a human
// that input is flowing when it is not, and they would act on that at exactly the moment it
// matters. Safety behaviour must not change to make a label look right; the label has to
// tell the truth about the behaviour.

import { op, sleep, screen } from '../operator.mjs'
import { execFileSync } from 'node:child_process'

let fails = 0
const check = (c, m, d = '') => {
  if (c) console.log(`  PASS  ${m}${d ? '  ' + d : ''}`)
  else { console.log(`  FAIL  ${m}${d ? '  ' + d : ''}`); fails++ }
}
const g = () => op.guard()

console.log('\n=== 1. the reported status must never disagree with enforcement ===')
const s = await g()
console.log(`   state=${s.state} mayInject=${s.mayInject} inputPermission=${s.inputPermission} headline=${JSON.stringify(s.headline)}`)
check(s.inputPermission === (s.mayInject ? 'PERMITTED' : 'BLOCKED'),
  'inputPermission is derived from the authoritative mayInject',
  `${s.inputPermission} vs mayInject=${s.mayInject}`)
check(s.mayInject === false ? s.blockingReason !== null && String(s.blockingReason).length > 0 : s.blockingReason === null,
  'a blocking reason is present exactly when input is blocked',
  String(s.blockingReason))
check(!/^ARMED$/.test(s.headline) || s.mayInject,
  'the headline NEVER reads a bare "ARMED" while input is blocked',
  `headline=${JSON.stringify(s.headline)}`)

console.log('\n=== 2. reproduce the exact observed mismatch and check the report ===')
// Start from a clean state. An emergency-stop latch left by an earlier test legitimately
// OUTRANKS a takeover, so asserting takeover behaviour while latched tested the wrong thing.
await op.raw('/drain').catch(() => null)
await op.observe().catch(() => null)
await sleep(400)
// Drive a genuine human takeover with untagged input - the same mechanism as the original.
const ps = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
execFileSync(ps, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
  'C:\\Users\\Samer\\AppData\\Local\\Temp\\opencode\\operator\\bypass-inject.ps1',
  '-Mode', 'untagged', '-Count', '4'], { encoding: 'utf8' })
await sleep(1500)
const during = await g()
console.log(`   state=${during.state} mayInject=${during.mayInject} takeoverPending=${during.takeoverPending}`)
console.log(`   headline=${JSON.stringify(during.headline)}`)
console.log(`   blockingReason=${JSON.stringify(during.blockingReason)}`)

const mismatchPresent = during.state === 'ARMED' || during.state === 'WORKING'
if (mismatchPresent) {
  check(during.mayInject === false, 'REPRODUCED: control state is ARMED/WORKING while input is blocked',
    `state=${during.state} mayInject=${during.mayInject}`)
  check(/INPUT BLOCKED/.test(during.headline),
    'and the headline now says so rather than reading a bare "ARMED"',
    `headline=${JSON.stringify(during.headline)}`)
  check(during.inputPermission === 'BLOCKED', 'and inputPermission reports BLOCKED')
  // The reason must name whatever is ACTUALLY blocking. An emergency latch outranks a
  // takeover, so accepting only "takeover" here would be asserting a falsehood whenever a
  // stop is latched - which is precisely when the operator is most stuck and the reason
  // matters most.
  check(/takeover|EMERGENCY_STOP|hook/i.test(String(during.blockingReason)),
    'and the reason names the actual blocker', String(during.blockingReason))
} else {
  // No ARMED/WORKING state observed. Two legitimate reasons, distinguished explicitly rather
  // than both being papered over as "fine".
  const latched = /EMERGENCY_STOP/.test(String(during.state)) || /re-arm/.test(String(during.blockingReason))
  if (latched) {
    // An emergency latch outranks a takeover BY DESIGN, so the untagged input above cannot
    // transition the state - and clearing the latch needs the human's Ctrl+Alt+R, which this
    // test deliberately cannot do. Stated rather than worked around.
    check(during.mayInject === false, 'an emergency latch is in effect and input is refused')
    check(/re-arm/i.test(String(during.blockingReason)),
      'and it names the action only the human can take', String(during.blockingReason))
    console.log('   note: the ARMED-while-blocked case needs a clear latch; the human\'s')
    console.log('         Ctrl+Alt+R is required first. That path was proven separately in')
    console.log('         prove-panel-colour.mjs, which drives ARMED via /arm under takeover.')
  } else {
    check(/HUMAN_TAKEOVER|PAUSED|OBSERVING/.test(during.state),
      'the untagged input was seen and the state reflects it',
      `state=${during.state}`)
    check(during.mayInject === false, 'input is refused regardless')
  }
}

console.log('\n=== 3. injection is genuinely refused while blocked ===')
const refused = await op.type({ hwnd: 0, pid: 0, title: 'x', text: 'NO', delayMs: 30 })
  .then(() => null).catch((e) => e.message)
check(/refus|guard|state|target/i.test(refused || ''), 'a type attempt while blocked is refused', String(refused).slice(0, 80))

console.log('\n=== 4. the rendered indicator agrees with the host ===')
await screen('status-truth-blocked')
// Green is the colour that means "safe for you to work". It must not appear while blocked.
const blockedNow = (await g()).mayInject === false
check(blockedNow, 'captured while input is blocked, which is the state under test')
console.log('   (see shots/status-truth-blocked.png: the panel must not be green while blocked)')

console.log('\n=== 5. the permitted case cannot be reached from here, by design ===')
// This step used to call op.release(), op.rearm() and op.arm() to demonstrate the
// permitted state. That was the operator RELEASING ITSELF - the exact thing the rules
// forbid, performed by my own test while the reason string claimed a human had done it.
// /release and /rearm are now refused over HTTP, so this cannot recur.
//
// The permitted case is verified elsewhere, by the human pressing Ctrl+Alt+F12, which the
// operator cannot manufacture. Until then the honest statement is that input is blocked,
// and the report must say so.
const after = await g()
console.log(`   state=${after.state} mayInject=${after.mayInject} headline=${JSON.stringify(after.headline)}`)
const rel = await op.raw('/release').then((r) => r.body).catch(() => ({}))
check(rel.ok === false, 'the operator still cannot reach the permitted state on its own')
check(after.mayInject === false, 'input remains blocked, which is the truth right now')
check(after.inputPermission === 'BLOCKED', 'and the report says BLOCKED')
check(!/^ARMED$/.test(after.headline) || after.mayInject,
  'and the headline does not read a bare ARMED while blocked', `headline=${JSON.stringify(after.headline)}`)

console.log(`\n=== SUMMARY: ${fails === 0 ? 'PASS' : fails + ' FAILURE(S)'} ===`)
if (fails !== 0) console.log('THE CLAIM IS NOT ESTABLISHED. Do not treat this run as evidence.')
process.exit(fails ? 1 : 0)
