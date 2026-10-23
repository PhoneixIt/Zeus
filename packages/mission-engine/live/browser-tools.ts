/**
 * BROWSER-TOOLS - the narrowest read-only browser capability that makes a real mission possible.
 *
 * =============================================================================
 * WHY THIS EXISTS
 * =============================================================================
 *
 * `browser:smoke` proved the browser can be driven: Chromium launches, CDP attaches, a page renders
 * and `readPage()` returns real DOM. That is a CAPABILITY PROOF, deliberately separated from a
 * mission - and a capability no plan can name is not a capability the system has.
 *
 * There was no `browser.*` entry in the capability vocabulary at all (seven entries, all filesystem
 * or terminal), so the smallest honest integration is to add exactly ONE and register it through the
 * existing `ToolRegistry`. Not a browser package. Not an OS-control capability. One read.
 *
 * =============================================================================
 * WHY `packages/browser` IS NOT WHERE THIS LIVES
 * =============================================================================
 *
 * That directory is empty, and it was empty before this change. The browser implementation is
 * `control-core/operator.mjs` over `control-core/cdp.mjs`, and it is proven. Creating a second
 * package would have been a parallel architecture, so this lives beside `file-tools.ts` - the other
 * set of mission-facing tools - and calls the proven operator path.
 *
 * =============================================================================
 * WHAT IS DELIBERATELY ABSENT
 * =============================================================================
 *
 * No click. No keystroke. No `page.goto()` to anywhere the caller did not name. No new authority.
 * The only browser action here is READ what is already rendered. Every one of those would be a
 * separate capability with its own governance argument, and this milestone does not need them.
 *
 * =============================================================================
 * PAGE CONTENT IS UNTRUSTED DATA - THE MOST IMPORTANT PROPERTY HERE
 * =============================================================================
 *
 * A page is written by whoever controls the server. The moment its text enters this system it is in
 * the same position as a file handed to `read-input-file`: DATA to be measured and reported, never
 * instructions to be obeyed.
 *
 * So two things are enforced, not merely documented:
 *
 *   1. The returned payload is STRUCTURED, and every field is typed and length-bounded. Nothing is
 *      evaluated, and no page string is ever concatenated into a command, a path, or a query.
 *   2. Page text is scanned for INJECTION SHAPES, and when one is present it is REPORTED AS DATA in a
 *      field the caller must carry - not executed, not obeyed, and not silently dropped. Dropping it
 *      would be as dishonest as obeying it: the mission would then have read a page containing
 *      instructions and reported nothing about it.
 *
 * The `untrustedNotice` field is the mechanism. It travels with the data into the summary, so the
 * written artifact records that the page tried to issue instructions and that they were not obeyed.
 */

import type { Tool, ToolContext, ToolResult, Verifier } from '../executor.ts'
import type { ToolRegistration } from '../../tool-router/router.ts'
import {
  checkDestination, checkFinalDestination, DEFAULT_NAVIGATION_POLICY, type NavigationPolicy,
} from './navigation-policy.ts'
import { sha256 } from './folder-tools.ts'
import type { Evidence, Step } from '../state.ts'

/** Bound everything. A page must not be able to exhaust memory by being large. */
export const MAX_PAGE_TEXT = 20_000
export const MAX_PAGE_ELEMENTS = 60

/**
 * Injection shapes. Deliberately about SHAPE, not about keywords.
 *
 * A word list would fire on any article about prompt injection and miss every real attempt, because
 * real attempts are phrased as helpfulness. What is actually dangerous is a pattern: imperative
 * text addressed at a system, claiming authority, and requesting a change of permission. Those
 * shapes are rare in ordinary prose and common in attacks.
 */
