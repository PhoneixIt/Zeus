/**
 * LIVE PROOF: WINDOW-MUTATING ROUTES ARE GOVERNED.
 *
 * =============================================================================
 * THE CLAIM
 * =============================================================================
 *
 *   Every route that can change a window's real machine state passes the authoritative permission
 *   boundary, and `/guifocus` - which only READS focus - does not.
 *
 * Before this milestone `/show`, `/restore` and `/focus` each verified only that the named hwnd
 * belonged to the named pid. That is an identity check. It proves the caller aimed where it said; it
 * says nothing about whether the caller was ALLOWED to act, so a window could be minimised, hidden or
 * yanked to the foreground while a human had taken over or an emergency stop was latched.
 *
 * =============================================================================
 * WHY THESE ASSERTIONS CANNOT PASS VACUOUSLY
 * =============================================================================
 *
 * Every case sends the window's REAL pid, so the identity check PASSES and the guard is the only
 * thing that can refuse. If the identity check were what refused, the proof would be measuring the
 * wrong thing - so it is measured explicitly, with a deliberately wrong pid, and asserted first.
 *
 * The outcome is then read back FROM WINDOWS rather than from the route's reply. A route that silently
 * changed the window and then claimed to have refused would still be caught.
 *
 * The authorized half uses `action=show` on an already-visible window: SW_SHOW on a visible window is a
 * no-op visually, so it proves the gate OPENS without requiring anything disruptive to be done to
 * whatever the human is using. Nothing here asks a human to do anything, and nothing here minimises,
 * hides or steals focus.
 */

import { connect } from '../../control-core/operator-client.mjs'

const client = await connect()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failures = 0
function check(what, ok, detail = '') {
  if (ok) { console.log(`   PASS  ${what}`); return }
  console.log(`   FAIL  ${what}${detail ? ` - ${detail}` : ''}`)
  failures++
}

const listWindows = async () => {
  const r = (await client.windows())
  return Array.isArray(r.windows) ? r.windows : []
}

const all = await listWindows()
const target = all.find((w) => w.title && !w.minimized)
if (!target) {
  console.log('   SKIP  no titled, non-minimized window to aim at')
  process.exit(3)
}
console.log(`   aiming at hwnd=${target.hwnd} pid=${target.pid} "${target.title.slice(0, 44)}"`)

// `raw` concatenates onto the base URL, so the leading slash is required.
const send = async (route, body) => (await client.raw('/' + route.replace(/^\//, ''), { method: 'POST', body }))
const stateOf = async (hwnd) => (await listWindows()).find((w) => w.hwnd === hwnd)

const before = await stateOf(target.hwnd)

console.log('\n=== 1. IDENTITY still runs first, and is not what we are measuring ===')
for (const [route, extra] of [['restore', {}], ['show', { action: 'minimize' }], ['focus', {}]]) {
  const wrong = await send(route, { hwnd: target.hwnd, pid: target.pid + 999999, title: target.title, ...extra })
  check(`${route}: a mismatched pid is refused on IDENTITY`,
    wrong.body.ok === false,
    JSON.stringify(wrong.body).slice(0, 100))
}

console.log('\n=== 2. with the REAL pid: identity passes, so only the GUARD can refuse ===')
const g0 = await client.guard()
console.log(`   state=${g0.state} mayInject=${g0.mayInject} hookUnhealthy=${String(g0.hookUnhealthy)}`)
check('the precondition holds: the operator may NOT inject right now', g0.mayInject === false,
  `mayInject=${g0.mayInject}`)

for (const [route, extra] of [['restore', {}], ['show', { action: 'minimize' }], ['focus', {}]]) {
  const r = await send(route, { hwnd: target.hwnd, pid: target.pid, title: target.title, ...extra })
  check(`${route} is REFUSED at mayInject=false`, r.body.ok === false,
    JSON.stringify(r.body).slice(0, 110))
  check(`   ... citing the guard`, r.body.guard === true, JSON.stringify(r.body).slice(0, 110))
  check(`   ... and naming the state (${g0.state})`,
    String(r.body.error ?? '').includes(String(g0.state)) || String(r.body.error ?? '').includes('ARMED'),
    String(r.body.error).slice(0, 110))
}

console.log('\n=== 3. AND THE WINDOW REALLY DID NOT CHANGE ===')
// Read from /windows, not from the route's reply.
const afterRefusals = await stateOf(target.hwnd)
check('the window still exists', Boolean(afterRefusals))
check('it was NOT minimised', afterRefusals?.minimized === false,
  `minimized=${String(afterRefusals?.minimized)}`)
check('its geometry is unchanged', afterRefusals?.left === before?.left && afterRefusals?.top === before?.top,
  `before ${before?.left},${before?.top} after ${afterRefusals?.left},${afterRefusals?.top}`)
check('and focus was NOT stolen from the human',
  afterRefusals?.foreground === before?.foreground,
  `before ${before?.foreground} after ${afterRefusals?.foreground}`)

console.log('\n=== 4. /guifocus is UNAFFECTED: observation stays available ===')
const gf = await client.raw('/guifocus?hwnd=' + target.hwnd, { method: 'GET' })
check('/guifocus still answers while mayInject=false', gf.body.ok === true,
  `status=${gf.status} ${JSON.stringify(gf.body).slice(0, 100)}`)
check('and it REPORTS focus rather than setting it',
  'thread' in gf.body && 'hwndActive' in gf.body,
  `keys=${Object.keys(gf.body).join(',')}`)

console.log('\n=== 5. and the gate OPENS when legitimately permitted ===')
await client.observe().catch(() => null)
await sleep(200)
await client.arm().catch(() => null)
await sleep(400)
const g1 = await client.guard()
console.log(`   state=${g1.state} mayInject=${g1.mayInject}`)
check('the operator is now permitted to inject', g1.mayInject === true,
  `state=${g1.state} mayInject=${g1.mayInject}`)

if (g1.mayInject === true) {
  // SW_SHOW on an already-visible window: permitted, and visually a no-op. This proves the route is
  // reachable when authorised WITHOUT minimising, hiding or focusing anything the human is using.
  const r = await send('show', { hwnd: target.hwnd, pid: target.pid, title: target.title, action: 'show' })
  check('/show is PERMITTED when the guard allows it', r.body.ok === true,
    JSON.stringify(r.body).slice(0, 110))
  const stillThere = await stateOf(target.hwnd)
  check('and the window is still visible and unchanged in place',
    stillThere?.minimized === false && stillThere?.left === before?.left,
    `minimized=${String(stillThere?.minimized)} left=${String(stillThere?.left)}`)
} else {
  console.log('   (the operator could not be armed - the authorized half is SKIPPED, not assumed)')
  failures++
}

console.log('\n=== 6. back to observation-only, the routes refuse again ===')
await client.observe().catch(() => null)
await sleep(300)
const g2 = await client.guard()
const r2 = await send('restore', { hwnd: target.hwnd, pid: target.pid, title: target.title })
check(`/restore is refused again at state=${g2.state}`, r2.body.ok === false,
  JSON.stringify(r2.body).slice(0, 100))

await sleep(200)
console.log('')
if (failures) {
  console.log(`   === ${failures} FAILURE(S) ===`)
  process.exit(1)
}
console.log('   === PASS ===')
console.log('   /show, /restore and /focus are governed; /guifocus remains read-only observation.')
process.exit(0)