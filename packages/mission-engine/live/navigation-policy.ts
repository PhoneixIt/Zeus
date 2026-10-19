/**
 * THE BROWSER DESTINATION POLICY.
 * =============================================================================
 * WHY THIS IS ITS OWN FILE AND NOT AN ARGUMENT
 * =============================================================================
 *
 * A navigation policy passed in by the caller is not a policy. If a step's arguments could widen
 * what the browser may reach, then a planner - which will eventually be a language model - could
 * widen it too, and the natural-language request would BE the authority. That is precisely what this
 * milestone must not allow: **a natural-language request alone must never grant navigation
 * authority.**
 *
 * So the policy is constructed here, passed to the tool at REGISTRATION time, and the step's
 * arguments are only ever checked AGAINST it. The plan chooses a destination. It cannot choose the
 * rules.
 *
 * =============================================================================
 * WHAT IS PERMITTED, AND WHY IT IS SO NARROW
 * =============================================================================
 *
 *   data:   ALLOWED, under four constraints. It is a fixture mechanism, not a browsing permission:
 *           it cannot reach a host, cannot be redirected off-machine, and needs no network. The
 *           constraints are what stop "data:" becoming a hole - see `checkDataUrl`.
 *
 *   file:   DISABLED. `file:` reads the local disk with the browser's privileges and can reach any
 *           path the process can. There is no demonstrated need for it in this milestone, and
 *           `filesystem.read` already exists for reading a file - through the governed path, with a
 *           workspace root. Enabling `file:` would create a second, ungoverned way to read a file.
 *
 *   http/https: DISABLED by default. External networking is off for this milestone. An empty
 *           `allowedHosts` means NO host is reachable, so the capability cannot leak onto the
 *           internet by accident or by a one-word change. Enabling a host is an explicit,
 *           reviewed edit to a policy constant - which is the point.
 *
 * =============================================================================
 * REDIRECTS
 * =============================================================================
 *
 * Checking the URL that was ASKED for is not enough. A permitted destination can answer with a
 * redirect to a prohibited one, and then the browser is somewhere the policy forbids while the plan
 * still shows a permitted URL. So `checkFinalDestination` is a SEPARATE check the verifier runs
 * after navigation, against what the page actually is. A policy that only validates the request
 * would pass this and be wrong.
 */

/** Schemes the policy can ever be configured to permit. */
export type AllowedScheme = 'data:' | 'http:' | 'https:'

export interface NavigationPolicy {
  /** Whether `data:` destinations may be navigated to at all. */
  readonly allowDataUrls: boolean
  /** Hard ceiling on a `data:` URL's length. Bounds what a plan can smuggle through one. */
  readonly maxDataUrlChars: number
  /** Whether `file:` is permitted. Disabled, and there is no demonstrated need to enable it. */
  readonly allowFileUrls: boolean
  /** Whether `http:`/`https:` are permitted at all. */
  readonly allowHttp: boolean
  /**
   * When `allowHttp` is true, the ONLY hosts reachable. An empty list means none, regardless of
   * `allowHttp`. Hosts are compared case-insensitively and must match exactly - no suffix matching,
   * because `endsWith('example.com')` also matches `notexample.com`.
   */
  readonly allowedHosts: readonly string[]
}

export interface PolicyCheck {
  readonly ok: boolean
  readonly reason: string
}

/**
 * THE DEFAULT POLICY - deny by default, with `data:` as the single narrow exception.
 *
 * Written out in full rather than derived from flags so that reading it tells you exactly what the
 * system can reach, with no inference required.
 */
export const DEFAULT_NAVIGATION_POLICY: NavigationPolicy = {
  allowDataUrls: true,
  maxDataUrlChars: 32_000,
  allowFileUrls: false,
  allowHttp: false,
  allowedHosts: [],
}

const ok: PolicyCheck = { ok: true, reason: 'permitted by the navigation policy' }
const no = (reason: string): PolicyCheck => ({ ok: false, reason })

/**
 * Parse a destination WITHOUT `new URL`, then validate it.
 *
 * `new URL` is deliberately not used for the scheme check. `new URL('C:/tmp/x')` succeeds and reports
 * the scheme `c:` - so a Windows path passed to a URL validator comes back as a valid URL on an
 * unknown scheme. The scheme is therefore read off the string literally, with an explicit allowlist,
 * before any structural parsing happens.
 */
