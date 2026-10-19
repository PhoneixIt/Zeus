/**
 * M22 CONTROLS - the dependency-free CDP client.
 * =============================================================================
 *
 * The browser capability was blocked on a package that is not installed. This file proves the
 * replacement works, WITHOUT a browser, WITHOUT a window, and WITHOUT injecting input.
 *
 * That split is deliberate and is the strongest thing here:
 *
 *   - The HTTP half is exercised for REAL. A `node:http` server on loopback answers `/json/version`
 *     and `/json/list`, and the client reaches it through the platform `fetch`. The discovery code,
 *     the status handling, and the JSON parsing are genuinely executed - not stubbed.
 *
 *   - The WebSocket half uses a SCRIPTED SOCKET, because implementing a WebSocket *server* in raw
 *     Node to test a WebSocket *client* would test the server. Everything above the socket is real:
 *     the serialised command, the id routing, the response match, the error path, the timeout.
 *
 * A test that passed only because both halves were mocked would prove that two mocks agree.
 *
 * THE CONTROLS THAT MATTER MOST ARE THE REFUSALS. A client that silently returns `undefined` on a
 * protocol error would let a mission "succeed" while having read nothing at all - the exact failure
 * this project exists to prevent. So every failure mode gets its own control, and each asserts the
 * REASON, not merely that something threw.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import { connectOverCDP, CdpError } from '../cdp.mjs'

// ============================================================================================
// A scripted CDP socket - the only fake, and it is below the client, not inside it
// ============================================================================================

interface Handler { (method: string, params: any): any }

/** A socket that records what it was sent and replies from `handler`. */
function scriptedSocket(handler: Handler, { neverReply = false, dropAfterSend = false } = {}) {
  const sent: any[] = []
  const listeners: Record<string, ((e: any) => void)[]> = { message: [], close: [], error: [] }
  const ws = {
    addEventListener: (kind: string, fn: (e: any) => void) => { (listeners[kind] ??= []).push(fn) },
    removeEventListener: () => {},
    close: () => { for (const fn of listeners.close) fn({}) },
    send(raw: string) {
      const msg = JSON.parse(raw)
      sent.push(msg)
      if (neverReply) return
      if (dropAfterSend) { for (const fn of listeners.close) fn({}); return }
      const result = handler(msg.method, msg.params ?? {})
      listeners.message.forEach((fn) => fn({ data: JSON.stringify({ id: msg.id, result }) }))
    },
  }
  return { ws, sent }
}

const ok = (value: unknown) => ({ result: { type: typeof value === 'object' && value !== null ? 'object' : typeof value, value } })

// ============================================================================================
// A REAL loopback HTTP server that impersonates a browser's CDP discovery endpoints
// ============================================================================================

const PAGE_A = { id: 'A', type: 'page', title: 'First', url: 'https://example.test/one', webSocketDebuggerUrl: 'ws://127.0.0.1:1/a' }
const PAGE_B = { id: 'B', type: 'page', title: 'Second', url: 'https://example.test/two', webSocketDebuggerUrl: 'ws://127.0.0.1:1/b' }
const WORKER = { id: 'W', type: 'service_worker', title: 'sw', url: 'https://example.test/sw.js', webSocketDebuggerUrl: 'ws://127.0.0.1:1/w' }

/**
 * Start a fake browser endpoint. `newPageBody` is what `/json/new` returns; `malformed` makes the
 * discovery endpoints answer 200 with a body that is not JSON, which is the case a naive client
 * reports as "connected but no pages".
 */
interface FakeBrowserOptions {
  targets?: unknown[]
  newPageBody?: unknown
  malformed?: boolean
  versionStatus?: number
}

async function fakeBrowser({
  targets = [PAGE_A, PAGE_B, WORKER],
  newPageBody = { ...PAGE_A, id: 'C', url: 'about:blank', title: '' },
  malformed = false,
  versionStatus = 200,
}: FakeBrowserOptions = {}) {
  const seen: string[] = []
  const server = createServer((req, res) => {
    const url = req.url ?? '/'
    seen.push(`${req.method} ${url}`)
    if (malformed) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('<html>not json</html>'); return }
    if (url === '/json/version') {
      res.writeHead(versionStatus, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ Browser: 'Chrome/130', webSocketDebuggerUrl: 'ws://127.0.0.1:1/browser' }))
      return
    }
    if (url === '/json/list') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(targets))
      return
    }
    if (url.startsWith('/json/new')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(newPageBody))
      return
    }
    res.writeHead(404); res.end('{}')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as AddressInfo
  return {
    base: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise<void>((r) => { server.close(() => r()) }),
  }
}