const INJECTION_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'disregard-prior-instructions', re: /\b(?:ignore|disregard|forget|override)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|all)\b[^.\n]{0,24}\b(?:instruction|instructions|prompt|rule|rules|direction)\w*/i },
  { name: 'claims-system-authority', re: /\byou are (?:now )?(?:an? )?(?:admin|administrator|root|developer|system|the assistant)\b|\bthis is (?:a )?(?:system|admin|developer) (?:message|instruction|prompt)\b|\bas (?:the )?(?:system|administrator|developer)\b[,:]/i },
  // Same reasoning: the dangerous shape is permission being granted TO THE READER. An article that
  // merely mentions an administrator granting access to a report is not an attack.
  { name: 'requests-permission-change', re: /\b(?:grant|give|enable|allow|escalate|raise|assume)\s+(?:me|us|your|my|the (?:user|agent|assistant|model))\s+(?:full |all |elevated |unrestricted )?\b(?:permission|permissions|authority|privilege|privileges|admin|root|access)\w*/i },
  // The dangerous shape is an imperative ADDRESSED to the reader ("you must run..."), not a bare
  // verb. "Click Run to start the analysis" is button text on every page ever written, and flagging
  // it made the detector fire on ordinary UI copy - which is how a real injection alert gets ignored.
  { name: 'requests-tool-or-action', re: /\b(?:you must|you should|you need to|please)\s+(?:now\s+)?(?:run|execute|invoke|call|navigate|download|delete|overwrite|send|post|upload)\b/i },
  // The object must be a SECRET. "We send a confirmation email" is not exfiltration; "send the
  // session cookie" is. Keying on the verb alone flagged every transactional web page.
  { name: 'exfiltrate-data', re: /\b(?:send|post|transmit|exfiltrate|leak|email)\b[^.\n]{0,30}\b(?:token|credential|password|secret|api[_ ]?key|cookie|session[_ ]?id)\w*/i },
  { name: 'reveal-prompt', re: /\b(?:reveal|print|show|repeat|output|display)\b[^.\n]{0,30}\b(?:your |the )?(?:system )?prompt\b|\bverbatim\b[^.\n]{0,20}\b(?:instruction|instructions)\b/i },
]

/** Everything the tool can return about a page. Bounded, typed, and never a live handle. */
export interface PageFacts {
  readonly url: string
  readonly title: string
  readonly text: string
  readonly characters: number
  readonly headings: ReadonlyArray<string>
  readonly links: ReadonlyArray<{ text: string; href: string }>
  readonly forms: number
  readonly inputs: number
  readonly truncated: boolean
}

/** A finding about the page's own text. Carried, reported, never acted on. */
export interface UntrustedNotice {
  readonly kind: 'page-instruction-attempt'
  readonly pattern: string
  readonly excerpt: string
}

/**
 * Scan page text for instruction-shaped content.
 *
 * Returns findings rather than a boolean, because "there was an attempt" and "there were three,
 * of these shapes" are different reports, and a mission that wrote the artifact should carry the
 * detail. Excerpts are truncated: enough to identify the attempt, not enough to paste a payload.
 */
export function scanForInstructions(text: string): UntrustedNotice[] {
  const out: UntrustedNotice[] = []
  for (const { name, re } of INJECTION_PATTERNS) {
    const m = re.exec(text)
    if (!m) continue
    out.push({
      kind: 'page-instruction-attempt',
      pattern: name,
      excerpt: m[0].replace(/\s+/g, ' ').slice(0, 120),
    })
  }
  return out
}

/**
 * Normalise whatever the operator returned into validated, bounded facts.
 *
 * Separated from the tool so the VERIFIER can re-derive facts from a fresh read and compare them,
 * exactly as `measureFile` is separated from `readInputFileTool` for files. A verifier that called
 * the tool would be checking the tool against itself.
 *
 * Every field is checked rather than cast. Page data crosses a trust boundary, and `as` on an
 * attacker-influenced value is how `undefined.length` becomes a crash inside a mission.
 */
