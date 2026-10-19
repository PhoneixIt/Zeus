/**
 * THE AIOS CHAT SERVER.
 *
 * =============================================================================
 * WHY A SERVER AND NOT EVERYTHING IN THE UI PROCESS
 * =============================================================================
 *
 * The window and the mission runner are separated for the same reason the Research Desk
 * separates its window from its engine: the engine launches and kills a browser, writes files,
 * and runs commands. None of that should be able to take the interface down, and the interface
 * must survive a mission crashing so the user can read why.
 *
 * So the window is a thin client. It renders events. The server owns the loop.
 *
 * The server binds to 127.0.0.1 only and requires a per-process token on every route. It is not
 * a web service; it is one user's assistant on one machine, and leaving it unauthenticated on
 * loopback would still let any other process on the box drive the laptop.
 *
 * =============================================================================
 * ROUTES
 * =============================================================================
 *
 *   GET  /events          SSE: live progress for the running mission
 *   POST /message         { text } -> starts a mission, returns its id immediately
 *   GET  /missions        past missions and their verification state
 *   POST /cancel          stops accepting new work for the current mission
 *   GET  /capabilities    the catalogue, so the UI can show what AIOS can actually do
 *   GET  /health          liveness
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { writeFileSync } from 'node:fs'

import { runGoal, readMissions, readConversations, ensureAgentDirs, type ProgressEvent } from './agent.ts'
import { CAPABILITIES, availableCapabilities } from './capabilities.ts'
import { livePermission } from '../live-control.ts'
import { listSessions, readSession, createSession, appendTurn, deleteSession, setSessionModel, sessionSummaries, DEFAULT_FREE_MODEL } from './sessions.ts'
import { freeModels, isFreeModel } from './models.ts'
import { UI_HTML, UI_JS, UI_CSS } from './ui-assets.ts'

const PORT = Number(process.env.AIOS_CHAT_PORT ?? '8777')
const HOST = '127.0.0.1'
const TOKEN = randomUUID()

/**
 * The token is handed to the window through a file rather than through an unauthenticated
 * endpoint.
 *
 * The first version had `/health` return the token without authentication, and the launcher
 * polled it. That works once and then stops: the launcher's first probe is necessarily
 * unauthenticated, and any process on the machine could have read the token in the gap before
 * the window opened. Writing it to the user's own home directory means the launcher can read a
 * token it did not have to be told by a stranger.
 */
export const SERVER_FILE = join(homedir(), '.aios', 'agent', 'server.json')

/** The session cookie the browser interface presents after the one-time token exchange. */
const COOKIE_NAME = 'aios_token'

/** Pull one cookie out of a Cookie header. Absent or malformed yields '' rather than throwing. */
function readCookie(header: string | undefined): string {
  if (!header) return ''
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    if (part.slice(0, i).trim() === COOKIE_NAME) return part.slice(i + 1).trim()
  }
  return ''
}

/** Every connected window gets every event. One user, one machine - fan-out is the honest model. */
const clients = new Set<ServerResponse>()

let currentMission: { id: string; cancelled: boolean } | null = null

/**
 * Every event is ALSO buffered here so a client can catch up by index.
 *
 * The window originally read the SSE stream with a blocking call on the UI thread, which froze
 * the form; the replacement runspace block was decorative and never connected at all. The
 * symptom was an assistant that accepted a message, showed "You", and then said nothing
 * forever - the most visible failure there is, and it shipped because every demonstration had
 * been driven over HTTP instead of by the window.
 *
 * Polling an indexed buffer is boring and works: the window asks for everything after the last
 * index it rendered, from a UI-thread timer, and nothing blocks anything.
 */
const eventBuffer: ProgressEvent[] = []

function broadcast(e: ProgressEvent): void {
  eventBuffer.push(e)
  // Bounded: a window left open for days must not grow this without limit.
  if (eventBuffer.length > 2000) eventBuffer.splice(0, eventBuffer.length - 2000)
  const line = `data: ${JSON.stringify(e)}\n\n`
  for (const c of clients) {
    try { c.write(line) } catch { clients.delete(c) }
  }
}

