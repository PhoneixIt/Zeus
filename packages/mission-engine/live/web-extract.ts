/**
 * EXTRACTION from an untrusted page - and the boundary that matters.
 *
 * =============================================================================
 * THE ONE RULE OF THIS FILE
 * =============================================================================
 *
 * PAGE TEXT IS DATA. IT IS NEVER AN AUTHORITY.
 *
 * A page can say anything. It can claim to be a system message, an operator instruction, a
 * policy update, a request for credentials, a request to run a command, a statement that the
 * guard has been lifted. NONE of that is true, and none of it is acted on - because nothing in
 * this file can act. Extraction turns markup into a bounded list of strings. It does not
 * interpret, follow, or grant.
 *
 * What it DOES do is refuse to launder an injection into the result. A hostile instruction is
 * RECORDED as an inert finding, with the phrase that triggered it, and the content it rode in
 * on is still returned as text. It is not silently dropped either: dropping it would hide the
 * fact that the page tried, and a reader of the evidence should be able to see that.
 *
 * There is no code path from anything returned here to a tool call, a permission, or a
 * command. The only consumer is a persistence layer that writes strings to disk.
 *
 * =============================================================================
 * BOUNDS
 * =============================================================================
 *
 *   maxElements   a page with 10,000 links would otherwise produce a 10,000-element result.
 *   maxTextLength each element is truncated, so one enormous node cannot dominate the record.
 *   title         taken once, length-capped.
 */

export interface ContentElement {
  readonly tag: string
  readonly text: string
  readonly href?: string
  /** True when this element's text was cut to fit the per-element bound. */
  readonly truncated: boolean
  /**
   * Where this element sits in the page's structure. `'unknown'` is a real answer, not a
   * placeholder: it means the signals available did not support a confident classification, and
   * the element is preserved and still verifiable.
   */
  readonly chrome: ChromeClass
  /** Why that classification was reached. Persisted so a reader can disagree with it. */
  readonly chromeReason: string
}

// ===========================================================================================
// SITE CHROME vs PAGE CONTENT
// ===========================================================================================

/**
 * What an extracted element IS, structurally.
 *
 * The point of this classification is that "we successfully collected a <p>" and "we learned
 * something about the company" are different claims. A corporate homepage yields far more menu
 * labels than sentences, and presenting those as findings is wrong in substance even when every
 * quote is genuine and traceable.
 *
 *   main-content     inside an explicit main/article/content landmark
 *   navigation       inside nav, role=navigation, or a nav/menu/breadcrumb/sidebar class or id
 *   header           inside header, role=banner, or a header/masthead class or id
 *   footer           inside footer, role=contentinfo, or a footer class or id
 *   consent-banner   cookie / consent / GDPR machinery
 *   unknown          the signals did not support a confident answer
 *
 * There is deliberately no boolean. A boolean would force every judgement into "relevant" or
 * "irrelevant", and the whole reason this is a six-valued label is that the honest answer is
 * often "I cannot tell".
 *
 * WHAT IS NOT ASSUMED:
 *   - Not every element inside a <header> or <footer> is chrome. Footers routinely carry real
 *     contact details and legal text, and headers sometimes carry a lead paragraph. So a LONG
 *     prose element inside a header or footer is NOT auto-classified as chrome; it becomes
 *     'unknown' with a reason saying so.
 *   - Not every element outside a <nav> is content. A paragraph in an unlabelled sidebar is
 *     'unknown', not 'main-content', because nothing proved it was page content.
 */
export type ChromeClass =
  | 'main-content' | 'navigation' | 'header' | 'footer' | 'consent-banner' | 'unknown'

export const CHROME_CLASSES: readonly ChromeClass[] = [
  'main-content', 'navigation', 'header', 'footer', 'consent-banner', 'unknown',
]

export function isChromeClass(v: unknown): v is ChromeClass {
  return typeof v === 'string' && (CHROME_CLASSES as readonly string[]).includes(v)
}

/**
 * A compact structural signature for one ancestor, produced by `domWalker` in the page.
 *
 * Format: `tag~role~id~class~ariaLabel`. Compact because a single element can have a dozen
 * ancestors and these strings are persisted into every artifact; delimited because the
 * classifier must be unit-testable against hand-written fixtures with no browser.
 */