export function normalisePage(raw: unknown): { facts: PageFacts; notices: UntrustedNotice[] } | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'the browser returned no page object' }
  const r = raw as Record<string, unknown>

  const url = typeof r.url === 'string' ? r.url : ''
  if (!url) return { error: 'the browser returned a page with no URL' }

  const title = typeof r.title === 'string' ? r.title.slice(0, 300) : ''
  const rawText = typeof r.text === 'string' ? r.text : ''
  if (typeof r.text !== 'string') return { error: 'the browser returned a page whose text was not a string' }

  const truncated = rawText.length > MAX_PAGE_TEXT
  const text = rawText.slice(0, MAX_PAGE_TEXT)

  const headings = Array.isArray(r.headings)
    ? r.headings.filter((h): h is string => typeof h === 'string').slice(0, 25).map((h) => h.slice(0, 120))
    : []

  const links = Array.isArray(r.links)
    ? r.links
      .filter((l): l is Record<string, unknown> => !!l && typeof l === 'object')
      .slice(0, MAX_PAGE_ELEMENTS)
      .map((l) => ({ text: String(l.t ?? l.text ?? '').slice(0, 80), href: String(l.href ?? '').slice(0, 400) }))
    : []

  const facts: PageFacts = {
    // NOT truncated. An earlier version sliced this to 500 characters, which silently broke identity
    // for any long URL: the verifier compares this against the destination the navigation step
    // landed on, and a real `data:text/html,...` fixture runs to several hundred characters. A
    // truncated identity is not a shorter one - it is a different value, and it made a successful
    // navigation fail verification.
    //
    // The upper bound is generous but real: the navigation policy caps `data:` URLs at 32k, so this
    // is a backstop for a page that reports an enormous URL of its own accord, not the normal path.
    url: url.slice(0, 65_536),
    title,
    text,
    characters: text.length,
    headings,
    links,
    forms: typeof r.forms === 'number' ? r.forms : 0,
    inputs: typeof r.inputs === 'number' ? r.inputs : 0,
    truncated,
  }

  return { facts, notices: scanForInstructions(text) }
}

/**
 * The reader. `readBrowser` is injected rather than imported directly.
 *
 * Two reasons, and the second is the important one. First, the unit tests must not need Chromium -
 * `npm test` cannot launch a browser. Second, and more importantly: if the tool imported
 * `operator.mjs` directly, there would be no seam at which the verifier could be given a DIFFERENT
 * reader than the tool used. The verifier's independence would then be an assertion about intent
 * rather than a property of the wiring. Injection makes "the verifier re-reads, and it is the same
 * operation" something the code can actually guarantee.
 */
export type PageReader = () => Promise<unknown>

/**
 * STEP 1 - read the current page.
 *
 * Read-only by construction: it takes no URL and navigates nowhere. It reports what is ALREADY
 * rendered. Navigating is a separate, separately-governed action and this milestone does not have it.
 */
export function makeBrowserReadTool(readBrowser: PageReader): Tool {
  return {
    name: 'read-browser-page',
    mode: 'filesystem',
    async run(_ctx: ToolContext, _args: Record<string, unknown>): Promise<ToolResult> {
      let raw: unknown
      try {
        raw = await readBrowser()
      } catch (e) {
        // A browser that is not there is an ordinary, reportable outcome - not an exception that
        // unwinds the mission with no explanation.
        return {
          kind: 'failed',
          reason: `the browser could not be read: ${e instanceof Error ? e.message : String(e)}`,
        }
      }
      const n = normalisePage(raw)
      if ('error' in n) return { kind: 'failed', reason: n.error }

      const summary = `read ${n.facts.url} (${n.facts.characters} chars${n.notices.length ? `, ${n.notices.length} untrusted notice(s)` : ''})`
      return {
        kind: 'data',
        data: { facts: n.facts, notices: n.notices },
        summary,
      }
    },
  }
}