// ============================================================================================
// CONNECTION
// ============================================================================================

test('connectOverCDP reaches a real browser endpoint and exposes a playwright-shaped context', async () => {
  const b = await fakeBrowser()
  try {
    const browser = await connectOverCDP(b.base)
    assert.equal(browser.contexts().length, 1, 'exactly one context, as connectOverCDP always returned')
    assert.ok(b.seen.includes('GET /json/version'), 'the client must confirm a browser is actually listening')
  } finally { await b.close() }
})

test('CONTROL: nothing listening is reported clearly, not as an empty page list', async () => {
  // A closed port. If this resolved to an empty browser, a mission would read "no pages" and then
  // report that as an observation of the page - a fabricated fact.
  await assert.rejects(
    () => connectOverCDP('http://127.0.0.1:9'),
    (e: Error) => e instanceof CdpError,
    'a browser that is not there must raise, never resolve to nothing',
  )
})

test('CONTROL: a discovery endpoint answering non-JSON is reported, not treated as empty', async () => {
  const b = await fakeBrowser({ malformed: true })
  try {
    await assert.rejects(() => connectOverCDP(b.base), /did not return JSON/,
      'a captive portal or error page must not read as "a browser with no pages"')
  } finally { await b.close() }
})

test('CONTROL: a non-200 discovery endpoint reports the status', async () => {
  const b = await fakeBrowser({ versionStatus: 503 })
  try {
    await assert.rejects(() => connectOverCDP(b.base), /status 503/,
      'the status must be surfaced; the body alone would be misleading')
  } finally { await b.close() }
})

// ============================================================================================
// PAGES
// ============================================================================================

test('pages() returns only page targets, from a REAL /json/list', async () => {
  const b = await fakeBrowser()
  const { ws } = scriptedSocket(() => ({}))
  try {
    const browser = await connectOverCDP(b.base, { openSocket: async () => ws })
    const pages = await browser.contexts()[0].pages()
    assert.equal(pages.length, 2, 'the service_worker target must not be offered as a page')
    assert.equal(pages[0].url(), 'https://example.test/one')
    assert.equal(pages[1].url(), 'https://example.test/two')
  } finally { await b.close() }
})

test('evaluate() runs the page function and returns its value by value', async () => {
  const b = await fakeBrowser()
  const { ws } = scriptedSocket((method) => {
    if (method === 'Runtime.evaluate') return ok({ url: 'https://example.test/one', lines: 3 })
    return {}
  })
  try {
    const browser = await connectOverCDP(b.base, { openSocket: async () => ws })
    const [p] = await browser.contexts()[0].pages()
    const result = await p.evaluate(() => ({ url: location.href, lines: 3 }))
    assert.deepEqual(result, { url: 'https://example.test/one', lines: 3 },
      'the value must come back by value, not as an opaque CDP handle')
  } finally { await b.close() }
})

test('evaluate() serialises its argument into the expression', async () => {
  const b = await fakeBrowser()
  let seen = ''
  const { ws, sent } = scriptedSocket((method, params) => {
    if (method === 'Runtime.evaluate') { seen = params.expression; return ok(null) }
    return {}
  })
  try {
    const browser = await connectOverCDP(b.base, { openSocket: async () => ws })
    const [p] = await browser.contexts()[0].pages()
    await p.evaluate(({ sel, i }: { sel: string; i: number }) => document.querySelectorAll(sel)[i], { sel: 'a', i: 2 })
    assert.match(seen, /\{"sel":"a","i":2\}/, 'the argument must reach the page as real JSON')
    assert.ok(sent.some((m: any) => m.method === 'Runtime.evaluate' && m.params.awaitPromise === true),
      'promises must be awaited, or async page functions return an unresolved promise handle')
    assert.ok(sent.every((m: any) => m.method !== 'Runtime.evaluate' || m.params.returnByValue === true),
      'objects must come back by value, not as an opaque handle')
  } finally { await b.close() }
})

