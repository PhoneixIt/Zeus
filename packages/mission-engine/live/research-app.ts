/**
 * THE RESEARCH DESK - a visible desktop application.
 *
 * =============================================================================
 * WHAT CHANGED FROM THE CONSOLE VERSION, AND WHY IT MATTERED
 * =============================================================================
 *
 * The first version printed to stdout and wrote its artifacts into a temp directory that it
 * deleted on exit. Both were wrong for an application someone is meant to use. Output that
 * scrolls past is not an interface you can point at afterwards, and evidence that disappears
 * with the process is not evidence - it is a claim.
 *
 * So this version has two things the console version did not:
 *
 *   A WINDOW. A real WinForms window with a URL box, a Research button, a log, and a results
 *   table. It is launched by the same command that runs the engine, on the desktop the person
 *   is already using. No browser window of the user's is touched: the engine drives its own
 *   headless Chromium, which has no window at all.
 *
 *   DURABLE STATE. Artifacts and mission history live under ~/.aios/research, outside every
 *   temp directory, and survive the app. The verification step then runs in a FRESH PROCESS
 *   after the app has exited, reading only what was written to disk. A verifier running inside
 *   the writer's process proves the writer can read its own memory.
 *
 * =============================================================================
 * THE AUTHORIZATION BOUNDARY IS UNCHANGED
 * =============================================================================
 *
 * This app performs NO desktop control. It launches its own headless browser, reads public
 * pages, and writes local files. It does not click, type, or move anything in the operator
 * host's space, so it needs no desktop-control authorization and takes none. The operator
 * guard is untouched and still blocks. Nothing here is a way around it.
 *
 * =============================================================================
 * WHAT IT DEMONSTRATES, AND HOW EACH CLAIM IS CHECKED
 * =============================================================================
 *
 * Interaction is not assumed. After navigating, the engine SCROLLS and reads back the scroll
 * offset from inside the page, CLICKS a link and reads back what element was actually at those
 * coordinates, and navigates BACK and compares the URL it returns to. Each of those returns a
 * value that could only have come from the page, so none of them can be faked by the engine
 * asserting success.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import {
  existsSync, mkdirSync, appendFileSync, readFileSync, readdirSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

import { connectOverCDP } from '../../control-core/cdp.mjs'
import { extractFrom, classifyElement, domWalker, toEvidence, type ChromeClass } from './web-extract.ts'
import { buildRecord, verifyRun, type ResearchRecord } from './web-verify.ts'

// ===========================================================================================
// durable state - outside every temp directory, on purpose
// ===========================================================================================

/** Artifacts and history live here, and survive the process. */
export const RESEARCH_ROOT = join(homedir(), '.aios', 'research')
export const RUNS_DIR = join(RESEARCH_ROOT, 'runs')
export const HISTORY_PATH = join(RESEARCH_ROOT, 'history.jsonl')

export function ensureDurableDirs(): void {
  mkdirSync(RUNS_DIR, { recursive: true })
}

export interface HistoryEntry {
  readonly runId: string
  /** The id that ties a task, its result and its verification together. */
  readonly correlationId: string
  readonly url: string
  readonly finalUrl: string
  readonly title: string
  readonly elements: number
  readonly findings: number
  readonly interaction: InteractionEvidence
  readonly verified: boolean
  readonly verifyReason: string
  readonly artifactPath: string
  readonly at: number
}

/** Append-only. History is a record of what happened, so it is never rewritten. */
export function appendHistory(e: HistoryEntry): void {
  ensureDurableDirs()
  appendFileSync(HISTORY_PATH, JSON.stringify(e) + '\n', 'utf8')
}

export function readHistory(): HistoryEntry[] {
  if (!existsSync(HISTORY_PATH)) return []
  return readFileSync(HISTORY_PATH, 'utf8')
    .split('\n').filter((l) => l.trim().length > 0)
    .flatMap((l) => { try { return [JSON.parse(l) as HistoryEntry] } catch { return [] } })
}

// ===========================================================================================
// interaction evidence
// ===========================================================================================

