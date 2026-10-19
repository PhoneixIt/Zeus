/**
 * A MINIMAL CHROME DEVTOOLS PROTOCOL CLIENT. No dependencies.
 * =============================================================================
 * WHY THIS FILE EXISTS
 * =============================================================================
 *
 * The browser capability in `operator.mjs` is blocked on ONE thing: the `playwright` npm package,
 * which is neither installed nor declared in `package.json`. Everything the browser needs is
 * already on this machine:
 *
 *   - the Chromium binary        C:/Users/Samer/AppData/Local/ms-playwright/chromium-1243/...
 *   - a CDP endpoint              127.0.0.1:9333, already polled by `cdpAlive()`
 *   - an HTTP client              `fetch`, built into Node
 *   - a WebSocket client          `WebSocket`, built into Node since v22 (verified on v24.21.0)
 *
 * Playwright is, for the surface this project actually uses, a convenience wrapper over CDP. CDP
 * is JSON over a WebSocket. So the wrapper was never load-bearing - it was the ONLY thing standing
 * between the repository and a working browser, and it can be removed for free.
 *
 * =============================================================================
 * THE EXACT SURFACE THIS REPLACES
 * =============================================================================
 *
 * `operator.mjs` uses precisely six things off playwright's object graph. Measured by searching
 * every call site, not assumed:
 *
 *     browser.contexts()[0]      ctx.pages()        ctx.newPage()
 *     page.evaluate(fn, arg)     page.url()         page.title()
 *
 * That is the whole contract. Anything more would be speculative, and speculative surface is how a
 * dependency-free replacement quietly becomes worse than the thing it replaced. `page.goto()` is
 * included because a CDP client without navigation is not a browser client - but note the browser's
 * OWN visible `navigate()` (Ctrl+L, type, Enter) remains the default path, because the user is meant
 * to watch the address bar fill. This is the programmatic alternative, not a replacement for it.
 *
 * =============================================================================
 * WHY THE DEPENDENCIES ARE INJECTED
 * =============================================================================
 *
 * `httpGet` and `openSocket` are parameters, not globals. That is what lets this file be tested
 * offline against a real HTTP server with a scripted socket - no browser, no window, no desktop, no
 * input injection. The alternative (mocking module globals) tests the mock as much as the client.
 *
 * `operator.mjs` passes nothing and gets the real thing.
 */

/** Thrown for every failure this client raises. Carries the CDP error verbatim when there is one. */
export class CdpError extends Error {
  constructor(message, { method, cdp } = {}) {
    super(message)
    this.name = 'CdpError'
    this.method = method
    this.cdp = cdp
  }
}

const DEFAULT_TIMEOUT_MS = 15_000

/**
 * JSON over HTTP against the CDP endpoint. Loopback only, by construction.
 *
 * `/json/new` requires PUT on current Chrome and GET on older builds, so both are attempted. The
 * status code is checked rather than trusted, because a rejected `/json/new` returns 405 with a body
 * that still parses as JSON - a silent-success bug waiting to happen.
 */
async function defaultHttpGet(url, { method = 'GET' } = {}) {
  let res
  try {
    res = await fetch(url, { method })
  } catch (e) {
    // A browser that is not running is the SINGLE most common reason to be here, and raw `fetch`
    // reports it as "fetch failed" - which says nothing about what the caller should do. Earlier this
    // surfaced as an unhandled TypeError; a control that cannot name its own cause cannot be acted on.
    throw new CdpError(`cannot reach the browser at ${url} (${method}): ${e instanceof Error ? e.cause?.message ?? e.message : String(e)}. Is the browser running with --remote-debugging-port?`)
  }
  const body = await res.text()
  let json
  try {
    json = JSON.parse(body)
  } catch {
    throw new CdpError(`${method} ${url} did not return JSON (status ${res.status}): ${body.slice(0, 120)}`)
  }
  if (!res.ok) {
    throw new CdpError(`${method} ${url} failed with status ${res.status}: ${String(json?.message ?? json).slice(0, 160)}`)
  }
  return json
}

