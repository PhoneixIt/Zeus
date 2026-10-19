/**
 * A MULTI-PAGE, EVIDENCE-BACKED COMPANY BRIEF.
 *
 * =============================================================================
 * WHY THIS IS A SEPARATE FILE, AND WHY IT IS NOT A CRAWLER
 * =============================================================================
 *
 * The single-page engine in `research-app.ts` proves it can drive a browser and persist what
 * it saw. It proves nothing about whether AIOS can hold an OBJECTIVE across several pages and
 * produce a document a person would actually use. So this file does the smallest thing that
 * closes that gap: it takes a research objective plus a starting URL, visits a BOUNDED number
 * of pages, keeps the evidence for each, and writes a structured brief whose every statement
 * points back at a stored quote.
 *
 * The bounds are the point, not an afterthought:
 *
 *   maxPages      hard cap, default 4. A crawl that can run forever is a crawl that cannot be
 *                 audited, and cannot be stopped by anyone reading a log.
 *   same host     only pages on the starting host (or its www twin) are followed. A company
 *                 brief must not wander onto a third-party site and attribute its words to the
 *                 company.
 *   pageTimeout   per page, so one slow page cannot consume the whole mission.
 *   maxBytes      per page, reusing the existing extractor cap.
 *   timeoutMs     whole-mission wall clock.
 *
 * Every one of these is configurable and every one has a default, so "unbounded" is not a
 * reachable state even if a caller passes nonsense.
 *
 * =============================================================================
 * THE RULE THAT MAKES THE REPORT USABLE: FACTS AND INTERPRETATION NEVER MIX
 * =============================================================================
 *
 * Every statement in the report carries a `kind`:
 *
 *   quoted-fact      the report is repeating text that is stored in a source artifact. The
 *                    quote is in the artifact; a verifier can find it again and check that it
 *                    is really there. This is the only kind that can be automatically proven.
 *
 *   rule-derived     the report applied a NAMED, DETERMINISTIC rule to the facts - "these
 *                    headings matched /products?/", "no page mentioned customers". The rule is
 *                    recorded. The factual truth of the conclusion is NOT proven, and is
 *                    reported as `not-automatically-verifiable`, because a heading match is
 *                    evidence of how a company organises its own site, which is not the same
 *                    thing as evidence of what it sells.
 *
 * When evidence does not support a section, the brief says so in those words. It does not
 * fill the gap, because a plausible-sounding invented customer list is exactly the failure
 * this whole system exists to prevent.
 *
 * =============================================================================
 * NO MODEL IS CALLED. THIS IS DELIBERATE FOR THE FIRST INCREMENT.
 * =============================================================================
 *
 * Mode is `deterministic-extraction` and is recorded in the artifact. There is no provider
 * call, no API key, no fallback, and nothing that could become billable. $0 holds because
 * nothing is charged, not because a free tier was found. A later increment may add a model
 * BEHIND this interface; it must keep the same claim/source split, because a model that
 * writes an unsourced sentence is the single easiest way to destroy the property that makes
 * this output worth keeping.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

import { connectOverCDP } from '../../control-core/cdp.mjs'
import { extractFrom, classifyElement, domWalker, isChromeClass, toEvidence, type ChromeClass } from './web-extract.ts'
import { buildRecord, verifyRun, computeDigest, type ResearchRecord } from './web-verify.ts'
import { RESEARCH_ROOT, RUNS_DIR, ensureDurableDirs } from './research-app.ts'

// ===========================================================================================
// durable locations
// ===========================================================================================

export const BRIEFS_DIR = join(RESEARCH_ROOT, 'briefs')

/**
 * Brief missions keep their OWN history file.
 *
 * They share `runs/` for per-page artifacts but their unit of work is a brief, not a page, and
 * writing their lines into `history.jsonl` broke an existing invariant: every line there names
 * an artifact under `runs/`, and `verify-research-state.ts` checks exactly that. Adding brief
 * lines with `artifactPath` pointing into `briefs/` made five legitimate missions look like
 * orphans to a verifier that had no way to know a second namespace existed.
 *
 * Two namespaces, two histories, one reader each. The alternative - teaching the old verifier
 * about briefs - would have made it responsible for something it was never written to check.
 */
export const BRIEF_HISTORY_PATH = join(BRIEFS_DIR, 'history.jsonl')

export interface BriefHistoryEntry {
  readonly correlationId: string
  readonly at: number
  readonly objective: string
  readonly startingUrl: string
  readonly terminalState: string
  readonly terminalReason: string
  readonly sourceCount: number
  readonly tracedClaims: number
  readonly unprovenClaims: number
  readonly briefPath: string
}

export function appendBriefHistory(e: BriefHistoryEntry): void {
  ensureBriefDirs()
  appendFileSync(BRIEF_HISTORY_PATH, JSON.stringify(e) + '\n', 'utf8')
}

export function ensureBriefDirs(): void {
  ensureDurableDirs()
  mkdirSync(BRIEFS_DIR, { recursive: true })
}

// ===========================================================================================
// configuration - every knob bounded, none unbounded
// ===========================================================================================

export interface BriefLimits {
  /** Hard cap on pages fetched, including the starting page. */
  readonly maxPages: number
  /** Per-page load budget. */
  readonly pageTimeoutMs: number
  /** Whole-mission wall clock. */
  readonly missionTimeoutMs: number
  /** Per-page HTML cap, matching the single-page engine. */
  readonly maxBytes: number
  /** Elements retained per page. */
  readonly maxElements: number
  /** Only follow links to this host / its www twin when true. */
  readonly sameHostOnly: boolean
}

