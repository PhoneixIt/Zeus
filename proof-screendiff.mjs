import { request } from 'node:http'
import { spawn, execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const h = JSON.parse(readFileSync('packages/control-core/host.json', 'utf8'))
console.log('host pid ' + h.pid)

function raw(p, b) {
  return new Promise((resolve) => {
    const body = b === undefined ? null : Buffer.from(JSON.stringify(b))
    const q = request({ host: '127.0.0.1', port: h.port, path: p, method: body ? 'POST' : 'GET',
      headers: { authorization: 'Bearer ' + h.token, ...(body ? { 'content-type': 'application/json', 'content-length': body.length } : {}) } },
      (x) => { const c = []; x.on('data', (d) => c.push(d)); x.on('end', () => resolve({ status: x.statusCode, body: Buffer.concat(c).toString() })) })
    q.on('error', (e) => resolve({ status: 'ERR', body: e.message }))
    if (body) q.write(body)
    q.end()
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const parsed = (r) => { try { return JSON.parse(r.body) } catch { return { parseFailed: true, body: r.body.slice(0, 120) } } }

async function main() {
  const R = 'x=200&y=600&w=320&h=180'
  const out = []
  const rec = (n, ok) => out.push([n, ok])

  const a = parsed(await raw('/screendiff?' + R))
  console.log('A no-baseline       ->', a.status ?? '', JSON.stringify(a).slice(0, 90))
  rec('refuses without baseline (no guess)', a.ok === false && /baseline/i.test(String(a.error)))

  console.log('B watch            ->', (await raw('/screenwatch?' + R)).body)
  await sleep(500)
  const b = parsed(await raw('/screendiff?' + R))
  console.log('B diff (no change) ->', JSON.stringify(b).slice(0, 130))
  rec('unchanged screen -> changed=false', b.changed === false && b.changedPixels === 0)

  console.log('C launching Notepad...')
  const np = spawn('notepad.exe', [], { detached: true, stdio: 'ignore' })
  np.unref()
  await sleep(3500)
  const c = parsed(await raw('/screendiff?' + R))
  console.log('C diff (changed)   ->', JSON.stringify(c).slice(0, 240))
  rec('changed screen -> changed=true with pixels', c.changed === true && c.changedPixels > 0)
  rec('localises the change as a region', c.region && c.region.w > 0 && c.region.h > 0)

  console.log('D closing Notepad...')
  try { execFileSync('taskkill', ['/IM', 'notepad.exe', '/F'], { stdio: 'ignore' }) } catch {}
  await sleep(3000)
  const d = parsed(await raw('/screendiff?' + R))
  console.log('D diff (reverted)  ->', JSON.stringify(d).slice(0, 240))
  rec('change reverts after closing', d.changed === false)

  console.log('')
  console.log('=== VERDICT ===')
  let all = true
  for (const [n, ok] of out) { console.log((ok ? 'PASS' : 'FAIL') + '  ' + n); if (!ok) all = false }
  console.log('')
  console.log(all ? 'ALL PASS' : 'SOME FAILED')
  try { process.kill(np.pid) } catch {}
}
main()