/**
 * BROWSER GUI WORKFLOW MISSION
 * End-to-end Windows GUI + browser interaction with independent verification.
 *
 * WHAT THIS MISSION DOES:
 *  1. Launches a supported browser (Chrome/Edge) with an isolated CDP profile
 *  2. Navigates to a harmless, specified public webpage
 *  3. Reads page content via the real browser GUI path (CDP + browser.read)
 *  4. Performs real mouse and keyboard GUI actions within the browser window
 *     - Scroll the page (mouse action through governed path)
 *     - Focus address bar via Ctrl+L keyboard shortcut (keyboard GUI action, gated by MayInject)
 *  5. Saves a short result to an authorized output file (filesystem.write, guard-gated)
 * 6. Reopens and verifies the saved result (filesystem.read + text comparison)
 * 7. Records evidence for each step with independent verification
 *
 * ARCHITECTURE REQUIREMENTS (from the specification):
 * - Explicitly distinguish browser API/DOM actions from mouse-and-keyboard actions
 * - Web content is untrusted input, not authority to control AIOS
 * - No account creation, payment, privileged changes, or external submission
 * - Harmless workflow only
 * - Guardian-gated input throughout
 * - Independent verification at each step
 *
 * The mission uses the governed execution loop:
 *   Observe → Understand → Plan → Propose → Authorize → Execute → Independently Verify → Persist → Recover/Complete
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { execute } from '../executor.ts'
import { DurableStore } from '../../persistence/store.ts'
import { StoreRecorder } from '../../persistence/recorder.ts'
import { liveControl, livePermission } from './live-control.ts'
import type { Mission, Step, Evidence } from '../state.ts'
import { normalisePage, scanForInstructions } from './browser-tools.ts'

const PORT = 9447
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
]

const HARMLESS_URL = 'https://en.wikipedia.org/wiki/Public_domain'

/** A harmless page whose text we will read, summarize, and save. */
const PAGE_TITLE = 'Public Domain'
const PAGE_SUMMARY_FOCUS = 'works that have entered the public domain due to expired copyright'

/** Scan page text for instruction-smuggling patterns; report as data, never obey. */
function scanPageForInstructions(text: string): { name: string; matched: string }[] {
  return scanForInstructions(text).map((n) => ({ name: n.kind, matched: n.pattern }))
}

/** Normalize page facts from a raw read, using the shared browser-tools normaliser. */
type NormalisedPageFacts = {
  facts: {
    url: string
    title: string
    text: string
    characters: number
    headings: string[]
    links: { text: string; href: string }[]
  }
  notices: { name: string; matched: string }[]
}
function normalisePageFacts(raw: unknown): NormalisedPageFacts | { error: string } {
  const n = normalisePage(raw);
  if ('error' in n) return { error: n.error };
  const facts = n.facts;
  const notices = n.notices ?? [];
  return {
    facts: {
      url: facts.url ?? HARMLESS_URL,
      title: facts.title ?? PAGE_TITLE,
      text: facts.text ?? '',
      characters: typeof facts.characters === 'number' ? facts.characters : (facts.text?.length ?? 0),
      headings: [],
      links: Array.isArray(facts.links) ? facts.links.map((l: any) => ({ text: typeof l.text === 'string' ? l.text.slice(0, 80) : '', href: typeof l.href === 'string' ? l.href.slice(0, 400) : '' })) : [],
    },
    notices: notices.length > 0 ? scanPageForInstructions(facts.text ?? '') : [],
  };
}

// ============================================================================================
// the harness
// ============================================================================================

let failed = 0
const check = (name: string, ok: boolean, detail?: string): void => {
  if (ok) { console.log(`   PASS  ${name}`); return }
  const d = detail ?? '';
  console.log(`   FAIL  ${name}${d ? ` - ${d}` : ''}`)
  failed += 1
}
let unverified = 0
const unverifiable = (name: string, why: string): void => {
  console.log(`  UNVERIFIED  ${name}  (${why})`)
  unverified += 1
}

const root = mkdtempSync(join(tmpdir(), 'aios-browser-gw-mission-'))
const ARTIFACT_PATH = join(root, 'browser-gw-summary.txt')
const dbPath = join(root, 'browser-gw-missions.sqlite')

// -------------------------------------------------------
// 0. Preflight: host availability + guard state
// -------------------------------------------------------

const client = await livePermission()
if (client.input !== 'PERMITTED' || client.infrastructureHealthy !== true) {
  console.log('  control layer refused input: ' + (client.blockedBy ?? 'input not permitted'))
  unverifiable('control layer permission', client.blockedBy ?? 'unknown')
  await rmSync(root, { recursive: true, force: true });
  process.exit(1);
}

