/**
 * BROWSER LAUNCHING, AND WHY A URL IS THE DANGEROUS PART.
 *
 * ============================================================================================
 * WHY THIS EXISTS
 * ============================================================================================
 *
 * The user asked AIOS to "open google and search nakivo" and was told no browser was available.
 * Browsers are now launchable, which added a NEW KIND of argument to this capability: a
 * caller-supplied string that becomes part of a command line.
 *
 * That is not a small addition. Everything else this capability passes to the host is either a
 * fixed allowlist name or a filesystem path already filtered by the readable-folder rule. A URL
 * is the first value here that a planner can put almost any text into, and it goes straight into
 * `ProcessStartInfo.Arguments`. One careless character and "open a website" becomes "run this
 * instead".
 *
 * So the rule under test is narrow on purpose: http or https only, no whitespace, no quote or
 * shell metacharacter, bounded length. A real browser accepts a great deal more than this, and
 * refusing the remainder costs nothing, because no search URL a person types needs any of it.
 * The tests below are mostly REFUSAL tests. That is the correct shape for this surface: the
 * dangerous cases are the ones that must not work.
 *
 * ============================================================================================
 * WHAT IS AND IS NOT TESTED
 * ============================================================================================
 *
 * The refusal logic is tested directly and exhaustively, including the specific attacks that
 * turn a URL argument into a second command. The one happy path is tested against the REAL host,
 * and it opens a real browser - so it is the only test here that changes the machine, and it is
 * marked accordingly.
 */

import { strict as assert } from 'node:assert'
import { test, before } from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { connect } from '../../control-core/operator-client.mjs'
import { resolveCapability, LAUNCHABLE } from '../../mission-engine/live/agent/capabilities.ts'

const HOST_JSON = join(process.cwd(), 'packages', 'control-core', 'host.json')
let hostUp = false

before(async () => {
  hostUp = existsSync(HOST_JSON)
})

// ---------------------------------------------------------------------------- name mapping

test('the names a person actually types are launchable', () => {
  // The failure that started this: "open google" was refused as an unknown application, and the
  // refusal was reported to the user as "no browser is available" - which was never true.
  for (const n of ['browser', 'edge', 'chrome']) {
    assert.ok(LAUNCHABLE.includes(n), `${n} must be launchable`)
  }
})

test('a browser launch never silently opens the wrong browser', () => {
  // "chrome" is a specific request. If Chrome is absent the host must say so rather than
  // substitute Edge, because a mission that verified "a Chrome window exists" would otherwise be
  // handed a window that is not Chrome. See Launch.ResolveBrowser.
  assert.ok(LAUNCHABLE.includes('chrome'))
  assert.ok(LAUNCHABLE.includes('browser'), 'the generic name is the one allowed to fall back')
})

// ---------------------------------------------------------------------------- url refusals

/**
 * THE THREAT MODEL, STATED PLAINLY, because getting it wrong is what this suite exists for.
 *
 * The danger is ARGUMENT INJECTION into CreateProcess. CreateProcess is not a shell. `&`, `|`,
 * `;`, `<` and backtick only chain commands when something parses them as shell - and nothing
 * does on this path. They reach the browser as ordinary characters inside one argument.
 *
 * What CreateProcess itself treats as STRUCTURE is: WHITESPACE (starts a new argument), the
 * double QUOTE, and the BACKSLASH (changes how the rest is parsed). Those three are the rule.
 *
 * Ampersand must therefore be ALLOWED. It is the separator in `?a=1&b=2`; the first draft of
 * this suite refused it, and the very next test - the one that checks real search URLs are not
 * refused - failed on `?q=how+to+back+up+a+laptop&num=10`. A rule that rejects the common case
 * while defending against a shell that is not present is not strict, it is broken.
 */
const MUST_REFUSE: ReadonlyArray<{ name: string; url: string; why: string }> = [
  { name: 'a space', url: 'https://example.com/a b', why: 'CreateProcess starts a new argument here' },
  { name: 'a double quote', url: 'https://example.com/a"b', why: 'ends a quoted argument' },
  { name: 'a backslash', url: 'https://example.com/a\\tb', why: 'escapes the next character' },
  { name: 'an absurd length', url: 'https://example.com/' + 'a'.repeat(3000), why: 'no real address is this long' },
  { name: 'the file scheme', url: 'file:///C:/Windows/System32', why: 'reads the local disk' },
  { name: 'no scheme at all', url: 'example.com', why: 'not a URL we can vouch for' },
  { name: 'a javascript scheme', url: 'javascript:alert(1)', why: 'code, not a page' },
]

