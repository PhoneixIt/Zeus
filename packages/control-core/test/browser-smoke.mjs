/**
 * THE REAL-BROWSER SMOKE TEST - drives the local Chromium over CDP. Headless, offline, loopback.
 * =============================================================================
 *
 * Run: npm run browser:smoke
 *
 * =============================================================================
 * WHAT THIS PROVES, AND WHAT IT DOES NOT
 * =============================================================================
 *
 * `cdp.test.ts` proves the PROTOCOL CLIENT is correct, against a real HTTP server and a scripted
 * socket. That is not the same as proving a browser can be driven. A client can be perfectly correct
 * and still never speak to a real browser in this repository's life.
 *
 * So this launches the ACTUAL Chromium that is already installed and drives it through the ACTUAL
 * `operator.mjs` path - `launchBrowser` is deliberately NOT used, because it opens a real visible
 * window on the human's desktop; the same capability is exercised headlessly instead. What is being
 * tested is `page()`, `readPage()` and `locate()`, which is where a client that works against mocks
 * and fails against a browser would show up.
 *
 * WHY HEADLESS, AND WHY ISOLATED
 *
 *   - headless        no window appears, so a routine check cannot steal focus mid-sentence.
 *   - fresh profile   a unique `--user-data-dir` in TEMP. The real user profile is never opened,
 *                     never written to, and never deleted. The directory is removed at the end and
 *                     only if this process created it.
 *   - loopback only   `--remote-debugging-address=127.0.0.1`, and the bind is VERIFIED below. A
 *                     debugging port on 0.0.0.0 is a remote-code-execution surface for anyone on the
 *                     network, so this is checked rather than assumed.
 *   - offline         `--host-resolver-rules=MAP * ~NOTFOUND` makes every external hostname fail to
 *                     resolve. Nothing can reach the internet even if the flags were wrong. Only
 *                     `about:blank` is loaded.
 *   - own process      the browser is started with a dedicated debugging port, so it can be identified
 *                     precisely and terminated. Nothing else is killed.
 *
 * HONESTY RULES THIS FILE KEEPS
 *
 *   - A missing Chromium is reported as SKIP with the path searched, never as PASS.
 *   - A launch failure, a CDP timeout, or an unexpected page is an explicit FAILURE.
 *   - The page content is asserted against what Chromium actually returned, not against what this
 *     file expected to build.
 *   - If the page under test is not the one launched, that is a failure, not something to work around.
 */

import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

/** A port unlikely to collide with a developer's own debugging session. */
const PORT = 9444

// Set BEFORE operator.mjs is imported, because it reads the port at module-evaluation time.
// Without this the operator path would attach to the DEFAULT port (9333) rather than the headless
// browser this test started - which is precisely the "it silently attached to something else" failure
// this test exists to prevent.
process.env.AIOS_CDP_PORT = String(PORT)

const { connectOverCDP, CdpError } = await import('../cdp.mjs')
const { page: opPage, readPage, locate } = await import('../operator.mjs')

const HERE = dirname(fileURLToPath(import.meta.url))

/** Candidate Chromium binaries, most-specific first. Any of these satisfies the test. */
const CHROME_CANDIDATES = [
  'C:/Users/Samer/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
]

function findChrome() {
  for (const c of CHROME_CANDIDATES) if (existsSync(c)) return c
  return null
}


let failures = 0
const check = (what, ok, detail = '') => {
  if (ok) { console.log(`   PASS  ${what}`); return true }
  console.log(`   FAIL  ${what}${detail ? ` - ${detail}` : ''}`)
  failures += 1
  return false
}