/**
 * One CDP connection to one page target.
 *
 * The request/response discipline is the part worth stating: CDP messages carry no correlation id of
 * their own beyond the `id` we assign, and responses can arrive out of order. Every send therefore
 * registers a pending promise BEFORE the frame goes out, and the reader routes purely on `id`.
 */
class Session {
  constructor(socket, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.socket = socket
    this.timeoutMs = timeoutMs
    this.nextId = 1
    this.pending = new Map()
    this.closed = false

    socket.addEventListener('message', (event) => this.#onMessage(String(event.data)))
    socket.addEventListener('close', () => this.#onClose('the CDP socket closed'))
    socket.addEventListener('error', () => this.#onClose('the CDP socket reported an error'))
  }

  #onMessage(raw) {
    let msg
    try {
      msg = JSON.parse(raw)
    } catch {
      return // A frame we cannot parse is not attributable; dropping it beats throwing off the reader.
    }
    const waiter = this.pending.get(msg.id)
    if (!waiter) return // An event, or a late reply to a request already timed out.
    this.pending.delete(msg.id)
    clearTimeout(waiter.timer)
    if (msg.error) {
      waiter.reject(new CdpError(msg.error.message ?? 'CDP returned an error', {
        method: waiter.method,
        cdp: msg.error.data,
      }))
      return
    }
    waiter.resolve(msg.result ?? {})
  }

  #onClose(reason) {
    if (this.closed) return
    this.closed = true
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer)
      waiter.reject(new CdpError(reason, { method: waiter.method }))
    }
    this.pending.clear()
  }

  /** Issue one CDP command and await its reply. Rejects on protocol error, socket close, or timeout. */
  send(method, params = {}) {
    if (this.closed) return Promise.reject(new CdpError(`cannot send ${method}: the CDP socket is closed`, { method }))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new CdpError(`${method} timed out after ${this.timeoutMs}ms`, { method }))
      }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, method, timer })
      try {
        this.socket.send(JSON.stringify({ id, method, params }))
      } catch (e) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(new CdpError(`${method} could not be sent: ${e instanceof Error ? e.message : String(e)}`, { method }))
      }
    })
  }

  close() {
    this.#onClose('the CDP session was closed')
    try {
      this.socket.close()
    } catch { /* already gone */ }
  }
}

/**
 * A page target, exposing the six playwright-shaped methods `operator.mjs` calls.
 *
 * `url` is CACHED, and this is a real limitation worth stating rather than hiding. Playwright's
 * `page.url()` is synchronous, and the one call site (`operator.mjs:402`) relies on that, so this
 * cannot re-query the browser without changing the shape of the caller. It is seeded from the
 * target list and updated by `goto`. The AUTHORITATIVE url is the one read inside the page by
 * `readPage()`, which reads `location.href` from the page itself - so the audit trail that matters
 * does not depend on this cache.
 */
class Page {
  constructor(session, target) {
    this.session = session
    this.targetId = target.id
    this._url = target.url ?? ''
    this._title = target.title ?? ''
  }

  url() { return this._url }

  async title() {
    const { result } = await this.session.send('Runtime.evaluate', {
      expression: 'document.title', returnByValue: true,
    })
    this._title = result?.value ?? ''
    return this._title
  }

  /**
   * Run `fn(arg)` inside the page and bring the result back by value.
   *
   * The function is serialised by source, which is why `arg` must be JSON-serialisable: there is no
   * structured-clone bridge here, and pretending otherwise would fail deep inside the page with an
   * error that says nothing about the cause. Non-serialisable arguments are rejected HERE, loudly.
   *
   * `returnByValue` and `awaitPromise` are both required: without them CDP returns an opaque handle
   * for objects and an unresolved promise for anything async, and the caller would receive
   * `{type:'object'}` where it expected data.
   */
  async evaluate(fn, arg) {
    if (typeof fn !== 'function') throw new CdpError('evaluate() needs a function to run in the page')
    let literal = ''
    if (arg !== undefined) {
      try {
        literal = JSON.stringify(arg)
      } catch {
        throw new CdpError('evaluate() argument is not JSON-serialisable; this client has no structured-clone bridge')
      }
      if (literal === undefined) throw new CdpError('evaluate() argument serialised to undefined')
    }
    const { result, exceptionDetails } = await this.session.send('Runtime.evaluate', {
      expression: `(${fn.toString()})(${literal})`,
      returnByValue: true,
      awaitPromise: true,
    })
    if (exceptionDetails) {
      const d = exceptionDetails
      const text = d.exception?.description ?? d.text ?? 'the page function threw'
      throw new CdpError(`page function threw: ${String(text).split('\n')[0]}`, { method: 'Runtime.evaluate' })
    }
    if (result && result.type === 'undefined') return undefined
    return result?.value
  }

