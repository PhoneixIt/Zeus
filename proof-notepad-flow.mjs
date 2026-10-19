// ===========================================================================================
// proof-notepad-flow.mjs - what actually happens on this machine, step by step.
//
// WHY THIS EXISTS BEFORE ANY MISSION RUNNER
//
// The save step is the part everyone assumes works and almost never does. Ctrl+S in Notepad
// opens a SEPARATE dialog window with its own handle, and the path has to go into that
// dialog rather than into the document. Whether that dialog appears at all, what it is
// called, and whether the filename field is pre-focused are all properties of this machine's
// Windows build, not of the plan.
//
// So this probes the real machine first and prints what it saw. Writing the mission runner
// against an assumed save behaviour would produce a mission that fails at step 3 and looks
// like a planner fault.
// ===========================================================================================
import { call, get, post } from './hostcall.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const log = (...a) => console.log(...a)
const wins = async () => (await get('/windows')).json?.windows ?? []

function brief(list) {
  return list
    .filter((w) => !['Program Manager', 'Windows Input Experience'].includes(w.title))
    .map((w) => `hwnd=${w.hwnd} pid=${w.pid} "${w.title}" fg=${w.foreground}`)
}

async function main() {
  log('=== 0. baseline windows ===')
  log(brief(await wins()).join('\n'))

  // Close any Notepad left over from a previous run so the flow starts from a known state.
  //
  // By the window's own Close button, not by Ctrl+W.
  //
  // Ctrl+W closes a TAB, not the window, and it was sending a bare "W" rather than Ctrl+W for as
  // long as the harness passed `ctrl=true` as the STRING "true" instead of the JSON boolean the
  // host's literal `"ctrl":true` check requires - so this loop was typing W into documents and
  // closing nothing. With that fixed it closed tabs, and a launch following a tab-close still
  // lost the first six characters of the next sentence, while a launch following a real
  // window-close did not. Closing the window properly is both what a person does and the only
  // version that leaves the desktop measurable.
  for (let pass = 0; pass < 15; pass++) {
    const notes = (await wins()).filter((w) => /notepad/i.test(w.title) || w.class === '#32770')
    if (notes.length === 0) break
    for (const w of notes) {
      await post('/focus', { hwnd: w.hwnd }).catch(() => {})
      await sleep(250)
      const s = await get(`/uiasurvey?hwnd=${w.hwnd}&max=60`).catch(() => null)
      const close = (s?.json?.elements ?? []).find((e) => e.controlType === 'Button' && e.automationId === 'Close')
      if (close) await post('/uiainvoke', { hwnd: w.hwnd, index: close.index }).catch(() => {})
      else await post('/key', { hwnd: w.hwnd, pid: w.pid, title: w.title, vk: (27).toString(16) }).catch(() => {})
    }
    await sleep(700)
    for (const w of await wins()) {
      const s = await get(`/uiasurvey?hwnd=${w.hwnd}&max=40`).catch(() => null)
      const discard = (s?.json?.elements ?? []).find((e) => e.controlType === 'Button' && /don'?t save/i.test(e.name ?? ''))
      if (discard) {
        await post('/focus', { hwnd: w.hwnd }).catch(() => {})
        await sleep(250)
        await post('/uiainvoke', { hwnd: w.hwnd, index: discard.index }).catch(() => {})
      }
    }
    await sleep(400)
  }

  log('\n=== 1. launch notepad ===')
  const launch = (await post('/launch', { app: 'notepad' })).json
  log(JSON.stringify(launch))
  if (!launch.ok) { log('LAUNCH FAILED'); return }
  const target = { hwnd: launch.hwnd, pid: launch.pid, title: launch.title }
  await sleep(600)

  // START A NEW DOCUMENT, EXPLICITLY.
  //
  // Windows 11 Notepad restores unsaved tabs at startup, so a freshly "opened" Notepad can arrive
  // holding a previous run's text - and a document left over from a run that was itself truncated
  // comes back already scrolled, which is indistinguishable from typing having lost its opening
  // characters. That produced a saved file beginning "nd-to-end" on runs whose keystrokes had in
  // fact all landed.
  //
  // Three candidate fixes were tested against that, and two of them were wrong in an instructive
  // way. "Wait until the window stops changing" reported settled=true after 240ms and the loss
  // continued, because a restored document is not changing - it has simply not finished becoming
  // an input target. "Wait for a text-capable element" returned true immediately for the same
  // reason. What did hold is that typing into a document created AFTER the process is warm landed
  // in full, 5/5 and 6/6 and 4/4 across three separate probes.
  //
  // Ctrl+N is what a person presses for a new document, and it creates a genuinely empty one
  // whatever the session restored.
  await post('/key', { ...target, vk: (78).toString(16), ctrl: true }) // Ctrl+N
  await sleep(700)

  log('\n=== 2. type text ===')
  const text = 'AIOS end-to-end GUI mission proof.'
  const typed = (await post('/type', { ...target, text })).json
  log(JSON.stringify(typed))
  await sleep(600)

  log('\n=== 2b. read it back via UIA (independent of what /type returned) ===')
  const survey = (await get(`/uiasurvey?hwnd=${target.hwnd}&max=60`)).json
  const seen = (survey?.elements ?? [])
    .map((e) => e.name ?? e.value ?? '')
    .filter(Boolean)
  log(`uia text: ${JSON.stringify(seen.filter((s) => s.includes('AIOS')))}`)

  log('\n=== 3. Ctrl+S  (vk 83 decimal -> 0x53 hex) ===')
  const before = new Set((await wins()).map((w) => w.hwnd))
  const saved = (await post('/key', { ...target, vk: (83).toString(16), ctrl: true })).json
  log(JSON.stringify(saved))
  await sleep(2500)

  const after = (await wins()).filter((w) => !before.has(w.hwnd))
  log(`\nwindows that appeared after Ctrl+S: ${after.length}`)
  log(brief(after).join('\n') || '(none)')

  log('\n=== 3b. is there a file already? (Notepad may autosave) ===')
  const g = (await get('/guard')).json
  log(`guard: ${g.inputPermission}`)

  log('\n=== 4. try typing the path into the new dialog, if one appeared ===')
  if (after.length > 0) {
    const dlg = after.find((w) => !/notepad/i.test(w.title)) ?? after[0]
    log(`dialog candidate: hwnd=${dlg.hwnd} "${dlg.title}" class=${dlg.class}`)
    const dSurvey = (await get(`/uiasurvey?hwnd=${dlg.hwnd}&max=80`)).json
    log(`dialog controls: ${JSON.stringify((dSurvey?.elements ?? []).map((e) => e.name).filter(Boolean).slice(0, 25))}`)
    const dest = 'C:\\Users\\Samer\\Documents\\AIOS-E2E-PROOF.txt'
    log(`\ntyping path: ${dest}`)
    log(JSON.stringify((await post('/type', { hwnd: dlg.hwnd, pid: dlg.pid, title: dlg.title, text: dest })).json))
    await sleep(500)
    log('pressing Enter (vk 0x0D)')
    log(JSON.stringify((await post('/key', { hwnd: dlg.hwnd, vk: '0d' })).json))
    await sleep(2500)
  } else {
    log('no dialog appeared - Ctrl+S did not open Save As')
  }

  log('\n=== 5. does the file exist on disk? ===')
  const { existsSync, readFileSync } = await import('node:fs')
  const dest = 'C:\\Users\\Samer\\Documents\\AIOS-E2E-PROOF.txt'
  log(`exists: ${existsSync(dest)}`)
  if (existsSync(dest)) log(`contents: ${JSON.stringify(readFileSync(dest, 'utf8'))}`)

  log('\n=== 6. windows at the end ===')
  log(brief(await wins()).join('\n'))
}

await main()