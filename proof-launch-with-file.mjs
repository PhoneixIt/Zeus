// Proof: launch an application WITH a document, instead of driving a Save As dialog.
//
// WHY THIS EXISTS
//
// The original flow had to: open Notepad, type, press Ctrl+S, DETECT the dialog that appeared,
// find its handle, type the path into it, press Enter. Five steps, three of which depend on a
// dialog behaving exactly as it does on this Windows build.
//
// Opening the document up front removes the dialog entirely. The document exists before anything
// is typed, there is exactly one of it, and Ctrl+S writes straight to the path it already has.
// It also removes the failure this project keeps hitting: Notepad restoring a previous session and
// the flow typing into one tab while saving another.
//
// This proves the whole chain on the real machine, with the file checked on disk afterwards.
import { post, get } from './hostcall.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const { existsSync, readFileSync, rmSync } = await import('node:fs')

const DEST = 'C:\\Users\\Samer\\Documents\\AIOS-LAUNCHFILE-PROOF.txt'
const TEXT = 'Opened by path, not by dialog.'
rmSync(DEST, { force: true })

const step = (n, s) => console.log(`\n=== ${n}. ${s} ===`)

step(1, 'refuse to open a PROGRAM - "open a document" must never become "run this"')
const bad = (await post('/launch', { app: 'notepad', path: 'C:\\Windows\\System32\\cmd.exe' })).json
console.log(`  ok=${bad.ok}`)
console.log(`  ${bad.error}`)

step(2, 'an app that cannot take a document says so, naming the ones that can')
const noFile = (await post('/launch', { app: 'calculator', path: DEST })).json
console.log(`  ok=${noFile.ok}`)
console.log(`  ${noFile.error}`)

step(3, 'launch notepad WITH the document')
const l = (await post('/launch', { app: 'notepad', path: DEST })).json
console.log('  ' + JSON.stringify(l))
if (!l.ok) process.exit(1)
await sleep(1500)

step(4, 'the document window is the one launch named')
const ws = (await get('/windows')).json?.windows ?? []
const target = ws.find((w) => w.hwnd === l.hwnd)
console.log(`  hwnd=${l.hwnd} title="${target?.title}" visible=${target?.visible}`)
if (!target) { console.log('  the launched window is not in the window table'); process.exit(1) }

step(5, 'type - no dialog to appear afterwards, so there is nothing to wait for')
const t = (await post('/type', { hwnd: target.hwnd, pid: target.pid, title: target.title, text: TEXT })).json
console.log(`  sent=${t.chars} landedSuffix=${t.landedSuffixChars} fully=${t.landedFully}`)
await sleep(600)

step(6, 'Ctrl+S writes straight to the path the document already has')
const before = new Set((await get('/windows')).json?.windows?.map((w) => w.hwnd) ?? [])
const k = (await post('/key', { hwnd: target.hwnd, pid: target.pid, title: target.title, vk: 83, ctrl: true })).json
console.log('  ' + JSON.stringify(k))
await sleep(2500)
const after = (await get('/windows')).json?.windows ?? []
const appeared = after.filter((w) => !before.has(w.hwnd))
console.log(`  new windows after Ctrl+S: ${appeared.length} ${appeared.map((w) => `"${w.title}"`).join(', ')}`)
console.log('  (0 is the point: no Save As dialog, so nothing to discover and nothing to mistype into)')

step(7, 'the file on disk')
if (!existsSync(DEST)) { console.log('  FAIL: not on disk'); process.exit(1) }
const got = readFileSync(DEST, 'utf8').replace(/\r\n/g, '\n')
console.log(`  contents: ${JSON.stringify(got)}`)
console.log(`  ${got === TEXT ? 'PASS - exactly the requested text, nothing inherited' : 'FAIL'}`)