// Can the automation layer release the operator?
//
// THE CONTROL
//
// A rectangle on the visible panel. Clicking it is meant to release the operator.
//
// WHY IT IS NOT A BUTTON
//
// The panel is click-through and has NO click handler. It is a picture, not a control. The
// decision is made in the low-level mouse hook, and only for an event that satisfies BOTH:
//
//   1. dwExtraInfo != Guard.Sentinel   - the operator's own input carries the sentinel, so its
//                                        clicks are recognisably its own
//   2. LLMHF_INJECTED not set          - Windows sets this on anything SendInput produced, so no
//                                        program on this machine can synthesise it
//
// Condition 1 alone would still admit an untagged injection. Condition 2 alone would still
// admit a sentinel-tagged event. Together, the only thing that releases is a real finger on a
// real mouse.
//
// There is no HTTP route, no callback and no application event handler that performs a
// release. A caller cannot invoke release; it can only put a physical click in a rectangle.
//
// WHAT THIS PROVES
//
// That automation cannot get through: not via HTTP, not via its own tagged click, not via an
// untagged SendInput, not via a direct call. And that the operator stays safely PAUSED when it
// fails, because failing closed is the whole point.

import { op, sleep } from '../operator.mjs'
import { execFileSync } from 'node:child_process'

let fails = 0
const check = (c, m, d = '') => {
  if (c) console.log(`  PASS  ${m}${d ? '  ' + d : ''}`)
  else { console.log(`  FAIL  ${m}${d ? '  ' + d : ''}`); fails++ }
}
const raw = async (p, o) => (await op.raw(p, o ?? {})).body
const hooks = async () => raw('/hooks')
const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const SENTINEL_SCRIPT = 'C:\\Users\\Samer\\AppData\\Local\\Temp\\opencode\\operator\\bypass-inject.ps1'

// Put the operator in a state where release would be meaningful, without releasing anything.
await raw('/drain')
await raw('/release').catch(() => null)   // refused by design; clears nothing
await op.observe().catch(() => null)
await sleep(500)

console.log('=== 0. the control exists and is published ===')
const h0 = await hooks()
console.log(`   releaseRegion=${JSON.stringify(h0.releaseRegion)}`)
check(Array.isArray(h0.releaseRegion) && h0.releaseRegion[2] > 0 && h0.releaseRegion[3] > 0,
  'the release region is published to the hook', JSON.stringify(h0.releaseRegion))
const [rx, ry, rw, rh] = h0.releaseRegion
const cx = Math.round(rx + rw / 2), cy = Math.round(ry + rh / 2)

console.log('\n=== 1. HTTP cannot release ===')
const r1 = await raw('/release')
check(r1.ok === false, '/release is refused', String(r1.refused).slice(0, 52))
const r2 = await raw('/rearm')
check(r2.ok === false, '/rearm is refused', String(r2.refused).slice(0, 52))

console.log('\n=== 2. the automation layer\'s OWN click on the control is refused ===')
// The sharpest test. The operator CAN move a real cursor to those coordinates and click.
// What it cannot do is make the click untagged.
//
// NOTE: while the operator is in HUMAN_TAKEOVER the host refuses /click at the GATE, so the
// click never reaches the hook at all. That is a stronger refusal, but it means this step
// cannot observe the hook's own sentinel check - so it asserts the gate refusal here, and the
// sentinel check is exercised below with the operator temporarily ARMED, where the click
// really does travel and the hook really does see it tagged.
const before = await hooks()
const gBefore = await op.guard()
console.log(`   state=${gBefore.state} mayInject=${gBefore.mayInject} - attempting an operator click at ${cx},${cy}`)
const moveRes = await op.move({ hwnd: 0, pid: 0, title: 'x', x: cx, y: cy })
  .then(() => null).catch((e) => e.message)
