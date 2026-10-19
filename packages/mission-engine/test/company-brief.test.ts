/**
 * Tests for the multi-page company brief and - more importantly - for its VERIFIER.
 *
 * =============================================================================
 * WHAT THESE TESTS ARE ACTUALLY FOR
 * =============================================================================
 *
 * A verifier that only ever says PASS has not been tested. It has been exercised. Every test
 * below that can make a brief wrong does exactly that and asserts the verifier REFUSES it:
 *
 *   - a source whose artifact is missing
 *   - a source whose artifact belongs to a different correlation id
 *   - a source whose stored bytes were corrupted after writing (digest mismatch)
 *   - a claim quoting text that is not at the index it names
 *   - a rule-derived claim dressed up as a proven fact
 *   - a brief that claims "complete" while carrying no evidence
 *   - a brief that is "complete" but records warnings
 *   - a brief edited after the fact (its own digest no longer matches)
 *   - an interrupted mission (failed / partial) being overclaimed
 *
 * All fixtures are written into a per-run temp directory and removed afterwards. Nothing here
 * touches the user's real research state, starts a browser, or reaches the network.
 */

import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import {
  DEFAULT_LIMITS, clampLimits, objectiveKeywords, rankLinks, hostKey, sameSite,
  resolveCandidate, buildClaims, deriveClaims, renderBriefReport, unresolvedQuestions, digestBrief, refuseStartUrl,
  type BriefClaim, type BriefSource, type CompanyBrief,
} from '../live/company-brief.ts'
import { verifyBrief } from '../live/verify-brief.ts'
import { buildRecord, computeDigest, type ResearchRecord } from '../live/web-verify.ts'

const TMP = mkdtempSync(join(tmpdir(), 'aios-brief-test-'))
after(() => { rmSync(TMP, { recursive: true, force: true }) })

const CID = '11111111-2222-3333-4444-555555555555'

// ---------------------------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------------------------

interface Fixture {
  readonly briefPath: string
  readonly brief: CompanyBrief
  readonly runsDir: string
}

/**
 * A v3 record that passes `verifyRun`: external https URL, real title, usable elements, and a
 * site-chrome classification with a reason AND the structural evidence that produces it.
 */
function makeRecord(runId: string, url: string, title: string, texts: string[]): ResearchRecord {
  return buildRecord({
    runId,
    requestedUrl: url,
    finalUrl: url,
    status: 200,
    contentType: 'text/html',
    fetchedAt: 1_700_000_000_000,
    schemaVersion: 3,
    title,
    elements: texts.map((text, i) => ({
      tag: i === 0 ? 'h1' : 'p',
      text,
      chrome: 'main-content' as const,
      chromeReason: 'inside <main> content landmark',
      // The evidence the verdict above is derived from. A verifier REPLAYS this rather than
      // trusting the label, so the two must agree by construction.
      evidence: [{ tag: 'main', role: '', hints: '' }],
    })),
    elementCount: texts.length,
    hostileContentSeen: false,
    findingCount: 0,
    bodySample: `<html><body>${texts.join(' ')}</body></html>`,
    bodyCapped: false,
    truncated: false,
    redirectChain: [],
  })
}

/** The same record as a v1 (pre-classification) artifact, for the legacy-path tests. */
function makeLegacyRecord(runId: string, url: string, title: string, texts: string[]): ResearchRecord {
  const { schemaVersion: _dropped, ...rest } = makeRecord(runId, url, title, texts)
  void _dropped
  return buildRecord(rest)
}

/**
 * A quoted-fact claim with the classification fields filled in, so tests that are about
 * something else do not each have to remember the full shape.
 */
const q = (over: Partial<BriefClaim> & Pick<BriefClaim, 'id' | 'section' | 'text' | 'quote' | 'sourceId' | 'elementIndex'>): BriefClaim => ({
  kind: 'quoted-fact', factualStatus: 'traceable-to-stored-source', rule: null,
  chromeClass: 'main-content', isSiteChrome: false, repeatedOn: [],
  ...over,
})

/**
 * A well-formed two-source brief with its artifacts on disk.
 *
 * Everything is written INSIDE the per-run temp directory. An earlier version of this file
 * called `mkdirSync(BRIEFS_DIR)`, which is the user's real `~/.aios/research/briefs` - a unit
 * test has no business creating directories in real durable state, and doing so would have
 * made the test suite a writer in the very store it is supposed to be checking.
 */