  /** Programmatic navigation. The visible Ctrl+L path in `operator.mjs` remains the default. */
  async goto(url) {
    const { errorText, frameId } = await this.session.send('Page.navigate', { url })
    if (errorText) throw new CdpError(`navigation to ${url} failed: ${errorText}`, { method: 'Page.navigate' })
    this._url = url
    return { frameId }
  }

  /**
   * Wait until the document has finished parsing.
   *
   * `Page.navigate` resolves when the navigation COMMITS, not when the DOM exists. Reading the
   * document immediately returned a 484-byte shell - a <title> and nothing else - for a page
   * that has 29 content elements. Anything that inspects the page must therefore ask for the
   * load state rather than infer it. Returns the state it waited for, so a caller can tell
   * "loaded" from "gave up".
   */
  async waitForLoad(timeoutMs = DEFAULT_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs
    let state = ''
    while (Date.now() < deadline) {
      state = (await this.evaluate(() => document.readyState)) ?? ''
      if (state === 'complete' || state === 'interactive') return state
      await new Promise((r) => setTimeout(r, 150))
    }
    return state
  }

  /**
   * Scroll the window by a number of pixels. A REAL input event through the Input domain, not
   * a JS assignment to scrollTop: the point is to exercise the same path a person's wheel
   * takes, and a scripted assignment would prove nothing about the browser or the page.
   */
  async scroll(deltaY, x = 0, y = 0) {
    await this.session.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x, y, deltaX: 0, deltaY, pointerType: 'mouse',
    })
    return { deltaY }
  }

  /**
   * Click at viewport coordinates. Also a real Input event.
   *
   * What is at the point is sampled BEFORE the click is dispatched. The first version sampled
   * afterwards and reported `<HTML>` for every link: by the time it looked, the click had
   * already navigated, so it was asking the NEW document what used to be there. A read-back
   * taken after the thing it measures has changed measures the wrong thing.
   */
  async clickAt(x, y) {
    const before = await this.evaluate(([px, py]) => {
      const el = document.elementFromPoint(px, py)
      if (!el) return null
      // `elementFromPoint` returns the INNERMOST node, which for a logo link is the <img> -
      // so a click that really hit a link would be reported as clicking an image. The nearest
      // ancestor anchor is what makes the claim meaningful, and both are reported so the
      // caller can see exactly what was there.
      const anchor = el.closest ? el.closest('a[href]') : null
      return {
        tag: el.tagName,
        href: el.getAttribute('href') ?? null,
        text: (el.textContent ?? '').trim().slice(0, 80),
        anchorHref: anchor ? anchor.getAttribute('href') : null,
        anchorText: anchor ? (anchor.textContent ?? '').trim().slice(0, 80) : null,
      }
    }, [x, y])
    await this.session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, pointerType: 'mouse' })
    await this.session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, pointerType: 'mouse' })
    await this.session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, pointerType: 'mouse' })
    return before
  }

  /** Navigate back in history. Returns whether there was anywhere to go back to. */
  async goBack() {
    const before = await this.evaluate(() => window.location.href)
    // `send()` resolves to the CDP result object ITSELF (see `goto`), not a `{result}` wrapper.
    // Reading `{result}` here produced `undefined` and a TypeError on the first real back
    // navigation - which is the one call that only ever runs interactively, so nothing else
    // would have caught it.
    const history = await this.session.send('Page.getNavigationHistory')
    const current = history?.currentIndex ?? 0
    if (current <= 0) return { wentBack: false, from: before }
    const entry = (history.entries ?? [])[current - 1]
    if (!entry) return { wentBack: false, from: before }
    await this.session.send('Page.navigateToHistoryEntry', { entryId: entry.id })
    await this.waitForLoad()
    return { wentBack: true, from: before, to: await this.evaluate(() => window.location.href) }
  }

  close() { this.session.close() }
}