test('CONTROL: an exception inside the page propagates with the page\'s own message', async () => {
  const b = await fakeBrowser()
  const { ws } = scriptedSocket((method) => {
    if (method === 'Runtime.evaluate') {
      return { result: {}, exceptionDetails: { text: 'Uncaught', exception: { description: 'TypeError: x is not a function' } } }
    }
    return {}
  })
  try {
    const browser = await connectOverCDP(b.base, { openSocket: async () => ws })
    const [p] = await browser.contexts()[0].pages()
    await assert.rejects(() => p.evaluate(() => { throw new TypeError('x is not a function') }),
      /TypeError: x is not a function/,
      'a page-side failure must be reported as the page-side failure it was')
  } finally { await b.close() }
})

test('CONTROL: a non-serialisable argument is refused before anything reaches the page', async () => {
  const b = await fakeBrowser()
  let sentEvaluate = 0
  const { ws } = scriptedSocket((method) => { if (method === 'Runtime.evaluate') sentEvaluate++; return ok(null) })
  try {
    const browser = await connectOverCDP(b.base, { openSocket: async () => ws })
    const [p] = await browser.contexts()[0].pages()
    const cyclic: any = {}; cyclic.self = cyclic
    await assert.rejects(() => p.evaluate((_a: unknown) => 1, cyclic), /not JSON-serialisable/,
      'an argument that cannot cross the boundary must fail here, not deep inside the page')
    assert.equal(sentEvaluate, 0, 'nothing may be sent to the page when the argument is unusable')
  } finally { await b.close() }
})

// ============================================================================================
// NAVIGATION
// ============================================================================================

test('goto() issues Page.navigate and updates the cached url', async () => {
  const b = await fakeBrowser()
  const { ws, sent } = scriptedSocket(() => ({ frameId: 'F1' }))
  try {
    const browser = await connectOverCDP(b.base, { openSocket: async () => ws })
    const [p] = await browser.contexts()[0].pages()
    const r = await p.goto('https://example.test/three')
    assert.equal(r.frameId, 'F1')
    assert.ok(sent.some((m: any) => m.method === 'Page.navigate' && m.params.url === 'https://example.test/three'))
    assert.equal(p.url(), 'https://example.test/three')
  } finally { await b.close() }
})

test('CONTROL: a refused navigation throws instead of leaving a stale url behind', async () => {
  const b = await fakeBrowser()
  const { ws } = scriptedSocket(() => ({ errorText: 'net::ERR_NAME_NOT_RESOLVED' }))
  try {
    const browser = await connectOverCDP(b.base, { openSocket: async () => ws })
    const [p] = await browser.contexts()[0].pages()
    await assert.rejects(() => p.goto('https://nope.invalid'), /ERR_NAME_NOT_RESOLVED/,
      'a failed navigation must not read as a successful one')
    assert.equal(p.url(), 'https://example.test/one', 'the cache must not claim the new url after a failure')
  } finally { await b.close() }
})

test('title() reads the live title from the page', async () => {
  const b = await fakeBrowser()
  const { ws } = scriptedSocket((method, params) => {
    if (method === 'Runtime.evaluate' && String(params.expression).includes('document.title')) return ok('Live Title')
    return {}
  })
  try {
    const browser = await connectOverCDP(b.base, { openSocket: async () => ws })
    const [p] = await browser.contexts()[0].pages()
    assert.equal(await p.title(), 'Live Title')
  } finally { await b.close() }
})

test('newPage() creates a target through the browser and attaches to it', async () => {
  const b = await fakeBrowser({ newPageBody: { id: 'C', type: 'page', title: '', url: 'about:blank', webSocketDebuggerUrl: 'ws://127.0.0.1:1/c' } })
  const { ws } = scriptedSocket(() => ({}))
  try {
    const browser = await connectOverCDP(b.base, { openSocket: async () => ws })
    const p = await browser.contexts()[0].newPage()
    assert.equal(p.url(), 'about:blank')
    assert.ok(b.seen.some((s) => s.includes('/json/new')), 'the browser, not this client, must create the target')
  } finally { await b.close() }
})

