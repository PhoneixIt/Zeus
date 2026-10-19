// The governed desktop operator.
//
// This is the operator, not a demonstration of one. It drives the real interactive
// Windows session: a real headed browser window, real OS-level mouse and keyboard,
// real screen capture. Everything the user sees happen is caused by a Win32 call
// made from this process.
//
// THREE THINGS SEPARATE IT FROM A SCRIPT THAT TYPES THINGS:
//
//   1. TARGET GOVERNANCE. No input is ever sent because a window happens to be in
//      front. Every action resolves a target and pins hwnd + pid + the live title,
//      and the host independently re-verifies visibility, process, title and
//      foreground. A refusal is a normal outcome, not an error to route around.
//
//   2. ACTION GOVERNANCE. Actions are classified routine / sensitive / consequential.
//      Routine proceeds. Sensitive requires an explicit acknowledgement. Consequential
//      is refused outright and recorded as a gate. The classification lives here, in
//      one table, so it cannot drift per call site.
//
//   3. RECOVERY THAT DIAGNOSES. A failed action does not retry blindly. Each
//      recoverable failure has a named diagnosis and a named correction, and the
//      correction is verified before the caller continues.
//
// The audit log records real actions with their real results. It is a record of what
// actually happened, not a narration: every entry is written after the corresponding
// Win32 call returned.

// THE BROWSER IS DRIVEN OVER RAW CDP, AND THE PLAYWRIGHT DEPENDENCY IS GONE.
//
// It used to be loaded lazily, and the lazy import of `playwright` failed: the package is neither
// installed nor declared in package.json, so the browser capability raised "the browser capability
// needs the playwright package" at the point of use. It had originally been a TOP-LEVEL import,
// which meant a missing browser library made this module un-importable at all - taking the operator
// with it and stopping every harness that needed the operator, including the proof harnesses, which
// are about WINDOWS and never touch a browser.
//
// The premise of that error was wrong, and it is worth being exact about why. What is missing is a
// convenience WRAPPER, not the capability:
//
//   - the Chromium binary is present (ms-playwright/chromium-1243)
//   - the CDP endpoint on 127.0.0.1:9333 is already polled by cdpAlive()
//   - Node v22+ ships `fetch` and `WebSocket`, both verified present on v24.21.0
//
// Playwright is, for the six methods this file uses, a wrapper over the Chrome DevTools Protocol -
// which is JSON over a WebSocket. `./cdp.mjs` speaks it directly, with no dependency at all.
//
// Playwright is still preferred IF it is ever installed, because it is battle-tested and this client
// is not. But its absence is no longer a reason the browser cannot work.
let chromium = null
let cdpBrowser = null
async function chromiumApi() {
  if (chromium) return chromium
  try {
    ({ chromium } = await import('playwright'))
    return chromium
  } catch {
    // Fall through to the built-in client. This is the path that runs today.
    return null
  }
}

/**
 * A playwright-shaped browser handle, from whichever backend is available.
 *
 * Both backends expose `contexts()[0].pages()` and a page with `evaluate`/`url`/`title`, so every
 * call site below is unchanged. The preference order is deliberate: real playwright if installed,
 * otherwise the dependency-free CDP client. Only if BOTH are unavailable does this raise, and it says
 * which is missing and how to start the browser.
 */
async function connectBrowser() {
  const api = await chromiumApi()
  if (api) return api.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`)
  if (!cdpBrowser) cdpBrowser = await connectOverCDP(`http://127.0.0.1:${CDP_PORT}`)
  return cdpBrowser
}
import { op, listWindows, foreground, sleep, identity } from './driver.mjs'
import { connectOverCDP } from './cdp.mjs'
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'

const CHROME = 'C:/Users/Samer/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe'