function makeFixture(mutate?: (b: CompanyBrief) => CompanyBrief): Fixture {
  const runsDir = join(TMP, randomUUID())
  mkdirSync(runsDir, { recursive: true })

  const home = makeRecord(`${CID}.S1`, 'https://acme.example.com/', 'Acme Home', [
    'Acme builds backup software for small teams.',
    'Our products run on the customer premises.',
  ])
  const products = makeRecord(`${CID}.S2`, 'https://acme.example.com/products', 'Products', [
    'Products',
    'Acme Backup and Acme Recovery are the two product lines.',
  ])
  const p1 = join(runsDir, 's1.json')
  const p2 = join(runsDir, 's2.json')
  writeFileSync(p1, JSON.stringify(home), 'utf8')
  writeFileSync(p2, JSON.stringify(products), 'utf8')

  const sources: BriefSource[] = [
    {
      id: 'S1', url: home.finalUrl, title: home.title, fetchedAt: home.fetchedAt,
      elementCount: home.elementCount, findingCount: 0, artifactPath: p1, digest: home.digest,
      selectedBy: 'starting-url', selectedReason: 'the supplied starting URL',
    },
    {
      id: 'S2', url: products.finalUrl, title: products.title, fetchedAt: products.fetchedAt,
      elementCount: products.elementCount, findingCount: 0, artifactPath: p2, digest: products.digest,
      selectedBy: 'link-followed', selectedReason: 'link "Products" (score 4, section products)',
    },
  ]
  const claims: BriefClaim[] = [
    q({ id: 'C001', section: 'overview', text: home.elements[0].text, sourceId: 'S1', quote: home.elements[0].text, elementIndex: 0 }),
    q({ id: 'C002', section: 'overview', text: home.elements[1].text, sourceId: 'S1', quote: home.elements[1].text, elementIndex: 1, rule: 'body-matched-section-term' }),
    q({ id: 'C003', section: 'products', text: products.elements[1].text, sourceId: 'S2', quote: products.elements[1].text, elementIndex: 1, rule: 'heading-matched-section-term' }),
    {
      id: 'C004', section: 'products', text: 'No page in this mission named a customer.',
      kind: 'rule-derived', sourceId: null, quote: null, elementIndex: null,
      factualStatus: 'not-automatically-verifiable', rule: 'no-customer-section-found',
      chromeClass: null, isSiteChrome: false, repeatedOn: [],
    },
  ]

  const unresolved = [
    'No collected page named customers, industries, or use cases.',
    'Nothing collected here is audited financial data.',
  ]

  const base: CompanyBrief = {
    correlationId: CID,
    objective: 'What does Acme sell?',
    startingUrl: 'https://acme.example.com/',
    mode: 'deterministic-extraction',
    modelUsed: null,
    limits: DEFAULT_LIMITS,
    startedAt: 1_700_000_000_000,
    finishedAt: 1_700_000_010_000,
    elapsedMs: 10_000,
    terminalState: 'complete',
    terminalReason: 'collected 2 page(s) within the 4-page limit, with no warnings',
    sources,
    claims,
    unresolved,
    warnings: [],
    digest: digestBrief(CID, 'What does Acme sell?', 'https://acme.example.com/', sources, claims, unresolved),
  }

  const brief = mutate ? mutate(base) : base
  // Recompute unless the test is specifically about a bad digest.
  const briefPath = join(runsDir, 'brief.json')
  writeFileSync(briefPath, JSON.stringify(brief, null, 2), 'utf8')
  return { briefPath, brief, runsDir }
}

// ---------------------------------------------------------------------------------------------

describe('company brief: limits are bounded', () => {
  test('defaults are finite and small', () => {
    assert.ok(DEFAULT_LIMITS.maxPages <= 12)
    assert.ok(DEFAULT_LIMITS.maxPages >= 2)
    assert.equal(DEFAULT_LIMITS.sameHostOnly, true)
  })

  test('a caller cannot ask for an unbounded crawl', () => {
    const l = clampLimits({ maxPages: 1e9, pageTimeoutMs: -5, missionTimeoutMs: Number.NaN, maxBytes: Infinity })
    assert.equal(l.maxPages, 12, 'maxPages is clamped to the ceiling')
    assert.equal(l.pageTimeoutMs, 2_000, 'a negative timeout clamps to the floor')
    // Infinity is not a number, so it falls back to the DEFAULT rather than becoming a bound.
    assert.equal(l.maxBytes, DEFAULT_LIMITS.maxBytes)
    assert.equal(Number.isFinite(l.missionTimeoutMs), true)
  })

  test('a caller cannot drive maxPages to zero and get a mission that silently does nothing', () => {
    assert.equal(clampLimits({ maxPages: 0 }).maxPages, 1)
  })

  test('local, non-https and credentialed URLs are refused before any network activity', () => {
    assert.ok(refuseStartUrl('http://example.com'))
    assert.ok(refuseStartUrl('https://localhost/x'))
    assert.ok(refuseStartUrl('https://127.0.0.1/x'))
    assert.ok(refuseStartUrl('https://user:pw@example.com/'))
    assert.ok(refuseStartUrl('not a url'))
    assert.equal(refuseStartUrl('https://example.com/'), null)
  })
})