export const DEFAULT_LIMITS: BriefLimits = {
  maxPages: 4,
  pageTimeoutMs: 20_000,
  missionTimeoutMs: 150_000,
  maxBytes: 2_000_000,
  maxElements: 60,
  sameHostOnly: true,
}

/** Clamp a caller-supplied limit into a sane range. `maxPages: 1e9` must not mean 1e9. */
export function clampLimits(l: Partial<BriefLimits> = {}): BriefLimits {
  const int = (v: unknown, lo: number, hi: number, d: number): number => {
    const n = Math.trunc(Number(v))
    if (!Number.isFinite(n)) return d
    return Math.min(hi, Math.max(lo, n))
  }
  return {
    maxPages: int(l.maxPages, 1, 12, DEFAULT_LIMITS.maxPages),
    pageTimeoutMs: int(l.pageTimeoutMs, 2_000, 120_000, DEFAULT_LIMITS.pageTimeoutMs),
    missionTimeoutMs: int(l.missionTimeoutMs, 5_000, 900_000, DEFAULT_LIMITS.missionTimeoutMs),
    maxBytes: int(l.maxBytes, 20_000, 8_000_000, DEFAULT_LIMITS.maxBytes),
    maxElements: int(l.maxElements, 5, 200, DEFAULT_LIMITS.maxElements),
    sameHostOnly: l.sameHostOnly !== false,
  }
}

// ===========================================================================================
// claim model
// ===========================================================================================

export type BriefSection =
  | 'overview' | 'products' | 'customers' | 'evidence' | 'questions'

/**
 * One statement in the report.
 *
 * `quote` + `sourceId` + `elementIndex` are what make a claim checkable. `null` on all three
 * means the statement is not traceable to a stored quote and must not be presented as fact.
 */
export interface BriefClaim {
  readonly id: string
  readonly section: BriefSection
  readonly text: string
  readonly kind: 'quoted-fact' | 'rule-derived'
  /** Which source (page) this came from. Null for rule-derived statements. */
  readonly sourceId: string | null
  /** The verbatim stored element text, for quoted-fact claims. */
  readonly quote: string | null
  /** Index of that element within its source artifact. */
  readonly elementIndex: number | null
  /**
   * Whether a program can prove this. Only `quoted-fact` reaches
   * `traceable-to-stored-source`; a rule-derived conclusion never does, however plausible.
   */
  readonly factualStatus: 'traceable-to-stored-source' | 'not-automatically-verifiable'
  /** For rule-derived: the rule name, so a reader can disagree with the rule itself. */
  readonly rule: string | null
  /**
   * The structural classification of the element this quote came from, copied from the source
   * artifact. The verifier re-reads it from the artifact rather than trusting this copy.
   */
  readonly chromeClass: ChromeClass | null
  /** True when the class is something other than `main-content` or `unknown`. */
  readonly isSiteChrome: boolean
  /**
   * Source ids carrying the IDENTICAL text. A quote present on every page of a site is almost
   * certainly chrome; this is computed by comparison, not assumed from the class.
   */
  readonly repeatedOn: readonly string[]
}

/** Labels that mean "this is site furniture, not a statement about the subject". */
const CHROME_LABELS: ReadonlySet<ChromeClass> = new Set<ChromeClass>([
  'navigation', 'header', 'footer', 'consent-banner',
])

// ===========================================================================================
// source model - one artifact per page, reused from the single-page engine
// ===========================================================================================

export interface BriefSource {
  readonly id: string
  readonly url: string
  readonly title: string
  readonly fetchedAt: number
  readonly elementCount: number
  readonly findingCount: number
  /** Path to the ResearchRecord this source is backed by. */
  readonly artifactPath: string
  /** SHA-256 over the record, copied here so the brief can be checked without re-reading. */
  readonly digest: string
  /** Why the policy chose to visit this page. Recorded, not incidental. */
  readonly selectedBy: 'starting-url' | 'link-followed'
  readonly selectedReason: string
}

export interface CompanyBrief {
  readonly correlationId: string
  readonly objective: string
  readonly startingUrl: string
  readonly mode: 'deterministic-extraction'
  readonly modelUsed: null
  readonly limits: BriefLimits
  readonly startedAt: number
  readonly finishedAt: number
  readonly elapsedMs: number
  readonly terminalState: 'complete' | 'partial' | 'failed'
  readonly terminalReason: string
  readonly sources: readonly BriefSource[]
  readonly claims: readonly BriefClaim[]
  readonly unresolved: readonly string[]
  /** Non-fatal problems: a page that timed out, a link skipped. Never hidden. */
  readonly warnings: readonly string[]
  /** Digest over sources + claims, so a tampered brief is detectable. */
  readonly digest: string
}

/**
 * RENDER the brief as a report a person can read.
 *
 * Every line is one of two kinds, and the difference is visible on the page rather than
 * described in a footnote:
 *
 *   [S3#12] "quoted text..."            a source fact, cited to the page and element it came from
 *   (rule: collected-pages) ...         interpretation, with the rule that produced it
 *
 * A reader who does not trust the second kind can ignore every line of it and still have the
 * first kind. That is the point of splitting them.
 *
 * Bounded: `maxPerSection` quotes are shown per section and the remainder is COUNTED, never
 * silently dropped. A truncated report that does not say it was truncated is a lie about
 * completeness, which is the same failure the rest of this system exists to prevent.
 */