/** STEP 2 - the disclosed summary. Deterministic: counts and structure, never interpretation. */
export function renderPageSummary(f: PageFacts, notices: UntrustedNotice[]): string {
  const lines = [
    `# Page summary: ${f.title || '(untitled)'}`,
    '',
    `- url: ${f.url}`,
    `- title: ${f.title || '(none)'}`,
    `- rendered characters: ${f.characters}${f.truncated ? '  (READ TRUNCATED at ' + MAX_PAGE_TEXT + ' characters)' : ''}`,
    `- headings: ${f.headings.length ? f.headings.map((h) => h.slice(0, 60)).join(' | ') : '(none)'}`,
    `- links: ${f.links.length}`,
    `- inputs: ${f.inputs}`,
    '',
  ]

  lines.push(
    'Provenance: deterministic structural facts read from the page the browser actually rendered.',
    'No language model read this page and no meaning was inferred. This says what the page CONTAINS,',
    'not what it is FOR. Every number is re-derivable by loading the same URL again.',
    '',
  )

  if (notices.length) {
    lines.push(
      'UNTRUSTED CONTENT NOTICE',
      'The page text contained instruction-shaped content. It was treated as DATA and was not obeyed:',
      '',
    )
    for (const n of notices) lines.push(`- ${n.pattern}: "${n.excerpt}"`)
    lines.push('')
  }

  return lines.join('\n')
}

/** STEP 3 - write the summary, refusing to overwrite. Same rule as `write-file-summary`. */
export function makeWritePageSummaryTool(): Tool {
  return {
    name: 'write-page-summary',
    mode: 'filesystem',
    async run(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { existsSync, writeFileSync } = await import('node:fs')
      const from = String(args.from ?? '')
      const src = ctx.prior?.[from]?.output as { text?: string } | undefined
      const text = src?.text
      const target = String(args.target ?? '')
      if (!text) return { kind: 'failed', reason: `no summary text available from step "${from}"` }
      if (!target) return { kind: 'failed', reason: 'no target given' }
      if (existsSync(target)) return { kind: 'failed', reason: `refusing to overwrite ${target}` }
      writeFileSync(target, text, 'utf8')
      return { kind: 'data', data: { target, text }, summary: `wrote ${target}` }
    },
  }
}

/** STEP 2's tool: turn read facts into the disclosed summary text. */
export function makeSummarisePageTool(): Tool {
  return {
    name: 'summarise-browser-page',
    mode: 'filesystem',
    async run(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
      const from = String(args.from ?? '')
      const src = ctx.prior?.[from]?.output as { facts?: PageFacts; notices?: UntrustedNotice[] } | undefined
      if (!src?.facts) return { kind: 'failed', reason: `no page facts available from step "${from}"` }
      const text = renderPageSummary(src.facts, src.notices ?? [])
      return { kind: 'data', data: { text, facts: src.facts, notices: src.notices ?? [] }, summary: `summarised ${src.facts.url}` }
    },
  }
}

/**
 * =============================================================================
 * GOVERNED NAVIGATION
 * =============================================================================
 * `browser.navigate` moves the browser. `browser.read` does not, and that difference is the whole
 * reason this needs its own tool, its own capability and its own approval.
 *
 * THREE INDEPENDENT GATES, and all three are required:
 *
 *   1. PREFLIGHT - `preflight` below. A destination the policy refuses is BLOCKED, and blocked with
 *      `needsHuman: false`. There is deliberately no approval that unlocks an arbitrary destination:
 *      widening where the system can reach is a change to the POLICY, which is a reviewed edit to a
 *      constant here - not something a mission or a human-in-the-loop can wave through.
 *
 *   2. APPROVAL - `effectOf` below. Every permitted navigation DECLARES an effect, so the executor's
 *      approval gate requires a human approval bound to mission + step + kind + target + plan epoch.
 *      A plan cannot authorise itself, and an approval for one destination does not carry to another.
 *
 *   3. RE-VALIDATION AFTER LANDING - the tool reads back `page.url()` and runs
 *      `checkFinalDestination` on it. A permitted destination that answered with a redirect to a
 *      prohibited one fails HERE, after the browser has already moved, and the step is reported as
 *      failed rather than quietly succeeding.
 *
 * The policy is a CONSTRUCTOR argument, never a step argument. A step can ask for a destination; it
 * cannot supply the rules that decide whether the destination is allowed.
 */

