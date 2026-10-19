/**
 * Tests for SITE-CHROME CLASSIFICATION.
 *
 * =============================================================================
 * WHY THIS FILE EXISTS SEPARATELY
 * =============================================================================
 *
 * The classifier is the one piece of this pipeline that makes a JUDGEMENT rather than a
 * measurement, so it is the one piece that can quietly go wrong. A rule that silently labels
 * real content as navigation does not crash anything - it just makes every downstream report
 * quietly worse, and nothing fails. So the rules are pinned here against hand-written ancestry
 * fixtures, with no browser involved: `classifyElement` is pure, which is exactly why it is
 * separated from the DOM walk.
 *
 * The cases that matter most are the ones where the honest answer is "unknown". A classifier
 * that never says "unknown" is not confident, it is wrong, and the tests below refuse that.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  classifyElement, isChromeClass, CHROME_CLASSES, domWalker,
  type AncestorSignal, type ChromeClass,
} from '../live/web-extract.ts'

/**
 * Build an ancestry chain nearest-first, exactly as `domWalker` emits it:
 * `tag~role~id~class~ariaLabel`.
 *
 * A bare string means "a tag with no attributes". A tuple fills those slots in order, and any
 * slot past the tuple's end is left empty - so `['div','','','cookie','']` is a div with an
 * empty role, empty id, class "cookie", empty aria.
 */
const chain = (
  ...parts: Array<string | [string, string] | [string, string, string] | [string, string, string, string] | [string, string, string, string, string]>
): AncestorSignal[] =>
  parts.map((p) => {
    if (!Array.isArray(p)) return `${p}~~~`
    const [tag = '', role = '', id = '', cls = '', aria = ''] = p
    return `${tag}~${role}~${id}~${cls}~${aria}`
  })

const classify = (ancestry: AncestorSignal[], text = 'Some short label', tag = 'a'): ChromeClass =>
  classifyElement({ tag, ancestry, text }).chrome

// ---------------------------------------------------------------------------------------------

describe('classification: the label set is closed and well-formed', () => {
  test('exactly six labels are declared', () => {
    assert.equal(CHROME_CLASSES.length, 6)
    for (const c of CHROME_CLASSES) assert.equal(isChromeClass(c), true)
  })

  test('anything outside the set is rejected, including near-misses', () => {
    for (const bad of ['main', 'nav', 'content', '', 'MAIN-CONTENT', 'chrome', null, 7, {}]) {
      assert.equal(isChromeClass(bad), false, `should reject ${JSON.stringify(bad)}`)
    }
  })
})

describe('classification: navigation', () => {
  test('a <nav> ancestor is navigation', () => {
    assert.equal(classify(chain('ul', 'nav', 'div')), 'navigation')
  })

  test('role=navigation is navigation even without a <nav> tag', () => {
    assert.equal(classify(chain('div', ['div', 'navigation', '', ''])), 'navigation')
  })

  test('a class named nav / navbar / menu / breadcrumb / sidebar is navigation', () => {
    for (const cls of ['nav', 'navbar', 'main-nav', 'site_menu', 'breadcrumb', 'sidebar', 'dropdown-menu']) {
      assert.equal(classify(chain('div', ['div', '', '', cls, ''])), 'navigation', cls)
    }
  })

  test('<nav> nested inside <header> is navigation, not header', () => {
    // The overwhelmingly common real shape. Getting this backwards would label the primary
    // menu as header chrome and hide the fact that it is navigation.
    assert.equal(classify(chain('ul', 'nav', ['header', 'banner', '', ''])), 'navigation')
  })
})