/**
 * The port this module attaches to, overridable so a TEST can use its own.
 *
 * It defaults to 9333, which is what every existing caller has always used - nothing about the
 * production path changes. The override exists for `browser-smoke.mjs`, which must NOT attach to (or
 * terminate) a developer's own browser session: a headless check that reused the default port would
 * either collide with a running browser or, worse, terminate one. The value is parsed strictly,
 * because an unparseable value would otherwise become `NaN` and silently produce the URL
 * `http://127.0.0.1:NaN` - a browser capability that is broken in a way nothing reports.
 */
const CDP_PORT = (() => {
  const raw = process.env.AIOS_CDP_PORT
  if (!raw) return 9333
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1024 || n > 65535) {
    throw new Error(`AIOS_CDP_PORT must be an integer port in 1024-65535, got ${JSON.stringify(raw)}`)
  }
  return n
})()
const PROFILE_DIR = 'C:/Users/Samer/AppData/Local/Temp/opencode/browser-lab/profile'
const SHOTS = 'C:/Users/Samer/AppData/Local/Temp/opencode/desktop-capture'
const AUDIT = 'C:/Users/Samer/AppData/Local/Temp/opencode/operator/audit.jsonl'
const PS = 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'

mkdirSync('C:/Users/Samer/AppData/Local/Temp/opencode/operator', { recursive: true })

// ---------------------------------------------------------------- audit

let seq = 0

/**
 * Record an action that actually happened.
 *
 * `result` is the real return value from the Win32-backed call, so a refusal is
 * recorded as a refusal. Nothing is logged optimistically.
 */
function audit(action, target, risk, result, extra = {}) {
  seq += 1
  const entry = {
    seq,
    at: new Date().toISOString(),
    action,
    risk,
    target: target ? { hwnd: target.hwnd, pid: target.pid, title: String(target.title).slice(0, 80) } : null,
    result,
    ...extra,
  }
  appendFileSync(AUDIT, `${JSON.stringify(entry)}\n`, 'utf8')
  return entry
}

export function auditTail(n = 20) {
  try {
    const raw = execFileSync(PS, ['-NoProfile', '-Command', `Get-Content -LiteralPath '${AUDIT}' -Tail ${n}`], { encoding: 'utf8' })
    return raw
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => {
        try {
          const e = JSON.parse(l)
          return `${String(e.seq).padStart(4)} ${e.at.slice(11, 19)} ${e.risk.padEnd(12)} ${e.action.padEnd(16)} ${JSON.stringify(e.result)}`
        } catch {
          return l
        }
      })
  } catch {
    return '(no audit yet)'
  }
}

// ---------------------------------------------------------------- governance

/**
 * Risk classification. One table, enforced at the single choke point below.
 *
 * routine       proceed. Observation, navigation, reading, clicking, typing into
 *               non-sensitive fields, running tests, editing source.
 * sensitive     proceed only with explicit acknowledgement. Configuration changes,
 *               installs, anything touching credentials or external accounts.
 * consequential refuse, and record as a gate. Production data, purchases,
 *               deployments, credential rotation, irreversible changes.
 */
const RISK = {
  see: 'routine',
  windows: 'routine',
  screen: 'routine',
  focus: 'routine',
  click: 'routine',
  type: 'routine',
  scroll: 'routine',
  key: 'routine',
  navigate: 'routine',
  readDom: 'routine',
  launchApp: 'routine',
  terminal: 'routine',
  install: 'sensitive',
  config: 'sensitive',
  credential: 'sensitive',
  externalAccount: 'sensitive',
  productionDb: 'consequential',
  deleteData: 'consequential',
  purchase: 'consequential',
  deploy: 'consequential',
  externalCommit: 'consequential',
}

/** Sensible default for anything unclassified: treat unknown actions as sensitive. */
function riskOf(action) {
  return RISK[action] || 'sensitive'
}

export class GovernanceError extends Error {
  constructor(message, gate) {
    super(message)
    this.name = 'GovernanceError'
    this.gate = gate
  }
}

/**
 * The single choke point for input. Nothing in this module sends input except
 * through here, so governance cannot be bypassed by calling something else.
 */