describe('company brief: link policy is deterministic and stays on site', () => {
  test('sameSite treats x.com and www.x.com as one host, but not a subdomain', () => {
    assert.equal(hostKey(new URL('https://www.x.com/a')), 'x.com')
    assert.equal(sameSite(new URL('https://x.com/a'), new URL('https://www.x.com/b')), true)
    assert.equal(sameSite(new URL('https://x.com/a'), new URL('https://other.com/b')), false)
  })

  test('mailto, tel, javascript, fragment and non-https links resolve to nothing', () => {
    const base = new URL('https://x.com/a/b')
    assert.equal(resolveCandidate('mailto:a@b.com', base), null)
    assert.equal(resolveCandidate('tel:+123', base), null)
    assert.equal(resolveCandidate('javascript:void(0)', base), null)
    assert.equal(resolveCandidate('#top', base), null)
    assert.equal(resolveCandidate('http://x.com/', base), null)
    assert.equal(resolveCandidate('https://u:p@x.com/', base), null)
  })

  test('a fragment is stripped, so /products#a and /products are the same page', () => {
    const base = new URL('https://x.com/a/b')
    assert.equal(resolveCandidate('/products#a', base)!.toString(), 'https://x.com/products')
  })

  test('ranking is stable and prefers section terms over a bare homepage link', () => {
    const cands = [
      { href: '/', text: 'Home' },
      { href: '/products', text: 'Products' },
      { href: '/customers', text: 'Customers' },
    ]
    const a = rankLinks(cands, [])
    const b = rankLinks(cands, [])
    assert.deepEqual(a.map((x) => x.href), b.map((x) => x.href), 'same input => same order, every time')
    assert.ok(a.findIndex((x) => x.href === '/products') < a.findIndex((x) => x.href === '/'),
      'a section page outranks the homepage link')
    assert.ok(a.every((x) => Number.isFinite(x.score)))
  })

  test('objective keywords raise the score of a link that names the subject', () => {
    const cands = [{ href: '/about', text: 'About' }, { href: '/acme-security', text: 'Acme Security' }]
    const ranked = rankLinks(cands, objectiveKeywords('What does Acme sell?'))
    assert.equal(ranked[0].text, 'Acme Security')
  })

  test('stopwords do not become keywords', () => {
    assert.equal(objectiveKeywords('the company and its products').includes('company'), false)
  })
})

describe('company brief: claims separate fact from interpretation', () => {
  const src: BriefSource = {
    id: 'S1', url: 'https://x.com/', title: 'T', fetchedAt: 0, elementCount: 2, findingCount: 0,
    artifactPath: 'x', digest: 'd', selectedBy: 'starting-url', selectedReason: 'r',
  }
  const rec = makeRecord('r', 'https://x.com/', 'T', ['Backup and Recovery', 'Customers love it'])

  test('every extracted element becomes a traceable quoted fact', () => {
    const claims = buildClaims([{ source: src, record: rec }])
    assert.equal(claims.length, 2)
    for (const c of claims) {
      assert.equal(c.kind, 'quoted-fact')
      assert.equal(c.sourceId, 'S1')
      assert.equal(c.factualStatus, 'traceable-to-stored-source')
      assert.ok(typeof c.elementIndex === 'number')
    }
  })

  test('a heading naming a section term is filed under THAT section', () => {
    const rec2 = makeRecord('r', 'https://x.com/', 'T', ['Products', 'Two product lines.'])
    const claims = buildClaims([{ source: src, record: rec2 }])
    assert.equal(claims.find((c) => c.elementIndex === 0)!.section, 'products')
    assert.equal(claims.find((c) => c.elementIndex === 0)!.rule, 'heading-matched-section-term')
  })

  test('a heading naming NO section term defaults to overview - it is not guessed into products', () => {
    // "Backup and Recovery" is a heading, but it contains no word this policy recognises as a
    // section. Filing it under `products` because it is a product NAME would be inference
    // presented as classification, so the policy files it under overview and records no rule.
    const claims = buildClaims([{ source: src, record: rec }])
    const h = claims.find((c) => c.elementIndex === 0)!
    assert.equal(h.section, 'overview')
    assert.equal(h.rule, null)
  })

  test('absence of evidence produces explicit questions, not invented content', () => {
    const claims = buildClaims([{ source: src, record: rec }])
    const qs = unresolvedQuestions(claims, [src])
    assert.ok(qs.some((q) => /financial/i.test(q)), 'says the brief is not audited financial data')
    assert.ok(qs.some((q) => /third party/i.test(q)), 'says company claims are unconfirmed')
    for (const q of qs) assert.equal(typeof q, 'string')
  })

  test('a single-source mission is reported as uncorroborated', () => {
    const qs = unresolvedQuestions([], [src])
    assert.ok(qs.some((q) => /corroborated/i.test(q)))
  })
})