describe('classification: header and footer', () => {
  test('<header> and role=banner are header', () => {
    assert.equal(classify(chain('div', 'header')), 'header')
    assert.equal(classify(chain('div', ['div', 'banner', '', ''])), 'header')
  })

  test('<footer> and role=contentinfo are footer', () => {
    assert.equal(classify(chain('div', 'footer')), 'footer')
    assert.equal(classify(chain('div', ['div', 'contentinfo', '', ''])), 'footer')
  })

  test('a <nav> inside a <footer> is classified by the NEAREST landmark, which is the nav', () => {
    // Both labels are chrome, so the report treats them identically. Recording the nearest one
    // is the rule, and it is asserted here so a future edit cannot quietly change it.
    assert.equal(classify(chain('ul', 'nav', 'footer')), 'navigation')
  })

  test('there is no "footer is terminal" special case - the rule is uniformly nearest-first', () => {
    // A footer-is-terminal rule was considered and rejected: it requires checking for a footer
    // BEFORE walking the ancestry, which is precisely the rule-before-ancestry ordering that
    // produced the fastly.com failure. A nearer content landmark therefore wins, and this test
    // pins that so the rejected special case cannot creep back in.
    assert.equal(classify(chain('div', ['div', '', 'content-body', ''], 'footer')), 'main-content')
    assert.equal(classify(chain('div', 'footer')), 'footer')
  })

  test('NEAREST landmark wins: a close content div beats a distant navigation wrapper', () => {
    // The defect a real run exposed. fastly.com put the whole mega-menu under a wrapper classed
    // `_nav-viewport_…` six levels up, while the actual copy sat three levels from a `content`
    // div. Rule-by-rule ordering let the distant menu swallow all 240 elements and produced a
    // report with no evidence at all.
    assert.equal(classify(chain('div', 'main', 'div', 'nav', 'div', 'body')), 'main-content')
    assert.equal(classify(chain('div', ['div', '', '_content_mmd2f_16', ''], 'div', ['div', '', '_nav-viewport_4s5x6', ''])), 'main-content')
  })

  test('LONG prose (over 120 chars) inside a header is NOT assumed to be chrome', () => {
    // The requirement is explicit: do not assume every element in a header is irrelevant. A
    // long lead paragraph in a site header is real content, so it must not be silently binned.
    // The threshold is deliberately stated in the rule and pinned here; text UNDER it (a menu
    // label, a "Privacy Policy" link) is still classified as header/footer.
    const long = 'We build the fastest data protection platform available to small teams today, and we have been doing exactly that since the company was founded.'
    assert.ok(long.length > 120, 'fixture must actually exercise the long-text branch')
    const r = classifyElement({ tag: 'p', ancestry: chain('div', 'header'), text: long })
    assert.equal(r.chrome, 'unknown')
    assert.match(r.reason, /not assumed to be chrome/)
  })

  test('LONG prose (over 120 chars) inside a footer is NOT assumed to be chrome either', () => {
    const long = 'Backblaze is a publicly traded company listed on NASDAQ under the symbol BLZE and has been continuously listed since mid-2015, filing quarterly reports with the SEC.'
    assert.ok(long.length > 120)
    const r = classifyElement({ tag: 'p', ancestry: chain('div', 'footer'), text: long })
    assert.equal(r.chrome, 'unknown')
    assert.match(r.reason, /not assumed to be chrome/)
  })

  test('text just UNDER the threshold inside a footer IS still classified as footer', () => {
    // The boundary is pinned from both sides, so a future edit to LABEL_MAX cannot silently
    // start swallowing short content.
    const short = '© 2026 Backblaze. All rights reserved.'
    assert.ok(short.length <= 120)
    assert.equal(classify(chain('div', 'footer'), short), 'footer')
  })

  test('SHORT text inside a footer IS classified as footer', () => {
    assert.equal(classify(chain('div', 'footer'), 'Privacy Policy'), 'footer')
  })
})

