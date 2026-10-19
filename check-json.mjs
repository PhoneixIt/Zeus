import { request } from 'node:http'
import { readFileSync } from 'node:fs'
const h = JSON.parse(readFileSync('packages/control-core/host.json', 'utf8'))
function raw(p) {
  return new Promise((resolve) => {
    const q = request({ host: '127.0.0.1', port: h.port, path: p, method: 'GET', headers: { authorization: 'Bearer ' + h.token } },
      (x) => { const c = []; x.on('data', (d) => c.push(d)); x.on('end', () => resolve({ status: x.statusCode, body: Buffer.concat(c).toString() })) })
    q.on('error', (e) => resolve({ status: 'ERR', body: e.message }))
    q.end()
  })
}
const r = await raw('/screendiff?x=200&y=600&w=320&h=180')
console.log('status  :', r.status)
console.log('body    :', JSON.stringify(r.body))
console.log('has backslash-quote:', r.body.includes('\\"'))
let o = null
try { o = JSON.parse(r.body); console.log('PARSE OK :', JSON.stringify(o)) } catch (e) { console.log('PARSE FAIL:', e.message) }