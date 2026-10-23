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
 *   GET  /recovery        unsettled missions from previous sessions (read-only; nothing is re-run)
 *   POST /recover         { missionId } -> settle ONE interrupted mission as a FRESH governed run;
 *                         the interrupted chain durably names that run (the settlement cross-link)
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

import { runGoal, readMissions, readConversations, ensureAgentDirs, AGENT_ROOT, type ProgressEvent, type GoalResult } from './agent.ts'
import { CAPABILITIES, availableCapabilities } from './capabilities.ts'
import { ApprovalStore } from '../../../governance/approval.ts'
import { DurableStore } from '../../../persistence/store.ts'
import { StoreRecorder } from '../../../persistence/recorder.ts'
import { matchOutstanding, isCompleteTarget } from './approval-route.ts'
// STAGE C - the recovery READ side: enumerate what a previous session left unsettled, say it
// in words, and settle one only as a fresh governed run. Policy lives in recovery-report.ts
// (testable without a server, the same split /approve has with approval-route.ts).
import { listObligations, obligationNotice, composeResume, noteRecoveryAccepted, noteRecoveryCarried } from './recovery-report.ts'
import { livePermission } from '../live-control.ts'
import { listSessions, readSession, createSession, deleteSession, setSessionModel, sessionSummaries, pruneSessions, recordTurn, DEFAULT_FREE_MODEL, type ChatSession } from './sessions.ts'
import { recordConversationTurn, resolveFollowUp, isConversationRecall } from './session-history.ts'
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

/**
 * The mission currently running, if any.
 *
 * `controller` is the REAL cancellation, threaded into `runGoal`: its signal reaches the model
 * child process (killed mid-call) and the executor (halts before the next step). The old shape
 * carried a `cancelled` flag that only suppressed future step-start EVENTS - the model kept
 * thinking and the executor kept running while the window said "cancelled".
 *
 * `approvals` is THIS mission's authority over consequential steps - one store per run, never
 * shared, so an authorisation can neither carry into the next mission nor be decided against a
 * request nobody made. It is also what `/approve` writes to: the executor's gate polls this
 * exact instance, so a decision here is the thing that unblocks a waiting step.
 */
let currentMission: {
  id: string
  state: 'running' | 'cancelling'
  controller: AbortController
  approvals: ApprovalStore
} | null = null

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

/**
 * THE DETACHED MISSION RUN - ONE shape for every entry point.
 *
 * `/message` (a fresh request) and `/recover` (settling an interrupted mission) both start
 * their run through this block, because the parts moved into it are subtle and must not fork
 * between two routes that only look alike: the mine-guard that keeps a replaced zombie's
 * terminal event from repainting the new mission's state, the terminal-pair exception that
 * lets a live failure keep its summary bubble, and the single transcript append that used to
 * run once per terminal event and write TWO assistant turns per failure.
 *
 * The body moved here verbatim from `/message` when Stage C added the second caller;
 * `/message`'s behaviour is unchanged, and both routes are exercised live.
 */