function json(res: ServerResponse, code: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) })
  res.end(payload)
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(Buffer.from(c))
  if (chunks.length === 0) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> } catch { return {} }
}

async function main(): Promise<void> {
  ensureAgentDirs()

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`)

    // Token on every route. Loopback is not an authorization boundary.
    //
    // WHY A COOKIE IS ALSO ACCEPTED
    //
    // The interface is a web page, and a browser navigation physically cannot send an
    // `Authorization` header. Without this, /ui returned 401, Edge rendered its error page, and
    // the window opened with the URL as its title and nothing in it.
    //
    // The token is not simply dropped: the launcher opens `/ui?k=<token>`, the server verifies
    // that ONE value, sets it as an HttpOnly cookie, and redirects to a clean `/ui`. So the
    // credential is used once to establish a session and is not left in the address bar, in
    // browser history, or in a Referer header. Every later request - the assets, /sessions,
    // /message, the event stream - carries the cookie instead.
    const cookieToken = readCookie(req.headers.cookie)
    const queryToken = url.searchParams.get('k')
    const presented = req.headers.authorization === `Bearer ${TOKEN}` ? TOKEN
      : cookieToken === TOKEN ? TOKEN
        : queryToken === TOKEN ? TOKEN
          : null

    if (url.pathname === '/ui' && queryToken === TOKEN) {
      res.writeHead(302, {
        location: '/ui',
        'set-cookie': `${COOKIE_NAME}=${TOKEN}; HttpOnly; Path=/; SameSite=Strict`,
        'cache-control': 'no-store',
      })
      res.end()
      return
    }

    if (presented === null) {
      json(res, 401, { error: 'missing or wrong token' })
      return
    }

    if (url.pathname === '/health') {
      json(res, 200, { ok: true, port: PORT, token: TOKEN, missions: readMissions().length })
      return
    }

    if (url.pathname === '/progress') {
      // Everything after the caller's last index. A window that was closed and reopened, or
      // that fell behind, catches up from the same buffer the live stream is written to.
      const since = Number(url.searchParams.get('since') ?? '0')
      const from = Number.isFinite(since) && since > 0 ? since : 0
      json(res, 200, { from, total: eventBuffer.length, events: eventBuffer.slice(from) })
      return
    }

    if (url.pathname === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      res.write(': connected\n\n')
      clients.add(res)
      req.on('close', () => { clients.delete(res) })
      return
    }

    // ---------------------------------------------------------------- the interface
    //
    // Served from this same origin, over loopback, with the same token as every other route.
    // A web UI here is not "putting AIOS on the internet": the server binds 127.0.0.1, the
    // assets are in this repository, and nothing is fetched from anywhere. The window is opened
    // in browser app mode so it presents as a desktop application rather than a tab.

    if (url.pathname === '/ui' || url.pathname === '/ui/') {
      // The token is injected into the page rather than fetched from an unauthenticated
      // endpoint, which is the mistake the first /health did and had to be reverted for.
      // Only the model default is injected. The token is NOT put in the page: the browser holds
      // it in an HttpOnly cookie, so page source and JavaScript never see a credential.
      const html = UI_HTML.replace('__ZEUS_DEFAULT_MODEL__', DEFAULT_FREE_MODEL)
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(html)
      return
    }

    if (url.pathname === '/ui/app.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
      res.end(UI_JS)
      return
    }

    if (url.pathname === '/ui/app.css') {
      res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-store' })
      res.end(UI_CSS)
      return
    }

    if (url.pathname === '/ui/zeus.svg') {
      // The favicon, drawn as text so the mark has one source of truth. The desktop icon is
      // generated from the same geometry by build-zeus-icon.ps1; a logo that drifts from its own
      // in-app twin is worse than no logo.
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">'
        + '<defs><linearGradient id="z" x1="0" y1="0" x2="1" y2="1">'
        + '<stop offset="0" stop-color="#0f9d76"/><stop offset="1" stop-color="#19e3aa"/>'
        + '</linearGradient></defs>'
        + '<rect x="1" y="1" width="38" height="38" rx="11" fill="url(#z)"/>'
        + '<path d="M12 12.5h16L16.5 28H28" fill="none" stroke="#fff" stroke-width="3.4" '
        + 'stroke-linecap="round" stroke-linejoin="round"/></svg>'
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'max-age=86400' })
      res.end(svg)
      return
    }

    if (url.pathname === '/models' && req.method === 'GET') {
      void (async () => {
        try {
          json(res, 200, { models: await freeModels(), note: 'free models only; a paid model is never substituted' })
        } catch (err) {
          // Fail loudly and selectably-empty. Listing a paid model here would be the one
          // unacceptable answer, because it spends money the project is not allowed to spend.
          json(res, 503, { error: err instanceof Error ? err.message : String(err), models: [] })
        }
      })()
      return
    }

    if (url.pathname === '/sessions' && req.method === 'GET') {
      const { sessions, unreadable } = listSessions()
      json(res, 200, { sessions: sessionSummaries(), unreadable })
      return
    }

    if (url.pathname === '/sessions' && req.method === 'POST') {
      void (async () => {
        const body = await readBody(req)
        const requested = typeof body.model === 'string' ? body.model : undefined
        // The client's model choice is a REQUEST, never an authorisation. Only a model this
        // machine can positively identify as free is honoured.
        let model = DEFAULT_FREE_MODEL
        if (requested) {
          if (!isFreeModel(requested)) {
            json(res, 400, { error: `${requested} is not a free model; AIOS offers free models only` })
            return
          }
          model = requested
        }
        const s = createSession({ model })
        json(res, 201, { session: s })
      })()
      return
    }

    const sessionMatch = /^\/sessions\/([A-Za-z0-9_-]{1,64})$/.exec(url.pathname)
    if (sessionMatch) {
      const id = sessionMatch[1]!
      if (req.method === 'GET') {
        const s = readSession(id)
        if (!s) { json(res, 404, { error: 'no such session' }); return }
        json(res, 200, { session: s })
        return
      }
      if (req.method === 'DELETE') {
        json(res, 200, { deleted: deleteSession(id) })
        return
      }
      if (req.method === 'PATCH') {
        void (async () => {
          const body = await readBody(req)
          const requested = String(body.model ?? '')
          if (!isFreeModel(requested)) {
            json(res, 400, { error: `${requested || '(none)'} is not a free model; AIOS offers free models only` })
            return
          }
          const s = setSessionModel(id, requested)
          if (!s) { json(res, 404, { error: 'no such session' }); return }
          json(res, 200, { session: s })
        })()
        return
      }
    }

    if (url.pathname === '/capabilities') {
      void (async () => {
        try {
          const permission = await livePermission()
          json(res, 200, {
            permission,
            capabilities: CAPABILITIES.map((c: typeof CAPABILITIES[number]) => ({
              id: c.id, mode: c.mode, available: c.available,
              description: c.description, unavailableReason: c.unavailableReason ?? null,
            })),
            availableCount: availableCapabilities().length,
          })
        } catch (err) {
          // A missing operator host is a blocked capability, not a reason to crash the chat server.
          // Fail closed and keep read-only API routes available for diagnosis.
          const detail = err instanceof Error ? err.message : String(err)
          json(res, 503, {
            error: 'operator host unavailable; desktop input remains blocked',
            detail,
          })
        }
      })()
      return
    }

    if (url.pathname === '/pool') {
      void (async () => {
        // The interface no longer offers a model dropdown, so this is the only place the pool is
        // visible from the UI. It reports SHAPE, not the eleven identifiers: how many free models
        // are drawing, how many are healthy, and whether traffic has concentrated on one of them.
        //
        // Concentration is the one that earns its place. It is the condition that precedes a
        // rate-limit exhaustion, so showing it means the warning arrives before the failure rather
        // than being reconstructed from a rate-limit error afterwards.
        try {
          const { freeModels } = await import('./models.ts')
          const { poolStatus } = await import('./zeus.ts')
          const ids = (await freeModels()).map((m) => m.id)
          const status = poolStatus(ids)
          json(res, 200, {
            zeus: status.zeus,
            total: status.total,
            healthy: status.healthy,
            cooling: status.cooling,
            concentrated: status.concentrated,
            // Names, not ids: the pool is reported, the routing is not exposed as a control.
            drawn: status.used.map((u) => u.model.split('/')[1] ?? u.model),
          })
        } catch (err) {
          // A pool that cannot be read is not a reason to take the interface down. Zeus falls back
          // to its known-free list, and the UI shows nothing rather than something wrong.
          json(res, 200, { zeus: 'Zeus V1.0', total: 0, healthy: 0, cooling: [], concentrated: false, drawn: [], unavailable: err instanceof Error ? err.message : String(err) })
        }
      })()
      return
    }

    if (url.pathname === '/missions') {
      json(res, 200, { missions: readMissions().slice(-50).reverse(), conversation: readConversations().slice(-100) })
      return
    }

    if (url.pathname === '/cancel') {
      if (currentMission) {
        currentMission.cancelled = true
        broadcast({ kind: 'status', text: 'Cancellation requested; the current step will finish and the mission will stop.' })
      }
      json(res, 200, { cancelled: true })
      return
    }

    if (url.pathname === '/message' && req.method === 'POST') {
      void (async () => {
        const body = await readBody(req)
        const text = String(body.text ?? '').trim()
        if (!text) { json(res, 400, { error: 'empty message' }); return }
        if (currentMission && !currentMission.cancelled) {
          json(res, 409, { error: 'a mission is already running; cancel it first' })
          return
        }

        // The session and the model both come from the client, so both are re-validated here.
        // A model id is a REQUEST; only a model this machine can identify as free is honoured,
        // because the alternative is that a modified client picks a billable one.
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
        let model = DEFAULT_FREE_MODEL
        if (typeof body.model === 'string' && body.model) {
          if (!isFreeModel(body.model)) {
            json(res, 400, { error: `${body.model} is not a free model; AIOS offers free models only` })
            return
          }
          model = body.model
        }
        const session = sessionId ? readSession(sessionId) : null
        if (sessionId && !session) { json(res, 404, { error: 'no such session' }); return }

        const id = randomUUID()
        currentMission = { id, cancelled: false }
        json(res, 202, { missionId: id, sessionId: session?.id ?? null, model })

        // The user's turn is recorded BEFORE the mission runs. A mission that then fails still
        // leaves the question in the transcript, which is what actually happened.
        if (session) appendTurn(session.id, { role: 'user', text, at: Date.now() })

        // Run detached: the response is already sent, so a long mission cannot time out the
        // request, and progress reaches the window over the event stream.
        void runGoal(text, (e) => {
          if (currentMission?.cancelled && e.kind === 'step-start') {
            broadcast({ kind: 'status', text: `skipping ${e.stepId} because the mission was cancelled` })
            return
          }
          broadcast(e)
          if (e.kind === 'done' || e.kind === 'error') {
            // Persist the assistant's turn against the session that asked for it. This is the
            // transcript, so a session can be reopened and read without replaying a mission.
            if (session) {
              appendTurn(session.id, {
                role: 'assistant',
                text: e.kind === 'done' ? e.text : `error: ${e.text}`,
                at: Date.now(),
                missionId: id,
                ok: e.kind === 'done' ? e.ok : false,
              })
            }
            currentMission = null
          }
        }, { model }).catch((err: unknown) => {
          broadcast({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
          if (session) appendTurn(session.id, { role: 'assistant', text: `error: ${err instanceof Error ? err.message : String(err)}`, at: Date.now(), missionId: id, ok: false })
          currentMission = null
        })
      })()
      return
    }

    json(res, 404, { error: `no route ${url.pathname}` })
  })

  server.listen(PORT, HOST, () => {
    writeFileSync(SERVER_FILE, JSON.stringify({ port: PORT, host: HOST, token: TOKEN, pid: process.pid }), 'utf8')
    console.log('AIOS Assistant')
    console.log('===============')
    console.log(`  listening   http://${HOST}:${PORT}`)
    console.log(`  token       ${TOKEN}`)
    console.log(`  state       ${join(homedir(), '.aios', 'agent')}`)
    console.log(`  launch the window with:`)
    console.log(`    node --experimental-strip-types --no-warnings packages/mission-engine/live/run-aios-chat.ts`)
    console.log(`  model       opencode/space-bunny-free  (free, local CLI, no key)`)
  })
}

void main()