/** The playwright-shaped context: a fixed list of page targets, fetched fresh each time. */
class Context {
  constructor(base, { httpGet, openSocket, timeoutMs }) {
    this.base = base
    this.opts = { httpGet, openSocket, timeoutMs }
    this.sessions = new Set()
  }

  /** Targets of type `page`, fresh from the browser. Extra targets (workers, the GPU process) are excluded. */
  async targets() {
    const list = await this.opts.httpGet(`${this.base}/json/list`)
    if (!Array.isArray(list)) throw new CdpError('the CDP target list was not an array')
    return list.filter((t) => t && t.type === 'page' && t.webSocketDebuggerUrl)
  }

  /** Attach to every current page. Sockets are opened per target, so a closed target does not poison the rest. */
  async pages() {
    const found = await this.targets()
    const out = []
    for (const t of found) {
      try {
        const socket = await this.opts.openSocket(t.webSocketDebuggerUrl, this.opts)
        const session = new Session(socket, this.opts)
        this.sessions.add(session)
        out.push(new Page(session, t))
      } catch (e) {
        // One unattachable target must not fail the whole listing.
        if (!out.length && found.length === 1) throw e
      }
    }
    return out
  }

  /**
   * Open a new page. Uses the browser's own `/json/new`, then re-reads the target list so the
   * returned handle is attached through exactly the same path as every other page - a page acquired
   * by a different route would be a page with different behaviour, which is how this gets confusing.
   */
  async newPage(url = 'about:blank') {
    const endpoint = `${this.base}/json/new?${encodeURIComponent(url)}`
    let created
    try {
      created = await this.opts.httpGet(endpoint, { method: 'PUT' })
    } catch {
      created = await this.opts.httpGet(endpoint, { method: 'GET' })
    }
    if (!created?.webSocketDebuggerUrl) throw new CdpError(`the browser did not report a usable new page for ${url}`)
    const socket = await this.opts.openSocket(created.webSocketDebuggerUrl, this.opts)
    const session = new Session(socket, this.opts)
    this.sessions.add(session)
    return new Page(session, created)
  }

  /** Release every socket this context opened. Called on teardown so nothing is left attached. */
  close() {
    for (const s of this.sessions) s.close()
    this.sessions.clear()
  }
}

/** Playwright-shaped root, so `browser.contexts()[0]` reads the same as before. */
class Browser {
  constructor(context) { this._contexts = [context] }
  contexts() { return this._contexts }
  close() { this._contexts.forEach((c) => c.close()) }
}

/**
 * Connect to a browser already listening for CDP on `baseUrl` (e.g. `http://127.0.0.1:9333`).
 *
 * Returns the same shape `connectOverCDP` returned, so `operator.mjs` needs one line changed, not a
 * rewrite. The browser is NOT launched here - `launchBrowser()` owns that, and this function refuses
 * to start anything: attaching to a browser someone else started is a smaller act than starting one.
 */
export async function connectOverCDP(
  baseUrl,
  { httpGet = defaultHttpGet, openSocket = defaultOpenSocket, timeoutMs = DEFAULT_TIMEOUT_MS } = {},
) {
  const base = baseUrl.replace(/\/+$/, '')
  // Fails fast and legibly if nothing is listening, instead of an opaque socket error later.
  await httpGet(`${base}/json/version`)
  const context = new Context(base, { httpGet, openSocket, timeoutMs })
  return new Browser(context)
}

/** Node's built-in WebSocket, wrapped so the client sees one shape. */
function defaultOpenSocket(url) {
  return new Promise((resolve, reject) => {
    let settled = false
    const ws = new WebSocket(url)
    ws.addEventListener('open', () => { settled = true; resolve(ws) })
    ws.addEventListener('error', () => {
      if (!settled) reject(new CdpError(`could not open a CDP socket to ${url}`))
    }, { once: true })
  })
}

export const __testing = { Session, Page, Context, Browser, defaultHttpGet }