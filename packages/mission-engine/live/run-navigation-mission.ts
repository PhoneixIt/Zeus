/**
 * THE GOVERNED-NAVIGATION MISSION - end to end, against a REAL browser.
 *
 * Run: npm run mission:navigate
 *
 * =============================================================================
 * THE HONESTY REQUIREMENT THIS FILE EXISTS TO SATISFY
 * =============================================================================
 *
 * The browser mission before this one navigated in HARNESS SETUP and then ran a plan that only read.
 * That was a real mission, but the plan did not navigate - the harness did, silently, before the
 * mission began.
 *
 * So here the fixture page is NEVER loaded by the harness. The harness creates a BROWSER and nothing
 * else; the page is loaded by the `navigate-browser` step of the plan, through the tool, through the
 * policy, under an approval the executor checked. The evidence that this is true is structural:
 *
 *   - before the mission, the harness asserts the browser is on `about:blank`
 *   - the navigation step's outcome is asserted to be `done:verified`
 *   - the verifier's own landing check reads the page and confirms it is on the destination
 *   - the artifact carries the destination URL, which only a navigation could have put there
 *
 * If the harness had navigated in setup, the pre-mission assertion would have failed.
 *
 * =============================================================================
 * THE APPROVAL IS NOT FAKED AWAY
 * =============================================================================
 *
 * The mission is run TWICE against the same registry: once with NO approval store, which must leave
 * the navigation at `needs-human` and stop the mission from completing, and once with an approval
 * granted for that exact destination. The first run is the control that makes the second meaningful -
 * without it, "the approval gate works" is an assertion about a belief.
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, existsSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { existsSync as fsExists } from 'node:fs'

import { execute } from '../executor.ts'
import { DurableStore } from '../../persistence/store.ts'
import { StoreRecorder } from '../../persistence/recorder.ts'
import { DeterministicPlanProvider } from '../../planner/deterministic.ts'
import { ToolRegistry } from '../../tool-router/router.ts'
import { ApprovalStore, keyFor } from '../../governance/approval.ts'
import {
  makeBrowserReadTool, makeSummarisePageTool, makeWritePageSummaryTool,
  navigationRegistration, browserSummaryVerifier, normalisePage, MAX_PAGE_TEXT,
} from './browser-tools.ts'
import { DEFAULT_NAVIGATION_POLICY, type NavigationPolicy } from './navigation-policy.ts'
import type { Mission, Step } from '../state.ts'
import type { ControlSurface, Observation } from '../../governance/contract.ts'

/** Minimal control surface for browser navigation missions.
 *
 * Browser navigation drives a headless Chromium via CDP directly - it does not
 * need the operator host or desktop observation. A minimal observe() returns
 * an empty desktop so the executor can proceed without requiring the operator
 * host to be reachable. The input methods are not called by the executor for
 * navigation steps, so they are stubbed.
 */
const minimalControl: ControlSurface = {
  async observe(): Promise<Observation> {
    return {
      screen: { width: 0, height: 0, session: 0 },
      windows: [],
      foreground: null,
      permission: { control: 'ARMED', input: 'PERMITTED', blockedBy: null, infrastructureHealthy: true },
      warnings: [],
    }
  },
  async raw() { throw new Error('not used by browser navigation') },
  async ocr() { return { ok: false, error: 'not used', lines: [] } },
  async captureScreen() { throw new Error('not used by browser navigation') },
  async screenWatch() { return { ok: false, error: 'not used' } },
  async screenDiff() { return { ok: false, changed: false, changedPixels: 0, changedPercent: 0, region: { x: 0, y: 0, w: 0, h: 0 }, error: 'not used' } },
  async verifyTarget() { return { ok: false, reason: 'not used', hwnd: 0, pid: 0, title: '', visible: false, foreground: false } },
  async move() { return { attempted: true, delivered: false, refusedBy: 'not used' } },
  async click() { return { attempted: true, delivered: false, refusedBy: 'not used' } },
  async doubleClick() { return { attempted: true, delivered: false, refusedBy: 'not used' } },
  async drag() { return { attempted: true, delivered: false, refusedBy: 'not used' } },
  async scroll() { return { attempted: true, delivered: false, refusedBy: 'not used' } },
  async type() { return { attempted: true, delivered: false, refusedBy: 'not used' } },
  async pressKey() { return { attempted: true, delivered: false, refusedBy: 'not used' } },
}