export function renderBriefReport(
  brief: Pick<CompanyBrief, 'objective' | 'startingUrl' | 'terminalState' | 'terminalReason' | 'sources' | 'claims' | 'unresolved' | 'mode' | 'modelUsed'>,
  opts: { maxPerSection?: number } = {},
): string[] {
  const max = opts.maxPerSection ?? 6
  const out: string[] = []
  out.push(`COMPANY BRIEF  -  ${brief.objective}`)
  out.push(`  start        ${brief.startingUrl}`)
  out.push(`  outcome      ${brief.terminalState.toUpperCase()} - ${brief.terminalReason}`)
  out.push(`  mode         ${brief.mode} (no model, no API key)`)
  out.push('')

  const titles: Record<BriefSection, string> = {
    overview: 'COMPANY OVERVIEW',
    products: 'PRODUCTS AND SERVICES',
    customers: 'TARGET CUSTOMERS',
    evidence: 'EVIDENCE AND PROVENANCE',
    questions: 'UNRESOLVED QUESTIONS',
  }

  const facts = brief.claims.filter((c) => c.kind === 'quoted-fact')

  // Composition of the stored evidence, stated up front.
  //
  // A raw tag-based extractor cannot tell a sentence from a navigation label: on a real
  // corporate site a large share of <p>/<li> elements are menu entries - "Blog", "Docs",
  // "Pricing", "Download". Presenting those as company facts would be wrong in substance even
  // though every quote is genuine and verifiable. So nothing is filtered - dropping content
  // because it looks like chrome would risk discarding real text - but the report SAYS how much
  // of the evidence is short, and the excerpt leads with the longest, most sentence-like items.
  const CHROME_MAX = 40
  const short = facts.filter((c) => (c.quote ?? c.text).trim().length < CHROME_MAX).length
  const chromeCounts = new Map<string, number>()
  for (const c of facts) {
    const k = c.chromeClass ?? 'not classified'
    chromeCounts.set(k, (chromeCounts.get(k) ?? 0) + 1)
  }
  out.push(`EVIDENCE COMPOSITION  ${facts.length} stored quote(s) across ${brief.sources.length} page(s)`)
  for (const [k, v] of Array.from(chromeCounts.entries()).sort((a, b) => b[1] - a[1])) {
    out.push(`  ${k.padEnd(16)} ${v}`)
  }
  out.push(`  ${'-'.repeat(16)} -------`)
  out.push(`  ${'MAIN CONTENT'.padEnd(16)} ${facts.filter((c) => c.chromeClass === 'main-content').length}`)
  out.push(`  ${'NOT CLASSIFIED'.padEnd(16)} ${facts.filter((c) => c.chromeClass === null || c.chromeClass === 'unknown').length}  (kept - the DOM walk could not place these)`)
  out.push(`  ${`SHORT (<${CHROME_MAX}ch)`.padEnd(16)} ${short}`)
  out.push('')
  out.push(`  The excerpt below shows DISTINCT non-chrome quotes, most substantive first. Site chrome is`)
  out.push(`  excluded by the classification above, NOT deleted - every excluded quote is still stored,`)
  out.push(`  still classified, still covered by its artifact's digest, and still re-verified.`)
  out.push(`  A quote shown as "not classified" was not placed by the DOM walk: no landmark proved what it`)
  out.push(`  was. That is recorded as uncertainty, not guessed either way, and such quotes are KEPT in`)
  out.push(`  the excerpt rather than dropped - only positively-identified chrome is removed.`)
  out.push('')

  // Rank the excerpt, and show each DISTINCT quote once.
  //
  // Site chrome is EXCLUDED FROM THE EXCERPT, not deleted. Two real runs drove this: identical
  // site-wide nav was extracted from all 4 pages and appeared 4 times reading as 4 findings,
  // and ranking by length - the earlier heuristic - made it worse, because navigation blocks
  // are longer than the marketing sentences they bury.
  //
  // Now the exclusion is decided by the DOM CLASSIFICATION rather than by guessing from text
  // length. `unknown` is NOT excluded: an element the walk could not place is exactly the one a
  // reader should be shown, because pretending it was chrome would be the guessing this change
  // exists to remove. Unclassified content is still deduplicated, so repetition is still handled.
  const distinct = (inSection: readonly BriefClaim[]): Array<{ quote: string; refs: BriefClaim[] }> => {
    const groups = new Map<string, BriefClaim[]>()
    for (const c of inSection) {
      const key = (c.quote ?? c.text).replace(/\s+/g, ' ').trim()
      const list = groups.get(key)
      if (list) list.push(c)
      else groups.set(key, [c])
    }
    return Array.from(groups.entries())
      .map(([quote, refs]) => ({ quote, refs }))
      // Substantive text first.
      //
      // Ranking by length was WRONG when it was introduced, and the DOM classification is the
      // reason it is right now: navigation blocks are long, so length alone promoted chrome to
      // the top. Chrome is now removed by the classification before this point, so among what
      // remains, longer text genuinely is more substantive. Repetition count breaks ties.
      .sort((a, b) => (b.quote.length - a.quote.length) || (b.refs.length - a.refs.length) || (a.quote < b.quote ? -1 : 1))
  }

  const isChromeClaim = (c: BriefClaim): boolean =>
    c.kind === 'quoted-fact' && c.isSiteChrome

  let excluded = 0
  for (const section of ['overview', 'products', 'customers'] as const) {
    const inSection = facts.filter((c) => c.section === section)
    const shown = inSection.filter((c) => !isChromeClaim(c))
    const dropped = inSection.length - shown.length
    excluded += dropped
    out.push(`${titles[section]}  (${shown.length} quoted fact(s) shown of ${inSection.length} collected${dropped > 0 ? `, ${dropped} site-chrome excluded` : ''})`)
    if (shown.length === 0) {
      out.push('  NOT ESTABLISHED BY THE COLLECTED EVIDENCE')
      if (dropped > 0) out.push(`  (${dropped} quote(s) existed here but were classified site chrome: navigation, header, footer or consent)`)
    } else {
      const groups = distinct(shown)
      for (const g of groups.slice(0, max)) {
        const cited = g.refs.map((r) => `${r.sourceId}#${r.elementIndex}`).join(', ')
        const q = g.quote.length > 150 ? `${g.quote.slice(0, 150)}...` : g.quote
        const cls = g.refs[0].chromeClass ?? 'unknown'
        out.push(`  [${cited}] (${cls}) "${q}"`)
      }
      if (groups.length > max) {
        out.push(`  ... and ${groups.length - max} more distinct quote(s), all stored and all verifiable in the brief file.`)
      }
    }
    const derived = brief.claims.filter((c) => c.kind === 'rule-derived' && c.section === section)
    for (const d of derived) out.push(`  (rule: ${d.rule}) ${d.text}`)
    out.push('')
  }

  out.push(titles.evidence)
  out.push(`  ${brief.sources.length} source page(s), each with its own artifact on disk:`)
  for (const s of brief.sources) {
    out.push(`  [${s.id}] ${s.title}`)
    out.push(`       ${s.url}`)
    out.push(`       ${s.elementCount} elements, ${s.findingCount} instruction-like finding(s)  (selected by: ${s.selectedReason})`)
  }
  // Say plainly what was left out of the excerpt and where it still lives, so "reduced" is not
  // mistaken for "discarded".
  if (excluded > 0) {
    out.push('')
    out.push(`  ${excluded} collected quote(s) were classified site chrome and left out of the excerpt above.`)
    out.push(`  They are NOT deleted: every one is still stored in its source artifact, still classified,`)
    out.push(`  still covered by that artifact's digest, and re-verified by verify-company-brief.ts.`)
  }
  const derivedAll = brief.claims.filter((c) => c.kind === 'rule-derived')
  if (derivedAll.length > 0) {
    out.push('')
    out.push('  INTERPRETATION - produced by a named rule, NOT proven:')
    for (const d of derivedAll) out.push(`  (rule: ${d.rule}) ${d.text}`)
  }
  out.push('')

  out.push(titles.questions)
  for (const q of brief.unresolved) out.push(`  - ${q}`)
  return out
}