/** Effect kind used for a navigation. `external-send` is the closest of the six, chosen
 * conservatively so that a navigation can never be a "no effect" step and go ungated. */
const NAVIGATION_EFFECT_KIND = 'external-send' as const

export interface NavigateDeps {
  /** Navigate the browser and return the handle. Injected for tests; never for production shortcuts. */
  readonly navigate: (url: string) => Promise<{ url(): string }>
  /** The policy. Supplied at REGISTRATION time, so a plan cannot widen it. */
  readonly policy: NavigationPolicy
}

/**
 * The governed navigation tool.
 *
 * Returns an object carrying the tool plus the two gate hooks the executor consults, because the
 * executor reads them off the router rather than off the tool (`executor.ts` reads
 * `deps.tools.preflight` / `deps.tools.effectOf`). Registering this means registering a wrapper that
 * forwards those hooks - see `withNavigationGovernance` below, which the ToolRegistry consumes.
 */
export function makeNavigateTool(deps: NavigateDeps): Tool {
  return {
    name: 'navigate-browser',
    mode: 'filesystem',
    async run(_ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
      const destination = args.url

      // Re-checked HERE as well as in preflight. Belt and braces on purpose: the executor runs
      // preflight before tool selection, but a tool that trusts its own preflight has already lost
      // the property that made the gate worth having.
      const check = checkDestination(destination, deps.policy)
      if (!check.ok) return { kind: 'failed', reason: `navigation refused: ${check.reason}` }

      let landed: string
      try {
        const handle = await deps.navigate(String(destination))
        landed = handle.url()
      } catch (e) {
        return {
          kind: 'failed',
          reason: `navigation failed: ${e instanceof Error ? e.message : String(e)}`,
        }
      }

      // Gate 3: the browser has moved. Confirm WHERE it actually is before claiming success.
      const finalCheck = checkFinalDestination(landed, deps.policy)
      if (!finalCheck.ok) {
        return {
          kind: 'failed',
          reason: `navigation reached a destination the policy does not permit: ${finalCheck.reason} (landed on ${landed})`,
        }
      }

      return {
        kind: 'data',
        data: { requested: String(destination), landedOn: landed },
        summary: `navigated to ${landed}`,
      }
    },
  }
}

/**
 * The `ToolRegistration` for navigation: the tool plus BOTH gates, built together.
 *
 * Returned as one object on purpose. A caller could register the bare tool and get an ungated
 * navigation with nothing complaining - `ToolRegistry` does not require a gate, it only forwards one
 * if present. Making the gates inseparable from the tool is what stops that mistake from being
 * available rather than merely discouraged.
 */
export function navigationRegistration(deps: NavigateDeps): ToolRegistration {
  return {
    tool: makeNavigateTool(deps),
    capabilities: ['browser.navigate'],

    /**
     * GATE 1 - the destination policy, evaluated BEFORE authorisation is considered.
     *
     * `needsHuman: false` is the load-bearing part. A destination outside the policy is not a
     * consequential action awaiting a signature; it is an action the system will not take at all.
     * Reporting it as `needs-human` would imply a human could approve `javascript:` or an arbitrary
     * host, which is precisely the authority this milestone must not create.
     */
    preflight: (step: Step) => {
      const url = (step.args as { url?: unknown } | undefined)?.url
      const check = checkDestination(url, deps.policy)
      if (check.ok) return undefined
      return { blocked: `navigation refused by policy: ${check.reason}`, needsHuman: false }
    },

    /**
     * GATE 2 - declare the effect so the executor's approval gate engages.
     *
     * The target is the DESTINATION, so an approval granted for one URL does not carry to another.
     * The executor binds mission, step, kind, target and plan epoch, and fails the step on a
     * disagreement between this and the plan's own declaration - which is what makes a plan that
     * under-declares its navigation a PLAN DEFECT rather than a quiet bypass.
     */
    effectOf: (step: Step) => {
      const url = (step.args as { url?: unknown } | undefined)?.url
      // A destination that fails the policy declares NO effect, because preflight has already blocked
      // it and the approval gate is never reached. Declaring one anyway would put a request for
      // approval in front of a human for something that will never run.
      const check = checkDestination(url, deps.policy)
      if (!check.ok) return undefined
      return {
        kind: NAVIGATION_EFFECT_KIND,
        target: String(url),
        reason: `direct the browser to ${String(url).slice(0, 120)}`,
        irreversible: false,
      }
    },
  }
}