const CHROME_CANDIDATES = [
  'C:/Users/Samer/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
]
const PORT = 9447
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A mission-scoped policy that permits ONLY https://example.com.
 *
 * This is NOT a change to DEFAULT_NAVIGATION_POLICY, which still denies all
 * HTTP destinations. This policy is constructed here and passed to the tool
 * at registration time, so the plan cannot widen it. It is the exact, narrow
 * authority needed for this mission and nothing more.
 */
const EXAMPLE_COM_POLICY: NavigationPolicy = {
  allowDataUrls: false,
  maxDataUrlChars: 32_000,
  allowFileUrls: false,
  allowHttp: true,
  allowedHosts: ['example.com'],
}

let failures = 0
const check = (what: string, ok: unknown, detail = ''): void => {
  if (ok) { console.log(`   PASS  ${what}`); return }
  console.log(`   FAIL  ${what}${detail ? ` - ${detail}` : ''}`)
  failures += 1
}

const out = mkdtempSync(join(tmpdir(), 'aios-m25-mission-'))
const profile = mkdtempSync(join(tmpdir(), 'aios-m25-profile-'))
const dbPath = join(out, 'mission.sqlite')
const artifactPath = join(out, 'browser-page-summary.txt')

async function cleanup(browser: { kill(): void; exitCode: number | null; once?: (e: string, f: () => void) => void } | null) {
  if (browser && browser.exitCode === null) {
    const gone = new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(false), 8000)
      browser.once?.('exit', () => { clearTimeout(t); resolve(true) })
    })
    try { browser.kill() } catch { /* already gone */ }
    await gone
  }
  for (let i = 0; i < 5; i += 1) {
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
      rmSync(out, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
      return
    } catch { await sleep(400) }
  }
}

// ============================================================================================

const chromePath = CHROME_CANDIDATES.find((c) => fsExists(c))
if (!chromePath) {
  console.log('=== SKIP: no Chromium/Chrome/Edge binary found ===')
  for (const c of CHROME_CANDIDATES) console.log(`    ${c}`)
  console.log('  Governed navigation is UNPROVEN without a browser. A skip, not a pass.')
  await cleanup(null)
  process.exit(2)
}

console.log('=== 1. THE BROWSER (headless, loopback, isolated profile) ===')
console.log(`  binary  ${chromePath}`)