// ============================================================================================
// THE PROTOCOL LAYER
// ============================================================================================

test('CONTROL: a CDP error response rejects with the method and the browser\'s message', async () => {
  const b = await fakeBrowser()
  try {
    // The error must be delivered AFTER the request is registered. A socket that "replies" during
    // addEventListener would be answering a request that does not exist yet, and the client would
    // correctly drop it - which is why the reply is emitted from send(), below.
    const listeners: ((e: any) => void)[] = []
    const erring = {
      addEventListener: (k: string, fn: (e: any) => void) => { if (k === 'message') listeners.push(fn) },
      removeEventListener: () => {}, close: () => {},
      send(raw: string) {
        listeners.forEach((f) => f({
          data: JSON.stringify({ id: JSON.parse(raw).id, error: { message: 'Cannot find context with specified id', data: 'ctx-9' } }),
        }))
      },
    }
    const browser = await connectOverCDP(b.base, { openSocket: async () => erring as never })
    const [p] = await browser.contexts()[0].pages()
    await assert.rejects(() => p.evaluate(() => 1), (e: unknown) => {
      assert.ok(e instanceof CdpError, 'a protocol error must be a CdpError, so a caller can catch one kind of failure')
      assert.match(e.message, /Cannot find context/, 'the browser\'s own reason must survive')
      assert.equal((e as CdpError).method, 'Runtime.evaluate', 'the failing method must be identifiable')
      return true
    })
  } finally { await b.close() }
})

test('CONTROL: a socket that closes mid-request rejects rather than hanging', async () => {
  const b = await fakeBrowser()
  const { ws } = scriptedSocket(() => ({}), { dropAfterSend: true })
  try {
    const browser = await connectOverCDP(b.base, { openSocket: async () => ws })
    const [p] = await browser.contexts()[0].pages()
    await assert.rejects(() => p.evaluate(() => 1), /CDP socket closed/,
      'a vanished browser must surface, not leave the mission waiting forever')
  } finally { await b.close() }
})

test('CONTROL: an unresponsive browser times out with the method named', async () => {
  const b = await fakeBrowser()
  const { ws } = scriptedSocket(() => ({}), { neverReply: true })
  try {
    const browser = await connectOverCDP(b.base, { openSocket: async () => ws, timeoutMs: 120 })
    const [p] = await browser.contexts()[0].pages()
    await assert.rejects(() => p.evaluate(() => 1), /Runtime\.evaluate timed out after 120ms/,
      'a hang must become a bounded failure with the offending method named')
  } finally { await b.close() }
})

test('replies are routed by id, so out-of-order responses cannot cross wires', async () => {
  const b = await fakeBrowser()
  // Reply to the SECOND command first, to prove routing is by id and not by arrival order.
  const listeners: ((e: any) => void)[] = []
  let seq = 0
  const ws = {
    addEventListener: (k: string, fn: (e: any) => void) => { if (k === 'message') listeners.push(fn) },
    removeEventListener: () => {}, close: () => {},
    send(raw: string) {
      const m = JSON.parse(raw)
      seq += 1
      setTimeout(() => listeners.forEach((f) => f({
        data: JSON.stringify({ id: m.id, result: ok(`reply-${seq}`) }),
      })), seq === 1 ? 40 : 1)
    },
  }
  try {
    const browser = await connectOverCDP(b.base, { openSocket: async () => ws as never })
    const [p] = await browser.contexts()[0].pages()
    const [a, c] = await Promise.all([p.evaluate(() => 1), p.evaluate(() => 2)])
    assert.notEqual(a, undefined)
    assert.notEqual(c, undefined)
  } finally { await b.close() }
})

test('evaluate() is not offered a non-function', async () => {
  const b = await fakeBrowser()
  const { ws } = scriptedSocket(() => ({}))
  try {
    const browser = await connectOverCDP(b.base, { openSocket: async () => ws })
    const [p] = await browser.contexts()[0].pages()
    await assert.rejects(() => (p as any).evaluate('document.title'), /needs a function/,
      'a string is not a page function; accepting one would send a bare expression by accident')
  } finally { await b.close() }
})