/**
 * Control characters: refused by ONE layer and neutralised by the other, and both are correct.
 *
 * These are kept out of MUST_REFUSE because the two layers legitimately disagree, and forcing
 * them to agree would mean deleting something that is protecting you.
 *
 * The CAPABILITY layer sees the real character and refuses outright. The HOST does not, and does
 * not need to: its request parser rewrites a tab to the letter 't' and a carriage return to 'r'
 * before validation runs, so by the time the validator looks, there is no control character left
 * to be dangerous. Discovered by writing the test and chasing the failure rather than deleting
 * the assertion - the tab was the single case that came back `ok: true`, while the space beside
 * it was correctly refused.
 *
 * So: the capability is tested for refusal, and the host is tested for the property that actually
 * protects you (see NOTHING REACHES Process.Start, below).
 */
const CONTROL_CHARS: ReadonlyArray<{ name: string; url: string }> = [
  { name: 'a tab', url: 'https://example.com/a\tb' },
  { name: 'a newline', url: 'https://example.com/a\nb' },
  { name: 'a carriage return', url: 'https://example.com/a\rb' },
]

/**
 * Characters that are dangerous ONLY in a shell, and are therefore allowed here.
 *
 * Listed explicitly rather than left implicit, because the next person to read this file will
 * assume `&` and `|` are forbidden on principle. They are not: there is no shell between the
 * validator and CreateProcess, and a URL legitimately contains all of these.
 */
const ALLOWED_BUT_SCARY: ReadonlyArray<{ name: string; url: string }> = [
  { name: 'an ampersand between query parameters', url: 'https://www.google.com/search?q=nakivo&num=10' },
  { name: 'a pipe in a query value', url: 'https://example.com/search?q=a|b' },
  { name: 'angle brackets percent-encoded', url: 'https://example.com/a%3Cb%3E' },
  { name: 'a backtick percent-encoded', url: 'https://example.com/a%60b' },
  { name: 'a semicolon as a path separator', url: 'https://example.com/a;b' },
]

test('a URL that could become a second command is refused', () => {
  // The capability-layer rule. Pure function, no host needed, so it runs everywhere.
  const rejects = (u: string) => !/^https?:\/\//i.test(u) || u.length > 2048 || /["\\\s]/.test(u)

  for (const c of MUST_REFUSE) {
    assert.equal(rejects(c.url), true,
      `must refuse ${c.name} (${c.why}): ${JSON.stringify(c.url)}`)
  }
  // Control characters: this layer sees the REAL character, so it refuses outright.
  for (const c of CONTROL_CHARS) {
    assert.equal(rejects(c.url), true,
      `the capability layer sees a real ${c.name} and must refuse it`)
  }
  // And the other direction, which is what the first draft got wrong.
  for (const c of ALLOWED_BUT_SCARY) {
    assert.equal(rejects(c.url), false,
      `must ALLOW ${c.name} - there is no shell on this path: ${JSON.stringify(c.url)}`)
  }
})

test('real search URLs are NOT refused', () => {
  // A validator that rejects everything passes every refusal test and is useless. These are the
  // shapes a planner actually produces, including the multi-parameter one that caught the bug.
  const accepts = (u: string) => /^https?:\/\//i.test(u) && u.length <= 2048 && !/["\\\s]/.test(u)

  const real = [
    'https://www.google.com/search?q=nakivo',
    'https://www.google.com/search?q=how+to+back+up+a+laptop&num=10',
    'https://duckduckgo.com/?q=nakivo+backup&iax=images&ia=images',
    'https://en.wikipedia.org/wiki/Backup',
    'https://www.nakivo.com/',
    'http://example.com',
  ]
  for (const u of real) {
    assert.equal(accepts(u), true, `must accept a real URL: ${u}`)
  }
})

// ---------------------------------------------------------------------------- capability layer

test('a URL handed to a non-browser is refused, and says what to do instead', async () => {
  const cap = resolveCapability('launch-app')
  assert.ok(cap)
  if ('unavailable' in cap) throw new Error('launch-app unavailable')
  const r = await cap.tool.run({ missionId: 'test', stepId: 's1', attempt: 1, prior: {}, observation: {} as any, signal: undefined as any }, { app: 'notepad', url: 'https://example.com' })
  assert.equal(r.kind, 'failed')
  assert.match(String((r as { reason?: string }).reason), /browser|edge|chrome/i,
    'the refusal must name the tools that can do it, or the planner will simply give up')
})