export type AncestorSignal = string

/**
 * Parse one ancestor signal into its slots. Declared before the evidence helpers below, which
 * use it, and deliberately tolerant: a malformed signal yields empty slots rather than throwing,
 * so a hostile page cannot crash extraction by shipping a malformed attribute.
 */
const sig = (s: AncestorSignal): { tag: string; role: string; id: string; cls: string; aria: string } => {
  const [tag = '', role = '', id = '', cls = '', aria = ''] = s.split('~')
  return { tag, role, id, cls, aria }
}

const has = (hay: string, re: RegExp): boolean => re.test(hay)
const blob = (a: { id: string; cls: string; aria: string }): string =>
  `${a.id} ${a.cls} ${a.aria}`.toLowerCase()

export interface ElementSignal {
  readonly tag: string
  readonly text: string
  readonly href?: string
  /** Nearest ancestor first, excluding the element itself. */
  readonly ancestry: readonly AncestorSignal[]
}

/** Above this length, text inside a header/footer is prose, not a label. */
const LABEL_MAX = 120

/**
 * The structural patterns, declared ONCE so the classifier and the evidence writer cannot drift.
 *
 * `toEvidence` uses these to decide which page-supplied strings are worth persisting; if the two
 * lists ever diverged, a classification could become irreproducible - the verifier would replay
 * the evidence and reach a different answer than the mission did. Sharing the list is the only
 * way to make that impossible rather than merely unlikely.
 */
export const STRUCTURAL_HINTS = {
  consent: /cookie|consent|gdpr|ccpa|onetrust|trustarc/,
  footer: /(^|[-_ ])footer([-_ ]|$)/,
  navigation: /(^|[-_ ])(nav|navbar|navigation|menu|breadcrumb|breadcrumbs|sidebar|side-?bar|dropdown|sub-?menu)([-_ ]|$)/,
  header: /(^|[-_ ])(header|masthead|top-?bar|site-?header)([-_ ]|$)/,
  content: /(^|[-_ ])(main|article|articlebody|post|postbody|entry|entry-content|content|contentbody|prose)([-_ ]|$)/,
} as const

// ===========================================================================================
// PERSISTED STRUCTURAL EVIDENCE
// ===========================================================================================

/**
 * The minimal record of WHY an element was classified, sufficient to reproduce the
 * classification without the original page.
 *
 * A classification a verifier cannot re-derive is an assertion. This is the difference between
 * "the mission said main-content" and "replaying these bytes through the authoritative
 * classifier says main-content".
 *
 * BOUNDED, deliberately. A hostile page can nest a thousand divs and pack megabytes into a
 * class attribute; without caps, one page could inflate an artifact without limit or stall
 * verification. Every field here has a hard ceiling:
 *
 *   ancestors   MAX_ANCESTORS (12) - only the nearest are kept, and only they are ever consulted
 *   tag         32 chars, must look like an element name
 *   role        40 chars, must look like an ARIA role
 *   hints       160 chars, and ONLY when it matches a structural pattern
 *
 * THAT LAST CAP IS THE ONE THAT MATTERS FOR SAFETY. `hints` is page-controlled text. Rather than
 * persisting arbitrary `id`/`class`/`aria` values, the writer keeps the whole "id class aria"
 * blob ONLY IF it matches one of STRUCTURAL_HINTS, and stores an empty string otherwise.
 *
 * A value that matches no structural pattern cannot influence any decision - every rule tests
 * against exactly these patterns - so blanking it loses nothing and reproduction still holds.
 * The upshot is that only page strings that already LOOK like structural markup enter a record:
 * a page cannot smuggle arbitrary content into the evidence field and have it mean anything.
 *
 * There is deliberately no free-text field here. `chromeReason` is derived, never stored raw,
 * and never echoes a page string.
 */
export interface AncestorEvidence {
  readonly tag: string
  readonly role: string
  /** Lowercased "id class aria", or '' when it matched no structural pattern. */
  readonly hints: string
}

export const MAX_ANCESTORS = 12
export const MAX_TAG = 32
export const MAX_ROLE = 40
export const MAX_HINTS = 160