/**
 * INDEPENDENT VERIFICATION of a browser-to-file mission, including a navigation step.
 *
 * Four properties, and the fourth is the one that matters most:
 *
 *   1. The read is RE-READ. `readBrowser` is called again and the page's own reported URL, title and
 *      character count must match. A page that changed under the mission is rejected, exactly as a
 *      file that changed under the mission is rejected.
 *
 *   2. The WRITTEN artifact is re-read FROM DISK and compared against what the writer claimed. A
 *      writer that reported success without writing the bytes is caught here.
 *
 *   3. The NAVIGATION is verified by landing. The page is re-read and its CURRENT url checked against
 *      the policy, so a step claiming to have navigated while the browser is elsewhere cannot
 *      complete, and a redirect to a prohibited destination is caught after the fact.
 *
 *   4. The artifact must carry the disclosure, and must carry the CURRENT page's numbers rather than
 *      the ones the writer claimed. So the check runs against a fresh read, never against the
 *      execution-reported facts. Comparing a number to itself proves arithmetic, not reality.
 */
export function browserSummaryVerifier(
  readBrowser: PageReader,
  policy: NavigationPolicy = DEFAULT_NAVIGATION_POLICY,
): Verifier {
  return {
    verifies: (step: Step) =>
      step.id === 'navigate-browser' || step.id === 'read-browser' ||
      step.id === 'summarise-page' || step.id === 'write-page-summary',
    async verify(step, _ctx, toolData) {
      const { readFileSync, existsSync } = await import('node:fs')
      // Normalize trailing slashes: Chrome's page.url() may report `https://example.com/`
      // while the navigation tool's CDP handle reports `https://example.com`. They are the
      // same destination; only a trailing slash differs. Stripping it keeps the comparison
      // strict enough to catch real mismatches (e.g. example.com vs example.com.evil.com)
      // while accepting the harmless Chrome normalization.
      const norm = (u: string) => u.replace(/\/$/, '')

      if (step.id === 'navigate-browser') {
        // The navigation is verified by LANDING, not by the tool's own report. The page is re-read
        // and its CURRENT url is checked against the policy - so a step that claims to have navigated
        // while the browser is somewhere else cannot complete, and a redirect off-policy is caught.
        const claimed = toolData as { requested?: string; landedOn?: string } | undefined
        if (!claimed?.landedOn) return { rejected: 'the navigation named no destination it landed on' }
        const policyCheck = checkFinalDestination(claimed.landedOn, policy)
        if (!policyCheck.ok) return { rejected: `the destination the browser reached is not permitted: ${policyCheck.reason}` }
        let now: unknown
        try {
          now = await readBrowser()
        } catch (e) {
          return { rejected: `an independent read of the page failed: ${e instanceof Error ? e.message : String(e)}` }
        }
        const n = normalisePage(now)
        if ('error' in n) return { rejected: `an independent read produced no usable page: ${n.error}` }
        if (norm(n.facts.url) !== norm(claimed.landedOn)) {
          return {
            rejected: `the browser is now at ${n.facts.url}, not the ${claimed.landedOn} the step reported landing on`,
          }
        }
        return { evidence: { kind: 'page-read', url: n.facts.url, characters: n.facts.characters } as unknown as Evidence }
      }

      if (step.id === 'read-browser') {
        const claimed = toolData as { facts?: PageFacts } | undefined
        if (!claimed?.facts?.url) return { rejected: 'the read named no URL' }
        let again: unknown
        try {
          again = await readBrowser()
        } catch (e) {
          return { rejected: `an independent re-read of the page failed: ${e instanceof Error ? e.message : String(e)}` }
        }
        const n = normalisePage(again)
        if ('error' in n) return { rejected: `an independent re-read produced no usable page: ${n.error}` }
        if (norm(n.facts.url) !== norm(claimed.facts.url)) {
          return { rejected: `the page moved under the mission (read ${claimed.facts.url}, now ${n.facts.url})` }
        }
        if (n.facts.characters !== claimed.facts.characters) {
          return {
            rejected: `the page changed under the mission (read ${claimed.facts.characters} characters, now ${n.facts.characters})`,
          }
        }
        return { evidence: { kind: 'page-read', url: n.facts.url, characters: n.facts.characters, title: n.facts.title } as unknown as Evidence }
      }

      if (step.id === 'summarise-page') {
        // Re-read the page and check the summary against THAT, not against what the tool reported.
        const text = (toolData as { text?: string }).text
        if (typeof text !== 'string' || !text) return { rejected: 'the summarise step produced no text' }
        let again: unknown
        try {
          again = await readBrowser()
        } catch (e) {
          return { rejected: `an independent re-read of the page failed: ${e instanceof Error ? e.message : String(e)}` }
        }
        const n = normalisePage(again)
        if ('error' in n) return { rejected: `an independent re-read produced no usable page: ${n.error}` }
        if (!text.includes(`- rendered characters: ${n.facts.characters}`)) {
          return {
            rejected: `the summary does not carry the page's CURRENT character count ${n.facts.characters}`,
          }
        }
        if (!text.includes(`- url: ${n.facts.url}`)) {
          return { rejected: `the summary does not carry the page's CURRENT url ${n.facts.url}` }
        }
        return { evidence: { kind: 'page-read', url: n.facts.url, characters: n.facts.characters } as unknown as Evidence }
      }

      const claimed = toolData as { target?: string; text?: string } | undefined
      if (!claimed?.target) return { rejected: 'the write named no target' }
      if (!existsSync(claimed.target)) {
        return { rejected: `an independent stat of "${claimed.target}" found nothing - the writer reported success without writing` }
      }
      const onDisk = readFileSync(claimed.target, 'utf8')
      if (typeof claimed.text === 'string' && claimed.text !== onDisk) {
        return { rejected: 'the artifact on disk differs from what the writer reported writing' }
      }
      // The artifact's own numbers must match a FRESH read of the page.
      let again: unknown
      try {
        again = await readBrowser()
      } catch (e) {
        return { rejected: `an independent re-read of the page failed: ${e instanceof Error ? e.message : String(e)}` }
      }
      const n = normalisePage(again)
      if ('error' in n) return { rejected: `an independent re-read produced no usable page: ${n.error}` }
      if (!onDisk.includes(`- rendered characters: ${n.facts.characters}`)) {
        return { rejected: `the artifact does not carry the page's current character count ${n.facts.characters}` }
      }
      if (!/no language model read this page/i.test(onDisk)) {
        return { rejected: 'the artifact does not disclose that no model read the page' }
      }
      // If the page carried an injection attempt, the artifact must say so. Silently omitting it
      // would be as dishonest as obeying it.
      if (n.notices.length && !/UNTRUSTED CONTENT NOTICE/.test(onDisk)) {
        return {
          rejected: `the page contained instruction-shaped content (${n.notices.map((x) => x.pattern).join(', ')}) but the artifact records no untrusted-content notice`,
        }
      }
      return { evidence: { kind: 'file-read-back', path: claimed.target, bytes: Buffer.byteLength(onDisk), heading: onDisk.split('\n')[0] ?? '', sha256: sha256(onDisk) } as unknown as Evidence }
    },
  }
}