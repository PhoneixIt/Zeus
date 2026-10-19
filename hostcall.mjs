// ===========================================================================================
// hostcall.mjs - the one way this session talks to the operator host.
//
// WHY A FILE AND NOT `node -e`
//
// The operator host requires an Authorization header, and a browser navigation or a
// PowerShell Invoke-RestMethod cannot send one. Every attempt to hand-roll that request
// inline has cost more time than the thing being tested: PowerShell quoting inside a
// `node -e "..."` string mangles itself, and PowerShell's Invoke-RestMethod produces a bare
// 403 that looks exactly like an authentication failure and is not. This file exists so the
// transport is written once, correctly, and never re-derived under time pressure.
//
// It reads the RUNTIME host.json, never the repo mirror: the host runs out of
// %TEMP%\opencode\operator and the mirror goes stale after every rebuild, which silently
// sends requests to the port of a host that no longer exists.
//
//   node hostcall.mjs get  /windows
//   node hostcall.mjs post /launch '{"app":"notepad"}'
// ===========================================================================================
import http from 'node:http'
import { readFileSync } from 'node:fs'

const RUNTIME_STATE = 'C:/Users/Samer/AppData/Local/Temp/opencode/operator/host.json'

function state() {
  try {
    return JSON.parse(readFileSync(RUNTIME_STATE, 'utf8'))
  } catch (e) {
    throw new Error(`cannot read the runtime state file at ${RUNTIME_STATE}: ${e.message}`)
  }
}

export function call(method, path, body) {
  const s = state()
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8')
  return new Promise((resolve, reject) => {
    const headers = { authorization: `Bearer ${s.token || ''}` }
    if (payload) {
      headers['content-type'] = 'application/json'
      headers['content-length'] = String(payload.length)
    }
    const req = http.request(
      { host: '127.0.0.1', port: s.port, path, method, headers },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          try {
            resolve({ status: res.statusCode, json: JSON.parse(text) })
          } catch {
            resolve({ status: res.statusCode, text })
          }
        })
      },
    )
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

export const get = (path) => call('GET', path)
export const post = (path, body) => call('POST', path, body)

// --- CLI -------------------------------------------------------------------------
if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  const [, , method, path, json] = process.argv
  if (!method || !path) {
    console.error('usage: node hostcall.mjs <get|post> <path> [json-body | key=value ...]')
    process.exit(2)
  }

  // Accept `key=value key=value` as well as raw JSON.
  //
  // Raw JSON is unusable from PowerShell. This is not a hypothetical: typing
  // node hostcall.mjs post /launch '{"app":"notepad"}' in PowerShell delivers
  // {app:notepad} to the process, because the shell eats the inner double quotes on the way
  // through. The failure then surfaces as "Expected property name or '}'", which reads as a
  // malformed request rather than a quoting problem, and costs a debugging round every time.
  // key=value has no quotes to lose, so the common case cannot be broken by the shell.
  let body
  if (json !== undefined && !json.trim().startsWith('{')) {
    body = {}
    for (const pair of process.argv.slice(4)) {
      const eq = pair.indexOf('=')
      if (eq < 0) continue
      const k = pair.slice(0, eq)
      const v = pair.slice(eq + 1)
      // Booleans matter here and were wrong for a long time.
      //
      // The host reads its modifier with a literal `body.IndexOf("\"ctrl\":true")` - it looks for
      // the JSON token `true`, not for the six-character string "true". Passing this helper
      // `ctrl=true` therefore produced `{"ctrl":"true"}`, the host did not find what it was
      // looking for, and sent a BARE "W" instead of Ctrl+W. The request came back `ok: true`,
      // so every caller recorded success while typing an unshifted W into whatever window was
      // focused - and a window that was supposed to be closing instead showed up modified.
      //
      // A test harness that reports success while doing the wrong thing is worse than no
      // harness, because it is believed. Numbers and booleans are converted; everything else is
      // left as a string, and `stringify` puts quotes around it.
      if (v === 'true') body[k] = true
      else if (v === 'false') body[k] = false
      else if (/^-?\d+(\.\d+)?$/.test(v)) body[k] = Number(v)
      else body[k] = v
    }
  } else if (json !== undefined) {
    try {
      body = JSON.parse(json)
    } catch (e) {
      console.error(`the JSON body did not parse: ${e.message}`)
      console.error('from PowerShell, pass key=value pairs instead, e.g. ... post /launch app=notepad')
      process.exit(2)
    }
  }

  try {
    const r = await call(method.toLowerCase() === 'post' ? 'POST' : 'GET', path, body)
    console.log(JSON.stringify(r.json ?? r.text, null, 2))
  } catch (e) {
    console.error(`host call failed: ${e.message}`)
    process.exit(1)
  }
}