const TAG_RE = /^[a-z][a-z0-9-]*$/
const ROLE_RE = /^[a-z]+$/

/** Does this blob influence ANY classification rule? */
function hintsAreStructural(hints: string): boolean {
  return hints.length > 0 && (
    STRUCTURAL_HINTS.consent.test(hints) ||
    STRUCTURAL_HINTS.footer.test(hints) ||
    STRUCTURAL_HINTS.navigation.test(hints) ||
    STRUCTURAL_HINTS.header.test(hints) ||
    STRUCTURAL_HINTS.content.test(hints)
  )
}

/**
 * Reduce live-DOM ancestry signals to the minimal persistable evidence.
 *
 * Pure, so it is directly testable, and lossy ONLY in ways that cannot change a verdict.
 */
export function toEvidence(ancestry: readonly AncestorSignal[]): AncestorEvidence[] {
  const out: AncestorEvidence[] = []
  for (const raw of ancestry.slice(0, MAX_ANCESTORS)) {
    const a = sig(raw)
    const tag = a.tag.toLowerCase().slice(0, MAX_TAG)
    const role = a.role.toLowerCase().slice(0, MAX_ROLE)
    // `blob` is `${id} ${cls} ${aria}`, so an empty id/aria leaves leading and trailing spaces.
    // Trimming makes the persisted form a FIXED POINT: re-blobbing the stored value and
    // re-trimming returns the same string. Without this, evidence would drift by a space on
    // every round trip, and "replay reproduces the verdict" would rest on regexes tolerating
    // stray whitespace rather than on the representation being stable.
    const b = blob(a).trim()
    out.push({
      tag: TAG_RE.test(tag) ? tag : 'div',
      role: ROLE_RE.test(role) ? role : '',
      hints: hintsAreStructural(b) ? b.slice(0, MAX_HINTS) : '',
    })
  }
  return out
}

/**
 * Reconstruct ancestry signals from persisted evidence.
 *
 * The inverse of `toEvidence`, in the same delimited format the classifier consumes. Because the
 * verifier's replay path goes through this function, a reproduction uses the SAME authoritative
 * `classifyElement` the mission used - never a second implementation that could drift.
 */
export function fromEvidence(evidence: readonly AncestorEvidence[]): AncestorSignal[] {
  return evidence.slice(0, MAX_ANCESTORS).map((e) => `${e.tag}~${e.role}~~${e.hints}~`)
}

/**
 * Reproduce a classification from persisted evidence, through the SAME authoritative classifier.
 *
 * The verifier calls this rather than reimplementing the rules. A second implementation would be
 * a second thing to keep correct, and the day it disagreed with the first, every artifact would
 * still "verify" while meaning something different from what the mission recorded.
 */
export function classifyFromEvidence(
  evidence: readonly AncestorEvidence[],
  text: string,
): { chrome: ChromeClass; reason: string } {
  return classifyElement({ tag: 'p', ancestry: fromEvidence(evidence), text })
}

/**
 * Classify one element from its structural signals.
 *
 * Pure, total, and side-effect free - which is what makes the classification testable at all.
 * The walker that PRODUCES the signals runs in a browser and cannot be; splitting the work this
 * way keeps the judgement itself under test.
 *
 * =============================================================================
 * NEAREST LANDMARK WINS
 * =============================================================================
 *
 * The first version iterated RULE BY RULE across the whole ancestry: check every ancestor for
 * consent, then every ancestor for footer, then navigation, then header, then content. That is
 * wrong, and a real run proved it.
 *
 * On fastly.com it classified 240 of 240 elements as navigation and produced a report with no
 * evidence at all. The reason was structural, not a bad regex: the page's mega-menu lives under
 * a wrapper classed `_nav-viewport_…`, which is a genuine navigation ancestor - but it sits six
 * levels up, while the actual content was only three levels from a `<main>` or a `content` div.
 * Because navigation was checked before content, the distant menu won and swallowed the page.
 *
 * So the walk is now NEAREST ANCESTOR FIRST, and the first ancestor that expresses any landmark
 * decides. That is both more accurate and easier to reason about: an element is classified by
 * the structure immediately around it, not by whichever pattern happens to be tested first.
 *
 * Two consequences worth stating, because they are judgement calls rather than accidents:
 *
 *   - a `<nav>` inside a `<footer>` is classified `navigation`, not `footer`. Nearest wins, and
 *     it genuinely is a nav element. Both labels are chrome, so the report treats them the same.
 *   - there is deliberately NO "footer is terminal" special case. It was considered and
 *     rejected: it would mean checking for a footer before walking, which is exactly the
 *     rule-before-ancestry ordering that produced the fastly.com failure. One rule, applied
 *     uniformly, is worth more than an exception that is right most of the time.
 */
