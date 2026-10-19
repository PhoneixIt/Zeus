// ===========================================================================================
// aios-client.mjs - talk to AIOS the way its OWN user interface does.
//
// WHY THIS FILE EXISTS
//
// Everything proved so far was driven by running `runGoal` directly from a script. That exercises
// the planner, the executor, the verifier and the operator host - but it BYPASSES the platform:
// the chat server, its authentication, its progress feed, and the browser UI the user actually
// looks at. A system can be perfect underneath and broken on the surface, and none of that would
// have shown up.
//
// So this speaks the real protocol: the one-time token becomes an HttpOnly cookie exactly as it
// does for a browser, and every call afterwards is the endpoint the UI calls. If this works, the
// UI works, because they are the same calls made by the same server.
//
// WHAT IS DELIBERATELY NOT HERE
//
// No shortcuts and no private access. The token exchange, the cookie, the JSON shapes - all of it
// is the platform's, not a harness written to suit. A test client that reached past the platform
// would prove the harness works, which is the opposite of the point.
// ===========================================================================================
import http from 'node:http'
import { readFileSync } from 'node:fs'

const SERVER = 'C:/Users/Samer/.aios/agent/server.json'

function state() {
  return JSON.parse(readFileSync(SERVER, 'utf8'))
}

/** Raw request with a jar, so the cookie set by /ui survives into later calls. */
let cookie = null

function request(method, path, body) {
  const s = state()
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8')
  return new Promise((resolve, reject) => {
    const headers = {}
    if (cookie) headers.cookie = cookie
    if (payload) {
      headers['content-type'] = 'application/json'
      headers['content-length'] = String(payload.length)
    }
    const req = http.request(
      { host: s.host, port: s.port, path, method, headers, timeout: 900_000 },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const set = res.headers['set-cookie']
          if (set) cookie = set.map((c) => c.split(';')[0]).join('; ')
          const text = Buffer.concat(chunks).toString('utf8')
          try { resolve({ status: res.statusCode, json: JSON.parse(text) }) }
          catch { resolve({ status: res.statusCode, text }) }
        })
      },
    )
    req.on('timeout', () => { req.destroy(new Error(`timeout on ${method} ${path}`)) })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

/** Authenticate exactly as the browser does: one-time token in the URL, cookie thereafter. */
export async function signIn() {
  const s = state()
  // The parameter is `k`, and the cookie is `aios_token` - both read out of chat-server.ts rather
  // than guessed. Guessing them produced "the token exchange set no cookie", which is the correct
  // and useful failure: it says the client is wrong, not the server.
  const r = await request('GET', `/ui?k=${encodeURIComponent(s.token)}`)
  if (!cookie) throw new Error('the token exchange set no cookie, so the UI could not authenticate either')
  return r
}

export const get = (p) => request('GET', p)
export const post = (p, body) => request('POST', p, body)

/** The capability catalogue as the USER's assistant sees it - not as a developer reads the source. */
export async function capabilities() {
  await signIn()
  return get('/capabilities')
}

/**
 * Send a goal and follow the mission to completion, printing AIOS's own progress events.
 *
 * The feed is the platform's: `/progress?since=N` is indexed and replayable, which is what the UI
 * renders. Reading it here means what is printed is what the user would have watched happen.
 */
export async function runGoalThroughAios(goal, opts = {}) {
  await signIn()

  // NOTE WHERE THE FEED IS NOW, BEFORE SENDING.
  //
  // `/progress` is a single GLOBAL feed, not a per-mission one. The first version of this client
  // started reading it at `since=0`, so it replayed an EARLIER mission's events and reported
  // "Completed 4 step(s); every step and the objective were independently verified" for a run
  // that had in fact failed at step one. It looked exactly like AIOS succeeding while producing an
  // empty file, which is the worst kind of wrong: the client and the product agreed on a success
  // neither had earned.
  //
  // So the cursor is marked BEFORE the message is sent, and only events after that mark belong to
  // this mission. Failing to do this produces a test rig that reports other runs' results.
  const before = await get('/progress?since=0')
  let cursor = Number.isFinite(before.json?.total) ? before.json.total : 0

  const started = await post('/message', { text: goal, ...(opts.model ? { model: opts.model } : {}) })
  const missionId = started.json?.missionId ?? started.json?.id
  if (!missionId) throw new Error(`the platform accepted the message but returned no mission id: ${JSON.stringify(started.json ?? started.text)}`)

  const seen = []
  for (let tick = 0; tick < 900; tick++) {
    await new Promise((r) => setTimeout(r, 1500))
    const feed = await get(`/progress?since=${cursor}`)
    // The feed is `{ from, total, events }` and the events carry no sequence number, so the cursor
    // has to advance on the FEED's own position. The first version looked for `e.seq`, found
    // nothing, never moved the cursor - and re-printed the same twenty events on every tick until
    // the client timed out, which reads exactly like AIOS looping forever. It was the client.
    const events = feed.json?.events ?? []
    const next = Number.isFinite(feed.json?.total) ? feed.json.total : cursor + events.length
    if (next <= cursor && events.length === 0) continue
    cursor = Math.max(cursor, next)
    for (const e of events) {
      seen.push(e)
      if (e.kind) console.log(`   [${e.kind}] ${(e.text ?? e.intent ?? '').toString().slice(0, 150)}`)
      if (e.kind === 'done') return { missionId, events: seen, done: e }
    }
  }
  throw new Error('the mission did not finish within the time this client was willing to wait')
}

// --- CLI -------------------------------------------------------------------------
if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  const cmd = process.argv[2]
  const goal = process.argv[3]
  try {
    if (cmd === 'caps') {
      await signIn()
      const c = await capabilities()
      const list = c.json?.capabilities ?? c.json ?? []
      console.log(`AIOS reports ${Array.isArray(list) ? list.length : '?'} capabilities:`)
      for (const x of (Array.isArray(list) ? list : [])) {
        console.log(`  - ${x.id ?? x.name}${x.available === false ? '  (currently unavailable)' : ''}`)
      }
    } else if (cmd === 'run' && goal) {
      console.log(`\nGOAL given to AIOS: ${goal}\n`)
      const r = await runGoalThroughAios(goal)
      console.log(`\nAIOS finished: ok=${r.done?.ok}`)
      console.log(r.done?.text ?? '')
    } else {
      console.error('usage: node aios-client.mjs caps | run "<goal>"')
      process.exit(2)
    }
  } catch (e) {
    console.error(`AIOS platform call failed: ${e.message}`)
    process.exit(1)
  }
}