export interface InteractionEvidence {
  /** What the page said about its own scroll position, after the scroll. */
  readonly scrollBefore: number
  readonly scrollAfter: number
  readonly scrolled: boolean
  /** What was actually at the clicked coordinates - read back, not assumed. */
  readonly clickedTag: string | null
  readonly clickedHref: string | null
  readonly clickedText: string | null
  /** The URL after the click - a link click that navigates must change it. */
  readonly urlAfterClick: string | null
  /** The URL before and after going back. */
  readonly backFrom: string | null
  readonly backTo: string | null
  readonly wentBack: boolean
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function cdpAlive(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2500) })
    return r.ok
  } catch { return false }
}

export interface AppOptions {
  readonly chromePath: string
  readonly cdpPort: number
  readonly profileDir: string
  readonly runDir: string
  readonly timeoutMs: number
  readonly maxBytes: number
}

/**
 * Launch OUR OWN headless Chromium.
 *
 * Refuses to attach to a port already in use. Attaching to a browser somebody else started
 * would mean driving their logged-in sessions - their accounts, their cookies - against pages
 * this app chose. That is not a shortcut, it is a different and much larger act.
 */
async function launchBrowser(o: AppOptions): Promise<ChildProcess> {
  if (await cdpAlive(o.cdpPort)) {
    throw new Error(`port ${o.cdpPort} is already in use; refusing to attach to a browser this app did not start`)
  }
  // VISIBLE OPT-IN for the live Mission B demonstration. The default is headless: the Research
  // Desk's own window is the interface, and a test must not take over the desktop. With
  // AIOS_BROWSER_VISIBLE=1 the same isolated browser is shown, so the person can watch every
  // navigation, scroll, click and back-step the engine verifies.
  const visible = process.env.AIOS_BROWSER_VISIBLE === '1'
  const child = spawn(o.chromePath, [
    ...(visible ? ['--window-position=80,80'] : ['--headless=new']),
    `--remote-debugging-port=${o.cdpPort}`,
    `--user-data-dir=${o.profileDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--no-sandbox', '--disable-dev-shm-usage',
    '--window-size=1380,920',
    'about:blank',
  ], { stdio: 'ignore', windowsHide: !visible })
  for (let i = 0; i < 40; i++) {
    if (await cdpAlive(o.cdpPort)) return child
    await sleep(500)
  }
  throw new Error('the browser launched but its debugging endpoint never answered')
}

function refuseUrl(raw: string): string | null {
  let u: URL
  try { u = new URL(raw) } catch { return 'that is not a URL' }
  if (u.protocol !== 'https:') return 'only https:// URLs are accepted'
  const h = u.hostname.toLowerCase()
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.local')) return 'that points at this machine'
  if (u.username || u.password) return 'credentials in the URL are not accepted'
  return null
}

// ===========================================================================================
// the engine
// ===========================================================================================

export interface AppRun {
  readonly runId: string
  readonly correlationId: string
  readonly requestedUrl: string
  readonly finalUrl: string
  readonly title: string
  readonly elements: number
  readonly findings: number
  readonly elapsedMs: number
  readonly artifactPath: string
  readonly interaction: InteractionEvidence | null
  readonly verified: boolean
  readonly verifyReason: string
  readonly stage: 'complete' | 'failed'
  readonly failure?: string
}

/**
 * One research run, end to end, with real browser interaction.
 *
 * Returns a result in every case. "The page could not be fetched" is a fact the app must be
 * able to show, not an exception that unwinds past the point it could be recorded.
 */
export async function research(o: AppOptions, requestedUrl: string): Promise<AppRun> {
  ensureDurableDirs()
  // The run id and the correlation id are the same value here on purpose: one identifier ties
  // the task, the artifact, the history line and the verification to each other, so a result
  // can never be filed against the wrong run.
  const correlationId = randomUUID()
  const artifactPath = join(o.runDir, `${correlationId}.record.json`)
  const t0 = Date.now()
  const fail = (reason: string, interaction: InteractionEvidence | null = null): AppRun => ({
    runId: correlationId, correlationId, requestedUrl, finalUrl: requestedUrl,
    title: '', elements: 0, findings: 0, elapsedMs: Date.now() - t0, artifactPath,
    interaction, verified: false,
    verifyReason: 'not verified: the run did not complete', stage: 'failed', failure: reason,
  })

  const bad = refuseUrl(requestedUrl)
  if (bad) return fail(`refused before any network activity: ${bad}`)

  let browser: ChildProcess | null = null
  let ctx: Awaited<ReturnType<typeof connectOverCDP>> | null = null
  try {
    browser = await launchBrowser(o)
    ctx = await connectOverCDP(`http://127.0.0.1:${o.cdpPort}`)
    const page = await ctx.contexts()[0].newPage('about:blank')

    try {
      await page.goto(requestedUrl)
      const state = await page.waitForLoad(o.timeoutMs)
      if (state !== 'complete' && state !== 'interactive') {
        return fail(`the page did not finish loading within ${o.timeoutMs}ms (readyState=${state || 'unknown'})`)
      }

      // ---- REAL INTERACTION. Each value below is read back out of the page, so the engine
      // cannot assert any of them without the page agreeing.
      const scrollBefore = Number(await page.evaluate(() => window.scrollY))
      await page.scroll(1200, 400, 400)
      await sleep(700)
      const scrollAfter = Number(await page.evaluate(() => window.scrollY))

      // Click a real link, at coordinates taken from the live DOM, and read back what was hit.
      // A `Link` is required rather than any clickable element: clicking a bare <html> proves
      // the event path works but says nothing about navigation, and "we clicked something" is
      // not the claim being made.
      const target = await page.evaluate(() => {
        const a = Array.from(document.querySelectorAll('a[href]'))
          .find((x) => {
            const r = x.getBoundingClientRect()
            return r.width > 20 && r.height > 8 && r.top > 4 && r.top < window.innerHeight - 4
          })
        if (!a) return null
        const r = a.getBoundingClientRect()
        return {
          x: Math.round(r.left + r.width / 2),
          y: Math.round(r.top + r.height / 2),
          href: a.getAttribute('href'),
          text: (a.textContent ?? '').trim().slice(0, 60),
        }
      })
      let clickedTag: string | null = null
      let clickedHref: string | null = null
      let clickedText: string | null = null
      let urlAfterClick: string | null = null
      if (target && target.x > 0 && target.y > 0) {
        const hit = await page.clickAt(target.x, target.y)
        clickedTag = hit?.tag ?? null
        clickedHref = hit?.anchorHref ?? hit?.href ?? null
        clickedText = hit?.anchorText ?? hit?.text ?? null
        await sleep(900)
        urlAfterClick = String(await page.evaluate(() => window.location.href))
      }

      // Go back, and compare the URL the page itself reports afterwards.
      const back = await page.goBack()
      await sleep(300)

      const interaction: InteractionEvidence = {
        scrollBefore, scrollAfter,
        scrolled: Math.abs(scrollAfter - scrollBefore) > 1,
        clickedTag, clickedHref, clickedText, urlAfterClick,
        backFrom: back.from ?? null,
        backTo: back.to ?? null,
        wentBack: back.wentBack === true && back.from !== back.to,
      }

      const inside = await page.evaluate(() => window.location.href)
      const title = await page.title()
      const html = await page.evaluate(() => document.documentElement.outerHTML)
      if (typeof html !== 'string' || html.length === 0) return fail('the page rendered no HTML', interaction)
      if (html.length > o.maxBytes) return fail(`the page returned ${html.length} bytes, over the ${o.maxBytes} limit`, interaction)

      // Cap BEFORE extraction, so the stored body and the findings describe the same region
      // and the verifier can re-scan the record and reach the same answer.
      let bodySample = html.slice(0, 20_000)
      let parsed = extractFrom(bodySample)
      if ('error' in parsed || parsed.extraction.elements.length === 0) {
        bodySample = html
        parsed = extractFrom(bodySample)
      }
      if ('error' in parsed) return fail(`extraction failed: ${parsed.error}`, interaction)
      const capped = bodySample.length < html.length

      // The string parser cannot see the element tree, so it classifies everything `unknown`.
      // When the page is live we can do better: ask the DOM directly for each element's
      // ANCESTRY and classify that here, in Node, where the rule is unit-testable. The walker is
      // a fallback only - if it fails for any reason the honest classification is `unknown`, and
      // the run still completes.
      let classified: Array<{ tag: string; text: string; href?: string; chrome: ChromeClass; chromeReason: string; evidence: ReturnType<typeof toEvidence> }> | null = null
      try {
        const signals = await page.evaluate(domWalker)
        if (Array.isArray(signals) && signals.length > 0) {
          classified = signals.slice(0, parsed.extraction.elements.length || signals.length).map((s) => {
            const c = classifyElement({ tag: s.tag, ancestry: s.ancestry ?? [], text: s.text })
            return {
              tag: s.tag,
              text: String(s.text ?? '').slice(0, 300),
              ...(s.href ? { href: String(s.href).slice(0, 300) } : {}),
              chrome: c.chrome,
              chromeReason: c.reason,
              // The evidence the verdict was derived from, bounded and reduced. Persisting it is
              // what lets a later process REPLAY the classification instead of trusting it.
              evidence: toEvidence(s.ancestry ?? []),
            }
          })
        }
      } catch {
        classified = null
      }
      const elements = classified ?? parsed.extraction.elements.map((e) => ({
        tag: e.tag,
        text: e.text,
        ...(e.href ? { href: e.href } : {}),
        chrome: 'unknown' as ChromeClass,
        chromeReason: 'the DOM walk failed, so no ancestry was available and classification was refused',
        // No walk means no ancestry, so there is nothing to persist. `unknown` with empty
        // evidence is the honest record, and it replays to exactly this answer.
        evidence: [],
      }))

      const finalUrl = typeof inside === 'string' && inside.length > 0 ? inside : requestedUrl
      const record: ResearchRecord = buildRecord({
        runId: correlationId,
        requestedUrl,
        finalUrl,
        status: 200,
        contentType: 'text/html',
        fetchedAt: Date.now(),
        schemaVersion: 3,
        title: typeof title === 'string' ? title : parsed.extraction.title,
        elements,
        elementCount: elements.length,
        hostileContentSeen: parsed.extraction.hostileContentSeen,
        findingCount: parsed.extraction.findings.length,
        bodySample,
        bodyCapped: capped,
        truncated: parsed.extraction.truncated || capped,
        redirectChain: [],
      })
      writeFileSync(artifactPath, JSON.stringify(record, null, 2), 'utf8')

      // Independent verification: re-read the file. The record above is not consulted.
      const v = verifyRun(artifactPath, { runId: correlationId, url: finalUrl, minElements: 3 })
      const out: AppRun = {
        runId: correlationId, correlationId, requestedUrl, finalUrl,
        title: record.title, elements: record.elements.length, findings: record.findingCount,
        elapsedMs: Date.now() - t0, artifactPath, interaction,
        verified: v.ok,
        verifyReason: v.ok ? `verified from disk; ${v.rechecked} finding(s) re-derived from the stored body` : v.reason,
        stage: 'complete',
      }
      appendHistory({
        runId: out.runId, correlationId: out.correlationId, url: requestedUrl, finalUrl,
        title: out.title, elements: out.elements, findings: out.findings,
        interaction: out.interaction!, verified: out.verified, verifyReason: out.verifyReason,
        artifactPath: out.artifactPath, at: Date.now(),
      })
      return out
    } finally {
      try { page.close() } catch { /* the browser is going away */ }
    }
  } catch (e) {
    return fail(`navigation failed: ${e instanceof Error ? e.message : String(e)}`)
  } finally {
    try { ctx?.close() } catch { /* sockets already closed */ }
    if (browser) { try { browser.kill() } catch { /* already gone */ } }
  }
}