export function classifyElement(input: { tag: string; ancestry: readonly AncestorSignal[]; text: string }):
{ chrome: ChromeClass; reason: string } {
  const long = input.text.trim().length > LABEL_MAX

  for (let i = 0; i < input.ancestry.length; i++) {
    const a = sig(input.ancestry[i])
    const b = blob(a)

    // Consent machinery beats everything, at any depth. "Accept all cookies" is never a
    // statement about the subject.
    //
    // The reason deliberately does NOT echo the matched attribute values. Page-controlled
    // strings must not flow into any field of a record: `web-research.test.ts` asserts that the
    // extraction carries nothing a page could use to express itself as more than data.
    if (has(b, /cookie|consent|gdpr|ccpa|onetrust|trustarc/)) {
      return { chrome: 'consent-banner', reason: `ancestor <${a.tag}> carries a consent/cookie signal` }
    }

    // Footer is terminal.
    if (a.tag === 'footer' || a.role === 'contentinfo' || has(b, /(^|[-_ ])footer([-_ ]|$)/)) {
      if (long) return { chrome: 'unknown', reason: `long prose (${input.text.trim().length} chars) inside <${a.tag}>; not assumed to be chrome` }
      return { chrome: 'footer', reason: `inside <${a.tag}> footer landmark` }
    }

    if (a.tag === 'nav' || a.role === 'navigation' ||
      has(b, /(^|[-_ ])(nav|navbar|navigation|menu|breadcrumb|breadcrumbs|sidebar|side-?bar|dropdown|sub-?menu)([-_ ]|$)/)) {
      return { chrome: 'navigation', reason: `inside <${a.tag}> navigation landmark` }
    }

    // Header, with the "long text is not assumed to be chrome" caveat.
    if (a.tag === 'header' || a.role === 'banner' || has(b, /(^|[-_ ])(header|masthead|top-?bar|site-?header)([-_ ]|$)/)) {
      if (long) return { chrome: 'unknown', reason: `long prose (${input.text.trim().length} chars) inside <${a.tag}>; not assumed to be chrome` }
      return { chrome: 'header', reason: `inside <${a.tag}> header landmark` }
    }

    // Only an EXPLICIT landmark counts as content. Being outside a nav proves nothing, so an
    // unlandmarked element stays 'unknown' rather than being promoted on the basis of not
    // having been excluded.
    if (a.tag === 'main' || a.tag === 'article' || a.role === 'main' ||
      has(b, /(^|[-_ ])(main|article|articlebody|post|postbody|entry|entry-content|content|contentbody|prose)([-_ ]|$)/)) {
      return { chrome: 'main-content', reason: `inside <${a.tag}> content landmark` }
    }
  }

  if (input.ancestry.length === 0) {
    return { chrome: 'unknown', reason: 'no ancestry information was available; classification refused' }
  }
  return {
    chrome: 'unknown',
    reason: `inside <${sig(input.ancestry[0]).tag}> with no recognisable landmark among its ${input.ancestry.length} nearest ancestor(s); not proven either way`,
  }
}

/**
 * Walk the live DOM and return raw signals ONLY - no classification.
 *
 * This function is serialised into the page by CDP (`fn.toString()`), so it MUST be completely
 * self-contained: no imports, no closure over module scope, no helper calls. Keeping the walk
 * dumb and the judgement in Node is what lets the judgement be unit-tested.
 */