function startMissionRun(args: {
  readonly id: string
  readonly text: string
  readonly session: ChatSession | null
  readonly model: string
  readonly controller: AbortController
  readonly approvals: ApprovalStore
  readonly recorder: StoreRecorder
  /**
   * STAGE D: the interrupted chain this run was started to carry, by a human's `/recover`.
   *
   * When present, the run's END is written back onto that chain as the settlement
   * cross-link (`noteRecoveryCarried`): the old chain learns runGoal's internal ledger id -
   * which exists only inside the run - and how it ended. Absent on `/message`, whose runs
   * carry nothing, so the two routes stay the same block with one optional fact.
   */
  readonly carriesMissionId?: string
}): void {
  const { id, text, session, model, controller, approvals, recorder, carriesMissionId } = args

  // Run detached: the response is already sent, so a long mission cannot time out the
  // request, and progress reaches the window over the event stream.
  let ended = false
  let endedAsMine = false
  void runGoal(text, (e) => {
    // Events belong to the mission that produced them. When a cancelled mission has been
    // replaced, the old run's events still reach its own transcript but no longer reach
    // the window - otherwise a zombie's terminal event would repaint the state the new
    // mission just set.
    const mine = currentMission?.id === id
    const final = e.kind === 'done' || e.kind === 'error'
    // The exception to the id-guard is the SECOND half of runGoal's terminal pair: its
    // failure path emits `error` and then `done`, and the window has always rendered both.
    // The second one is let through only when the first one was, so a live failure keeps
    // its summary bubble while a replaced zombie stays fully silent.
    if (mine || (endedAsMine && final)) broadcast(e)
    if (final && !ended) {
      ended = true
      endedAsMine = mine
      // Persist the assistant's turn ONCE, against the session that asked for it. The old
      // code appended for every terminal event, so every failed mission wrote TWO
      // assistant turns into the same transcript - the error and the "could not run"
      // summary of the same error.
      if (session) {
        // The transcript write is REPORTED, not assumed. A failure here must not become a
        // silent "saved" - the answer already reached the window, so the honest thing is to
        // say that the transcript did not.
        const saved = recordTurn(session.id, {
          role: 'assistant',
          text: e.kind === 'done' ? e.text : `error: ${e.text}`,
          at: Date.now(),
          missionId: id,
          ok: e.kind === 'done' ? e.ok : false,
        })
        if (!saved.ok) {
          broadcast({
            kind: 'status',
            text: `The answer was shown, but it could not be saved to this conversation (${saved.error}). `
              + 'A restart will not restore this turn.',
          })
        }
      }
      if (mine) {
        // Terminal state, decided from what actually happened rather than from the event
        // kind alone: a done carrying `cancelled:true`, or any outcome produced after this
        // run's controller was aborted, is CANCELLED - not a failure the person caused.
        const terminal: 'completed' | 'cancelled' | 'failed' =
          e.kind === 'done' && e.ok ? 'completed'
            : controller.signal.aborted || (e.kind === 'done' && e.cancelled === true) ? 'cancelled'
              : 'failed'
        broadcast({ kind: 'mission-state', state: terminal })
        currentMission = null
      }
    }
  }, { model, signal: controller.signal, approvals, recorder,
    ...(session ? { sessionId: session.id } : {}) }).then((result: GoalResult) => {
    // STAGE D - THE SETTLEMENT CROSS-LINK, CARRIED SIDE. The run has ended; this is the
    // first moment runGoal's INTERNAL ledger id exists outside the run, and it is reported
    // back onto the interrupted chain the human's `/recover` named - the honest solve for
    // "the 202 route id is not a ledger id". A write that fails here may not repaint a run
    // that already ended: it is announced to the window, and the old chain simply stays
    // without a link rather than with a wrong one.
    //
    // The note's STATE comes from the run's own result, never from the event stream. The
    // stream's terminal pair fires for whatever terminal event arrives first, and a run
    // that fails an attempt and succeeds on a retry emits a failure pair MID-RUN: reading
    // the end off the stream recorded "ended failed" for a run the ledger then recorded
    // complete (measured live, Stage D demo, run 8114cf42 - attempt 1's GUI step failed,
    // attempt 2 verified the objective). The result is the run's verdict; the events are
    // the window's scrollback.
    if (!carriesMissionId) return
    try {
      noteRecoveryCarried(recorder, carriesMissionId, {
        routeId: id,
        ledgerMissionId: result.missionId ?? null,
        state: result.cancelled === true || controller.signal.aborted
          ? 'cancelled'
          : result.ok ? 'completed' : 'failed',
        ok: result.ok === true,
      })
    } catch (err) {
      broadcast({
        kind: 'status',
        text: `The run ended, but its settlement cross-link could not be written to mission `
          + `${carriesMissionId.slice(0, 8)} (${err instanceof Error ? err.message : String(err)}). `
          + 'That chain does not name this run; the record itself is unaffected.',
      })
    }
  }).catch((err: unknown) => {
    const mine = currentMission?.id === id
    const msg = err instanceof Error ? err.message : String(err)
    if (mine) broadcast({ kind: 'error', text: msg })
    if (!ended && session) {
      const saved = recordTurn(session.id, { role: 'assistant', text: `error: ${msg}`, at: Date.now(), missionId: id, ok: false })
      if (!saved.ok) {
        broadcast({
          kind: 'status',
          text: `The error was shown, but it could not be saved to this conversation (${saved.error}).`,
        })
      }
    }
    if (mine) {
      broadcast({ kind: 'mission-state', state: controller.signal.aborted ? 'cancelled' : 'failed' })
      currentMission = null
    }
    // The cross-link still tells the truth about this end - runGoal rejects only when it
    // could not produce a result at all, so there is no ledger identity to name, and the
    // note says exactly that instead of pointing at an id that does not exist. A failure
    // to write even that is swallowed here because this handler is already reporting the
    // run's own failure; the old chain keeps its accepted-side note and nothing false.
    if (carriesMissionId) {
      try {
        noteRecoveryCarried(recorder, carriesMissionId, {
          routeId: id,
          ledgerMissionId: null,
          state: controller.signal.aborted ? 'cancelled' : 'failed',
          ok: false,
        })
      } catch { /* announced above; the interrupted chain stays honest either way */ }
    }
  })
}

