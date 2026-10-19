const { request } = require('http')
const { spawn, execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const h = JSON.parse(fs.readFileSync('packages/control-core/host.json', 'utf8'))

const call = (p, body) => new Promise((res) => {
  const b = body === undefined ? null : Buffer.from(JSON.stringify(body))
  const r = request({ host: '127.0.0.1', port: h.port, path: p, method: b ? 'POST' : 'GET',
    headers: { authorization: 'Bearer ' + h.token, ...(b ? { 'content-type': 'application/json', 'content-length': b.length } : {}) } },
    (x) => { const c = []; x.on('data', (d) => c.push(d)); x.on('end', () => { const t = Buffer.concat(c).toString(); let j = {}; try { j = JSON.parse(t) } catch { j = { raw: t.slice(0, 200) } } res({ status: x.statusCode, j }) }) })
  r.on('error', (e) => res({ status: 'ERR', j: { err: e.message } }))
  if (b) r.write(b); r.end()
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const STAMP = 'AIOS-OK-' + Date.now().toString(36).toUpperCase()

  console.log('1. LAUNCH Notepad via the operator')
  const np = spawn('notepad.exe', [], { detached: true, stdio: 'ignore' })
  np.unref()
  await sleep(3500)

  const win = await call('/windows')
  const target = win.j.windows.find((w) => /notepad/i.test(w.title))
  if (!target) {
    console.log('   no Notepad window found:', win.j.windows.map((w) => w.title).join(' | '))
    return
  }
  console.log(`   hwnd=${target.hwnd} pid=${target.pid} title="${target.title}" visible=${!target.minimized}`)

  console.log('')
  console.log('2. FOCUS it (this route is documented as UNGATED - H5)')
  console.log('  ', JSON.stringify((await call('/focus', { hwnd: target.hwnd, pid: target.pid })).j).slice(0, 140))
  await sleep(1200)

  console.log('')
  console.log(`3. TYPE "${STAMP}" into it`)
  const typed = await call('/type', { hwnd: target.hwnd, pid: target.pid, text: STAMP })
  console.log('  ', JSON.stringify(typed.j).slice(0, 160))
  await sleep(1500)

  console.log('')
  console.log('4. VERIFY independently - read the window back via UI Automation')
  const seen = await call('/uiasurvey', { hwnd: target.hwnd, max: 60, includeOffscreen: false })
  const blob = JSON.stringify(seen.j)
  const found = blob.includes(STAMP)
  console.log(`   survey status=${seen.status}  contains the exact string: ${found}`)
  const texts = (seen.j.controls || seen.j.nodes || []).map((c) => c.name || c.text || '').filter(Boolean)
  if (texts.length) console.log('   control texts:', texts.slice(0, 6).join(' | ').slice(0, 200))
  else console.log('   raw:', blob.slice(0, 220))

  console.log('')
  console.log('=== VERDICT ===')
  console.log(found ? `PASS  typed "${STAMP}" and read it back from the real window`
                     : `FAIL  typed "${STAMP}" but it was NOT found on read-back`)
  try { process.kill(np.pid) } catch {}
  try { execFileSync('taskkill', ['/PID', String(np.pid), '/F'], { stdio: 'ignore' }) } catch {}
}
main()