export function domWalker(): Array<{ tag: string; text: string; href: string | null; ancestry: string[] }> {
  const out: Array<{ tag: string; text: string; href: string | null; ancestry: string[] }> = []
  const nodes = document.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,pre')
  const decode = (s: string): string =>
    s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
  for (let i = 0; i < nodes.length && out.length < 200; i++) {
    const el = nodes[i]
    if (!el.textContent) continue
    const text = decode(el.textContent.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()
    if (text.length === 0) continue
    const ancestry: string[] = []
    for (let n = el.parentElement; n && n !== document.documentElement && n.tagName; n = n.parentElement) {
      const tag = n.tagName.toLowerCase()
      const role = n.getAttribute('role') || ''
      const id = n.getAttribute('id') || ''
      const cls = n.getAttribute('class') || ''
      const aria = n.getAttribute('aria-label') || ''
      ancestry.push(tag + '~' + role + '~' + id + '~' + cls + '~' + aria)
      if (ancestry.length >= 12) break
    }
    out.push({ tag: el.tagName.toLowerCase(), text: text.slice(0, 300), href: el.getAttribute('href'), ancestry })
  }
  return out
}

export interface InjectionFinding {
  readonly kind: 'instruction-claim' | 'secret-request' | 'command-request' | 'permission-request'
  readonly phrase: string
  /** Always true. Stated so a reader cannot mistake a finding for an action taken. */
  readonly actedOn: false
}

export interface Extraction {
  readonly title: string
  readonly elements: readonly ContentElement[]
  readonly findings: readonly InjectionFinding[]
  /** True when the page tried to issue instructions. Recorded, never obeyed. */
  readonly hostileContentSeen: boolean
  readonly truncated: boolean
  readonly elementCount: number
}

export type ExtractResult = { readonly extraction: Extraction } | { readonly error: string }

export const MAX_ELEMENTS = 40
export const MAX_TEXT = 300

/**
 * Patterns for content that tries to act as an instruction rather than be read.
 *
 * Deliberately conservative and deliberately inert. Matching one is not an error: the page is
 * still read, still extracted, still persisted. Only the FINDING is recorded.
 */
const INJECTION: ReadonlyArray<{ kind: InjectionFinding['kind']; re: RegExp }> = [
  { kind: 'instruction-claim', re: /\b(ignore|disregard|forget)\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?)/i },
  { kind: 'instruction-claim', re: /\b(system|developer|admin|administrator|root)\s*(message|instruction|directive|command|note)\s*:/i },
  { kind: 'instruction-claim', re: /\byou\s+(are|have been)\s+(now\s+)?(a|an|the)\s+\w*\s*(assistant|agent|administrator|root|operator)/i },
  { kind: 'instruction-claim', re: /\b(new|updated|revised)\s+(instructions?|directives?|policy|rules)\s*[:\-]/i },
  { kind: 'secret-request', re: /\b(api[_\s-]?key|password|passwd|secret|token|credential|private[_\s-]?key)\b[\s\S]{0,40}\b(send|share|reveal|disclose|provide|email|post|give me|exfiltrat)/i },
  { kind: 'secret-request', re: /\b(send|post|email|upload|leak)\b[\s\S]{0,40}\b(password|credential|api[_\s-]?key|token|secret)s?\b/i },
  { kind: 'command-request', re: /\b(run|execute|eval|invoke)\b[\s\S]{0,30}\b(command|script|shell|powershell|bash|code|subprocess)\b/i },
  { kind: 'command-request', re: /\b(rm\s+-rf|del\s+|format\s+c:|drop\s+table|shutdown|rmdir)\b/i },
  // The window is deliberately wider than 30 characters. "Grant elevated permissions to this
  // session" is 41 characters of plain English; a narrower window matched nothing, and a test
  // caught it. A pattern that never fires is indistinguishable from a pattern that is absent.
  // `\b` on the RIGHT of a group is the trap here. With `permission|access|...`, `\b` is
  // evaluated at the END of the whole alternation, so for the branch "permission" the engine
  // tests a boundary after "permission" - and the following "s" is a word character, so the
  // boundary fails and "permissions" never matches. It passed a test written with the singular
  // and failed on the plural, which is exactly the shape of bug this file exists to catch. The
  // plural is written out rather than relying on `permission\w*`, so the intent is visible.
  { kind: 'permission-request', re: /\b(grant|give|extend|elevate|escalate|raise|bypass|disable|remove)\b[\s\S]{0,60}\b(permission|permissions|access|privilege|privileges|rights?|admin|root|guard|safety|authorization|restriction|restrictions)\b/i },
  { kind: 'permission-request', re: /\b(guard|safety|authorization)\b[\s\S]{0,30}\b(is\s+)?(now\s+)?(disabled|disabled|lifted|removed|off|bypassed)/i },
  // Written both ways round. The first version only matched "clear the human takeover", so a
  // page saying "release the human takeover" - the same request, the other word order - sailed
  // past. An injection filter that only catches one phrasing of the same ask is not a filter.
  { kind: 'permission-request', re: /\bhuman[_\s-]?takeover\b[\s\S]{0,40}\b(clear|cleared|release|released|reset|resetting|lift|lifted|disable|disabled)\b/i },
  { kind: 'permission-request', re: /\b(clear|release|reset|lift|disable)\b[\s\S]{0,40}\bhuman[_\s-]?takeover\b/i },
]

