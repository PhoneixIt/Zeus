/**
 * LIVE WEB RESEARCH - the acquisition stage.
 *
 * =============================================================================
 * WHAT THIS IS
 * =============================================================================
 *
 * A bounded, HTTPS-only retriever with explicit limits. It is the ACQUISITION half of the
 * `live-web-research` mission: acquisition is deliberately kept apart from planning,
 * authorisation, execution, persistence and verification, because the one thing that must
 * never happen in this system is a page's text becoming the thing that decides what happens
 * next. A retriever that also planned would let a page talk its way into a plan.
 *
 * So this file does one job: fetch a page under stated limits and hand back DATA. It has no
 * opinion about what the data means, no ability to call another tool, and no path by which
 * anything it read could change a permission.
 *
 * =============================================================================
 * WHY HTTPS RETRIEVAL, AND WHAT THAT DOES NOT PROVE
 * =============================================================================
 *
 * There is no browser with a CDP port on this machine right now, so this cannot drive a real
 * browser, and it does not pretend to. What it DOES prove is a genuine external HTTPS request:
 * a real DNS lookup, a real TLS handshake, a real HTTP response from a third-party server,
 * bytes over a socket. That is not the same claim as human-like browser control, and the
 * report labels it that way.
 *
 * Attaching to one of the running browsers would mean starting a new instance with a remote
 * debugging port, which changes the state of a window the person is using. That is their
 * machine and their session; not done here without being asked.
 *
 * =============================================================================
 * LIMITS, AND WHY EACH ONE EXISTS
 * =============================================================================
 *
 *   timeoutMs      a hung server must not hang the mission.
 *   maxBytes       a page can be arbitrarily large; reading it all is a denial of service
 *                  against ourselves. The body is cut and the cut is RECORDED, so a truncated
 *                  page is never silently presented as a whole one.
 *   maxRedirects   a redirect chain can loop. The chain is followed manually so that every
 *                  hop can be checked, rather than handed to fetch() which decides invisibly.
 *   requireHttps   a downgrade to http would move the payload off TLS. Refused outright.
 *   sameOrigin     after the first hop, only the same origin is followed. A page that
 *                  redirects to an unrelated host is not silently followed off-site.
 */

export interface FetchLimits {
  readonly timeoutMs: number
  readonly maxBytes: number
  readonly maxRedirects: number
  readonly requireHttps: boolean
}

export const DEFAULT_LIMITS: FetchLimits = {
  timeoutMs: 15_000,
  maxBytes: 512 * 1024,
  maxRedirects: 4,
  requireHttps: true,
}

export interface RetrievedPage {
  /** The URL actually served, after redirects. NOT the URL that was requested. */
  readonly finalUrl: string
  readonly requestedUrl: string
  readonly status: number
  readonly contentType: string | null
  /** Every hop, so an audit can see how the answer was arrived at. */
  readonly redirectChain: readonly string[]
  readonly truncated: boolean
  readonly bytes: number
  readonly body: string
  readonly fetchedAt: number
  readonly elapsedMs: number
}

export type FetchFailure =
  | { readonly kind: 'invalid-url'; readonly detail: string }
  | { readonly kind: 'insecure-scheme'; readonly detail: string }
  | { readonly kind: 'cross-origin-redirect'; readonly detail: string }
  | { readonly kind: 'too-many-redirects'; readonly detail: string }
  | { readonly kind: 'timeout'; readonly detail: string }
  | { readonly kind: 'network'; readonly detail: string }
  | { readonly kind: 'http-error'; readonly detail: string }

export type FetchResult = { readonly page: RetrievedPage } | { readonly failure: FetchFailure }

const originOf = (u: URL): string => `${u.protocol}//${u.host}`

/**
 * Read at most `maxBytes` of the body.
 *
 * The reader is cancelled as soon as the cap is hit. That is the point: without it a hostile
 * or broken server can keep streaming and the mission waits, or memory grows, regardless of
 * what the limit says.
 */