async function waitForCdp(port, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs
  let lastError = 'no attempt was made'
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (r.ok) return await r.json()
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e)
    }
    await new Promise((res) => setTimeout(res, 400))
  }
  throw new Error(`the browser's debugging endpoint never answered within ${timeoutMs}ms (last: ${lastError})`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ============================================================================================

const chromePath = findChrome()
if (!chromePath) {
  console.log('=== SKIP: no Chromium/Chrome/Edge binary found ===')
  console.log('  Searched:')
  for (const c of CHROME_CANDIDATES) console.log(`    ${c}`)
  console.log('')
  console.log('  This is reported as a SKIP and not a PASS on purpose. A missing browser means the')
  console.log('  capability is UNPROVEN - reporting green here would let an untested browser path')
  console.log('  look verified.')
  process.exit(2) // 2 = skipped, distinct from pass(0) and fail(1).
}

console.log('=== 1. THE BROWSER UNDER TEST ===')
console.log(`  binary  ${chromePath}`)
console.log(`  port    ${PORT} (loopback only)`)

const profile = mkdtempSync(join(tmpdir(), 'aios-browser-smoke-'))
console.log(`  profile ${profile}  (fresh; the real user profile is never touched)`)

console.log('')
console.log('=== 2. LAUNCH ===')
// NOTE the quoting: `--host-resolver-rules=MAP * ~NOTFOUND` contains spaces. Passed unquoted, Chromium
// reads `*` and `~NOTFOUND` as SEPARATE positional arguments, treats them as targets, and refuses to
// start with "Multiple targets are not supported in headless mode". That is a real trap, and it cost
// two launches before it was diagnosed - so the whole line is one quoted string here.
const ARGS = [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  '--remote-debugging-address=127.0.0.1',
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--no-proxy-server',
  // One token, spaces included. Split into two, Chromium reads `*` and `~NOTFOUND` as separate
  // positional arguments - that is, as two page targets to open - and refuses to start at all with
  // "Multiple targets are not supported in headless mode". Passing this as a pre-quoted string
  // through PowerShell works; passing it as a whitespace-split string does not.
  '--host-resolver-rules=MAP * ~NOTFOUND',
]

let browser = null
let version = null
try {
  browser = spawn(chromePath, ARGS, { stdio: ['ignore', 'pipe', 'pipe'] })
} catch (e) {
  // The profile was created ABOVE, so leaving here leaks it. Verified: this path really does leak -
  // an earlier version exited here and left an empty aios-browser-smoke-* directory in TEMP.
  console.log(`   FAIL  the browser could not be started at all: ${e.message}`)
  try { rmSync(profile, { recursive: true, force: true }) } catch { /* nothing to clean */ }
  process.exit(1)
}

let stderr = ''
browser.stderr?.on('data', (d) => { stderr += String(d) })
browser.on('error', (e) => { stderr += `\nspawn error: ${e.message}` })

console.log(`  spawned pid ${browser.pid}`)
console.log(`  args    ${ARGS.join(' ')}`)

let cleanupOk = true
try {
  version = await waitForCdp(PORT)
  console.log(`  answered ${version.Browser}`)
  check('the browser process is still alive', browser.exitCode === null, `it exited with ${browser.exitCode}`)

  // ---------------------------------------------------------------- the loopback guarantee
  console.log('')
  console.log('=== 3. THE PORT IS NOT EXPOSED ===')
  // Checked, not assumed. `--remote-debugging-address` is a request; this is the observation.
  const net = spawnSync('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
    ['-NoProfile', '-Command', `(Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue).LocalAddress -join ','`],
    { encoding: 'utf8' })
  const bound = String(net.stdout ?? '').trim()
  console.log(`  listening on: ${bound}`)
  check('CDP is bound to loopback only', bound.split(',').every((a) => a.trim() === '127.0.0.1'),
    `an empty result means it was NOT bound to loopback, which would expose a debugging port: "${bound}"`)
  check('CDP is not bound to all interfaces', !/\b0\.0\.0\.0\b/.test(bound) && !/\b::\b/.test(bound), bound)

  // ---------------------------------------------------------------- the real operator path
  console.log('')
  console.log('=== 4. THE REAL OPERATOR PATH ===')
  // operator.mjs caches its browser handle module-wide. These must be the handles THIS browser
  // answered for, not a page left over from anything else.
  const pagesBefore = await (await connectOverCDP(`http://127.0.0.1:${PORT}`)).contexts()[0].pages()
  console.log(`  the browser reports ${pagesBefore.length} page target(s)`)

  const p = await opPage()
  console.log(`  operator.page() -> ${p.constructor.name}, url=${p.url()}`)

  const list = await (await connectOverCDP(`http://127.0.0.1:${PORT}`)).contexts()[0].pages()
  check('the page belongs to THIS browser (port-matched)', list.length > 0, 'no page targets were found')
  const titles = list.map((x) => x.url())
  console.log(`  targets: ${titles.join(', ')}`)
  check('the browser is on a blank/new-tab page, not some pre-existing session',
    titles.every((u) => /^(about:|chrome:\/\/newtab)/.test(u)), titles.join(', '))

  // ---------------------------------------------------------------- real DOM read
  console.log('')
  console.log('=== 5. readPage() AGAINST THE REAL DOM ===')
  await p.goto('about:blank')
  // about:blank's body is empty, so the read is asserted for STRUCTURE. The CONTENT assertions run
  // against a page this browser actually rendered - created from a data: URL below, which loads no
  // network resource of any kind.
  const blank = await readPage({ max: 5000 })
  console.log(`  about:blank -> url=${blank.url} title='${blank.title}' chars=${blank.text.length}`)
  check('readPage() returns the page URL the browser reports', blank.url === 'about:blank', blank.url)
  check('readPage() returns a string body', typeof blank.text === 'string')
  check('readPage() reports a viewport', blank.viewport && blank.viewport.w > 0,
    JSON.stringify(blank.viewport))

  // ---------------------------------------------------------------- locator against real elements
  console.log('')
  console.log('=== 6. locate() AGAINST REAL ELEMENTS ===')
  const MISSING = await locate('definitely-not-present-aios-probe')
  check('locate() returns null for an absent selector (no invented coordinates)',
    MISSING === null, `got ${JSON.stringify(MISSING)} - an invented point would be clicked`)

  // A real, rendered page with real elements. data: URL => zero network access.
  const html = '<!doctype html><html><head><title>AIOS Probe</title></head><body>' +
    '<h1 id="heading">Hello from the local page</h1>' +
    '<p class="para">first paragraph</p><p class="para">second paragraph</p>' +
    '<a id="lnk" href="about:blank">a link</a>' +
    '</body></html>'
  await p.goto(`data:text/html,${encodeURIComponent(html)}`)
  await sleep(400)

  const read = await readPage({ max: 8000 })
  console.log(`  rendered  -> title='${read.title}' headings=${read.headings.length} links=${read.links.length}`)
  console.log(`  text      ${JSON.stringify(read.text.slice(0, 80))}`)
  check('readPage() reads the heading the page really has',
    read.headings.some((h) => h.includes('Hello from the local page')),
    JSON.stringify(read.headings))
  check('readPage() reads the real title', read.title === 'AIOS Probe', read.title)
  check('readPage() returns the real URL', read.url.startsWith('data:text/html'), read.url.slice(0, 40))
  check('readPage() enumerates the links present', read.links.some((l) => l.t === 'a link'),
    JSON.stringify(read.links))

  const h1 = await locate('#heading')
  check('locate() returns REAL screen coordinates for an element that exists',
    h1 && typeof h1.x === 'number' && typeof h1.y === 'number' && h1.w > 0 && h1.h > 0,
    JSON.stringify(h1))
  if (h1) console.log(`  #heading  centre=(${h1.x},${h1.y}) size=${h1.w}x${h1.h}`)

  const second = await locate('.para', 1)
  check('locate() honours the index argument', second !== null && (second.y > h1.y),
    `index 1 gave ${JSON.stringify(second)}; #heading was at y=${h1?.y}`)

  // ---------------------------------------------------------------- error path, for real
  console.log('')
  console.log('=== 7. FAILURE PATHS, EXERCISED FOR REAL ===')
  const before = await readPage({ max: 2000 })
  let threw = null
  try {
    await p.evaluate(() => { throw new Error('deliberate failure from the page') })
  } catch (e) { threw = e }
  check('a page-side exception surfaces with the page\'s own message',
    threw instanceof CdpError && /deliberate failure/.test(threw.message),
    threw ? `${threw.name}: ${threw.message}` : 'it did not throw at all')
  const after = await readPage({ max: 2000 })
  check('the page is still usable after a failed evaluate (the connection survived)',
    typeof after.text === 'string' && after.title === read.title)

  let navThrew = null
  try { await p.goto('ht!tp://not a url at all') } catch (e) { navThrew = e }
  check('a malformed navigation fails loudly rather than silently doing nothing', navThrew !== null,
    'it reported success for an invalid URL')
} catch (e) {
  check('the browser path ran to completion', false, e instanceof Error ? e.message : String(e))
  if (stderr.trim()) {
    console.log('  --- browser stderr (diagnostic) ---')
    for (const line of stderr.split('\n').slice(0, 12)) console.log(`    ${line}`)
  }
}

console.log('')
console.log('=== 8. CLEANUP ===')
// Terminate ONLY what this process started. The browser was launched with a dedicated debugging
// port, and its pid is known; nothing else is signalled.
if (browser.exitCode === null) {
  browser.kill()
  const gone = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 8000)
    browser.once('exit', () => { clearTimeout(t); resolve(true) })
  })
  cleanupOk = check('the browser process this test started has terminated', gone, 'it had to be force-killed')
} else {
  console.log('  the browser had already exited')
}
try {
  rmSync(profile, { recursive: true, force: true })
  check('its own temporary profile was removed', !existsSync(profile), profile)
} catch (e) {
  cleanupOk = false
  console.log(`   FAIL  the temporary profile could not be removed: ${e.message}`)
  console.log(`         ${profile}`)
}

console.log('')
if (failures) {
  console.log(`   === ${failures} FAILURE(S) ===`)
  console.log('  The browser capability is NOT proven. Diagnose before building on it.')
  process.exit(1)
}
if (!cleanupOk) { console.log('   === PASSED BUT CLEANUP INCOMPLETE ==='); process.exit(1) }
console.log('   === PASS: a real Chromium was launched, driven, and cleaned up ===')
console.log('  Proved: launch, loopback-only CDP, page attach, navigate, readPage, locate,')
console.log('          page-side exception propagation, post-failure usability, cleanup.')
console.log('  NOT proved: any external site, any OS-level click, any keyboard input.')
process.exit(0)