async function main(): Promise<void> {
  ensureAgentDirs()

  // RETENTION, APPLIED ONCE AT STARTUP. The policy is documented in sessions.ts: at most 500
  // conversations, and nothing untouched for 90 days. It is reported, not silently performed.
  const pruned = pruneSessions()
  if (pruned.deleted > 0) {
    console.log(`  retention   ${pruned.deleted} old conversation(s) removed; ${pruned.kept} kept`)
  }
  for (const e of pruned.errors) console.log(`  retention   could not remove ${e}`)

  // STAGE B - THE WRITE-AHEAD LEDGER for every mission the chat runs.
  //
  // One store, one recorder, one session for this server's whole lifetime: the durable history
  // of what the machine was asked to do and what it actually did lives in ONE place, so a
  // recovery read sees the whole story rather than a per-mission fragment. Built HERE rather
  // than inside runGoal because the store owns that history; the recorder stays optional on
  // runGoal's side (see InterpretOptions), so this is the production path opting in, not the
  // engine silently inventing a ledger.
  //
  // The store REFUSES TO START when the database cannot be opened or is not writable, and so
  // does this server. A chat server whose missions could not be recorded would run work no
  // recovery pass could ever account for - the exact failure the persistence layer exists to
  // prevent. The launcher reports the startup failure with the store's own reason.
  const store = new DurableStore({ path: join(AGENT_ROOT, 'aios.db') })
  const recorder = new StoreRecorder(store)

  // STAGE C - SURFACE WHAT A PREVIOUS SESSION OWED, THE MOMENT THIS ONE STARTS.
  //
  // The ledger's whole purpose is that a crash is ACCOUNTED FOR rather than mysterious: a
  // step killed between its write-ahead intent and its outcome left a durably recorded
  // ATTEMPT whose result is unknown - it may or may not have reached the machine. That is
  // exactly the fact a human must see before repeating anything, so it is spoken here,
  // loudly, rather than left for someone to discover in a database.
  //
  // SURFACING IS READ-ONLY (listObligations suppresses the recovery side-effect): an
  // obligation is REPORTED, never settled, and never becomes authority for the runs that
  // follow. The window receives this through the event buffer - a window opened later
  // catches up via /progress - and the machine-readable record is GET /recovery. The
  // settlement channel is POST /recover, and it belongs to the person, not to startup.
  const obligations = listObligations(store)
  if (obligations.length > 0) {
    const notice = obligationNotice(obligations)
    broadcast({ kind: 'status', text: notice })
    // No credential appears here; this stdout is redirected to the launcher log.
    console.log(notice)
  }

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
      // The token is deliberately NOT in this response - even though every caller here has
      // already authenticated to receive it. A credential that appears in a response body
      // travels to whatever logs or scrapes the caller's output, and both existing consumers
      // (`launch-aos.ps1`'s readiness check and `run-aios-chat.ts`'s liveness probe) read only
      // `ok`. The FILE is the token handoff channel, and it is announced by path at listen
      // time, never by value in anything a tool might store.
      json(res, 200, { ok: true, port: PORT, missions: readMissions().length })
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

    // STAGE C - THE OBLIGATION LIST, READ-ONLY.
    //
    // What a previous session left unsettled, as facts: the mission, its objective, the
    // steps with a durable attempt and no outcome. Asking this route PERFORMS no recovery
    // and settles nothing - it is the window (or a person with curl) reading the record
    // before deciding anything.
    if (url.pathname === '/recovery' && req.method === 'GET') {
      const obs = listObligations(store)
      json(res, 200, { obligations: obs, notice: obligationNotice(obs) })
      return
    }

    if (url.pathname === '/cancel') {
      if (currentMission && currentMission.state === 'running') {
        currentMission.state = 'cancelling'
        // THE REAL THING. This aborts the per-mission AbortController, whose signal is threaded
        // through runGoal into the model child (killed mid-call) and into the executor (halts
        // before the next step). The old handler only flipped a flag that hid later step-start
        // events - the mission kept running while the window said "cancelled".
        currentMission.controller.abort()
        broadcast({ kind: 'mission-state', state: 'cancelling' })
        broadcast({ kind: 'status', text: 'Cancellation requested: the model call is being killed or the next step will not start. Steps that already ran are kept and reported.' })
      }
      json(res, 200, { cancelled: currentMission !== null, state: currentMission?.state ?? 'idle' })
      return
    }

    // THE DECISION CHANNEL.
    //
    // The executor's gate records a request, emits it to the window (Approve/Reject), and waits
    // by polling this mission's store. This route is the ONLY writer of decisions, and it never
    // builds a key from scratch: it finds the exact outstanding request the executor made and
    // hands THAT key to `decide()`, which refuses anything it never asked for. So the worst a
    // hostile or broken client can do is fail to approve - requests cannot be invented, and a
    // target that matches no request gets 404 rather than a decision that applies to something.
    if (url.pathname === '/approve' && req.method === 'POST') {
      void (async () => {
        const body = await readBody(req)
        const stepId = String(body.stepId ?? '')
        const kind = String(body.kind ?? '')
        const target = String(body.target ?? '')
        const decision = String(body.decision ?? '')
        if (decision !== 'approved' && decision !== 'rejected') {
          json(res, 400, { error: "decision must be exactly 'approved' or 'rejected'" })
          return
        }
        if (!isCompleteTarget({ stepId, kind, target })) {
          json(res, 400, { error: 'stepId, kind and target are required; a partial key is not a request' })
          return
        }
        if (!currentMission || currentMission.state !== 'running') {
          json(res, 409, {
            error: 'no mission is waiting on an authorisation',
            state: currentMission?.state ?? 'idle',
          })
          return
        }
        // The match itself is the pure, tested part (approval-route.ts): EXACT MATCH OR NOTHING,
        // and ambiguity is a refusal rather than a coin flip. A request already decided is not
        // outstanding, so a double-click finds nothing here instead of deciding twice.
        const outcome = matchOutstanding(currentMission.approvals.outstanding(), { stepId, kind, target })
        if (outcome.kind === 'not-found') {
          json(res, 404, { error: 'no outstanding authorisation request matches that step, kind and target' })
          return
        }
        if (outcome.kind === 'ambiguous') {
          json(res, 409, { error: `${outcome.count} outstanding requests match; refusing to guess which one was decided` })
          return
        }
        const key = outcome.request.key
        try {
          const a = currentMission.approvals.decide(key, decision, 'the operator at the window', Date.now())
          broadcast({
            kind: 'status',
            text: `Authorisation ${decision} for ${key.kind} on ${key.target}: recorded against the `
              + 'exact request this mission made. Nothing can act on it but this mission, this step.',
          })
          json(res, 200, { recorded: true, state: a.state })
        } catch (e) {
          // decide() throws for a key that was never requested - the store's own invariant,
          // surfaced as a refusal rather than as a silent no-op.
          json(res, 409, { error: e instanceof Error ? e.message : String(e) })
        }
      })()
      return
    }

    // STAGE C - THE SETTLEMENT CHANNEL.
    //
    // An interrupted mission is NEVER resumed by the server on its own: a persisted row is
    // a record, never an authorisation, and a crash must not become a way to obtain
    // authority. This route is the human's explicit act, and it is shaped like /approve on
    // purpose - the exact mission id or a refusal, never a guess.
    //
    // What a "resume" RUNS is a FRESH mission through the same governed pipeline as
    // /message: fresh controller, fresh approval store, fresh write-ahead chain, and a
    // planner that re-plans from a RECOVERY BRIEF (composeResume) which states what the
    // ledger knows - an action recorded as ATTEMPTED whose outcome is unknown - and that
    // the record authorises nothing. Nothing of the old chain is executed; every guard,
    // approval and verification of the ordinary path applies to the new run unchanged.
    if (url.pathname === '/recover' && req.method === 'POST') {
      void (async () => {
        const body = await readBody(req)
        const missionId = String(body.missionId ?? '').trim()
        if (!missionId) {
          json(res, 400, { error: 'missionId is required; a recovery names the exact mission it settles' })
          return
        }
        if (currentMission && currentMission.state === 'running') {
          json(res, 409, { error: 'a mission is already running; cancel it first', state: currentMission.state })
          return
        }
        // The pure policy (recovery-report.ts): refuse unknown, already-settled and
        // quarantined missions; otherwise produce the recovery goal for a fresh run. The
        // CONSUMING recovery read happens inside composeResume - only now, because a human
        // asked - so a refused recovery leaves the ledger exactly as it was.
        const decision = composeResume(store, missionId)
        if (decision.kind === 'refuse') {
          json(res, decision.unknown ? 404 : 409, { error: decision.reason })
          return
        }

        // Same model and session validation as /message: a resume is a mission like any
        // other, and a model id remains a REQUEST that only the free-only check can honour.
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
        const controller = new AbortController()
        // A FRESH authority object, exactly as /message builds one: the old mission's
        // approvals died with its process and nothing may carry into this run.
        const approvals = new ApprovalStore()

        // STAGE D - THE SETTLEMENT CROSS-LINK, ACCEPTED SIDE. The interrupted chain is told
        // a fresh run (route `id`) started to carry it BEFORE anything starts: the run's
        // ledger id does not exist yet, and if the process dies in the next moment this
        // note is what the old chain still holds about the recovery that was in flight.
        // If the ledger cannot take even that note, no run starts - the same fail-closed
        // rule Stage B set for a recorder that cannot write.
        try {
          noteRecoveryAccepted(recorder, missionId, id)
        } catch (err) {
          json(res, 500, {
            error: `the ledger could not record this settlement (`
              + `${err instanceof Error ? err.message : String(err)}); recovery not started`,
          })
          return
        }

        currentMission = { id, state: 'running', controller, approvals }
        json(res, 202, {
          missionId: id,
          resumedFrom: missionId,
          sessionId: session?.id ?? null,
          model,
          obligations: decision.obligations,
        })
        broadcast({ kind: 'mission-state', state: 'running' })
        broadcast({ kind: 'status', text: decision.notice })

        if (session) {
          const saved = recordConversationTurn({
            sessionId: session.id,
            role: 'user',
            text: `recover ${missionId}: ${decision.notice}`,
            at: Date.now(),
          })
          if (!saved.ok) {
            broadcast({
              kind: 'status',
              text: `The recovery note could not be saved to this conversation (${saved.error}). `
                + 'The recovery itself continues; its transcript entry is missing.',
            })
          }
        }

        // The same detached run block /message uses, so the two entry points cannot drift.
        // `carriesMissionId` is the settlement cross-link's second half: when this run ends,
        // its internal ledger id is written back onto missionId's chain (Stage D).
        startMissionRun({ id, text: decision.goal, session, model, controller, approvals, recorder, carriesMissionId: missionId })
      })()
      return
    }

    if (url.pathname === '/message' && req.method === 'POST') {
      void (async () => {
        const body = await readBody(req)
        const text = String(body.text ?? '').trim()
        if (!text) { json(res, 400, { error: 'empty message' }); return }
        if (currentMission && currentMission.state === 'running') {
          json(res, 409, { error: 'a mission is already running; cancel it first', state: currentMission.state })
          return
        }
        // A CANCELLING MISSION MAY BE REPLACED - but only as a liveness escape hatch for a run
        // that will not end. The old run's remaining events still reach ITS session transcript
        // (each run's emit closure captures its own session), but they stop reaching the window
        // and the state machine below the moment its id is no longer the current one, so a
        // zombie's terminal event cannot overwrite the new mission's state.
        if (currentMission && currentMission.state === 'cancelling') {
          broadcast({ kind: 'status', text: 'Starting a new mission while the previous one finishes stopping; its last events will still be recorded but no longer shown.' })
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

        // THE USER'S TURN IS PERSISTED BEFORE ANYTHING STARTS, and a failed write STOPS the
        // request. The old order sent 202 first and then wrote to disk, so a failed write was
        // invisible: the window had already been told the message was accepted, and a restart
        // silently lost it.
        if (session) {
          const saved = recordConversationTurn({
            sessionId: session.id,
            role: 'user',
            text,
            at: Date.now(),
          })
          if (!saved.ok) {
            json(res, 500, {
              error: `this message could not be saved to the conversation (${saved.error}); nothing was started`,
            })
            return
          }
        }

        // A QUESTION ABOUT THIS CONVERSATION IS ANSWERED FROM THE RESTORED TRANSCRIPT.
        //
        // "What did I just ask?" has its answer in the persisted turns, not in a new mission.
        // `resolveFollowUp` reads the session back from disk - the same read a fresh process
        // performs - so this path exercises restart recovery, not an in-memory copy. The answer
        // is explicitly non-authoritative: history cannot approve or execute anything.
        if (session && isConversationRecall(text)) {
          const recall = resolveFollowUp(session.id, text)
          json(res, 202, {
            missionId: id,
            sessionId: session.id,
            model,
            conversational: true,
            restoredFromHistory: !recall.missing,
          })
          broadcast({ kind: 'mission-state', state: 'running' })
          broadcast({ kind: 'done', ok: true, text: recall.answer })
          broadcast({ kind: 'mission-state', state: 'completed' })
          const saved = recordConversationTurn({
            sessionId: session.id,
            role: 'assistant',
            text: recall.answer,
            at: Date.now(),
            missionId: id,
            ok: true,
          })
          if (!saved.ok) {
            broadcast({
              kind: 'status',
              text: `The recalled answer was shown, but it could not be saved (${saved.error}).`,
            })
          }
          return
        }

        const controller = new AbortController()
        // The mission's approval authority. Created HERE so the route that starts the mission
        // owns the object `/approve` will write to; a store created inside runGoal would be
        // unreachable to the decision channel and every request would end at needs-human.
        const approvals = new ApprovalStore()
        currentMission = { id, state: 'running', controller, approvals }
        json(res, 202, { missionId: id, sessionId: session?.id ?? null, model })
        broadcast({ kind: 'mission-state', state: 'running' })

        // Run detached: the response is already sent, so a long mission cannot time out the
        // request, and progress reaches the window over the event stream. The block itself is
        // shared with /recover (Stage C) so the two entry points cannot drift apart.
        startMissionRun({ id, text, session, model, controller, approvals, recorder })
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
    // NEVER the token value. This stdout is redirected to launcher.out.log by launch-aos.ps1
    // (`-RedirectStandardOutput`), so a printed token is a live credential persisted in a log
    // file on disk - which is exactly where the mandate forbids it. The token handoff is the
    // SERVER_FILE written on the line above; no consumer needs it from this console.
    console.log(`  token       in ${SERVER_FILE} (not printed: stdout lands in the launcher log)`)
    console.log(`  state       ${join(homedir(), '.aios', 'agent')}`)
    console.log(`  launch the window with:`)
    console.log(`    node --experimental-strip-types --no-warnings packages/mission-engine/live/run-aios-chat.ts`)
    console.log(`  model       opencode/space-bunny-free  (free, local CLI, no key)`)
  })
}

void main()