async function readCapped(res: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) {
    const t = await res.text()
    return { text: t.slice(0, maxBytes), truncated: t.length > maxBytes }
  }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let truncated = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      const remaining = maxBytes - total
      if (remaining <= 0) { truncated = true; break }
      if (value.length > remaining) {
        chunks.push(value.subarray(0, remaining))
        total = maxBytes
        truncated = true
        break
      }
      chunks.push(value)
      total += value.length
    }
  } finally {
    try { await reader.cancel() } catch { /* the stream may already be closed */ }
  }
  const merged = new Uint8Array(total)
  let at = 0
  for (const c of chunks) { merged.set(c, at); at += c.length }
  return { text: new TextDecoder('utf-8', { fatal: false }).decode(merged), truncated }
}

/**
 * Fetch one page under the stated limits. Resolves to a failure object rather than throwing:
 * a refused fetch is a result this mission must be able to persist and audit, not an
 * exception that unwinds past the point where the failure could be recorded.
 */
export async function fetchPage(url: string, limits: FetchLimits = DEFAULT_LIMITS): Promise<FetchResult> {
  const started = Date.now()
  let current: string
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch (e) {
    return { failure: { kind: 'invalid-url', detail: `${url}: ${e instanceof Error ? e.message : String(e)}` } }
  }
  if (limits.requireHttps && parsed.protocol !== 'https:') {
    return { failure: { kind: 'insecure-scheme', detail: `${parsed.protocol} is refused; this mission retrieves over HTTPS only` } }
  }
  current = parsed.toString()
  const firstOrigin = originOf(parsed)
  const chain: string[] = []

  for (let hop = 0; hop <= limits.maxRedirects; hop++) {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), limits.timeoutMs)
    let res: Response
    try {
      res = await fetch(current, {
        signal: ctl.signal,
        redirect: 'manual', // followed here, so every hop is inspected
        headers: { accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5' },
      })
    } catch (e) {
      clearTimeout(timer)
      const msg = e instanceof Error ? e.message : String(e)
      if (ctl.signal.aborted) return { failure: { kind: 'timeout', detail: `${current} exceeded ${limits.timeoutMs}ms` } }
      return { failure: { kind: 'network', detail: `${current}: ${msg}` } }
    }
    clearTimeout(timer)

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location')
      if (!loc) {
        return { failure: { kind: 'http-error', detail: `${current} returned ${res.status} with no Location header` } }
      }
      let next: URL
      try {
        next = new URL(loc, current)
      } catch {
        return { failure: { kind: 'invalid-url', detail: `${current} redirected to an unparseable Location: ${loc}` } }
      }
      if (limits.requireHttps && next.protocol !== 'https:') {
        return { failure: { kind: 'insecure-scheme', detail: `redirect from ${current} would downgrade to ${next.protocol}` } }
      }
      // Same-origin only after the first hop. Cross-site redirects are how a link you did not
      // follow takes you somewhere you did not approve.
      if (originOf(next) !== firstOrigin) {
        return { failure: { kind: 'cross-origin-redirect', detail: `${current} redirected off-origin to ${next.origin}; not followed` } }
      }
      chain.push(next.toString())
      current = next.toString()
      continue
    }

    if (!res.ok) {
      return { failure: { kind: 'http-error', detail: `${current} returned HTTP ${res.status} ${res.statusText}` } }
    }

    let capped: { text: string; truncated: boolean }
    try {
      capped = await readCapped(res, limits.maxBytes)
    } catch (e) {
      return { failure: { kind: 'network', detail: `reading ${current}: ${e instanceof Error ? e.message : String(e)}` } }
    }
    return {
      page: {
        finalUrl: res.url || current,
        requestedUrl: url,
        status: res.status,
        contentType: res.headers.get('content-type'),
        redirectChain: chain,
        truncated: capped.truncated,
        bytes: capped.text.length,
        body: capped.text,
        fetchedAt: Date.now(),
        elapsedMs: Date.now() - started,
      },
    }
  }
  return { failure: { kind: 'too-many-redirects', detail: `${url} exceeded ${limits.maxRedirects} redirects` } }
}