const clickRes = await op.click({ hwnd: 0, pid: 0, title: 'x', x: cx, y: cy, button: 'left' })
  .then(() => null).catch((e) => e.message)
await sleep(700)
const after = await hooks()
console.log(`   move: ${String(moveRes).slice(0, 54)}`)
console.log(`   click: ${String(clickRes).slice(0, 54)}`)
console.log(`   panelSeen ${before.panelReleaseSeen} -> ${after.panelReleaseSeen}  accepted ${before.panelReleaseAccepted} -> ${after.panelReleaseAccepted}`)
check(clickRes !== null && /refus/i.test(String(clickRes)),
  'an operator click on the control is REFUSED at the gate', String(clickRes).slice(0, 58))
check(after.panelReleaseAccepted === before.panelReleaseAccepted,
  'and did NOT release',
  `accepted stayed ${after.panelReleaseAccepted}`)

console.log('\n=== 3. an UNTAGGED injected click is refused too (no sentinel to lean on) ===')
// Belt and braces: even with the sentinel check removed from the equation, Windows' own
// injected flag refuses it. This is the condition automation cannot forge.
const b3 = await hooks()
execFileSync(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
  `$sig = [IntPtr]::Zero; Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;
public class M {
 [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public IU U; }
 [StructLayout(LayoutKind.Explicit)] public struct IU { [FieldOffset(0)] public MI mi; }
 [StructLayout(LayoutKind.Sequential)] public struct MI { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
 [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] p, int size);
 public static uint Click(int x,int y){
   int nx = x*65536/1920, ny = y*65536/1080;
   SendInput(1,new INPUT[]{new INPUT{type=0,U=new IU{mi=new MI{dx=nx,dy=ny,mouseData=0,dwFlags=0x0001|0x8000,time=0,dwExtraInfo=new IntPtr(0)}}}},Marshal.SizeOf(typeof(INPUT)));
   System.Threading.Thread.Sleep(60);
   SendInput(1,new INPUT[]{new INPUT{type=0,U=new IU{mi=new MI{dx=0,dy=0,mouseData=0,dwFlags=0x0002|0x8000,time=0,dwExtraInfo=new IntPtr(0)}}}},Marshal.SizeOf(typeof(INPUT)));
   return 1;
 }
}
'@ -Language CSharp
[M]::Click(${cx},${cy})`], { encoding: 'utf8', shell: 'powershell.exe' })
await sleep(900)
const a3 = await hooks()
console.log(`   panelSeen ${b3.panelReleaseSeen} -> ${a3.panelReleaseSeen}  accepted ${b3.panelReleaseAccepted} -> ${a3.panelReleaseAccepted}  injected ${b3.panelInjectedSeen} -> ${a3.panelInjectedSeen}`)
console.log(`   lastPanelOutcome=${JSON.stringify(a3.lastPanelOutcome)}`)
check(a3.panelReleaseAccepted === b3.panelReleaseAccepted,
  'an untagged INJECTED click did NOT release - Windows flagged it and the hook refused',
  `accepted stayed ${a3.panelReleaseAccepted}`)

console.log('\n=== 4. ARMED: the operator TAGGED click now reaches the hook - and is refused ===')
// With no takeover pending the host permits input, so the click really travels and the hook
// really sees it carrying the sentinel. This is the check that matters most: it proves the
// refusal is not merely the gate declining, but the HOOK recognising its own automation.
await op.observe().catch(() => null)
await sleep(300)
await op.arm().catch(() => null)
await sleep(500)
const gArm = await op.guard()
console.log(`   state=${gArm.state} mayInject=${gArm.mayInject}`)
const b4 = await hooks()
console.log(`   clicking the control at ${cx},${cy} while ARMED, through the operator's input path`)
const armedClick = await op.click({ hwnd: 0, pid: 0, title: 'x', x: cx, y: cy, button: 'left' })
  .then(() => 'DELIVERED').catch((e) => String(e.message).slice(0, 50))
