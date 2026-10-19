import { request } from 'node:http'
import { readFileSync } from 'node:fs'

const h = JSON.parse(readFileSync('packages/control-core/host.json', 'utf8'))
const T = h.token, P = h.port

function call(p, b) {
  return new Promise((resolve) => {
    const body = b === undefined ? null : Buffer.from(JSON.stringify(b))
    const q = request({ host: '127.0.0.1', port: P, path: p, method: body ? 'POST' : 'GET',
      headers: { authorization: 'Bearer ' + T, ...(body ? { 'content-type': 'application/json', 'content-length': body.length } : {}) } },
      (x) => { const c = []; x.on('data', (d) => c.push(d)); x.on('end', () => resolve({ status: x.statusCode, body: Buffer.concat(c).toString() })) })
    q.on('error', (e) => resolve({ status: 'ERR', body: e.message }))
    if (body) q.write(body)
    q.end()
  })
}
const j = async (p, b) => { const r = await call(p, b); try { return JSON.parse(r.body) } catch { return { raw: r.body.slice(0, 120) } } }

const TARGET = { hwnd: 10552972, pid: 464, title: 'AIOS Assistant' }
const ROUTES = [
  ['/focus', TARGET],
  ['/show', { ...TARGET, action: 'maximize' }],
  ['/restore', TARGET],
]

async function main() {
  const out = []
  const rec = (n, ok) => out.push([n, ok])

  console.log('=== PHASE 1: guard PERMITTED -> all three must WORK ===')
  let g = await j('/guard')
  console.log('  guard: input=' + g.inputPermission + ' takeover=' + g.takeoverPending)
  for (const [route, body] of ROUTES) {
    const r = await j(route, body)
    const ok = r.ok === true
    console.log('  ' + route.padEnd(10) + ' -> ' + JSON.stringify(r).slice(0, 110))
    rec(route + ' works when permitted', ok)
  }

  console.log('')
  console.log('=== PHASE 2: latch the emergency stop -> all three must REFUSE ===')
  const es = await j('/emergency-stop')
  console.log('  /emergency-stop -> ' + JSON.stringify(es).slice(0, 120))
  g = await j('/guard')
  console.log('  guard now: input=' + g.inputPermission + ' latched=' + g.emergencyLatched)

  for (const [route, body] of ROUTES) {
    const r = await j(route, body)
    const refused = r.ok === false && r.guard === true
    console.log('  ' + route.padEnd(10) + ' -> ' + JSON.stringify(r).slice(0, 130))
    rec(route + ' refuses when guard is closed', refused)
  }

  console.log('')
  console.log('=== PHASE 3: the refusal must name the guard, not the target ===')
  // A target failure would say "pid mismatch" or "not visible". A guard failure says
  // guard:true. Distinguishing them is the whole point: a route that refuses for the
  // wrong reason is indistinguishable from one that never checked.
  const r = await j('/focus', TARGET)
  const namesGuard = r.guard === true && /EMERGENCY_STOP|takeover|guard/i.test(String(r.error))
  console.log('  /focus error: ' + String(r.error).slice(0, 90))
  rec('refusal names the guard, not the target', namesGuard)

  console.log('')
  console.log('=== PHASE 4: re-arm -> they work again ===')
  const re = await j('/rearm')
  console.log('  /rearm -> ' + JSON.stringify(re).slice(0, 120))
  g = await j('/guard')
  console.log('  guard now: input=' + g.inputPermission + ' latched=' + g.emergencyLatched)
  const back = await j('/focus', TARGET)
  console.log('  /focus -> ' + JSON.stringify(back).slice(0, 110))
  rec('works again after re-arm', back.ok === true)

  console.log('')
  console.log('=== VERDICT ===')
  let all = true
  for (const [n, ok] of out) { console.log((ok ? 'PASS' : 'FAIL') + '  ' + n); if (!ok) all = false }
  console.log('')
  console.log(all ? 'ALL PASS' : 'SOME FAILED')
}
main()