const decodeEntities = (s: string): string =>
  s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')

const stripTags = (s: string): string => decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()

/** Extract the document title, length-capped. */
function extractTitle(html: string): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  if (!m) return ''
  return stripTags(m[1]).slice(0, 200)
}

/**
 * Pull bounded, meaningful content elements.
 *
 * Headings, paragraphs and list items, because those are what a page is actually saying. A
 * page with none of them is not an error - it is a page whose content we did not understand,
 * and the caller decides what that means.
 */
function extractElements(html: string, maxElements: number): { elements: ContentElement[]; truncated: boolean } {
  const out: ContentElement[] = []
  let truncated = false
  // `pre` is included because specifications - RFCs, drafts, API docs - carry their substance
  // in preformatted blocks, and a mission pointed at one found ZERO elements from its opening
  // kilobytes. Without it, "no content found" would have meant "the content is not in a tag I
  // recognise", which is a failure of the extractor, not of the page.
  const re = /<(h[1-6]|p|li|pre)\b([^>]*)>([\s\S]*?)<\/\1>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    if (out.length >= maxElements) { truncated = true; break }
    const tag = m[1].toLowerCase()
    const text = stripTags(m[3])
    if (text.length === 0) continue
    const full = text.length > MAX_TEXT
    const hrefM = /\bhref\s*=\s*["']([^"']+)["']/i.exec(m[2] ?? '')
    out.push({
      tag,
      text: text.slice(0, MAX_TEXT),
      ...(hrefM ? { href: hrefM[1].slice(0, 300) } : {}),
      truncated: full,
      // A regex over an HTML string cannot see the element tree. Rather than guess, this path
      // records `unknown` - which is the honest answer, and is why the live pipeline runs the
      // DOM walker instead.
      chrome: 'unknown',
      chromeReason: 'parsed from an HTML string; DOM ancestry was not available, so classification was refused',
    })
  }
  return { elements: out, truncated }
}

/**
 * Scan text for content trying to issue instructions. Returns findings only - never an action,
 * never a modified result.
 */
export function scanForInjection(text: string): InjectionFinding[] {
  const findings: InjectionFinding[] = []
  for (const { kind, re } of INJECTION) {
    const m = re.exec(text)
    if (m) {
      findings.push({
        kind,
        phrase: m[0].slice(0, 120),
        actedOn: false,
      })
    }
  }
  return findings
}

/** Extract from a page body. Total failure to produce a title AND elements is an error. */
export function extractFrom(html: string, opts: { maxElements?: number } = {}): ExtractResult {
  const maxElements = opts.maxElements ?? MAX_ELEMENTS
  const title = extractTitle(html)
  const { elements, truncated } = extractElements(html, maxElements)
  if (title.length === 0 && elements.length === 0) {
    return { error: 'no title and no content elements found; refusing to record an empty extraction as success' }
  }
  const findings = scanForInjection(html)
  return {
    extraction: {
      title,
      elements,
      findings,
      hostileContentSeen: findings.length > 0,
      truncated,
      elementCount: elements.length,
    },
  }
}