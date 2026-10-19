// Close every Notepad window GRACEFULLY and clear the file, so a measurement starts clean.
//
// Force-killing Notepad arms its session restore, so the next launch brings the previous
// document back and appends to it. That is how a probe ends up saving ten copies of a sentence
// and looks like a typing defect. Closing through the window's own Close button is what a person
// does and it leaves nothing to restore.
import { get, post } from './hostcall.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

for (let pass = 0; pass < 15; pass++) {
  const ws = (await get('/windows')).json?.windows ?? []
  const notes = ws.filter((w) => /notepad/i.test(w.title) || w.class === '#32770')
  if (notes.length === 0) { console.log('desktop is clear of Notepad'); break }
  for (const w of notes) {
    await post('/focus', { hwnd: w.hwnd }).catch(() => {})
    await sleep(250)
    const s = await get(`/uiasurvey?hwnd=${w.hwnd}&max=60`).catch(() => null)
    const els = s?.json?.elements ?? []
    const close = els.find((e) => e.controlType === 'Button' && e.automationId === 'Close')
    if (close) await post('/uiainvoke', { hwnd: w.hwnd, index: close.index }).catch(() => {})
    else await post('/key', { hwnd: w.hwnd, pid: w.pid, title: w.title, vk: (87).toString(16), ctrl: true }).catch(() => {})
  }
  await sleep(700)
  // Answer Notepad's own unsaved-changes prompt by button name.
  for (const w of (await get('/windows')).json?.windows ?? []) {
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