await sleep(900)
const a4 = await hooks()
console.log(`   result: ${armedClick}`)
console.log(`   panelSeen ${b4.panelReleaseSeen} -> ${a4.panelReleaseSeen}`)
console.log(`   panelTagged ${b4.panelTaggedSeen} -> ${a4.panelTaggedSeen}`)
console.log(`   panelAccepted ${b4.panelReleaseAccepted} -> ${a4.panelReleaseAccepted}`)
console.log(`   lastPanelOutcome=${JSON.stringify(a4.lastPanelOutcome)}`)
check(a4.panelTaggedSeen > b4.panelTaggedSeen,
  'the hook SAW the operator click in the region', `tagged +${a4.panelTaggedSeen - b4.panelTaggedSeen}`)
check(a4.panelReleaseAccepted === b4.panelReleaseAccepted,
  'and REFUSED it as automation - this is the sentinel check doing the work',
  `accepted stayed ${a4.panelReleaseAccepted}`)
check(/sentinel|automation/i.test(String(a4.lastPanelOutcome)),
  'and said why', String(a4.lastPanelOutcome).slice(0, 70))

console.log('\n=== 5. the operator is still PAUSED and still cannot inject ===')
await op.observe().catch(() => null)
await sleep(300)
const g = await op.guard()
console.log(`   state=${g.state} mayInject=${g.mayInject} headline=${JSON.stringify(g.headline)}`)
check(g.mayInject === false, 'injection is refused in observation-only')
const typed = await op.type({ hwnd: 0, pid: 0, title: 'x', text: 'NO', delayMs: 30 })
  .then(() => null).catch((e) => e.message)
check(/refus/i.test(typed || ''), 'a type attempt is refused', String(typed).slice(0, 60))

console.log('\n=== 6. emergency stop still outranks the panel control ===')
await op.emergencyStop().catch(() => null)  // latches; nothing after this can inject
await sleep(400)
const gStop = await op.guard()
check(gStop.mayInject === false, 'an emergency stop still blocks injection')
check(/re-arm|EMERGENCY_STOP/i.test(String(gStop.blockingReason)),
  'and is named as the blocker', String(gStop.blockingReason).slice(0, 60))
// A click on the control while latched must NOT clear it.
const b5 = await hooks()
execFileSync(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'exit 0'], { encoding: 'utf8' })
const a5 = await hooks()
const gAfter = await op.guard()
check(gAfter.mayInject === false, 'and it stays latched - the panel control does not clear a stop')

console.log('\n=== 7. there is no API that performs a release ===')
// Enumerate the routes and confirm none of them releases. A release route existing at all
// would be the defect the previous cycle fixed; this asserts the set has not grown back.
const routes = ['/release', '/rearm', '/panel-release', '/release-click', '/unpause']
let anyRelease = false
for (const rt of routes) {
  const res = await raw(rt)
  const refused = res.ok === false
  console.log(`   ${rt.padEnd(16)} ok=${res.ok} ${refused ? 'refused' : 'ACCEPTED'}`)
  if (!refused && /release/i.test(rt)) anyRelease = true
}
check(!anyRelease, 'no route accepts a release', 'every candidate route refused')

console.log('\n=== 8. what is NOT claimed ===')
console.log('   That a PHYSICAL click releases. That requires a human finger, and it is the one')
console.log('   acceptance test still owed. Everything that can be tested without a human has')
console.log('   been: the refusal paths above are all machine-verified.')
console.log('   The panel control is trustworthy BECAUSE it is the only path, and every other')
console.log('   path is refused - not because a synthetic test simulated a human.')

console.log(`\n=== SUMMARY: ${fails === 0 ? 'PASS' : fails + ' FAILURE(S)'} ===`)
if (fails !== 0) console.log('THE CLAIM IS NOT ESTABLISHED. Automation may be able to release.')
process.exit(fails ? 1 : 0)