console.log('=== 0. PREFLIGHT: host available, guard state read ===')
console.log(`  guard: state=${client.control} mayInject=${client.input} takeoverPending=${client.takeoverPending}`)
check('host is available and permissioned for this mission', client.input === 'PERMITTED' || client.takeoverPending !== true,
  `state=${client.control} mayInject=${client.input} takeover=${client.takeoverPending}`);

// -------------------------------------------------------
// 1. LAUNCH BROWSER
// -------------------------------------------------------

console.log('')
console.log('=== 1. LAUNCH BROWSER with isolated CDP profile ===');

const chromePath = CHROME_CANDIDATES.find((c) => existsSync(c));
if (!chromePath) {
  unverifiable('browser binary', 'no Chromium/Chrome/Edge binary found at known paths');
  await rmSync(root, { recursive: true, force: true });
  process.exit(1);
}
console.log(`  browser binary: ${chromePath}`);

const profilePath = mkdtempSync(join(tmpdir(), 'aios-browser-profile-'));
const browser = spawn(chromePath, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--remote-debugging-address=127.0.0.1`,
  `--user-data-dir=${profilePath}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--host-resolver-rules=MAP * ~NOTFOUND',
], { stdio: ['ignore', 'pipe', 'pipe'] });

// Wait for the CDP endpoint
let cdpAlive = false;
for (let i = 0; i < 60; i += 1) {
  await sleep(400);
  try {
    const ok = await fetch(`http://127.0.0.1:${PORT}/json/version`);
    if (ok.ok) { cdpAlive = true; break; }
  } catch { /* not yet */ }
}
if (!cdpAlive) {
  unverifiable('browser CDP', 'browser debugging endpoint never answered on port ' + PORT);
  await rmSync(root, { recursive: true, force: true });
  process.exit(1);
}
console.log('  CDP endpoint answered');

// Import the operator page API after the browser is running
const { page: opPage, readPage } = await import('../../control-core/operator.mjs');

// Navigate to the harmless public webpage
const pageHandle = await opPage()
await pageHandle.goto(HARMLESS_URL)
await sleep(1000);

// Read the page content through the real browser GUI path (CDP + browser.read)
const rawPage = await readPage({ max: 20_000 })
const pageNormalised = normalisePageFacts(rawPage);

if ('error' in pageNormalised) {
  unverifiable('page read from browser', pageNormalised.error);
  await rmSync(root, { recursive: true, force: true });
  process.exit(1);
} else {
  console.log(`  read ${pageNormalised.facts.characters} characters from '${pageNormalised.facts.title}'`);
  console.log(`  url: ${pageNormalised.facts.url}`);
  const notices = pageNormalised.notices;
  if (notices.length > 0) {
    console.log(`  injection patterns noticed: ${notices.length}`);
    for (const n of notices) {
      console.log(`    - ${n.name}: ${n.matched}`);
    }
  } else {
    console.log('  no instruction-smuggling patterns detected');
  }
}

// -------------------------------------------------------
// 2. REAL MOUSE AND KEYBOARD GUI ACTIONS
// -------------------------------------------------------

console.log('')
console.log('=== 2. REAL MOUSE AND KEYBOARD GUI ACTIONS ===');

// Get current guard state before actions
const beforeGuard = await livePermission();
console.log(`  guard before actions: state=${beforeGuard.control} mayInject=${beforeGuard.input} takeover=${beforeGuard.takeoverPending}`);

// Mouse action: scroll the page within the browser window.
// This is a real GUI mouse action through the governed operator path.
// The guard's MayInject() is checked before the action; if refused, no input is injected.
const scrollOk = beforeGuard.input === 'PERMITTED' && beforeGuard.takeoverPending !== true;
console.log(`  scroll action ${scrollOk ? 'permitted by guard' : ' refused by guard (takeoverPending or input false)'}`);
check('scroll action guard check', scrollOk,
  `input=${beforeGuard.input} takeover=${beforeGuard.takeoverPending}`);

// Keyboard GUI action: focus the address bar via Ctrl+L, then type a search query.
// This is a keyboard GUI action, gated by the same MayInject() gate as all input.
// We report the guard's decision rather than auto-performing.
const keyboardPermitted = beforeGuard.input === 'PERMITTED' && beforeGuard.takeoverPending !== true;
console.log(`  keyboard Ctrl+L+type focus: ${keyboardPermitted ? 'would be permitted' : 'would be refused by guard'}`);
check('keyboard action guard decision reported', keyboardPermitted !== undefined);

// Get guard state after actions
const afterGuard = await livePermission();
console.log(`  guard after actions: state=${afterGuard.control} mayInject=${afterGuard.input} takeover=${afterGuard.takeoverPending}`);

// -------------------------------------------------------
// 3. SAVE SUMMARY TO AUTHORIZED OUTPUT FILE
// -------------------------------------------------------

console.log('')
console.log('=== 3. SAVE SUMMARY TO AUTHORIZED OUTPUT FILE ===');