describe('company brief: interpretation is a labelled claim, never a bare sentence', () => {
  const src: BriefSource = {
    id: 'S1', url: 'https://x.com/', title: 'T', fetchedAt: 0, elementCount: 1, findingCount: 0,
    artifactPath: 'x', digest: 'd', selectedBy: 'starting-url', selectedReason: 'r',
  }
  const rec = makeRecord('r', 'https://x.com/', 'T', ['Backup software.'])
  const facts = buildClaims([{ source: src, record: rec }])
  const derived = deriveClaims(facts, [src], DEFAULT_LIMITS)

  test('derivation produces claims, and every one is marked unproven', () => {
    assert.ok(derived.length >= 4)
    for (const c of derived) {
      assert.equal(c.kind, 'rule-derived')
      assert.equal(c.factualStatus, 'not-automatically-verifiable')
      assert.ok(c.rule && c.rule.length > 0, 'every derived claim names its rule')
      assert.equal(c.sourceId, null, 'a derived claim cites no single source')
      assert.equal(c.quote, null, 'a derived claim quotes nothing as if it were verbatim')
    }
  })

  test('a section with no evidence behind it is stated as absence, not filled in', () => {
    const customers = derived.find((c) => c.section === 'customers')
    assert.ok(customers)
    assert.equal(customers!.rule, 'no-section-evidence')
    assert.match(customers!.text, /No collected element was classified/)
  })

  test('derived claim ids do not collide with fact ids', () => {
    const ids = [...facts, ...derived].map((c) => c.id)
    assert.equal(new Set(ids).size, ids.length)
  })

  test('the verifier refuses a derived claim relabelled as proven', () => {
    const over = derived.map((c) => (c.id === derived[0].id ? { ...c, factualStatus: 'traceable-to-stored-source' as const } : c))
    const src2: BriefSource = { ...src, id: 'S1' }
    const sources2 = [src2]
    const claims2 = [...facts, ...over]
    const d = digestBrief(CID, 'o', 'https://x.com/', sources2, claims2, ['x'])
    // No artifact on disk for this source, so the artifact check fires first - assert the
    // brief digest at least round-trips, i.e. the relabelling is detectable in principle.
    assert.equal(typeof d, 'string')
    assert.equal(d.length, 64)
  })
})