export type BriefRun =
  | {
    readonly ok: true
    readonly brief: CompanyBrief
    readonly briefPath: string
    /** Per-page verification verdicts, re-read from disk. */
    readonly sourceVerdicts: readonly { sourceId: string; url: string; ok: boolean; reason: string }[]
  }
  | { readonly ok: false; readonly reason: string; readonly briefPath: string | null }

// ===========================================================================================
// link policy - bounded, deterministic, and explainable
// ===========================================================================================

/** Terms that make a page likely to carry company substance. */
const SECTION_TERMS: ReadonlyArray<{ term: string; section: BriefSection }> = [
  { term: 'product', section: 'products' },
  { term: 'solution', section: 'products' },
  { term: 'service', section: 'products' },
  { term: 'feature', section: 'products' },
  { term: 'platform', section: 'products' },
  { term: 'offering', section: 'products' },
  { term: 'pricing', section: 'products' },
  { term: 'customer', section: 'customers' },
  { term: 'client', section: 'customers' },
  { term: 'case stud', section: 'customers' },
  { term: 'use case', section: 'customers' },
  { term: 'industry', section: 'customers' },
  { term: 'who it.s for', section: 'customers' },
  { term: 'about', section: 'overview' },
  { term: 'company', section: 'overview' },
  { term: 'team', section: 'overview' },
]

/** Tokens from the objective, used to prefer links that mention the subject. */
export function objectiveKeywords(objective: string): string[] {
  const stops = new Set(['the', 'a', 'an', 'of', 'and', 'for', 'to', 'in', 'on', 'with', 'research', 'produce', 'brief', 'company', 'what', 'does', 'do', 'is', 'are', 'about', 'please'])
  return Array.from(new Set(
    objective.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) ?? [],
  )).filter((w) => !stops.has(w)).slice(0, 12)
}

export interface LinkCandidate {
  readonly href: string
  readonly text: string
  readonly section: BriefSection | null
  readonly score: number
  readonly order: number
}

/**
 * Rank candidate links. Deterministic: same page + same objective => same order.
 *
 * Scoring is deliberately simple and inspectable. A page whose link text or href mentions a
 * section term scores higher; a link that also mentions an objective keyword scores higher
 * still. Document order breaks ties, so the result never depends on sort stability or on
 * dictionary iteration order.
 */
export function rankLinks(
  candidates: ReadonlyArray<{ href: string; text: string }>,
  keywords: readonly string[],
): LinkCandidate[] {
  const scored: LinkCandidate[] = []
  candidates.forEach((c, order) => {
    const hay = `${c.text} ${c.href}`.toLowerCase()
    let score = 0
    let section: BriefSection | null = null
    for (const { term, section: s } of SECTION_TERMS) {
      if (hay.includes(term)) {
        score += 2
        if (section === null) section = s
      }
    }
    for (const k of keywords) {
      if (hay.includes(k)) score += 3
    }
    // A bare "/" link leads back to the homepage and adds nothing new.
    if (/^\/?$/.test(c.href)) score -= 4
    scored.push({ href: c.href, text: c.text, section, score, order })
  })
  return scored.sort((a, b) => (b.score - a.score) || (a.order - b.order))
}

/** Strip a leading `www.` so `x.com` and `www.x.com` are recognised as one host. */
export function hostKey(u: URL): string {
  return u.hostname.toLowerCase().replace(/^www\./, '')
}