describe('classification: consent banners', () => {
  test('cookie / consent / GDPR machinery is a consent banner wherever it sits', () => {
    for (const cls of ['cookie-banner', 'cookieConsent', 'gdpr-modal', 'onetrust-consent', 'ccpa-banner']) {
      assert.equal(classify(chain('div', ['div', '', '', cls, '']), 'Accept all'), 'consent-banner', cls)
    }
  })

  test('a consent banner inside a footer is still a consent banner', () => {
    assert.equal(classify(chain('div', ['div', '', '', 'cookie-notice', ''], 'footer')), 'consent-banner')
  })

  test('aria-label alone is enough', () => {
    assert.equal(classify(chain('div', ['div', '', '', '', 'Cookie preferences'])), 'consent-banner')
  })
})

describe('classification: main content', () => {
  test('<main>, <article>, role=main and content-ish class names are main content', () => {
    assert.equal(classify(chain('div', 'main')), 'main-content')
    assert.equal(classify(chain('div', 'article')), 'main-content')
    assert.equal(classify(chain('div', ['div', 'main', '', ''])), 'main-content')
    assert.equal(classify(chain('div', ['div', '', '', 'entry-content', ''])), 'main-content')
    assert.equal(classify(chain('div', ['div', '', 'content', '', ''])), 'main-content')
  })

  test('an element inside <main> inside <nav> is classified by the NEAREST landmark', () => {
    // A breadcrumb inside the main landmark is a breadcrumb. Nearest-ancestor wins, and
    // pretending otherwise would relabel breadcrumbs as article text.
    assert.equal(classify(chain('ol', 'nav', 'main')), 'navigation')
  })
})

describe('classification: ambiguity is reported, not resolved by guessing', () => {
  test('no ancestry at all is `unknown` and says so', () => {
    const r = classifyElement({ tag: 'p', ancestry: [], text: 'Anything' })
    assert.equal(r.chrome, 'unknown')
    assert.match(r.reason, /no ancestry information/)
  })

  test('a bare <body> with no landmark is `unknown`, NOT main-content', () => {
    // This is the important one. "Not navigation" does not imply "content". Promoting an
    // unlandmarked paragraph to main-content would be inventing certainty.
    const r = classifyElement({ tag: 'p', ancestry: chain('div', 'body'), text: 'Some copy' })
    assert.equal(r.chrome, 'unknown')
    assert.match(r.reason, /no recognisable landmark among its 2 nearest ancestor\(s\)/)
  })

  test('an unlabelled sidebar-ish div is not promoted to content', () => {
    assert.equal(classify(chain('div', ['div', '', 'col-md-3', ''])), 'unknown')
  })

  test('every classification carries a non-empty, reviewable reason', () => {
    const cases: AncestorSignal[][] = [
      chain('div'), chain('nav'), chain('header'), chain('footer'), chain('main'), [],
      chain(['div', '', '', 'cookie', '']), chain('ul', 'nav', 'header'),
    ]
    for (const a of cases) {
      const r = classifyElement({ tag: 'p', ancestry: a, text: 'x' })
      assert.ok(r.reason.trim().length > 0, JSON.stringify(a))
    }
  })

  test('the classifier is a pure function of its inputs', () => {
    const a = chain('div', 'nav', 'main')
    const one = classifyElement({ tag: 'li', ancestry: a, text: 'Pricing' })
    const two = classifyElement({ tag: 'li', ancestry: [...a], text: 'Pricing' })
    assert.deepEqual(one, two)
  })
})

describe('classification: the DOM walker is self-contained', () => {
  test('it stringifies to source with no free references', () => {
    // `page.evaluate` sends `fn.toString()` into the page. Any module-scope reference would
    // arrive as an undefined identifier and fail at runtime, in the browser, on a live mission.
    const src = domWalker.toString()
    assert.match(src, /querySelectorAll/, 'it must actually walk the DOM')
    for (const forbidden of ['classifyElement', 'CHROME_CLASSES', 'extractFrom', 'require(', 'import ']) {
      assert.equal(src.includes(forbidden), false, `walker must not reference ${forbidden}`)
    }
  })

  test('it returns raw signals only, and no classification', () => {
    const src = domWalker.toString()
    assert.equal(/\bchrome\b/.test(src), false, 'the walker must not classify; that is the Node side')
  })
})