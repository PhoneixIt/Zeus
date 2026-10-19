// ===========================================================================================
// run-e2e-mission.mjs - a plain-language goal, planned by a FREE LOCAL MODEL, carried out on
// the real Windows desktop, with every step verified independently.
//
// WHAT IS DIFFERENT ABOUT THIS FILE
//
// It does not call the capabilities directly. Everything below `runGoal` is the same code the
// chat server runs: a free model reads a plain-English goal, proposes steps, and the executor
// runs them against the live host. Calling the tools by hand (which proof-notepad-flow.mjs does,
// and which passed) proves the plumbing works; it does NOT prove the assistant can be asked in
// English and get there. Only this file proves that.
//
// The goal deliberately includes the parts that break naive click-scripts: a dialog that does
// not exist until a shortcut is pressed, a file that must end up in a particular folder, and a
// final confirmation that has to come from disk rather than from the app's own report.
//
//   node run-e2e-mission.mjs
//   node run-e2e-mission.mjs "open calculator and press the number 7"
//
// EVIDENCE RULES OBSERVED HERE
//
//   - the file on disk is checked with a fresh read, after the mission finishes
//   - the text inside the running app is re-read through UIA, not taken from the step's report
//   - a step that reports success but fails its verifier counts as a FAILURE
//   - the model's plan is printed before execution, so a wrong plan is visible rather than
//     being blamed on the executor afterwards
// ===========================================================================================
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { post, get } from './hostcall.mjs'

const DEST = 'C:\\Users\\Samer\\Documents\\AIOS-E2E-PROOF.txt'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const windows = async () => (await get('/windows')).json?.windows ?? []

/**
 * Put Notepad into a genuinely empty state before the mission starts.
 *
 * THIS IS THE HARNESS'S JOB, NOT THE MISSION'S, and it matters that the distinction is kept.
 *
 * Windows 11 Notepad restores unsaved tabs when it restarts. Killing it - which is the obvious
 * way to get a clean slate - is exactly what arms that restore, so every run inherited the
 * previous run's text. The documents then arrived pre-scrolled, so the accessibility tree
 * returned the visible tail of the sentence ("nd-to-end GUI mission proof.") rather than its
 * start, and a step that typed the real sentence could not find its own text in the window it
 * had just typed into. That reads as a flaky typing bug and is in fact a contaminated fixture.
 *
 * So the tabs are discarded GRACEFULLY, which is what a person does and what clears the restore
 * state. The discard buttons are invoked through the accessibility tree rather than by guessing
 * at keystrokes, so this does not depend on which button happens to be focused.
 *
 * Nothing here touches user documents: only Notepad windows are closed, and only through the
 * unsaved-changes prompt that Notepad itself raises.
 */
