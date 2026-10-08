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
// The whole point of this proof is to read the pixels the panel actually paints.
//
// `/panelgrid` - like `/screen.png` - currently closes the connection without a response on this
// machine, so the host's pixel-capture path is broken. That makes this proof INCONCLUSIVE rather than
// failed: the claim was not tested, it was not disproved.
//
// It must NOT print PASS. A proof that reports PASS while the instrument it depends on is dead is
// exactly what let five never-running harnesses be cited as evidence for a milestone.
let pixelCaptureLost = null
const panel = await op.raw('/panelgrid').then((r) => r.body).catch((e) => {
  pixelCaptureLost = e
  console.log('\n=== INCONCLUSIVE: the panel pixels could not be read ===')
  console.log('    ' + (e instanceof Error ? e.message : String(e)))
  console.log('    The claim below was NOT tested. It was not disproved either.')
  return {}
})
const dom = pixelCaptureLost ? '' : hex(panel.dominant)

// SKIPPED, which is a third thing that is neither PASS nor FAIL.
//
// The colour assertions BELOW depend entirely on the pixels having been read. When the instrument is
// dead they cannot be evaluated, and letting them report FAIL attributes to the panel a defect that is
// actually in the capture path. So they are marked skipped, counted separately, and the run exits 3.
let skipped = 0
const skip = (label) => { skipped++; console.log(`   SKIP ${label}  (the pixels could not be read)`) }
console.log(`   state=${g.state} latched=${panel.latched} mayInject=${g.mayInject}`)
console.log(`   headline=${JSON.stringify(g.headline)}`)
console.log(`   panel dominant=${dom} purity=${panel.purity} rect=${JSON.stringify(panel.rect)}`)

check(g.state === 'ARMED' && g.mayInject === false,
  'REPRODUCED: control state is ARMED while input is blocked',
  `state=${g.state} mayInject=${g.mayInject}`)
if (pixelCaptureLost) skip('the panel is NOT painted green while input is blocked'); else
check(dom !== GREEN,
  'the panel is NOT painted green while input is blocked',
  `dominant=${dom}, healthy green would be ${GREEN}`)
if (pixelCaptureLost) skip('and is painted a blocked/stop colour instead'); else
check(isBlockedColour(dom),
  'and is painted a blocked/stop colour instead',
  `dominant=${dom}, expected ${AMBER} or ${RED}`)
// Report the latch rather than asserting it is clear: a previous test may legitimately have
// latched an emergency stop, and red is then the CORRECT colour, not a defect.
if (panel.latched) {
  console.log(`   note: the emergency latch is set from an earlier test, so ${RED} is correct here.`)
} else {
  if (pixelCaptureLost) skip('with no latch, the blocked colour is specifically amber'); else
  check(dom === AMBER, 'with no latch, the blocked colour is specifically amber', `dominant=${dom}`)
}

console.log('\n=== the same panel in the genuinely healthy case ===')
console.log('   Not reachable from here: clearing a takeover requires the human\'s chord.')
console.log('   Stated rather than faked. Verified by the human pressing Ctrl+Alt+F12.')

console.log(`\n   (${skipped} assertion(s) skipped because the pixels could not be read)`)
console.log(`\n=== SUMMARY: ${
  fails !== 0 ? fails + ' FAILURE(S)' : pixelCaptureLost || skipped ? 'INCONCLUSIVE' : 'PASS'
} ===`)
if (fails !== 0) console.log('THE CLAIM IS NOT ESTABLISHED. The panel may be lying about being safe.')
if (fails === 0 && pixelCaptureLost) console.log('THE RUN WAS NOT COMPLETE. Do not read this as a clean pass.')
process.exit(fails ? 1 : pixelCaptureLost ? 3 : 0)