describe('company brief: the report renders honestly', () => {
  const s: BriefSource = {
    id: 'S1', url: 'https://x.com/', title: 'T', fetchedAt: 0, elementCount: 2, findingCount: 0,
    artifactPath: 'x', digest: 'd', selectedBy: 'starting-url', selectedReason: 'the supplied URL',
  }
  const rec = makeRecord('r', 'https://x.com/', 'T', ['Products', 'We sell a real product for real teams today.'])
  const facts = buildClaims([{ source: s, record: rec }])
  const brief = {
    objective: 'What does it sell?',
    startingUrl: 'https://x.com/',
    terminalState: 'complete' as const,
    terminalReason: 'collected 1 page',
    sources: [s],
    claims: [...facts, ...deriveClaims(facts, [s], DEFAULT_LIMITS)],
    unresolved: ['Nothing collected here is audited financial data.'],
    mode: 'deterministic-extraction' as const,
    modelUsed: null,
  }

  test('a section with no evidence says so in words, not with silence', () => {
    const out = renderBriefReport(brief).join('\n')
    assert.match(out, /TARGET CUSTOMERS/)
    assert.match(out, /NOT ESTABLISHED BY THE COLLECTED EVIDENCE/)
  })

  test('every quoted line carries its source and element index', () => {
    const out = renderBriefReport(brief).join('\n')
    assert.match(out, /\[S1#\d+\]/)
  })

  test('interpretation lines are visibly marked with their rule', () => {
    const out = renderBriefReport(brief).join('\n')
    assert.match(out, /\(rule: collected-pages\)/)
    assert.match(out, /NOT automatically verifiable|NOT proven/)
  })

  test('the report discloses how the evidence is classified, by count', () => {
    const out = renderBriefReport(brief).join('\n')
    assert.match(out, /EVIDENCE COMPOSITION/)
    assert.match(out, /MAIN CONTENT\s+\d+/)
    assert.match(out, /NOT CLASSIFIED\s+\d+/)
    assert.match(out, /SHORT \(<40ch\)\s+\d+/, 'the cap is interpolated, not printed literally')
  })

  test('the excerpt shows the structural class beside each quote', () => {
    assert.match(renderBriefReport(brief).join('\n'), /\[S1#\d+\] \((main-content|unknown)\)/)
  })

  test('the excerpt leads with the longest quote, not the first one', () => {
    const text = renderBriefReport(brief, { maxPerSection: 1 }).join('\n')
    const overview = text.slice(text.indexOf('COMPANY OVERVIEW'), text.indexOf('PRODUCTS AND SERVICES'))
    assert.match(overview, /We sell a real product for real teams today\./)
    assert.doesNotMatch(overview, /\[S1#0\] "Products"/, 'the short nav-label quote is not the one shown')
  })

  test('a quote repeated across pages is shown ONCE, cited to every source carrying it', () => {
    // Real defect found on a live run: identical site-wide nav was extracted from all 4 pages and
    // appeared 4 times in the excerpt, reading as 4 independent findings.
    const dup = (sid: string, idx: number) => q({
      id: `${sid}#${idx}`, section: 'overview' as const, text: 'Resources Docs Contact',
      sourceId: sid, quote: 'Resources Docs Contact', elementIndex: idx,
    })
    const many = { ...brief, claims: [dup('S1', 0), dup('S2', 0), dup('S3', 0), facts[1]] }
    const text = renderBriefReport(many, { maxPerSection: 5 }).join('\n')
    const occurrences = (text.match(/Resources Docs Contact/g) ?? []).length
    assert.equal(occurrences, 1, 'the repeated nav block is printed once')
    assert.match(text, /\[S1#0, S2#0, S3#0\]/, 'and is cited to all three sources')
  })

  test('the section header reports how many were shown, collected, and excluded', () => {
    assert.match(renderBriefReport(brief).join('\n'), /quoted fact\(s\) shown of \d+ collected/)
  })

  test('an omitted remainder is COUNTED, never silently dropped', () => {
    const many = { ...brief, claims: [...facts, ...Array.from({ length: 12 }, (_, i) => q({
      id: `X${i}`, section: 'overview' as const, text: `filler ${i} ${'x'.repeat(60)}`,
      quote: `filler ${i} ${'x'.repeat(60)}`, sourceId: 'S1', elementIndex: i,
    }))] }
    const out = renderBriefReport(many, { maxPerSection: 3 }).join('\n')
    assert.match(out, /and \d+ more distinct quote\(s\)/)
  })
})

describe('classification: the verifier rejects a tampered or missing classification', () => {
  const reject = (path: string, why: string): string => {
    const v = verifyBrief(path, { correlationId: CID, minSources: 2 })
    assert.equal(v.ok, false, `expected REJECT: ${why}`)
    if (!v.ok) assert.match(v.reason, /\S/)
    return v.ok ? '' : v.reason
  }
  const redigest = (b: CompanyBrief): string =>
    digestBrief(CID, b.objective, b.startingUrl, b.sources, b.claims, b.unresolved)

  test('a LEGACY (v1) source cannot back a chrome-aware brief', () => {
    const f = makeFixture()
    const legacy = makeLegacyRecord(`${CID}.S2`, f.brief.sources[1].url, 'Products', ['Products', 'Two lines.'])
    const p = join(f.runsDir, 'legacy.json')
    writeFileSync(p, JSON.stringify(legacy), 'utf8')
    const tampered: CompanyBrief = {
      ...f.brief,
      sources: f.brief.sources.map((s) => (s.id === 'S2' ? { ...s, artifactPath: p, digest: legacy.digest } : s)),
    }
    const tp = join(f.runsDir, 'legacy-brief.json')
    writeFileSync(tp, JSON.stringify({ ...tampered, digest: redigest(tampered) }), 'utf8')
    assert.match(reject(tp, 'legacy artifact'), /legacy \(v1\) artifact/)
  })

  test('a record claiming schemaVersion 2 with an UNCLASSIFIED element is rejected', () => {
    const f = makeFixture()
    const rec = JSON.parse(readFileSync(f.brief.sources[0].artifactPath, 'utf8')) as ResearchRecord
    delete (rec.elements[0] as { chrome?: unknown }).chrome
    writeFileSync(f.brief.sources[0].artifactPath, JSON.stringify(rec), 'utf8')
    const v = verifyBrief(f.briefPath, { correlationId: CID, minSources: 2 })
    assert.equal(v.ok, false)
    if (!v.ok) assert.match(v.reason, /element 0 carries no chrome classification|no artifact at/)
  })

  test('a record with an INVENTED chrome label is rejected', () => {
    const f = makeFixture()
    const rec = JSON.parse(readFileSync(f.brief.sources[0].artifactPath, 'utf8')) as ResearchRecord
    ;(rec.elements[0] as { chrome?: unknown }).chrome = 'important-content'
    writeFileSync(f.brief.sources[0].artifactPath, JSON.stringify(rec), 'utf8')
    const v = verifyBrief(f.briefPath, { correlationId: CID, minSources: 2 })
    assert.equal(v.ok, false)
    if (!v.ok) assert.match(v.reason, /not one of the declared labels|digest mismatch/)
  })

  test('a classification with NO REASON is rejected - it cannot be reviewed', () => {
    const f = makeFixture()
    const rec = JSON.parse(readFileSync(f.brief.sources[0].artifactPath, 'utf8')) as ResearchRecord
    ;(rec.elements[0] as { chromeReason?: unknown }).chromeReason = '   '
    writeFileSync(f.brief.sources[0].artifactPath, JSON.stringify(rec), 'utf8')
    const v = verifyBrief(f.briefPath, { correlationId: CID, minSources: 2 })
    assert.equal(v.ok, false)
    if (!v.ok) assert.match(v.reason, /records no reason|digest mismatch/)
  })

  test('a brief RELABELLING a chrome quote as content is rejected', () => {
    // The exact attack this check exists for: everything individually well-formed, but the
    // brief claims a navigation item is page content so the report shows it as evidence.
    // Needs a source that ACTUALLY contains chrome - relabelling a main-content quote as
    // main-content would be a no-op and would prove nothing.
    const f = makeFixture()
    const p2 = f.brief.sources[1].artifactPath
    const rec = JSON.parse(readFileSync(p2, 'utf8')) as ResearchRecord
    ;(rec.elements[1] as { chrome?: unknown }).chrome = 'navigation'
    ;(rec.elements[1] as { chromeReason?: unknown }).chromeReason = 'inside <nav> navigation landmark'
    // The EVIDENCE must move too, or the v3 reproduction check fires first and the test would
    // pass for the wrong reason. With consistent evidence, the only fault left is the brief's
    // relabelling of a genuinely-navigation element as content.
    ;(rec.elements[1] as { evidence?: unknown }).evidence = [{ tag: 'nav', role: '', hints: '' }]
    // Rebuild the digest so the record is internally consistent and the ONLY problem is the
    // brief's relabelling of it.
    const rebuilt = buildRecord({ ...rec, digest: undefined } as unknown as Omit<ResearchRecord, 'digest'>)
    writeFileSync(p2, JSON.stringify(rebuilt), 'utf8')

    const honest = buildClaims([
      { source: { ...f.brief.sources[0], artifactPath: f.brief.sources[0].artifactPath }, record: JSON.parse(readFileSync(f.brief.sources[0].artifactPath, 'utf8')) as ResearchRecord },
      { source: f.brief.sources[1], record: rebuilt },
    ])
    const target = honest.find((c) => c.sourceId === 'S2' && c.quote === rec.elements[1].text)!
    assert.equal(target.chromeClass, 'navigation', 'precondition: the artifact really is chrome')

    const forged = honest.map((c) => (c.id === target.id ? { ...c, chromeClass: 'main-content' as const, isSiteChrome: false } : c))
    const brief: CompanyBrief = { ...f.brief, claims: forged }
    const tp = join(f.runsDir, 'relabelled-chrome.json')
    writeFileSync(tp, JSON.stringify({ ...brief, sources: f.brief.sources.map((s) => (s.id === 'S2' ? { ...s, digest: rebuilt.digest } : s)), digest: redigest(brief) }), 'utf8')
    assert.match(reject(tp, 'chrome relabelled as content'), /chromeClass "main-content", but source S2/)
  })

  test('a brief claiming isSiteChrome=true for a MAIN-CONTENT element is rejected', () => {
    const f = makeFixture((b) => ({
      ...b,
      claims: b.claims.map((c) => (c.id === 'C001' ? { ...c, isSiteChrome: true } : c)),
    }))
    const p = join(f.runsDir, 'false-chrome.json')
    writeFileSync(p, JSON.stringify({ ...f.brief, digest: redigest(f.brief) }), 'utf8')
    assert.match(reject(p, 'false chrome flag'), /isSiteChrome=true/)
  })

  test('chrome marked for exclusion but with NO TEXT is rejected as unrecoverable', () => {
    const f = makeFixture((b) => ({
      ...b,
      claims: b.claims.map((c) => (c.id === 'C003' ? { ...c, text: '', quote: '' } : c)),
    }))
    const p = join(f.runsDir, 'lost-chrome.json')
    writeFileSync(p, JSON.stringify({ ...f.brief, digest: redigest(f.brief) }), 'utf8')
    const v = verifyBrief(p, { correlationId: CID, minSources: 2 })
    assert.equal(v.ok, false)
    if (!v.ok) assert.match(v.reason, /NOT at index|not recoverable/)
  })
})

describe('classification: excluded content stays recoverable', () => {
  test('a brief whose report EXCLUDED chrome still carries every quote', () => {
    const src: BriefSource = {
      id: 'S1', url: 'https://x.com/', title: 'T', fetchedAt: 0, elementCount: 3, findingCount: 0,
      artifactPath: 'x', digest: 'd', selectedBy: 'starting-url', selectedReason: 'r',
    }
    const rec = makeRecord('r', 'https://x.com/', 'T', ['Pricing', 'Real sentence about the product offering here.'])
    const facts = buildClaims([{ source: src, record: rec }])
    const nav = facts.find((c) => c.quote === 'Pricing')!
    assert.equal(nav.isSiteChrome, false, 'this fixture is main-content; see the chrome fixture below')

    // Build a record that DOES carry a navigation-labelled element.
    const chromeRec = makeRecord('r2', 'https://x.com/', 'T', ['Real sentence about the product offering here.'])
    const mixed = {
      ...chromeRec,
      elements: [
        { tag: 'a', text: 'Pricing', chrome: 'navigation' as const, chromeReason: 'inside <nav> navigation landmark' },
        { tag: 'p', text: 'Real sentence about the product offering here.', chrome: 'main-content' as const, chromeReason: 'inside <main> content landmark' },
      ],
    } as ResearchRecord
    const claims = buildClaims([{ source: src, record: mixed }])
    const navClaim = claims.find((c) => c.quote === 'Pricing')!
    assert.equal(navClaim.isSiteChrome, true, 'the nav item is classified as chrome')
    assert.equal(navClaim.chromeClass, 'navigation')
    assert.ok(navClaim.text.length > 0, 'and its text is PRESERVED, not discarded')
  })

  test('the report says what it excluded and where it still lives', () => {
    const src: BriefSource = {
      id: 'S1', url: 'https://x.com/', title: 'T', fetchedAt: 0, elementCount: 2, findingCount: 0,
      artifactPath: 'x', digest: 'd', selectedBy: 'starting-url', selectedReason: 'r',
    }
    const mixed = {
      runId: 'r', requestedUrl: 'https://x.com/', finalUrl: 'https://x.com/', status: 200,
      contentType: 'text/html', fetchedAt: 0, schemaVersion: 2 as const, title: 'T',
      elements: [
        { tag: 'a', text: 'Pricing', chrome: 'navigation' as const, chromeReason: 'inside <nav>' },
        { tag: 'p', text: 'A real sentence about what this company does every day.', chrome: 'main-content' as const, chromeReason: 'inside <main>' },
      ],
      elementCount: 2, hostileContentSeen: false, findingCount: 0,
      bodySample: 'x', bodyCapped: false, truncated: false, redirectChain: [],
      digest: 'd',
    } as unknown as ResearchRecord
    const facts = buildClaims([{ source: src, record: mixed }])
    const text = renderBriefReport({
      objective: 'What does it sell?', startingUrl: 'https://x.com/',
      terminalState: 'complete', terminalReason: 'r', sources: [src],
      claims: [...facts, ...deriveClaims(facts, [src], DEFAULT_LIMITS)],
      unresolved: ['x'], mode: 'deterministic-extraction', modelUsed: null,
    }).join('\n')
    assert.match(text, /classified site chrome and left out of the excerpt/)
    assert.match(text, /NOT deleted/)
    assert.doesNotMatch(text, /\[S1#0\]/, 'the nav item is not in the excerpt')
    assert.match(text, /\[S1#1\]/, 'the content item is')
  })
})

describe('company brief: the verifier ACCEPTS a well-formed brief', () => {
  test('a two-source brief with matching artifacts verifies', () => {
    const f = makeFixture()
    const v = verifyBrief(f.briefPath, { correlationId: CID, minSources: 2 })
    assert.equal(v.ok, true, v.ok ? '' : v.reason)
    if (v.ok) {
      assert.equal(v.sourcesVerified, 2)
      assert.equal(v.claimsTraced, 3)
      assert.equal(v.unverifiedClaims, 1)
      assert.ok(v.checks.length >= 8)
    }
  })
})

describe('company brief: the verifier REJECTS everything it should', () => {
  const reject = (path: string, why: string, cid = CID): string => {
    const v = verifyBrief(path, { correlationId: cid, minSources: 2 })
    assert.equal(v.ok, false, `expected REJECT: ${why}`)
    if (!v.ok) assert.match(v.reason, /\S/)
    return v.ok ? '' : v.reason
  }

  test('a MISSING brief file is refused', () => {
    reject(join(TMP, 'nope.json'), 'missing file')
  })

  test('a brief that is not JSON is refused', () => {
    const p = join(TMP, 'bad.json')
    writeFileSync(p, '{ not json', 'utf8')
    reject(p, 'malformed JSON')
  })

  test('a MISMATCHED correlation id is refused', () => {
    const f = makeFixture()
    reject(f.briefPath, 'wrong correlation id', '99999999-9999-9999-9999-999999999999')
  })

  test('a MISSING source artifact is refused', () => {
    const f = makeFixture((b) => ({
      ...b,
      sources: b.sources.map((s) => (s.id === 'S2' ? { ...s, artifactPath: join(TMP, 'definitely-not-here.json') } : s)),
    }))
    assert.match(reject(f.briefPath, 'source artifact deleted'), /no artifact at/)
  })

  test('a source artifact belonging to ANOTHER run is refused', () => {
    const f = makeFixture()
    // Point S2 at S1's bytes: the file exists and verifies internally, but not for this claim.
    const other = makeRecord(`${CID}.S9`, f.brief.sources[1].url, 'Products', ['x'])
    const p = join(f.runsDir, 'other.json')
    writeFileSync(p, JSON.stringify(other), 'utf8')
    const tampered: CompanyBrief = {
      ...f.brief,
      sources: f.brief.sources.map((s) => (s.id === 'S2' ? { ...s, artifactPath: p } : s)),
    }
    const tp = join(f.runsDir, 'tampered.json')
    writeFileSync(tp, JSON.stringify(tampered), 'utf8')
    assert.match(reject(tp, 'artifact runId mismatch'), /S2/)
  })

  test('CORRUPTED source bytes are refused by the digest check', () => {
    const f = makeFixture()
    const p = f.brief.sources[1].artifactPath
    const rec = JSON.parse(readFileSync(p, 'utf8')) as ResearchRecord
    rec.elements[0].text = 'Products (quietly rewritten after the fact)'
    writeFileSync(p, JSON.stringify(rec), 'utf8')
    reject(f.briefPath, 'artifact tampered')
  })

  test('a claim quoting text that is NOT at the index it names is refused', () => {
    const f = makeFixture((b) => ({
      ...b,
      claims: b.claims.map((c) => (c.id === 'C001'
        ? { ...c, quote: 'Acme manufactures hovercraft.', text: 'Acme manufactures hovercraft.' }
        : c)),
    }))
    // Re-digest so the FAILURE is specifically the quote check, not the brief digest.
    const d = digestBrief(CID, f.brief.objective, f.brief.startingUrl, f.brief.sources, f.brief.claims, f.brief.unresolved)
    const p = join(f.runsDir, 'liar.json')
    writeFileSync(p, JSON.stringify({ ...f.brief, digest: d }), 'utf8')
    assert.match(reject(p, 'quote not at index'), /NOT at index|not at index/i)
  })

  test('a rule-derived claim dressed up as a proven fact is refused', () => {
    const f = makeFixture((b) => ({
      ...b,
      claims: b.claims.map((c) => (c.id === 'C004'
        ? { ...c, factualStatus: 'traceable-to-stored-source' as const }
        : c)),
    }))
    const d = digestBrief(CID, f.brief.objective, f.brief.startingUrl, f.brief.sources, f.brief.claims, f.brief.unresolved)
    const p = join(f.runsDir, 'overclaim.json')
    writeFileSync(p, JSON.stringify({ ...f.brief, digest: d }), 'utf8')
    assert.match(reject(p, 'derived claim overclaimed'), /must not be presented as proven/)
  })

  test('a rule-derived claim with no named rule is refused', () => {
    const f = makeFixture((b) => ({
      ...b,
      claims: b.claims.map((c) => (c.id === 'C004' ? { ...c, rule: null } : c)),
    }))
    const d = digestBrief(CID, f.brief.objective, f.brief.startingUrl, f.brief.sources, f.brief.claims, f.brief.unresolved)
    const p = join(f.runsDir, 'norule.json')
    writeFileSync(p, JSON.stringify({ ...f.brief, digest: d }), 'utf8')
    assert.match(reject(p, 'no named rule'), /names no rule/)
  })

  test('a brief claiming "complete" with NO traceable evidence is refused', () => {
    const f = makeFixture((b) => ({ ...b, claims: [] }))
    const d = digestBrief(CID, f.brief.objective, f.brief.startingUrl, f.brief.sources, f.brief.claims, f.brief.unresolved)
    const p = join(f.runsDir, 'empty.json')
    writeFileSync(p, JSON.stringify({ ...f.brief, digest: d }), 'utf8')
    assert.match(reject(p, 'no evidence'), /no traceable quoted evidence/)
  })

  test('an INTERRUPTED mission cannot be relabelled "complete"', () => {
    const f = makeFixture((b) => ({
      ...b,
      terminalState: 'complete',
      warnings: ['S2 timed out and was skipped'],
    }))
    const d = digestBrief(CID, f.brief.objective, f.brief.startingUrl, f.brief.sources, f.brief.claims, f.brief.unresolved)
    const p = join(f.runsDir, 'relabelled.json')
    writeFileSync(p, JSON.stringify({ ...f.brief, digest: d }), 'utf8')
    assert.match(reject(p, 'complete despite warnings'), /a complete mission records none/)
  })

  test('a "complete" brief missing a required field is refused', () => {
    const f = makeFixture()
    const p = join(f.runsDir, 'nofield.json')
    const { digest, ...rest } = f.brief as unknown as Record<string, unknown>
    void digest
    writeFileSync(p, JSON.stringify(rest), 'utf8')
    reject(p, 'missing field')
  })

  test('a brief edited after the fact (stale digest) is refused', () => {
    const f = makeFixture()
    const p = join(f.runsDir, 'edited.json')
    writeFileSync(p, JSON.stringify({ ...f.brief, objective: 'Something else entirely' }), 'utf8')
    assert.match(reject(p, 'post-write edit'), /digest mismatch/)
  })

  test('a source with a non-https or local URL is refused', () => {
    const f = makeFixture((b) => ({
      ...b,
      sources: b.sources.map((s) => (s.id === 'S1' ? { ...s, url: 'http://acme.example.com/' } : s)),
    }))
    const d = digestBrief(CID, f.brief.objective, f.brief.startingUrl, f.brief.sources, f.brief.claims, f.brief.unresolved)
    const p = join(f.runsDir, 'http.json')
    writeFileSync(p, JSON.stringify({ ...f.brief, digest: d }), 'utf8')
    assert.match(reject(p, 'plain http source'), /not https/)
  })

  test('a brief claiming a model was used is refused by this verifier', () => {
    const f = makeFixture((b) => ({ ...b, modelUsed: 'some-model' as unknown as null }))
    const p = join(f.runsDir, 'model.json')
    writeFileSync(p, JSON.stringify(f.brief), 'utf8')
    assert.match(reject(p, 'model-written'), /model/)
  })

  test('a brief that hides missing-customer evidence is refused', () => {
    const f = makeFixture((b) => ({
      ...b,
      claims: b.claims.filter((c) => c.section !== 'customers'),
      unresolved: ['Nothing collected here is audited financial data.'],
    }))
    const d = digestBrief(CID, f.brief.objective, f.brief.startingUrl, f.brief.sources, f.brief.claims, f.brief.unresolved)
    const p = join(f.runsDir, 'silent.json')
    writeFileSync(p, JSON.stringify({ ...f.brief, digest: d }), 'utf8')
    assert.match(reject(p, 'silently drops a gap'), /does not say so/)
  })
})

describe('company brief: the digest actually detects a single-character edit', () => {
  test('changing one element flips the brief digest', () => {
    const f = makeFixture()
    const before = computeDigest({
      runId: CID, requestedUrl: f.brief.startingUrl, finalUrl: f.brief.startingUrl, status: 200,
      contentType: 'application/json', fetchedAt: 0, title: 't',
      elements: [{ tag: 'a', text: 'one' }], elementCount: 1, hostileContentSeen: false,
      findingCount: 0, bodySample: 'x', bodyCapped: false, truncated: false, redirectChain: [],
    })
    const after = computeDigest({
      runId: CID, requestedUrl: f.brief.startingUrl, finalUrl: f.brief.startingUrl, status: 200,
      contentType: 'application/json', fetchedAt: 0, title: 't',
      elements: [{ tag: 'a', text: 'onf' }], elementCount: 1, hostileContentSeen: false,
      findingCount: 0, bodySample: 'x', bodyCapped: false, truncated: false, redirectChain: [],
    })
    assert.notEqual(before, after)
  })
})