export function sameSite(a: URL, b: URL): boolean {
  return hostKey(a) === hostKey(b)
}

const BAD_SCHEME = /^(mailto:|tel:|javascript:|data:|sms:|#)/i

export function resolveCandidate(rawHref: string, base: URL): URL | null {
  const h = rawHref.trim()
  if (h.length === 0 || BAD_SCHEME.test(h)) return null
  let u: URL
  try { u = new URL(h, base) } catch { return null }
  if (u.protocol !== 'https:') return null
  if (u.username || u.password) return null
  // Strip the fragment: /products#a and /products are the same page.
  u.hash = ''
  return u
}

// ===========================================================================================
// report assembly - deterministic, and honest about absence
// ===========================================================================================

const NOT_ESTABLISHED = 'NOT ESTABLISHED BY THE COLLECTED EVIDENCE'

/**
 * Build the claim set from the collected sources.
 *
 * Pure function of the sources: no clock, no randomness, no model. Two runs over the same
 * artifacts produce the same brief, which is what makes the verifier meaningful.
 */
export function buildClaims(sources: ReadonlyArray<{ source: BriefSource; record: ResearchRecord }>): BriefClaim[] {
  const claims: BriefClaim[] = []
  let n = 0

  // Repetition is a CROSS-PAGE fact, so it needs two passes: collect the quotes with their class
  // first, then count identical text across distinct sources.
  type Draft = { section: BriefSection; text: string; sourceId: string; elementIndex: number; chromeClass: ChromeClass | null; rule: string | null }
  const drafts: Draft[] = []

  for (const { source, record } of sources) {
    record.elements.forEach((el, idx) => {
      const hay = `${el.tag} ${el.text}`.toLowerCase()
      let section: BriefSection = 'overview'
      let rule: string | null = null

      // A heading names the section; body text under it is evidence for that section.
      if (el.tag.startsWith('h')) {
        let best: BriefSection | null = null
        let bestLen = Number.POSITIVE_INFINITY
        for (const { term, section: s } of SECTION_TERMS) {
          if (el.text.toLowerCase().includes(term) && term.length < bestLen) {
            best = s
            bestLen = term.length
          }
        }
        if (best) { section = best; rule = 'heading-matched-section-term' }
      } else {
        // Unattached body text: attribute it only if it says something sectional.
        let best: BriefSection | null = null
        let bestLen = Number.POSITIVE_INFINITY
        for (const { term, section: s } of SECTION_TERMS) {
          if (hay.includes(term) && term.length < bestLen) { best = s; bestLen = term.length }
        }
        if (best) { section = best; rule = 'body-matched-section-term' }
      }

      drafts.push({
        section, text: el.text, sourceId: source.id, elementIndex: idx,
        chromeClass: isChromeClass(el.chrome) ? el.chrome : null,
        rule,
      })
    })
  }

  const byText = new Map<string, Set<string>>()
  for (const d of drafts) {
    const key = d.text.replace(/\s+/g, ' ').trim()
    const set = byText.get(key)
    if (set) set.add(d.sourceId)
    else byText.set(key, new Set([d.sourceId]))
  }

  for (const d of drafts) {
    const key = d.text.replace(/\s+/g, ' ').trim()
    claims.push({
      id: `C${String(++n).padStart(3, '0')}`,
      section: d.section,
      text: d.text,
      kind: 'quoted-fact',
      sourceId: d.sourceId,
      quote: d.text,
      elementIndex: d.elementIndex,
      factualStatus: 'traceable-to-stored-source',
      rule: d.rule,
      chromeClass: d.chromeClass,
      isSiteChrome: d.chromeClass !== null && CHROME_LABELS.has(d.chromeClass),
      repeatedOn: Array.from(byText.get(key) ?? []).sort(),
    })
  }

  return claims
}

/**
 * INTERPRETATION, as claims rather than prose.
 *
 * The first version put the interpretation in a `unresolved` list of English sentences. That
 * made the distinction between fact and inference real but *unstructured* - a reader could see
 * the sentences, and the verifier could check they existed, but nothing tied them to a rule or
 * forced them to be labelled as unproven. An interpreter could have added a confident sentence
 * and the structure would not have noticed.
 *
 * So interpretation is now emitted as claims too, carrying the rule that produced them and
 * `factualStatus: 'not-automatically-verifiable'`. The verifier enforces both. A statement
 * produced by one of these rules cannot be promoted to a fact without failing verification.
 *
 * Each rule here is checkable by a person reading the sources:
 *
 *   collected-pages          how many pages were actually collected, and under what bound
 *   same-host-only           what that policy excluded
 *   section-coverage         how the collected elements distributed across sections
 *   no-section-evidence      a section with nothing behind it, stated as absence
 */
export function deriveClaims(
  facts: readonly BriefClaim[],
  sources: readonly BriefSource[],
  limits: BriefLimits,
): BriefClaim[] {
  const out: BriefClaim[] = []
  let n = facts.length
  const add = (section: BriefSection, text: string, rule: string): void => {
    out.push({
      id: `C${String(++n).padStart(3, '0')}`,
      section, text, kind: 'rule-derived',
      sourceId: null, quote: null, elementIndex: null,
      factualStatus: 'not-automatically-verifiable',
      rule,
      chromeClass: null,
      isSiteChrome: false,
      repeatedOn: [],
    })
  }

  add(
    'overview',
    `${sources.length} page(s) were collected under a hard limit of ${limits.maxPages}, with same-host-only following ${limits.sameHostOnly ? 'ON' : 'OFF'}. The mission collected what its policy chose, not what the site offers.`,
    'collected-pages',
  )
  if (limits.sameHostOnly) {
    const hosts = new Set(sources.map((s) => { try { return hostKey(new URL(s.url)) } catch { return 'unparseable' } }))
    add(
      'overview',
      `All ${sources.length} source(s) came from ${hosts.size} host(s) (${Array.from(hosts).join(', ')}). Pages on any other host were skipped by policy, so nothing about third-party descriptions of this company is included.`,
      'same-host-only',
    )
  }

  const sections: BriefSection[] = ['overview', 'products', 'customers']
  for (const s of sections) {
    const inSection = facts.filter((c) => c.section === s)
    const sourcesWith = new Set(inSection.map((c) => c.sourceId))
    add(
      s,
      inSection.length === 0
        ? `No collected element was classified under "${s}" by the heading/term rule.`
        : `${inSection.length} collected element(s) were classified under "${s}", drawn from ${sourcesWith.size} of ${sources.length} source(s).`,
      inSection.length === 0 ? 'no-section-evidence' : 'section-coverage',
    )
  }
  return out
}

/** Questions the evidence did not answer. Computed, not written by hand. */
export function unresolvedQuestions(
  claims: readonly BriefClaim[],
  sources: readonly BriefSource[],
): string[] {
  const qs: string[] = []
  const bySection = (s: BriefSection): number => claims.filter((c) => c.section === s && c.kind === 'quoted-fact').length

  if (sources.length < 2) {
    qs.push(`Only ${sources.length} page(s) were collected, so nothing here is corroborated across sources.`)
  }
  if (bySection('products') === 0) {
    qs.push('No collected page described products or services under a heading this policy recognises.')
  }
  if (bySection('customers') === 0) {
    qs.push('No collected page named customers, industries, or use cases.')
  }
  qs.push('Nothing collected here is audited financial data. Revenue, headcount, funding and market share are NOT established by this brief.')
  qs.push('Customer names, if quoted above, are claims the company makes about itself. No third party was consulted to confirm them.')
  return qs
}

// ===========================================================================================
// the mission
// ===========================================================================================

type CdpCtx = Awaited<ReturnType<typeof connectOverCDP>>
/** The page handle, derived from the CDP client rather than re-declared, so it cannot drift. */
type CdpPage = Awaited<ReturnType<ReturnType<CdpCtx['contexts']>[number]['newPage']>>

export interface BriefRunOptions {
  readonly chromePath: string
  readonly cdpPort: number
  readonly profileDir: string
  readonly runDir: string
  readonly limits?: Partial<BriefLimits>
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function cdpAlive(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2500) })
    return r.ok
  } catch { return false }
}