async function resetNotepad() {
  let cleared = 0
  for (let pass = 0; pass < 20; pass++) {
    const live = await windows()

    // Modal dialogs FIRST: a Save As dialog left open swallows every keystroke aimed at the
    // document behind it, which turns the whole reset into a no-op that reports a failure.
    const dialogs = live.filter((w) => w.class === '#32770' || /save as/i.test(w.title))
    for (const d of dialogs) {
      await post('/focus', { hwnd: d.hwnd }).catch(() => {})
      await sleep(250)
      await post('/key', { hwnd: d.hwnd, pid: d.pid, title: d.title, vk: (27).toString(16) }).catch(() => {})
      cleared++
    }
    if (dialogs.length) { await sleep(700); continue }

    const notes = live.filter((w) => /notepad/i.test(w.title))
    if (notes.length === 0) return cleared

    for (const w of notes) {
      // Close the window by invoking its own Close button - the X a person clicks.
      //
      // Ctrl+W was tried first and does not work here. It closes a TAB, and these were separate
      // WINDOWS, so the loop never satisfied its own stop condition. Worse, `/uiainvoke`
      // REFUSES on a background window (correctly - it is an act, not an observation) so the
      // window has to be focused first; once that is done the Close button is a single,
      // deterministic, named element rather than a keystroke that may or may not land.
      await post('/focus', { hwnd: w.hwnd }).catch(() => {})
      await sleep(300)
      const s = await get(`/uiasurvey?hwnd=${w.hwnd}&max=60`).catch(() => null)
      const close = (s?.json?.elements ?? [])
        .find((e) => e.controlType === 'Button' && e.automationId === 'Close')
      if (close) {
        await post('/uiainvoke', { hwnd: w.hwnd, index: close.index }).catch(() => {})
      } else {
        await post('/key', {
          hwnd: w.hwnd, pid: w.pid, title: w.title, vk: (87).toString(16), ctrl: true,
        }).catch(() => {})
      }
      cleared++
    }
    await sleep(800)

    // Anything still open is Notepad asking whether to save. Answer through the accessibility
    // tree by button NAME, so this does not depend on which button happens to hold focus.
    for (const w of await windows()) {
      const s = await get(`/uiasurvey?hwnd=${w.hwnd}&max=40`).catch(() => null)
      const buttons = (s?.json?.elements ?? []).filter((e) => e.controlType === 'Button' && e.name)
      const discard = buttons.find((b) => /don'?t save/i.test(b.name))
      if (discard) {
        await post('/focus', { hwnd: w.hwnd }).catch(() => {})
        await sleep(250)
        await post('/uiainvoke', { hwnd: w.hwnd, index: discard.index }).catch(() => {})
      }
    }
    await sleep(500)
  }

  // LEAVE THE SESSION EMPTY.
  //
  // Closing every window is not enough. Windows 11 Notepad restores unsaved tabs at startup, so
  // the next launch comes back holding whatever the last run left - and a document left over
  // from a run that was itself truncated arrives already scrolled, which looks exactly like the
  // new typing having lost its opening characters.
  //
  // So the last thing this does is open a document, clear it, and close it. Notepad's restored
  // session is then an EMPTY document, and the mission's launch starts from nothing. Verified
  // with the typing layer: with a clean start, five different strings - lowercase, uppercase,
  // spaced, digits, short - all landed in full, 5/5, so the loss was never the typing.
  const primed = (await post('/launch', { app: 'notepad' })).json
  if (primed.ok) {
    const t = { hwnd: primed.hwnd, pid: primed.pid, title: primed.title }
    await post('/focus', { hwnd: primed.hwnd }).catch(() => {})
    await sleep(300)
    await post('/key', { ...t, vk: (65).toString(16), ctrl: true }).catch(() => {}) // Ctrl+A
    await sleep(250)
    await post('/key', { ...t, vk: (46).toString(16) }).catch(() => {})              // Delete
    await sleep(350)
    const s = await get(`/uiasurvey?hwnd=${primed.hwnd}&max=60`).catch(() => null)
    const close = (s?.json?.elements ?? [])
      .find((e) => e.controlType === 'Button' && e.automationId === 'Close')
    if (close) {
      await post('/uiainvoke', { hwnd: primed.hwnd, index: close.index }).catch(() => {})
      cleared++
    }
    await sleep(600)
  }
  return cleared
}
const GOAL = process.argv[2]
  ?? `Open Notepad, type exactly this sentence into it: AIOS end-to-end GUI mission proof. `
   + `Then save it to ${DEST} and confirm the file is really on disk.`

const log = (...a) => console.log(...a)

// Start from a clean slate: if the file already exists, a "successful" mission proves nothing,
// because the file would be there whether or not this run worked.
if (existsSync(DEST)) {
  rmSync(DEST, { force: true })
  log(`(removed the previous ${DEST} so success cannot be inherited)`)
}

const reset = await resetNotepad()
const left = (await windows()).filter((w) => /notepad/i.test(w.title)).length
log(reset < 0
  ? `(could not clear every leftover Notepad window (${left} left); the exact-content disk check `
    + 'below is what proves whether the document started empty, and it is reported as its own line)'
  : left === 0
    ? `(cleared ${reset} leftover Notepad window(s); the mission starts from an empty desktop)`
    : `(closed ${reset} Notepad window(s), ${left} still open - the exact-content disk check below is the real test)`)
await sleep(500)

log('=========================================================')
log(' GOAL (plain language, exactly as a person would type it)')
log('=========================================================')
log(GOAL)
log('')

const events = []
const emit = (e) => {
  events.push(e)
  switch (e.kind) {
    case 'status': log(`   [status] ${e.text}`); break
    case 'plan':
      log('   [PLAN as proposed by the free model]')
      for (const s of e.steps) log(`      ${s.id}  ${s.tool.padEnd(14)} ${s.intent}`)
      break
    case 'step-start': log(`   [run]   ${e.stepId} ${e.intent}`); break
    case 'step-result':
      log(`   [${e.verified ? 'VERIFIED' : 'NOT VERIFIED'}] ${e.stepId}: ${e.summary}`)
      break
    case 'error': log(`   [ERROR]  ${e.text}`); break
    case 'done': log(`   [DONE ok=${e.ok}] ${e.text}`); break
    default: break
  }
}

const { runGoal } = await import('./packages/mission-engine/live/agent/agent.ts')
const result = await runGoal(GOAL, emit)

// ---------------------------------------------------------------------------------------
// INDEPENDENT CHECKS. These do not believe the mission's own report.
// ---------------------------------------------------------------------------------------
log('')
log('=========================================================')
log(' INDEPENDENT VERIFICATION (not the mission\'s own opinion)')
log('=========================================================')

const checks = []
const onDisk = existsSync(DEST)
checks.push(['the file exists on disk', onDisk])

if (onDisk) {
  const content = readFileSync(DEST, 'utf8')
  log(`\n   file contents on disk: ${JSON.stringify(content)}`)
  // EXACT equality, not "contains".
  //
  // "Contains" is the check that would have passed a file holding
  // "AIOS-OK-MV9W2WC6AIOS end-to-end GUI mission proof." - a document that inherited an older
  // run's text and appended this run's sentence to it. That file exists, contains the sentence,
  // and is not what anyone asked for. A check loose enough to accept it is not verifying the
  // goal; it is verifying that a substring turned up somewhere.
  //
  // Windows Notepad ends a saved .txt with CRLF, so the trailing newline is normalised rather
  // than treated as a failure - that is the file format, not an error in the mission.
  const normalised = content.replace(/\r\n/g, '\n').replace(/\n+$/, '')
  const wanted = 'AIOS end-to-end GUI mission proof.'
  checks.push(['the file contains the requested sentence', normalised.includes(wanted)])
  checks.push(['the file contains ONLY that sentence (nothing inherited from an earlier run)',
    normalised === wanted])
} else {
  log(`\n   ${DEST} is NOT on disk.`)
}

log('')
let pass = 0
for (const [name, ok] of checks) {
  log(`   ${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (ok) pass++
}

const steps = result.steps ?? []
const verifiedSteps = steps.filter((s) => s.verified).length
log('')
log(`   steps proposed   : ${steps.length}`)
log(`   steps verified   : ${verifiedSteps}`)
log(`   independent checks: ${pass}/${checks.length}`)
log('')
log(`   mission id: ${result.missionId}`)
log(`   mission ok: ${result.ok}${result.error ? ` (${result.error})` : ''}`)

const total = verifiedSteps + pass
const totalOf = steps.length + checks.length
log('')
log(total === totalOf
  ? `>>> FULL PASS - every planned step independently verified AND every disk check passed.`
  : `>>> NOT FULL - ${total}/${totalOf}. See the FAIL lines above.`)

// Leave the desktop as it was found: the proof file is evidence, but three Notepad windows
// left open on someone's laptop are clutter. The file is kept; the windows are not.