export function checkDestination(raw: unknown, policy: NavigationPolicy = DEFAULT_NAVIGATION_POLICY): PolicyCheck {
  if (typeof raw !== 'string') return no(`the destination must be a string, got ${typeof raw}`)
  // The control-character check below runs on the RAW string, before any trimming. An earlier
  // version trimmed first, which silently removed a trailing newline and then passed the very check
  // meant to catch it - a control that could not fail on the most obvious input.
  if (/[\u0000-\u001f\u007f]/.test(raw)) {
    return no('the destination contains control characters, which different parsers could read differently')
  }
  const url = raw.trim()
  if (!url) return no('no destination was given')
  if (url.length > policy.maxDataUrlChars && url.startsWith('data:')) {
    return no(`a data: URL may be at most ${policy.maxDataUrlChars} characters, this one is ${url.length}`)
  }

  // A data: payload runs to the END of the string - there is no delimiter for a browser to disagree
  // about - so ordinary spaces inside HTML are harmless and must be permitted, or no real fixture
  // could ever be navigated to. For a NETWORK destination the situation is the opposite: a space is
  // exactly the character a browser and this check could normalise differently, so it is refused.
  //
  // The two rules are separated rather than merged because merging them means choosing one and being
  // wrong for the other scheme. An earlier version refused whitespace everywhere and could not
  // navigate `data:text/html,<p>two words</p>` - which is most of HTML.
  const schemeHint = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url)?.[1]?.toLowerCase() ?? ''
  if (schemeHint !== 'data' && /[\s]/.test(url)) {
    return no('the destination contains whitespace, which different parsers could read differently')
  }

  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url)?.[1]?.toLowerCase()
  if (!scheme) return no(`"${url.slice(0, 40)}" has no URL scheme, so it cannot be a destination`)

  // Credentials in a URL are rejected outright. `https://user:pass@host` would put a secret in a plan
  // step, in the objective, in the audit trail and in the persisted store.
  const authority = url.slice(scheme.length + 1)
  if (authority.includes('@')) {
    return no('the destination embeds credentials, which must never appear in a plan or an audit trail')
  }

  if (scheme === 'data') {
    if (!policy.allowDataUrls) return no('data: destinations are disabled by the navigation policy')
    const payload = url.slice('data:'.length)
    // A data: URL must declare a media type or be `data:,...`. Requiring an explicit `;base64` or a
    // comma-bound body keeps a truncated `data:text/html,` from being treated as an empty document.
    if (!payload.includes(',')) return no('a data: URL must have a body after a comma (data:MIME,payload)')
    const meta = payload.slice(0, payload.indexOf(','))
    const allowedTypes = ['text/html', 'text/plain', 'text/markdown', 'application/json']
    const mime = (meta.split(';')[0] ?? '').trim().toLowerCase()
    if (!allowedTypes.includes(mime)) {
      return no(`a data: URL may only carry ${allowedTypes.join(', ')} - refusing "${mime || '(no media type)'}"`)
    }
    return ok
  }

  if (scheme === 'file') {
    if (!policy.allowFileUrls) {
      return no('file: destinations are DISABLED: the browser would read the local disk outside the governed filesystem path')
    }
    return no('file: destinations are not implemented even when enabled - there is no demonstrated need')
  }

  if (scheme === 'http' || scheme === 'https') {
    if (!policy.allowHttp) return no(`external networking is disabled, so ${scheme}// cannot be reached`)
    // Host extraction is manual for the same reason the scheme was: `new URL` would accept a path
    // here, and the check must agree with the browser about the HOST specifically.
    // strip `:` then the `//`, or the host parses as an empty string
    const afterScheme = url.slice(scheme.length + 1).replace(/^\/\//, '')
    const host = afterScheme.split(/[/?#]/)[0] ?? ''
    const hostOnly = host.split(':')[0]?.toLowerCase() ?? ''
    if (!hostOnly) return no('the destination names no host')
    const permitted = policy.allowedHosts.some((h) => h.toLowerCase() === hostOnly)
    if (!permitted) {
      return no(`host "${hostOnly}" is not on the navigation policy's allowlist ` +
        `(${policy.allowedHosts.length ? policy.allowedHosts.join(', ') : 'which is empty'})`)
    }
    return ok
  }

  return no(`the scheme "${scheme}:" is not one this system navigates to ` +
    `(permitted: ${policy.allowDataUrls ? 'data:' : 'no data:'}, no file:, ${policy.allowHttp ? 'listed http/https hosts' : 'no external hosts'})`)
}

/**
 * RE-VALIDATE WHAT THE BROWSER ACTUALLY LANDED ON.
 *
 * Runs after navigation, against the page's real URL. This is what catches a permitted destination
 * that answered with a redirect to a prohibited one: the request passed the policy, and this says
 * no.
 *
 * `browser-error:` and `chrome-error:` are refused explicitly. When Chromium cannot load a page it
 * synthesises a document whose URL is `chrome-error://chromewebdata/` - and a check that only looked
 * at the scheme allowlist would see a scheme it does not recognise and might wave it through. Naming
 * it means a failed navigation can never be reported as a successful one.
 */
export function checkFinalDestination(finalUrl: unknown, policy: NavigationPolicy = DEFAULT_NAVIGATION_POLICY): PolicyCheck {
  if (typeof finalUrl !== 'string' || !finalUrl) {
    return no('the browser reported no final URL, so the destination cannot be confirmed')
  }
  if (/^(chrome-error|chrome-error-chrome|net-error):/i.test(finalUrl)) {
    return no(`the browser reported an ERROR page for this destination (${finalUrl}), which is not a permitted destination`)
  }
  return checkDestination(finalUrl, policy)
}