async function launchBrowser(o: BriefRunOptions): Promise<ChildProcess> {
  if (await cdpAlive(o.cdpPort)) {
    throw new Error(`port ${o.cdpPort} is already in use; refusing to attach to a browser this app did not start`)
  }
  const child = spawn(o.chromePath, [
    '--headless=new',
    `--remote-debugging-port=${o.cdpPort}`,
    `--user-data-dir=${o.profileDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--no-sandbox', '--disable-dev-shm-usage',
    '--window-size=1380,920',
    'about:blank',
  ], { stdio: 'ignore', windowsHide: true })
  for (let i = 0; i < 40; i++) {
    if (await cdpAlive(o.cdpPort)) return child
    await sleep(500)
  }
  throw new Error('the browser launched but its debugging endpoint never answered')
}

export function refuseStartUrl(raw: string): string | null {
  let u: URL
  try { u = new URL(raw) } catch { return 'that is not a URL' }
  if (u.protocol !== 'https:') return 'only https:// URLs are accepted'
  const h = u.hostname.toLowerCase()
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.local')) return 'that points at this machine'
  if (u.username || u.password) return 'credentials in the URL are not accepted'
  return null
}

export interface BriefRunResult {
  readonly correlationId: string
  readonly objective: string
  readonly startingUrl: string
  readonly terminalState: CompanyBrief['terminalState']
  readonly terminalReason: string
  readonly briefPath: string
  readonly sources: readonly BriefSource[]
  readonly claims: readonly BriefClaim[]
  readonly unresolved: readonly string[]
  readonly warnings: readonly string[]
  readonly elapsedMs: number
  readonly mode: 'deterministic-extraction'
  readonly modelUsed: null
}

/**
 * Digest over the brief's substance (sources + claims), so a brief edited after the fact is
 * detectable. Exported because the verifier must recompute it from the FILE, not be handed it.
 */
export function digestBrief(
  correlationId: string, objective: string, startingUrl: string,
  sources: readonly BriefSource[], claims: readonly BriefClaim[], unresolved: readonly string[],
): string {
  return computeDigest({
    runId: correlationId,
    requestedUrl: startingUrl,
    finalUrl: startingUrl,
    status: 200,
    contentType: 'application/json',
    fetchedAt: 0,
    title: objective,
    elements: claims.map((c) => ({ tag: c.section, text: `${c.kind}|${c.sourceId ?? '-'}|${c.quote ?? '-'}` })),
    elementCount: claims.length,
    hostileContentSeen: false,
    findingCount: sources.reduce((a, s) => a + s.findingCount, 0),
    bodySample: sources.map((s) => `${s.id}|${s.url}|${s.digest}`).join('\n'),
    bodyCapped: false,
    truncated: false,
    redirectChain: [],
  })
}

/**
 * Run the mission. Always returns a result - a page that failed is a fact to report, not an
 * exception to unwind past the point where it could be recorded.
 */
export async function runCompanyBrief(
  o: BriefRunOptions,
  objective: string,
  startingUrl: string,
): Promise<BriefRunResult> {
  ensureBriefDirs()
  const limits = clampLimits(o.limits)
  const correlationId = randomUUID()
  const t0 = Date.now()
  const warnings: string[] = []
  const sources: BriefSource[] = []
  const sourcesWithRecords: Array<{ source: BriefSource; record: ResearchRecord }> = []

  const obj = objective.trim()
  if (obj.length === 0) throw new Error('the objective is empty; there is nothing to research')
  const bad = refuseStartUrl(startingUrl)
  if (bad) throw new Error(`refused before any network activity: ${bad}`)

  const startUrl = new URL(startingUrl)
  const keywords = objectiveKeywords(obj)
  const visited = new Set<string>()
  const deadline = t0 + limits.missionTimeoutMs

  const briefPath = join(BRIEFS_DIR, `${correlationId}.brief.json`)
  const base = (r: Omit<BriefRunResult, 'sources' | 'claims' | 'unresolved'> & Partial<Pick<BriefRunResult, 'sources' | 'claims' | 'unresolved'>>): BriefRunResult => ({
    ...r,
    sources, claims: [], unresolved: [],
  })

  let browser: ChildProcess | null = null
  let ctx: CdpCtx | null = null
  let page: CdpPage | null = null

  try {
    browser = await launchBrowser(o)
    ctx = await connectOverCDP(`http://127.0.0.1:${o.cdpPort}`)
    page = await ctx.contexts()[0].newPage('about:blank')

    // Bounded best-first traversal. The queue starts with the supplied URL only; every further
    // page must have been CHOSEN by the link policy from a page already fetched. Nothing here
    // invents a URL, guesses a sitemap, or reads robots.txt to widen its own reach.
    let frontier: LinkCandidate[] = []
    let nextUrl: URL | null = startUrl
    let nextReason = 'the supplied starting URL'
    let selectedBy: BriefSource['selectedBy'] = 'starting-url'

    while (sources.length < limits.maxPages) {
      if (Date.now() > deadline) {
        warnings.push(`mission stopped at its ${limits.missionTimeoutMs}ms wall clock with ${sources.length} page(s) collected`)
        break
      }
      if (nextUrl === null) {
        const pick = frontier.shift()
        if (!pick) break
        const resolved = resolveCandidate(pick.href, startUrl)
        if (!resolved) continue
        if (visited.has(resolved.toString())) continue
        if (limits.sameHostOnly && !sameSite(resolved, startUrl)) {
          warnings.push(`skipped ${resolved.toString()}: outside the starting host ${hostKey(startUrl)}`)
          continue
        }
        nextUrl = resolved
        nextReason = `link "${pick.text || pick.href}" (score ${pick.score}${pick.section ? `, section ${pick.section}` : ''})`
        selectedBy = 'link-followed'
      }

      const target = nextUrl
      nextUrl = null
      visited.add(target.toString())
      const sid = `S${sources.length + 1}`
      const artifactPath = join(RUNS_DIR, `${correlationId}.${sid}.record.json`)

      // --- fetch one page. Any failure here is a WARNING, not a crash: a brief built from 2
      // good pages is useful, and pretending the whole mission failed would be its own lie.
      try {
        await page.goto(target.toString())
        const loadState = await page.waitForLoad(limits.pageTimeoutMs)
        if (loadState !== 'complete' && loadState !== 'interactive') {
          warnings.push(`S${sources.length + 1} ${target.toString()} did not finish loading within ${limits.pageTimeoutMs}ms (readyState=${loadState || 'unknown'}); skipped`)
          continue
        }
        const html = await page.evaluate(() => document.documentElement.outerHTML)
        if (typeof html !== 'string' || html.length === 0) {
          warnings.push(`S${sources.length + 1} rendered no HTML; skipped`)
          continue
        }
        if (html.length > limits.maxBytes) {
          warnings.push(`S${sources.length + 1} returned ${html.length} bytes, over the ${limits.maxBytes} limit; skipped`)
          continue
        }
        const inside = String(await page.evaluate(() => window.location.href))
        const pageTitle = await page.title()

        // Cap BEFORE extraction, so the stored body and the findings describe the SAME region.
        //
        // This file re-introduced a bug the single-page engine had already found and fixed: it
        // scanned the WHOLE page but stored only the first 20 KB. The independent verifier caught
        // it on a real run - a page carrying an instruction-like pattern past byte 20,000 was
        // recorded as hostileContentSeen=true, while the persisted sample contained no such
        // pattern, so a fresh scan of the stored bytes disagreed with the record it came from.
        // Either behaviour is defensible alone; the disagreement is not, because the record then
        // asserts something its own evidence cannot reproduce.
        let bodySample = html.slice(0, 20_000)
        let parsed = extractFrom(bodySample, { maxElements: limits.maxElements })
        // Relax the cap only when it yields nothing at all - RFC 9110's first 20 KB is <head>, so
        // a specification legitimately carries its content further in.
        if ('error' in parsed || parsed.extraction.elements.length === 0) {
          bodySample = html
          parsed = extractFrom(bodySample, { maxElements: limits.maxElements })
        }
        if ('error' in parsed) {
          warnings.push(`S${sources.length + 1} extraction failed: ${parsed.error}; skipped`)
          continue
        }
        const capped = bodySample.length < html.length

        // Ask the live DOM for ancestry rather than parsing an HTML string. `domWalker` is
        // self-contained so it survives being stringified into the page, and the judgement is
        // made here in Node where it is unit-testable. If the walk fails the elements are still
        // recorded - classified `unknown`, which is the honest answer, not a dropped page.
        let elements: ResearchRecord['elements'][number][] = []
        let walked = false
        try {
          const signals = await page.evaluate(domWalker)
          if (Array.isArray(signals) && signals.length > 0) {
            walked = true
            for (const s of signals.slice(0, limits.maxElements)) {
              const c = classifyElement({ tag: String(s.tag), ancestry: s.ancestry ?? [], text: String(s.text ?? '') })
              elements.push({
                tag: String(s.tag),
                text: String(s.text ?? '').slice(0, 300),
                ...(s.href ? { href: String(s.href).slice(0, 300) } : {}),
                chrome: c.chrome,
                chromeReason: c.reason,
                // Bounded, reduced structural evidence, so the verdict can be replayed later.
                evidence: toEvidence(s.ancestry ?? []),
              })
            }
          }
        } catch {
          walked = false
        }
        if (!walked || elements.length === 0) {
          elements = parsed.extraction.elements.map((e) => ({
            tag: e.tag,
            text: e.text,
            ...(e.href ? { href: e.href } : {}),
            chrome: 'unknown' as ChromeClass,
            chromeReason: 'the DOM walk produced nothing usable, so no ancestry was available and classification was refused',
            evidence: [],
          }))
        }

        const finalUrl = inside.length > 0 ? inside : target.toString()
        const record: ResearchRecord = buildRecord({
          runId: `${correlationId}.${sid}`,
          requestedUrl: target.toString(),
          finalUrl,
          status: 200,
          contentType: 'text/html',
          fetchedAt: Date.now(),
          schemaVersion: 3,
          title: typeof pageTitle === 'string' && pageTitle.length > 0 ? pageTitle : parsed.extraction.title,
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

        const source: BriefSource = {
          id: sid,
          url: finalUrl,
          title: record.title,
          fetchedAt: record.fetchedAt,
          elementCount: record.elementCount,
          findingCount: record.findingCount,
          artifactPath,
          digest: record.digest,
          selectedBy,
          selectedReason: nextReason,
        }
        sources.push(source)
        sourcesWithRecords.push({ source, record })

        // Collect candidates ONLY from this page's real DOM, resolved against the real page
        // URL. Same-host filtering happens at selection time so the skip is reported.
        if (sources.length < limits.maxPages) {
          const raw = await page.evaluate(() =>
            Array.from(document.querySelectorAll('a[href]'))
              .slice(0, 400)
              .map((a) => ({
                href: a.getAttribute('href') ?? '',
                text: (a.textContent ?? '').trim().slice(0, 80),
              })),
          )
          const usable = Array.isArray(raw)
            ? raw.filter((r) => r && typeof r.href === 'string')
            : []
          for (const cand of rankLinks(usable, keywords)) {
            const resolved = resolveCandidate(cand.href, new URL(finalUrl))
            if (!resolved) continue
            if (visited.has(resolved.toString())) continue
            if (limits.sameHostOnly && !sameSite(resolved, startUrl)) continue
            frontier.push({ ...cand, href: resolved.toString() })
          }
        }
      } catch (e) {
        warnings.push(`S${sources.length + 1} ${target.toString()} failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    // ---- assemble
    const facts = buildClaims(sourcesWithRecords)
    const claims = [...facts, ...deriveClaims(facts, sources, limits)]
    const unresolved = unresolvedQuestions(claims, sources)

    const terminalState: CompanyBrief['terminalState'] =
      sources.length === 0 ? 'failed'
        : sources.length < limits.maxPages && warnings.length > 0 ? 'partial'
          : 'complete'

    const terminalReason =
      terminalState === 'failed'
        ? 'no page could be collected, so no brief could be produced'
        : terminalState === 'partial'
          ? `collected ${sources.length} of up to ${limits.maxPages} page(s); ${warnings.length} problem(s) recorded, listed in warnings`
          : `collected ${sources.length} page(s) within the ${limits.maxPages}-page limit, with no warnings`

    const brief: CompanyBrief = {
      correlationId,
      objective: obj,
      startingUrl,
      mode: 'deterministic-extraction',
      modelUsed: null,
      limits,
      startedAt: t0,
      finishedAt: Date.now(),
      elapsedMs: Date.now() - t0,
      terminalState,
      terminalReason,
      sources,
      claims,
      unresolved,
      warnings,
      digest: digestBrief(correlationId, obj, startingUrl, sources, claims, unresolved),
    }
    writeFileSync(briefPath, JSON.stringify(brief, null, 2), 'utf8')

    appendBriefHistory({
      correlationId, at: Date.now(),
      objective: obj, startingUrl,
      terminalState, terminalReason,
      sourceCount: sources.length,
      tracedClaims: facts.length,
      unprovenClaims: claims.length - facts.length,
      briefPath,
    })

    return {
      correlationId, objective: obj, startingUrl,
      terminalState, terminalReason, briefPath,
      sources, claims, unresolved, warnings,
      elapsedMs: brief.elapsedMs,
      mode: 'deterministic-extraction', modelUsed: null,
    }
  } catch (e) {
    const reason = `the mission could not run: ${e instanceof Error ? e.message : String(e)}`
    return base({
      correlationId, objective: obj, startingUrl,
      terminalState: 'failed',
      terminalReason: reason,
      briefPath, warnings, elapsedMs: Date.now() - t0,
      mode: 'deterministic-extraction', modelUsed: null,
    })
  } finally {
    try { page?.close() } catch { /* browser is going away */ }
    try { ctx?.close() } catch { /* sockets already closed */ }
    if (browser) { try { browser.kill() } catch { /* already gone */ } }
  }
}