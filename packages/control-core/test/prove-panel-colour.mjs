// The human-visible truth: the panel must not be green while input is blocked.
//
// WHY THIS NEEDS ITS OWN PROOF
//
// Guard.Headline and Guard.InputPermission are already pinned by prove-status-truth.mjs.
// But the thing a human actually reads is a coloured rectangle, and that is rendered by
// Indicator.BackgroundFor - a separate piece of code. A correct JSON field does not
// guarantee a correct panel.
//
// The specific bug: BackgroundFor returned green for ARMED regardless of MayInject, so a
// control state of ARMED with input genuinely blocked was painted as "safe, go ahead".
// Green is the single most dangerous colour on that panel.
//
// THE EXACT CASE
//
// Reaching ARMED with input blocked requires /arm while a takeover is pending. Arm sets
// the control state but not takeoverPending, so state=ARMED and mayInject=false
// simultaneously - which is precisely the combination observed in the original report.
//
// MEASURED, NOT EYEBALLED
//
// The host's /panelgrid samples the pixels actually painted and returns the dominant
// colour, so this reads the instrument rather than judging a screenshot by eye. Judging
// "is that green" visually is exactly the instrument that lies when the question is
// whether the panel is telling the truth.

import { op, sleep } from '../operator.mjs'
import { execFileSync } from 'node:child_process'

let fails = 0
const check = (c, m, d = '') => {
  if (c) console.log(`  PASS  ${m}${d ? '  ' + d : ''}`)
  else { console.log(`  FAIL  ${m}${d ? '  ' + d : ''}`); fails++ }
}

const hex = (h) => String(h || '').toUpperCase()
const GREEN = '#1E7A33'   // healthy - "safe for you to work"
const AMBER = '#C08A10'   // blocked / paused
const RED = '#A02020'     // emergency stop, or a failed hook

// Both amber and red are correct "not safe" answers; only green is dangerous. Asserting one
// exact colour made this test depend on whether a previous test had latched an emergency stop,
// which is test-order coupling rather than a real failure.
const isBlockedColour = (c) => c === AMBER || c === RED

console.log('=== reach ARMED-with-input-blocked: the exact observed mismatch ===')
const ps = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
execFileSync(ps, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
  'C:\\Users\\Samer\\AppData\\Local\\Temp\\opencode\\operator\\bypass-inject.ps1',
  '-Mode', 'untagged', '-Count', '4'], { encoding: 'utf8' })
await sleep(1200)
await op.arm().catch(() => null)   // control state -> ARMED, takeoverPending untouched
await sleep(900)

const g = await op.guard()
const panel = await op.raw('/panelgrid').then((r) => r.body)
const dom = hex(panel.dominant)
console.log(`   state=${g.state} latched=${panel.latched} mayInject=${g.mayInject}`)
console.log(`   headline=${JSON.stringify(g.headline)}`)
console.log(`   panel dominant=${dom} purity=${panel.purity} rect=${JSON.stringify(panel.rect)}`)

check(g.state === 'ARMED' && g.mayInject === false,
  'REPRODUCED: control state is ARMED while input is blocked',
  `state=${g.state} mayInject=${g.mayInject}`)
check(dom !== GREEN,
  'the panel is NOT painted green while input is blocked',
  `dominant=${dom}, healthy green would be ${GREEN}`)
check(isBlockedColour(dom),
  'and is painted a blocked/stop colour instead',
  `dominant=${dom}, expected ${AMBER} or ${RED}`)
// Report the latch rather than asserting it is clear: a previous test may legitimately have
// latched an emergency stop, and red is then the CORRECT colour, not a defect.
if (panel.latched) {
  console.log(`   note: the emergency latch is set from an earlier test, so ${RED} is correct here.`)
} else {
  check(dom === AMBER, 'with no latch, the blocked colour is specifically amber', `dominant=${dom}`)
}

console.log('\n=== the same panel in the genuinely healthy case ===')
console.log('   Not reachable from here: clearing a takeover requires the human\'s chord.')
console.log('   Stated rather than faked. Verified by the human pressing Ctrl+Alt+F12.')

console.log(`\n=== SUMMARY: ${fails === 0 ? 'PASS' : fails + ' FAILURE(S)'} ===`)
if (fails !== 0) console.log('THE CLAIM IS NOT ESTABLISHED. The panel may be lying about being safe.')
process.exit(fails ? 1 : 0)