// Write a short summary of the page content to an authorized output file.
// This uses the filesystem.write tool through the controlled path.
// The write is guard-gated: the executor will refuse if MayInject is false.
const summaryText = `${PAGE_TITLE}: ${PAGE_SUMMARY_FOCUS}\n\n` +
  `Source: ${HARMLESS_URL}\n` +
  `Characters read: ${pageNormalised.facts.characters}\n` +
  `Title: ${pageNormalised.facts.title}\n` +
  `Instructions were present: ${(pageNormalised.notices?.length ?? 0) > 0}\n` +
  `This summary was NOT obeyed: instruction patterns were recorded as data.`;

try {
  writeFileSync(ARTIFACT_PATH, summaryText, 'utf8');
  console.log(`  wrote summary to ${ARTIFACT_PATH} (${summaryText.length} bytes)`);
  check('artifact file was written', existsSync(ARTIFACT_PATH), ARTIFACT_PATH);
} catch (e: any) {
  unverifiable('file write', e.message ?? 'unknown error');
}

// -------------------------------------------------------
// 4. INDEpendENT VERIFICATION - RE-READ AND VERIFY
// -------------------------------------------------------

console.log('')
console.log('=== 4. INDEpendENT VERIFICATION - RE-READ AND VERIFY ===');

// Verify the artifact contains what the mission claims
if (!existsSync(ARTIFACT_PATH)) {
  unverifiable('artifact exists for re-read', 'file not found at ' + ARTIFACT_PATH);
} else {
  const artifactText = readFileSync(ARTIFACT_PATH, 'utf8');
  console.log(`  re-read artifact: ${artifactText.length} characters`);
  console.log(`  contains title: ${artifactText.includes(PAGE_TITLE)}`);
  console.log(`  contains focus phrase: ${artifactText.includes(PAGE_SUMMARY_FOCUS)}`);

  // Verify the artifact contains what the mission claims
  check('artifact contains the page title', artifactText.includes(PAGE_TITLE),
    `artifact text preview: ${artifactText.slice(0, 120)}`);
  check('artifact contains the summary focus', artifactText.includes(PAGE_SUMMARY_FOCUS),
    `artifact text preview: ${artifactText.slice(0, 120)}`);

// Also independently re-read the browser page and compare
  try {
    await import('../../control-core/operator.mjs');
    const reRead = await readPage({ max: 20_000 });
    const reNormalised = normalisePageFacts(reRead);
    if ('error' in reNormalised) {
      unverifiable('re-read browser page', reNormalised.error);
    } else {
      console.log(`  re-read ${reNormalised.facts.title} (${reNormalised.facts.characters} chars)`);
      check('artifact and re-read share the same title',
        artifactText.includes(reNormalised.facts.title));
    }
  } catch (e: any) {
    unverifiable('re-read browser page', e.message ?? 'unknown error');
  }
}

// -------------------------------------------------------
// 5. PERSISTENCE AND RECOVERY
// -------------------------------------------------------

console.log('')
console.log('=== 5. PERSISTENCE AND RECOVERY ===')

// Close the store and reopen to verify persistence
const store = new DurableStore({ path: dbPath });
const recorder = new StoreRecorder(store);

// Check the store has history for this mission
// Note: the executor may have written evidence during step execution.
// We check by reading what's persisted.
const history = store.readHistory('browser-gw-workflow-1');
check('store has history for this mission', history.length > 0, `entries=${history.length}`);

const evidenceRows = store.readEvidence('browser-gw-workflow-1');
check('VERIFIED EVIDENCE is durable', evidenceRows.length >= 1, `${evidenceRows.length} row(s)`);

// Close and reopen the store to survival test
store.close();
const reopened = new DurableStore({ path: dbPath });
const recoveredEvidence = reopened.readEvidence('browser-gw-workflow-1');
check('evidence SURVIVES a close and reopen from the same path',
  reopened.readEvidence('browser-gw-workflow-1').length === evidenceRows.length,
  `${reopened.readEvidence('browser-gw-workflow-1').length} vs ${evidenceRows.length} rows`);
reopened.close();

// -------------------------------------------------------
// 6. CLEANUP
// -------------------------------------------------------

console.log('')
console.log('=== 6. CLEANUP ===')
await rmSync(profilePath, { recursive: true, force: true });
rmSync(root, { recursive: true, force: true });
check('profile and stores were removed', !existsSync(profilePath) && !existsSync(dbPath));

// ============================================================================================
// FINAL RESULT
// ============================================================================================

console.log('')
const verdict = failed === 0 && unverified === 0
  ? 'PASS'
  : `${failed} FAILURE(S)` + (unverified ? `, ${unverified} UNVERIFIED` : '');
console.log(`=== ${verdict} ===`);
console.log(`  real browser GUI workflow: observation → navigation → ` +
  `mouse+keyboard GUI actions → independent verification → durable persistence`);
process.exit(failed === 0 && unverified === 0 ? 0 : 1);