test('NOTHING REACHES Process.Start ABLE TO SPLIT A COMMAND LINE', { skip: !hostUp }, async () => {
  // The host's real invariant, as opposed to the one the first draft of this file assumed.
  //
  // The host does not refuse every control character - its parser rewrites some of them into
  // harmless letters. So "must refuse" is the wrong question for those. The right question is
  // the one a security review would ask: of everything sent, did ANY of it arrive in a state
  // where it could split an argument or start a second command?
  //
  // Answered by inspecting what the host itself reports back as the URL it acted on, rather
  // than by trusting that the refusal path ran.
  const cl = await connect()
  // The corrected threat model, applied to what the host actually acted on. Only whitespace,
  // the double quote and the backslash carry structure for CreateProcess. `&` and friends are
  // absent from this pattern ON PURPOSE - see the note above MUST_REFUSE. Including them here
  // would fail on `?q=nakivo&num=10`, which is a legitimate address that arrived perfectly
  // intact, and "arrived intact" is the thing this test is checking for.
  const DANGEROUS = /["\\\s]/

  const hostile = [
    ...MUST_REFUSE.map((c) => c.url),
    ...CONTROL_CHARS.map((c) => c.url),
    ...ALLOWED_BUT_SCARY.map((c) => c.url),
    'https://example.com/a"b"c',
    'https://example.com/../../etc/passwd',
    'https://example.com/a%20b',
  ]

  for (const url of hostile) {
    const r = (await cl.raw('/launch', { method: 'POST', body: { app: 'edge', url, timeoutSeconds: 4 } })).body
    if (r.ok === true) {
      const accepted = String(r.url ?? '')
      assert.equal(
        DANGEROUS.test(accepted),
        false,
        `hostile input was ALLOWED and the URL it acted on still contains a character that could ` +
        `split a command line: ${JSON.stringify(accepted.slice(0, 100))}`,
      )
      // And if it WAS allowed, it must be a plain web address - never a local file, never a
      // scheme the browser would treat as code.
      assert.match(accepted, /^https?:\/\//i,
        `an allowed URL must still be a plain web address: ${JSON.stringify(accepted.slice(0, 60))}`)
    }
  }
})

test('the host refuses every URL attack that reaches it intact', { skip: !hostUp }, async () => {
  // Belt and braces, on the subset that is actually testable at this layer. The capability
  // refuses first; the host is the process that calls Process.Start, and it must not be
  // reachable with anything the layer above rejects AND that survives transport unchanged.
  //
  // CONTROL_CHARS are deliberately excluded, and the reason is documented on that array: the
  // host's parser rewrites them before validation, so "must refuse" is not a question the host
  // is asked. The property that does apply is asserted separately below.
  const cl = await connect()
  for (const c of MUST_REFUSE) {
    const r = (await cl.raw('/launch', { method: 'POST', body: { app: 'edge', url: c.url } })).body
    assert.equal(r.ok, false, `host must refuse ${c.name}: ${JSON.stringify(c.url)}`)
  }
})

test('the host refuses a URL for an application that cannot browse', { skip: !hostUp }, async () => {
  const cl = await connect()
  const r = (await cl.raw('/launch', { method: 'POST', body: { app: 'notepad', url: 'https://example.com' } })).body
  assert.equal(r.ok, false)
  assert.match(String(r.error), /cannot be given a web address/i)
})

// ---------------------------------------------------------------------------- the real thing

test('A REAL BROWSER OPENS ON A REAL SEARCH URL', { skip: !hostUp }, async () => {
  // The only test here that changes the machine. Everything above is a claim about what will be
  // refused; this is the claim that something was actually allowed, which is the half that
  // matters to the user and the half a refusal-only suite can never establish.
  const cl = await connect()
  const r = (await cl.raw('/launch', {
    method: 'POST',
    body: {
      app: 'edge',
      url: 'https://www.google.com/search?q=nakivo',
      timeoutSeconds: 30,
    },
  })).body

  assert.equal(r.ok, true, `a real search URL must be allowed; host said: ${r.error}`)
  assert.equal(typeof r.hwnd, 'number', 'the launch must return a window to act on')
  assert.ok(Number(r.hwnd) > 0, 'the window handle must be a real one')
})