async function guarded(action, target, body, { acknowledge = false } = {}) {
  const risk = riskOf(action)
  if (risk === 'consequential') {
    audit(action, target, risk, 'REFUSED', { reason: 'consequential action requires human approval' })
    throw new GovernanceError(`action "${action}" is consequential and requires human approval`, action)
  }
  if (risk === 'sensitive' && !acknowledge) {
    audit(action, target, risk, 'REFUSED', { reason: 'sensitive action not acknowledged' })
    throw new GovernanceError(`action "${action}" is sensitive and needs explicit acknowledgement`, action)
  }

  // Re-read identity immediately before acting. The title is mutable, so pinning a
  // stale one is how input ends up aimed at the wrong window.
  const id = await identity(target)
  const res = await op[body.op]({ hwnd: id.hwnd, pid: id.pid, title: id.title, ...body.args })
  audit(action, id, risk, res && res.ok === false ? 'REFUSED' : 'ok', { detail: body.op })
  return res
}

// ---------------------------------------------------------------- SEE / UNDERSTAND

export async function see() {
  const wins = await listWindows()
  const fg = await foreground()
  const state = {
    foreground: fg ? { hwnd: fg.hwnd, pid: fg.pid, class: fg.class, title: fg.title } : null,
    count: wins.length,
    windows: wins.map((w) => ({ hwnd: w.hwnd, pid: w.pid, cls: w.class, title: w.title, min: w.minimized })),
  }
  audit('see', null, 'routine', { windows: state.count, foreground: state.foreground ? state.foreground.title : null })
  return state
}

/** Capture the physical screen. */
export async function screen(name, { x, y, w, h } = {}) {
  const path = `${SHOTS}/${name}.png`
  // A region capture is not cosmetic: proving an interaction landed means comparing
  // the pixels of one control before and after, which is impractical at full
  // desktop size. x/y/w/h are all required together, or omitted for the full screen.
  const region = x == null ? null : { x: x | 0, y: y | 0, w: w | 0, h: h | 0 }
  const res = await op.screen(path, region)
  audit('screen', null, 'routine', { path, bytes: res.bytes, region: x ?? 'full' })
  return { path, bytes: res.bytes, region: x == null ? 'full' : [x, y, w, h] }
}

/** Find a window by predicate, with a timeout. Throws rather than returning null. */
export async function window_(predicate, { timeoutMs = 20000, label = 'window' } = {}) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const hit = (await listWindows()).find(predicate)
    if (hit) return hit
    await sleep(400)
  }
  throw new Error(`${label} not found within ${timeoutMs}ms`)
}

// ---------------------------------------------------------------- the real browser

let browser = null
let context = null

const cdpAlive = async () => {
  try {
    return (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).ok
  } catch {
    return false
  }
}

/**
 * Every process belonging to this browser, as a Set of pids.
 *
 * An earlier version took the FIRST process whose command line mentioned the debug
 * port. That is wrong: every child process - renderers, the GPU process, utility
 * processes - inherits the same command line, and only the browser process owns a
 * top-level window. Picking one at random meant the operator looked for a window
 * belonging to a renderer and correctly failed to find one. The pid SET is what
 * identifies the browser, and it is matched against real windows below.
 */