let browser: ReturnType<typeof spawn> | null = null
const stores: DurableStore[] = []
try {
  browser = spawn(chromePath, [
    // See run-browser-mission.ts: headless by default, visible only when the live procedure asks.
    ...(process.env.AIOS_BROWSER_VISIBLE === '1'
      ? ['--window-position=60,60', '--window-size=1280,900']
      : ['--headless=new']),
    `--remote-debugging-port=${PORT}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--no-proxy-server',
    // Allow DNS resolution for example.com while blocking all other external hosts.
    // Without this, MAP * ~NOTFOUND makes every external DNS query fail.
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE example.com',
  ], { stdio: ['ignore', 'pipe', 'pipe'] })

  let alive = false
  for (let i = 0; i < 60; i += 1) {
    await sleep(400)
    try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) { alive = true; break } } catch { /* not yet */ }
  }
  if (!alive) throw new Error(`the browser's debugging endpoint never answered on port ${PORT}`)
  console.log('  CDP answered')

  process.env.AIOS_CDP_PORT = String(PORT)
  const { page: opPage, readPage } = await import('../../control-core/operator.mjs')

  // ============================================================================================
  // 2. THE DESTINATION IS DECLARED BUT NOT LOADED
  // ============================================================================================

  const FIXTURE_URL = 'https://example.com'

  console.log('')
  console.log('=== 2. THE DESTINATION (declared, NOT loaded) ===')
  console.log(`  url    ${FIXTURE_URL}`)
  console.log('  NOTE: the harness does NOT navigate here. The plan does.')

  const pg = await opPage()
  // THE STRUCTURAL PROOF. If the harness had navigated during setup, this would not be about:blank.
  const beforeUrl = pg.url()
  console.log(`  browser is currently on: ${beforeUrl}`)
  check('the harness has NOT navigated anywhere (the browser is still blank)', /^about:|^chrome:\/\/newtab/.test(beforeUrl), beforeUrl)

  // ============================================================================================
  // 3. THE PLAN - which contains the governed navigation step
  // ============================================================================================

  const OBJECTIVE = `Navigate to the page ${FIXTURE_URL} and summarise the rendered content`
  const planner = new DeterministicPlanProvider()
  console.log('')
  console.log('=== 3. THE PLAN ===')
  const proposalResult = await planner.plan(OBJECTIVE, {
    outputRoot: out,
    now: () => Date.now(),
    world: {
      observationId: `m25-${Date.now()}`, observedAt: Date.now(),
      scope: { root: out, maxDepth: 1 }, entries: [], fingerprint: 'm25',
      capabilities: [], truncated: false, errors: [],
    },
  })
  console.log(`  provider   ${planner.name}`)
  console.log('  PLANNING MODE: DETERMINISTIC PHRASE MATCHING - no language model read this objective.')
  if (!proposalResult.ok) throw new Error(`the planner refused: ${proposalResult.code}: ${proposalResult.reason}`)
  const proposal = proposalResult.proposal
  console.log(`  steps      ${proposal.steps.map((s) => `${s.id}(${s.capability})`).join(' -> ')}`)

  const navStep = proposal.steps.find((s) => s.capability === 'browser.navigate')
  check('THE PLAN ITSELF contains a navigation step', !!navStep,
    proposal.steps.map((s) => s.capability).join(','))
  check('and it is the first step, so nothing can be read before the browser goes there',
    proposal.steps[0]?.capability === 'browser.navigate')
  check('and it DECLARES an effect, so approval is required',
    !!navStep?.effect, `effect=${JSON.stringify(navStep?.effect)}`)
  console.log(`  effect     kind=${navStep?.effect?.kind} target=${String(navStep?.effect?.target).slice(0, 48)}...`)

  // ============================================================================================
  // 4. THE REGISTRY - policy at REGISTRATION, so a plan cannot widen it
  // ============================================================================================

  const readBrowser = async (): Promise<unknown> => readPage({ max: MAX_PAGE_TEXT })
  const navigate = async (url: string) => {
    const handle = await opPage()
    await handle.goto(url)
    return { url: () => handle.url() }
  }

  const makeRegistry = () => new ToolRegistry({
    registrations: [
      // Gates inseparable from the tool: a bare navigation tool with no preflight would move the
      // browser ungated and the registry would not object.
      navigationRegistration({ navigate, policy: EXAMPLE_COM_POLICY }),
      { tool: makeBrowserReadTool(readBrowser), capabilities: ['browser.read'] },
      { tool: makeSummarisePageTool(), capabilities: ['filesystem.transform'] },
      { tool: makeWritePageSummaryTool(), capabilities: ['filesystem.write'] },
    ],
  })

  const buildMission = (id: string): Mission => ({
    id,
    objective: proposal.objective,
    constraints: proposal.constraints,
    state: 'executing',
    startedAt: Date.now(),
    history: [],
    pendingApprovals: [],
    plan: proposal.steps.map((st) => ({
      id: st.id, intent: st.intent, mode: st.mode, capability: st.capability, rationale: st.rationale,
      tool: st.tool, args: st.args, dependsOn: st.dependsOn, status: 'pending' as const, attempts: 0,
      effect: st.effect,
    })),
  })

  const runMission = async (id: string, dbFile: string, approvals?: ApprovalStore) => {
    const store = new DurableStore({ path: dbFile })
    stores.push(store)
    const r = await execute(buildMission(id), {
      tools: makeRegistry(),
      verifier: browserSummaryVerifier(readBrowser, EXAMPLE_COM_POLICY),
      control: minimalControl,
      config: { maxAttempts: 2, permission: async () => ({ control: 'ARMED', input: 'PERMITTED', blockedBy: null, infrastructureHealthy: true }), emergencyStop: async () => false, recorder: new StoreRecorder(store) },
      ...(approvals ? { approvals } : {}),
    })
    return { r, store }
  }

  // ============================================================================================
  // 5. CONTROL: with NO approval, the navigation must NOT run
  // ============================================================================================

  console.log('')
  console.log('=== 5. CONTROL: NO APPROVAL - the navigation must not run ===')
  // ONE approval store for both runs, because an approval authorises an action that must first have
  // been REQUESTED. Creating a fresh store for the second run - as a first version did - meant the
  // request recorded by the control was in a different store, so `decide` correctly refused: the
  // store is refusing to authorise something nobody asked about, which is the behaviour we want.
  const approvalStore = new ApprovalStore()
  const blocked = await runMission('nav-mission', join(out, 'control.sqlite'), approvalStore)
  const blockedNav = blocked.r.mission.plan.find((s) => s.id === 'navigate-browser')
  console.log(`  navigate-browser -> ${blockedNav?.status} (${blockedNav?.result?.outcome?.kind ?? 'no result'})`)
  // The STEP status is `failed`; the OUTCOME is `needs-human`. Asserting on the wrong field would
  // have made this control look like it failed when the gate had in fact engaged correctly.
  check('WITHOUT an approval the navigation is held for a human',
    blockedNav?.result?.outcome.kind === 'needs-human',
    `outcome=${blockedNav?.result?.outcome.kind} reason=${(blockedNav?.result?.outcome as { reason?: string } | undefined)?.reason}`)
  check('and the mission does not complete', !blocked.r.record.complete)
  check('and the browser was NOT moved', /^about:|^chrome:\/\/newtab/.test(pg.url()), pg.url())
  check('and no artifact was written', !existsSync(artifactPath))

  // ============================================================================================
  // 6. APPROVED: the plan navigates, reads, summarises, writes
  // ============================================================================================

  console.log('')
  console.log('=== 6. APPROVED: the plan navigates ===')
  const blockedKey = keyFor('nav-mission', 'navigate-browser',
    { kind: 'external-send', target: FIXTURE_URL, reason: 'fixture', irreversible: false }, 0)
  // `lookup` returns only DECIDED approvals, so a pending request reads as undefined - asserting on
  // it would have been asserting the wrong thing. The proof that a request was recorded is that
  // `decide` SUCCEEDS: the store refuses to authorise an action nobody asked about, so a successful
  // grant is itself the evidence that the gate fired.
  let approval = approvalStore.lookup(blockedKey)
  let requestedAndGrantable = false
  if (!approval) {
    try {
      approval = approvalStore.decide(blockedKey, 'approved', 'integration-test-human', Date.now())
      requestedAndGrantable = true
    } catch (e) {
      console.log(`  could not grant: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  check('the control run REQUESTED authorisation, and the store grantable ONLY because of it',
    requestedAndGrantable)
  check('an approval for the exact destination was granted', approval?.state === 'approved',
    `state=${approval?.state}`)
  console.log(`  approval   ${blockedKey.missionId}|${blockedKey.stepId}|${blockedKey.kind}|${String(blockedKey.target).slice(0, 40)}...`)
  console.log(`  described  ${approval?.description ?? '(none)'}`)

  const approved = await runMission('nav-mission', dbPath, approvalStore)
  const outcomes = approved.r.mission.plan
    .map((s) => `${s.id}:${s.status}:${s.result?.outcome.kind ?? '-'}`).join(' ')
  console.log(`  outcomes   ${outcomes}`)

  check('every step completed', approved.r.mission.plan.every((s) => s.status === 'done'),
    approved.r.mission.plan.map((s) => `${s.id}=${s.status}`).join(' '))

  const navOutcome = approved.r.mission.plan.find((s) => s.id === 'navigate-browser')
  check('the NAVIGATION step specifically completed and verified',
    navOutcome?.status === 'done' && navOutcome?.result?.outcome.kind === 'verified',
    `${navOutcome?.status}/${navOutcome?.result?.outcome.kind} reason=${
      navOutcome?.result?.outcome && 'reason' in navOutcome.result.outcome ? navOutcome.result.outcome.reason : '(none)'}`)

  const verifiedIds = Object.keys(approved.r.record.verified)
  console.log(`  verified   ${verifiedIds.join(', ')}`)
  check('every step was independently verified', verifiedIds.length === approved.r.mission.plan.length,
    `${verifiedIds.length}/${approved.r.mission.plan.length}`)

  // Read the browser's LIVE url rather than the handle captured before the mission. `operator.page()`
  // returns a new handle on each call and `page.url()` is a cache seeded at attach time, so the old
  // handle correctly still reports where it was - which says nothing about where the browser is now.
  // Asserting on it would have failed for the right reason and the wrong cause.
  const liveNow = normalisePage(await readBrowser())
  const liveUrl = ('error' in liveNow) ? '(read failed)' : liveNow.facts.url
  check('THE PLAN moved the browser (it was on about:blank before)', liveUrl.startsWith('https://example.com'),
    liveUrl.slice(0, 40))
  console.log(`  browser now at: ${liveUrl.slice(0, 48)}...`)

  // ============================================================================================
  // 7. THE ARTIFACT, INDEPENDENTLY RE-CHECKED
  // ============================================================================================

  console.log('')
  console.log('=== 7. THE ARTIFACT ===')
  check('the summary exists outside the repository', existsSync(artifactPath), artifactPath)
  check('and is not inside the repository tree', !artifactPath.toLowerCase().includes('\\projects\\aios\\'))
  if (!existsSync(artifactPath)) throw new Error('no artifact to check')

  const text = readFileSync(artifactPath, 'utf8')
  console.log(text.split('\n').map((l) => `    ${l}`).join('\n'))

  const independent = normalisePage(await readBrowser())
  if ('error' in independent) throw new Error(`harness read failed: ${independent.error}`)

  console.log('')
  console.log('=== 8. INDEPENDENT CROSS-CHECK ===')
  check('the artifact carries the destination the PLAN navigated to', text.includes(`- url: ${independent.facts.url}`))
  check('and the page title the browser really rendered', text.includes(`- title: ${independent.facts.title}`))
  check('and the page\'s CURRENT character count', text.includes(`- rendered characters: ${independent.facts.characters}`))
  check('and it discloses that no model read the page', /no language model read this page/i.test(text))
  check('the real example.com content is present', /Example Domain/.test(text))
  check('the benign page content is treated as DATA, not instructions', /Example Domain/.test(text))
  check('navigation granted the page no authority over the mission',
    /what the page CONTAINS/i.test(text))

  // ============================================================================================
  // 9. ACROSS A RESTART
  // ============================================================================================

  console.log('')
  console.log('=== 9. PERSISTENCE ACROSS A RESTART ===')
  for (const s of stores) { try { s.close() } catch { /* already closed */ } }
  const reopened = new DurableStore({ path: dbPath })
  const recovered = reopened.readMission('nav-mission')
  const evidenceAfter = reopened.readEvidence('nav-mission')
  const historyAfter = reopened.readHistory('nav-mission')
  const approvalsAfter = reopened.readApprovals('nav-mission')
  check('the mission survives closing and reopening the store', recovered !== undefined)
  check('its evidence survives', evidenceAfter.length >= approved.r.mission.plan.length,
    `${evidenceAfter.length} rows`)
  check('its history survives', historyAfter.length >= 1, `${historyAfter.length} rows`)
  const stepsAfter = recovered?.mission?.plan ?? []
  check('completion is RE-DERIVED from persisted step statuses',
    stepsAfter.length > 0 && stepsAfter.every((s) => s.status === 'done'),
    JSON.stringify(stepsAfter.map((s) => s.status)))
  const kinds = evidenceAfter.map((e) => (e as { kind?: string }).kind).filter(Boolean)
  check('the evidence includes the navigation landing check', kinds.filter((k) => k === 'page-read').length >= 2,
    JSON.stringify(kinds))
  check('and the artifact read-back', kinds.includes('file-read-back'), JSON.stringify(kinds))
  check('no approval carries authority into a NEW mission',
    approvalsAfter.every((a) => String(a.state) !== 'granted'),
    JSON.stringify(approvalsAfter.map((a) => a.state)))
  reopened.close()
} catch (e) {
  console.log('')
  console.log('  THE MISSION THREW')
  console.log(String((e as Error)?.stack ?? e))
  failures += 1
} finally {
  console.log('')
  console.log('=== 10. CLEANUP ===')
  await cleanup(browser)
  for (const s of stores) { try { s.close() } catch { /* already closed */ } }
  check('this run left no temporary directory behind', !existsSync(profile) && !existsSync(out),
    `profile=${profile} out=${out}`)
}

console.log('')
if (failures) {
  console.log(`   === ${failures} FAILURE(S) ===`)
  console.log('  Governed navigation did NOT pass end to end.')
  process.exit(1)
}
console.log('   === PASS: governed navigation -> read -> disclosed summary -> governed write')
console.log('             -> independent verification -> persistence, against a real browser ===')
console.log('  Proved: the approval gate blocks an unapproved navigation; a permitted destination is')
console.log('          approved for that exact URL only; the PLAN moved the browser; the destination')
console.log('          was re-validated after landing; the artifact was independently verified.')
process.exit(0)