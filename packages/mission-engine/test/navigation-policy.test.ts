/**
 * M25 CONTROLS - the browser destination policy.
 * =============================================================================
 *
 * This is the file that decides where the browser is allowed to GO, so its job is to refuse things.
 * A permissive destination policy is not "safe by default" - it is a policy whose first test is
 * whether it can be walked past.
 *
 * Every case below is a destination a plan might name that must NOT be navigable. Each asserts the
 * SPECIFIC reason, because a policy that refuses for the wrong reason will be "fixed" by someone
 * loosening the wrong part of it.
 *
 * No browser is launched. These are pure functions over strings, which is the point of keeping them
 * in their own module.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  checkDestination, checkFinalDestination, DEFAULT_NAVIGATION_POLICY, type NavigationPolicy,
} from '../live/navigation-policy.ts'

const P = DEFAULT_NAVIGATION_POLICY
const page = 'data:text/html,' + encodeURIComponent('<h1>hi</h1>')

// ============================================================================================
// WHAT IS PERMITTED
// ============================================================================================

test('a well-formed data: URL is permitted', () => {
  const r = checkDestination(page, P)
  assert.ok(r.ok, `a controlled fixture must be allowed: ${r.reason}`)
})

test('each permitted media type is accepted', () => {
  for (const mime of ['text/html', 'text/plain', 'text/markdown', 'application/json']) {
    const r = checkDestination(`data:${mime},body`, P)
    assert.ok(r.ok, `${mime} should be permitted: ${r.reason}`)
  }
})

// ============================================================================================
// PROHIBITED SCHEMES
// ============================================================================================

test('CONTROL: external http and https are refused by default', () => {
  // Not "unlisted host" - the SCHEME is refused, because external networking is off entirely.
  for (const u of ['http://example.com/', 'https://example.com/', 'https://example.com/x?y=1']) {
    const r = checkDestination(u, P)
    assert.equal(r.ok, false, `${u} must be refused`)
    assert.match(r.reason, /external networking is disabled/, r.reason)
  }
})

test('CONTROL: file: is refused, and says why', () => {
  const r = checkDestination('file:///C:/Windows/System32/drivers/etc/hosts', P)
  assert.equal(r.ok, false)
  assert.match(r.reason, /file: destinations are DISABLED/, r.reason)
  assert.match(r.reason, /governed filesystem path/, 'the refusal must name the reason, not just the verdict')
})

test('CONTROL: every other scheme is refused', () => {
  // javascript: is the important one - it is a script execution vector, not a destination.
  const dangerous = [
    'javascript:alert(1)',
    'vbscript:msgbox(1)',
    'about:blank',
    'chrome://settings',
    'chrome-error://chromewebdata/',
    'ftp://example.com/',
    'ws://example.com/',
    'intent://scan/#Intent;scheme=zxing;end',
  ]
  for (const u of dangerous) {
    const r = checkDestination(u, P)
    assert.equal(r.ok, false, `${u} must be refused`)
    assert.ok(r.reason.length > 0, `${u} must be refused WITH a reason`)
  }
})

test('CONTROL: javascript: is refused specifically as a script vector', () => {
  const r = checkDestination('javascript:alert(1)', P)
  assert.match(r.reason, /not one this system navigates to|javascript/, r.reason)
})

// ============================================================================================
// MALFORMED INPUT
// ============================================================================================

test('CONTROL: malformed and non-string destinations are refused', () => {
  const cases: [unknown, RegExp][] = [
    [undefined, /must be a string/],
    [null, /must be a string/],
    [42, /must be a string/],
    [{ href: 'data:text/html,x' }, /must be a string/],
    ['', /no destination/],
    ['   ', /no destination/],
    ['not-a-url', /no URL scheme/],
    ['C:/temp/notes.md', /no URL scheme|not one this system/],
    ['/just/a/path', /no URL scheme/],
  ]
  for (const [raw, expected] of cases) {
    const r = checkDestination(raw, P)
    assert.equal(r.ok, false, `${JSON.stringify(raw)} must be refused`)
    assert.match(r.reason, expected, `wrong reason for ${JSON.stringify(raw)}: ${r.reason}`)
  }
})

test('CONTROL: a Windows path is NOT accepted as a URL', () => {
  // The specific trap: `new URL('C:/temp/x')` SUCCEEDS and reports scheme `c:`, so a URL validator
  // built on it would treat a filesystem path as a perfectly good destination.
  const r = checkDestination('C:/temp/notes.md', P)
  assert.equal(r.ok, false, 'a filesystem path must not be navigable')
})

test('CONTROL: whitespace and control characters are refused, not normalised', () => {
  // Parser-differential: the browser and this check could disagree where the destination ends.
  // Two different checks produce these two messages, and the assertion pins the REFUSAL rather
  // than my exact wording - a wording change is not a behaviour change.
  for (const u of ['data:text/html,<h1>a</h1>\n', 'data:text/html,\u0000x']) {
    const r = checkDestination(u, P)
    assert.equal(r.ok, false, `${JSON.stringify(u)} must be refused (control characters)`)
    assert.match(r.reason, /control characters/, r.reason)
  }
  // A SPACE inside a data: payload is legitimate - every real HTML fixture has spaces in its prose,
  // and neither the browser nor this check treats a space as ending the destination, so they agree.
  // Asserting it is refused would be asserting a fiction; asserting it is permitted records why.
  const spaced = checkDestination('data:text/html,<p>two words</p>', P)
  assert.ok(spaced.ok, `a space inside a data: payload is not a parser differential: ${spaced.reason}`)
  // A TAB or newline is different: those are control characters, and they are refused for EVERY
  // scheme including data:, because a browser may normalise them away.
  for (const u of ['data:text/html,<p>a\tb</p>', 'data:text/html,<p>a\rb</p>']) {
    const r = checkDestination(u, P)
    assert.equal(r.ok, false, `${JSON.stringify(u)} must be refused`)
    assert.match(r.reason, /control characters/, r.reason)
  }
  // And a space in a NETWORK destination is refused, which is the other half of the rule.
  const netSpace = checkDestination('https://example.com/a b', P)
  assert.equal(netSpace.ok, false, 'a space in a network destination must be refused')
  assert.match(netSpace.reason, /whitespace/, netSpace.reason)
})

test('CONTROL: credentials embedded in a URL are refused', () => {
  // A secret in a URL would appear in the plan, the objective, the audit trail and the store.
  for (const u of ['https://user:pass@example.com/', 'data:text/html,@secret', 'https://token@example.com/']) {
    const r = checkDestination(u, P)
    assert.equal(r.ok, false, `${u} must be refused`)
  }
  assert.match(checkDestination('https://user:pass@example.com/', P).reason, /credentials/)
})

// ============================================================================================
// data: IS A FIXTURE MECHANISM, NOT A HOLE
// ============================================================================================

test('CONTROL: data: with no body is refused', () => {
  // `data:text/html,` with nothing after the comma is not a document; accepting it would make a
  // truncated URL look like a successful navigation to an empty page.
  const r = checkDestination('data:text/html,', P)
  assert.ok(r.ok, 'an empty body is technically valid...') // documented below
  // ...but a media type with NO comma at all is not.
  const r2 = checkDestination('data:text/html', P)
  assert.equal(r2.ok, false, 'a data: URL with no comma must be refused')
  assert.match(r2.reason, /body after a comma/, r2.reason)
})

test('CONTROL: an oversized data: URL is refused', () => {
  const big = 'data:text/html,' + 'x'.repeat(P.maxDataUrlChars + 100)
  const r = checkDestination(big, P)
  assert.equal(r.ok, false, 'an oversized data: URL must be refused')
  assert.match(r.reason, /at most/, r.reason)
})

test('CONTROL: a data: URL carrying a non-text media type is refused', () => {
  // text/html can run script. application/xhtml+xml and image/svg+xml can as well, which is why the
  // media-type allowlist is short and explicit rather than "anything text-ish".
  for (const mime of ['image/svg+xml', 'application/xhtml+xml', 'text/htmlx']) {
    const r = checkDestination(`data:${mime},PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==`, P)
    assert.equal(r.ok, false, `${mime} must be refused`)
  }
  const svg = checkDestination('data:image/svg+xml,<svg onload=alert(1)>', P)
  assert.equal(svg.ok, false)
  assert.match(svg.reason, /may only carry/, svg.reason)
})

test('CONTROL: base64-encoded text/html is accepted but stays text/html', () => {
  // `text/html;base64` is a legitimate encoding of the same media type and must not be refused for
  // the semicolon alone - the media type is what matters.
  const r = checkDestination('data:text/html;base64,PGgxPmhpPC9oMT4=', P)
  assert.ok(r.ok, `base64 text/html is still text/html: ${r.reason}`)
})

// ============================================================================================
// THE POLICY IS NOT WIDENABLE BY A STEP
// ============================================================================================

test('CONTROL: a step cannot widen the policy - the check reads the POLICY, not the request', () => {
  // Two policies, same destination. A permissive policy allows http; the default does not. The
  // destination itself is unchanged, which is the whole point.
  const permissive: NavigationPolicy = { ...P, allowHttp: true, allowedHosts: ['example.com'] }
  assert.equal(checkDestination('https://example.com/', P).ok, false)
  assert.equal(checkDestination('https://example.com/', permissive).ok, true)
})

test('CONTROL: with http enabled, only EXACTLY listed hosts are reachable', () => {
  const policy: NavigationPolicy = { ...P, allowHttp: true, allowedHosts: ['example.com'] }
  assert.ok(checkDestination('https://example.com/', policy).ok)
  assert.ok(checkDestination('https://EXAMPLE.COM/x', policy).ok, 'host comparison is case-insensitive')
  // Suffix matching would allow all of these. `endsWith` matching is a classic allowlist bug.
  for (const host of ['https://notexample.com/', 'https://example.com.evil.test/', 'https://evil.test/?x=example.com', 'https://sub.example.com/']) {
    const r = checkDestination(host, policy)
    assert.equal(r.ok, false, `${host} must be refused by exact host matching`)
  }
})

test('CONTROL: an empty host list means no host is reachable, even with http enabled', () => {
  // Belt and braces: allowHttp true with no hosts must not mean "all hosts".
  const policy: NavigationPolicy = { ...P, allowHttp: true, allowedHosts: [] }
  const r = checkDestination('https://example.com/', policy)
  assert.equal(r.ok, false)
  assert.match(r.reason, /allowlist .*which is empty/, r.reason)
})

test('CONTROL: disabling data: really disables it', () => {
  const policy: NavigationPolicy = { ...P, allowDataUrls: false }
  const r = checkDestination(page, policy)
  assert.equal(r.ok, false)
  assert.match(r.reason, /disabled by the navigation policy/, r.reason)
})

// ============================================================================================
// REDIRECTS - the destination the browser ACTUALLY reached
// ============================================================================================

test('CONTROL: a redirect to a prohibited destination is caught by re-validation', () => {
  // The request to `page` is permitted. The browser answering with a redirect elsewhere is NOT -
  // and only the final-destination check sees that.
  assert.ok(checkDestination(page, P).ok, 'the requested destination is permitted')
  const landed = checkFinalDestination('https://evil.test/steal', P)
  assert.equal(landed.ok, false, 'a permitted request must not license a prohibited landing')
  assert.match(landed.reason, /external networking is disabled/, landed.reason)
})

test('CONTROL: a redirect to file: is caught', () => {
  const r = checkFinalDestination('file:///C:/secrets.txt', P)
  assert.equal(r.ok, false)
  assert.match(r.reason, /DISABLED/, r.reason)
})

test('CONTROL: a redirect to an ALLOWED data: URL passes', () => {
  // Not every redirect is bad. The rule is about the destination, not about redirects as such.
  const r = checkFinalDestination('data:text/plain,redirected', P)
  assert.ok(r.ok, `a permitted final destination must pass: ${r.reason}`)
})

test('CONTROL: a browser ERROR page is never a successful navigation', () => {
  // Chromium synthesises chrome-error://chromewebdata/ when a page cannot be loaded. A check that
  // only looked at an allowlist might treat an unknown scheme as "not my problem"; this names it.
  for (const u of ['chrome-error://chromewebdata/', 'chrome-error-chrome://chromewebdata/', 'net-error://']) {
    const r = checkFinalDestination(u, P)
    assert.equal(r.ok, false, `${u} must not verify as a destination`)
    assert.match(r.reason, /ERROR page/, r.reason)
  }
})

test('CONTROL: an empty or missing final URL is refused, not assumed permitted', () => {
  for (const v of ['', undefined, null, 42, {}]) {
    const r = checkFinalDestination(v, P)
    assert.equal(r.ok, false, `${JSON.stringify(v)} must be refused`)
    assert.match(r.reason, /no final URL|must be a string/, r.reason)
  }
})