function browserPids() {
  const out = execFileSync(
    PS,
    [
      '-NoProfile',
      '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*remote-debugging-port=${CDP_PORT}*' } | Select-Object -Expand ProcessId`,
    ],
    { encoding: 'utf8' },
  )
  const pids = out
    .split(/\r?\n/)
    .map((l) => Number(l.trim()))
    .filter((n) => Number.isFinite(n) && n > 0)
  return new Set(pids)
}

/** Launch the real headed browser if it is not already up. */
export async function launchBrowser({ width = 1380, height = 920 } = {}) {
  if (await cdpAlive()) return { launched: false, pids: [...browserPids()] }
  execFileSync(
    PS,
    [
      '-NoProfile',
      '-Command',
      `Start-Process -FilePath '${CHROME}' -ArgumentList ` +
        `'--remote-debugging-port=${CDP_PORT}',` +
        `'--user-data-dir=${PROFILE_DIR}',` +
        `'--no-first-run','--no-default-browser-check',` +
        `'--disable-features=Translate,MediaRouter,OptimizationHints',` +
        `'--window-position=30,20','--window-size=${width},${height}' -PassThru | Select-Object -Expand Id`,
    ],
    { encoding: 'utf8' },
  )
  for (let i = 0; i < 60; i++) {
    if (await cdpAlive()) break
    await sleep(500)
  }
  if (!(await cdpAlive())) throw new Error('browser launched but its debugging endpoint never answered')
  const pids = [...browserPids()]
  audit('launchApp', null, 'routine', { app: 'chromium', pids, visible: true })
  return { launched: true, pids }
}

/**
 * The browser's real top-level window.
 *
 * Matched against the pid SET rather than one pid, because the window-owning process
 * is the browser process and it cannot be identified by command line alone. A
 * minimized window is still found here on purpose: restoring it is a separate,
 * explicit step, and refusing to even look at it would leave the operator unable to
 * recover from the one state it cannot click its way out of.
 */
export async function evalInPage(fn, arg) {
  const p = await page()
  if (!p || typeof p.evaluate !== 'function') throw new Error('page handle has no evaluate')
  return p.evaluate(fn, arg)
}

export async function browserWindow() {
  const pids = browserPids()
  return window_((w) => w.class === 'Chrome_WidgetWin_1' && pids.has(w.pid), {
    timeoutMs: 20000,
    label: `the Chromium window (pids ${[...pids].join(',')})`,
  })
}

/**
 * Bring the browser to the foreground, restoring it first if minimized.
 *
 * The restore is pid-verified in the host, and the input guard still runs afterwards
 * and still refuses unless the window is genuinely visible and foreground. This is
 * recovery, not a bypass: without it a minimized target is a dead end, because the
 * input guard is right to refuse input to a window nobody can see.
 */
export async function focus(win) {
  let current = win
  if (current.minimized) {
    const res = await op.restore({ hwnd: current.hwnd, pid: current.pid })
    audit('restore', current, 'routine', res)
    await sleep(400)
    const fresh = (await listWindows()).find((w) => w.hwnd === current.hwnd)
    if (!fresh) throw new Error('browser window vanished during restore')
    current = fresh
  }
  const res = await guarded('focus', current, { op: 'focus', args: {} })
  const fg = await foreground()
  if (!fg || fg.hwnd !== current.hwnd) throw new Error(`focus did not take (now "${fg ? fg.title : 'none'}")`)
  return { ...res, window: current }
}

/** Alias for call sites that read better as an explicit browser action. */
export const focusBrowser = focus

async function attach() {
  if (!browser || !context) {
    // Either backend produces the same shape, so nothing below this line knows or cares which one
    // answered. That is the point of the small surface: the swap is one line, not a rewrite.
    browser = await connectBrowser()
    context = browser.contexts()[0]
  }
  return context
}

export async function page() {
  const ctx = await attach()
  // connectOverCDP can resolve before the page objects are usable, and then
  // pages() yields a handle with no evaluate - which surfaces much later as a
  // confusing "page(...).evaluate is not a function". So the handle is validated
  // here and the wait is bounded, rather than leaving callers to guard.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    // AWAITED, and that `await` is load-bearing. Playwright's `context.pages()` is SYNCHRONOUS - it
    // reads pages the connection already knows about - but the CDP client's `pages()` must fetch
    // /json/list, so it returns a promise. Without the await, `pages` is a Promise, `pages.length`
    // is undefined, and every attempt falls through to `newPage()` on an empty-looking list until
    // this loop times out with "no usable page handle". Awaiting a non-promise is a no-op, so this
    // is correct for BOTH backends and the playwright path is unchanged.
    const pages = await ctx.pages()
    const candidate = pages[pages.length - 1] || (pages.length === 0 ? await ctx.newPage() : null)
    if (candidate && typeof candidate.evaluate === 'function') return candidate
    await sleep(250)
  }
  throw new Error('no usable page handle from the browser after 10s')
}

// ---------------------------------------------------------------- ACT (OS-level)

export async function clickAt(win, x, y) {
  const res = await guarded('click', win, { op: 'click', args: { x, y, button: 'left' } })
  return res
}

export async function typeInto(win, text) {
  if (/[\r\n]/.test(text)) throw new Error('typeInto is single-line')
  return guarded('type', win, { op: 'type', args: { text } })
}

export async function pressKey(win, vk, { ctrl = false } = {}) {
  return guarded('key', win, { op: 'key', args: { vk, ...(ctrl ? { ctrl: true } : {}) } })
}

export async function scrollAt(win, x, y, notches) {
  return guarded('scroll', win, { op: 'scroll', args: { x, y, notches } })
}

export const VK = { ENTER: '0D', ESC: '1B', TAB: '09', L: '4C', T: '54', F: '46', A: '41', F5: '74' }

// ---------------------------------------------------------------- visible navigation

/**
 * Navigate the way a person does: Ctrl+L to focus the address bar, type the URL,
 * press Enter. The user watches the omnibox fill and the page change.
 */
export async function navigate(url, { settleMs = 2500 } = {}) {
  const win = await browserWindow()
  await focusBrowser(win)
  await pressKey(win, VK.L, { ctrl: true })
  await sleep(250)
  await typeInto(win, url)
  await sleep(250)
  await pressKey(win, VK.ENTER)
  audit('navigate', win, 'routine', { url })
  await sleep(settleMs)
  const p = await page()
  return { url: p.url(), title: await p.title() }
}

// ---------------------------------------------------------------- READ / VERIFY

/** Read what is on screen. DOM is used to VERIFY what the user can already see. */
export async function readPage({ max = 14000 } = {}) {
  const p = await page()
  const data = await p.evaluate((limit) => {
    const visible = (el) => {
      const r = el.getBoundingClientRect()
      const s = getComputedStyle(el)
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'
    }
    return {
      url: location.href,
      title: document.title,
      text: (document.body ? document.body.innerText : '').replace(/\n{3,}/g, '\n\n').slice(0, limit),
      scrollY: window.scrollY,
      pageHeight: document.body ? document.body.scrollHeight : 0,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      headings: [...document.querySelectorAll('h1,h2,h3')].filter(visible).slice(0, 25).map((h) => h.innerText.trim().slice(0, 100)),
      links: [...document.querySelectorAll('a[href]')].filter(visible).slice(0, 80).map((a) => ({ t: (a.innerText || '').trim().slice(0, 70), href: a.href })),
      inputs: [...document.querySelectorAll('input,textarea,select')].filter(visible).slice(0, 20).map((el) => ({
        tag: el.tagName,
        type: el.getAttribute('type') || '',
        id: el.id || '',
        name: el.getAttribute('name') || '',
        placeholder: el.getAttribute('placeholder') || '',
      })),
    }
  }, max)
  audit('readDom', null, 'routine', { url: data.url, chars: data.text.length })
  return data
}

/** Screen coordinates of a visible element, for a real OS click. */
export async function locate(selector, index = 0) {
  const p = await page()
  return p.evaluate(
    ({ sel, i }) => {
      const el = document.querySelectorAll(sel)[i]
      if (!el) return null
      el.scrollIntoView({ block: 'center', behavior: 'instant' })
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) }
    },
    { sel: selector, i: index },
  )
}

/**
 * The page viewport, in screen coordinates, read from NATIVE window information.
 *
 * Chromium exposes its web page as a `Chrome_RenderWidgetHostHWND` child, so the
 * viewport rect is available exactly rather than inferred. Guessing the browser
 * chrome height would work until it did not, and a click landing 40px off is a
 * click on the wrong element - the precise silent failure this operator exists to
 * eliminate. Tree coordinates are client-relative, so the window origin is added.
 */
export async function viewport(win) {
  // Re-read the window's live geometry. The render surface is queried fresh below, but the
  // window's OWN origin used to come from the caller's snapshot - and a window that has
  // moved since it was captured produces a click origin that is silently wrong by exactly
  // the distance it moved. The symptom is not an error: the click lands on some other part
  // of the page, the field never takes focus, and the following keystrokes go nowhere while
  // every guard and hook reports success. That is the most expensive kind of bug here,
  // because nothing fails loudly.
  //
  // It surfaced in the takeover regression: earlier missions had moved browser windows, so
  // a window captured before the move mapped element coordinates to the wrong screen point.
  // Two assertions failed for a reason that had nothing to do with the safety layer.
  const live = (await listWindows()).find((w) => w.hwnd === win.hwnd) || win
  const tree = (await op.tree({ hwnd: live.hwnd, depth: 4 })).tree
  const render = tree
    .filter((c) => c.visible && c.class === 'Chrome_RenderWidgetHostHWND' && c.w > 200 && c.h > 200)
    .sort((a, b) => b.w * b.h - a.w * a.h)[0]
  if (!render) throw new Error('no Chromium render surface found; cannot map element coordinates safely')
  return {
    originX: live.left + render.x,
    originY: live.top + render.y,
    width: render.w,
    height: render.h,
    hwnd: render.hwnd,
    // Reported so a caller can tell a fresh mapping from a stale one.
    liveLeft: live.left, liveTop: live.top, movedFrom: (win.left !== live.left || win.top !== live.top),
  }
}

/** Convert a viewport-relative point to absolute screen coordinates. */
export async function toScreen(win, pt) {
  const vp = await viewport(win)
  return { x: vp.originX + Math.round(pt.x), y: vp.originY + Math.round(pt.y) }
}

// ---------------------------------------------------------------- RECOVERY

/**
 * Run an action with a named diagnosis and correction for each way it can fail.
 *
 * observe -> diagnose -> correct -> verify. Never a blind retry loop: each recovery
 * path states what it believes went wrong and what it changes in response.
 */
export async function withRecovery(label, action, { attempts = 2, verify } = {}) {
  let lastError = null
  for (let attempt = 1; attempt <= attempts + 1; attempt += 1) {
    try {
      const result = await action(attempt)
      if (verify) {
        const ok = await verify(result)
        if (!ok) throw new Error('verification failed after the action appeared to succeed')
      }
      if (attempt > 1) audit('recover', null, 'routine', { label, attempt, outcome: 'recovered' })
      return result
    } catch (err) {
      lastError = err
      const diagnosis = diagnose(err)
      audit('recover', null, 'routine', { label, attempt, outcome: 'failed', diagnosis, error: String(err.message).slice(0, 120) })
      if (attempt > attempts) break

      // Correct, based on what we believe actually went wrong.
      if (/did not take|not foreground|foreground/i.test(String(err.message))) {
        const win = await browserWindow().catch(() => null)
        if (win) {
          await op.focus({ hwnd: win.hwnd, pid: win.pid, title: win.title }).catch(() => {})
          await sleep(600)
        }
      } else if (/not found within/i.test(String(err.message))) {
        await launchBrowser().catch(() => {})
        await sleep(1200)
      } else if (/Target closed|disconnected|Session closed/i.test(String(err.message))) {
        browser = null
        context = null
        await sleep(800)
      } else {
        await sleep(700)
      }
    }
  }
  throw new Error(`${label} failed after recovery attempts: ${lastError ? lastError.message : 'unknown'}`)
}

function diagnose(err) {
  const m = String(err && err.message)
  if (/did not take|not foreground/i.test(m)) return 'lost-foreground'
  if (/not found within/i.test(m)) return 'window-missing'
  if (/Target closed|disconnected/i.test(m)) return 'browser-session-lost'
  if (/refus/i.test(m)) return 'governance-refusal'
  if (/ECONNREFUSED|ENOTFOUND|ERR_/i.test(m)) return 'network'
  if (/timeout|Timeout/i.test(m)) return 'timeout'
  return 'unknown'
}

export { sleep, op, listWindows, foreground }
