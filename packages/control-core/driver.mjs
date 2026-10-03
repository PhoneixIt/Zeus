// Operator driver: the small set of primitives the desktop operator needs to do
// real engineering work in a visible window.
//
// This is NOT a reporting abstraction. Every function here ends in a real,
// guarded call to the operator host, which performs the actual Win32 input. The
// only thing this layer adds is bookkeeping - and one piece of hard-won
// discipline:
//
//   The window title is MUTABLE, so it is re-read immediately before every
//   single input operation. Pinning a title captured earlier is how an earlier
//   attempt ended up aiming at the wrong window; the host correctly refused, and
//   the fix is to re-read, never to loosen the check.
//
// Safety is never bypassed here. hwnd + pid + title all go to the host on every
// call, and the host independently re-verifies visibility, process identity, title
// and foreground before injecting anything.

import { connect } from './operator-client.mjs'
import { execFileSync } from 'node:child_process'

const PS = 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
const SHOTS = 'C:/Users/Samer/AppData/Local/Temp/opencode/desktop-capture'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export const op = await connect()

/** All top-level windows the host can see, as host-reported objects. */
export async function listWindows() {
  return (await op.windows()).windows
}

export async function foreground() {
  return (await op.windows()).windows.find((w) => w.foreground) || null
}

/**
 * Resolve a window by predicate, with an explicit timeout.
 * Throws rather than returning null, so a caller cannot accidentally proceed
 * against an undefined target.
 */
export async function findWindow(predicate, { timeoutMs = 20000, label = 'window' } = {}) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const hit = (await listWindows()).find(predicate)
    if (hit) return hit
    await sleep(400)
  }
  throw new Error(`${label} not found within ${timeoutMs}ms`)
}

/** Re-read a window's current identity. Always call this before an input op. */
export async function identity(win) {
  const fresh = (await listWindows()).find((w) => w.hwnd === win.hwnd)
  if (!fresh) throw new Error(`window ${win.hwnd} has disappeared`)
  if (fresh.minimized) throw new Error(`window ${win.hwnd} is minimised; refusing to target it`)
  return { hwnd: fresh.hwnd, pid: fresh.pid, title: fresh.title }
}

/** Bring a window to the foreground through the host's guarded focus path. */
export async function focus(win) {
  const id = await identity(win)
  const res = await op.focus({ hwnd: id.hwnd, pid: id.pid, title: id.title })
  const fg = await foreground()
  if (!fg || fg.hwnd !== id.hwnd) throw new Error(`focus did not take: foreground is "${fg ? fg.title : 'none'}"`)
  return { ...id, foreground: true }
}

/** Send literal text with real OS keystrokes. Never includes a newline. */
export async function typeText(win, text) {
  const id = await identity(win)
  if (/[\r\n]/.test(text)) throw new Error('typeText takes a single line; use typeCommand for a command')
  return op.type({ hwnd: id.hwnd, pid: id.pid, title: id.title, text })
}

/** Press a virtual key by hex code. 0D = Enter, 0x1B = Escape, 0x03 = Ctrl+C. */
export async function pressKey(win, vkHex) {
  const id = await identity(win)
  return op.key({ hwnd: id.hwnd, pid: id.pid, title: id.title, vk: vkHex })
}

export const VK = { ENTER: '0D', ESC: '1B', CTRL_C: '03', TAB: '09' }

/** Type a command and press Enter, the way a person at a keyboard would. */
export async function typeCommand(win, command) {
  await typeText(win, command)
  await sleep(150)
  await pressKey(win, VK.ENTER)
}

/** OS-level mouse click at absolute screen coordinates. */
export async function clickAt(win, x, y) {
  const id = await identity(win)
  return op.click({ hwnd: id.hwnd, pid: id.pid, title: id.title, x, y, button: 'left' })
}

/** Move the OS cursor without clicking. */
export async function moveTo(win, x, y) {
  const id = await identity(win)
  return op.move({ hwnd: id.hwnd, pid: id.pid, title: id.title, x, y })
}

/** Capture the physical screen through the host (independent of any browser). */
export async function screenshot(name) {
  const path = `${SHOTS}/${name}.png`
  const res = await op.screen(path)
  return { path, bytes: res.bytes }
}

/** Launch a process detached, returning its pid. Uses Start-Process, the path
 *  proven to produce a visible console in this session. */
export function launchVisible(exe, args, cwd) {
  const argList = args.map((a) => `'${String(a).replace(/'/g, "''")}'`).join(',')
  const out = execFileSync(
    PS,
    ['-NoProfile', '-Command', `$p = Start-Process -FilePath '${exe}' -ArgumentList ${argList} -WorkingDirectory '${cwd}' -PassThru; $p.Id`],
    { encoding: 'utf8' },
  )
  return Number(out.trim().split(/\r?\n/).pop())
}

/** Read the tail of a log file the terminal is writing to. */
export function tailLog(path, lines = 40) {
  try {
    const text = execFileSync(PS, ['-NoProfile', '-Command', `Get-Content -LiteralPath '${path}' -Tail ${lines} -ErrorAction SilentlyContinue`], {
      encoding: 'utf8',
    })
    return text
  } catch {
    return ''
  }
}

// ------------------------------------------------------------------ workspace identity

const WORKSPACE_STATE = 'C:/Users/Samer/AppData/Local/Temp/opencode/operator/workspace.json'

/**
 * Persist the workspace window's identity by HWND.
 *
 * This exists because of an observed failure, not a hypothetical one. A PowerShell
 * window inside Windows Terminal takes its title from whatever command is currently
 * running, so a workspace identified by title changed from "PortAi Operator" to
 * "npm run test:sources-greenhouse" the moment real work started, and title-based
 * lookup failed on the very next command.
 *
 * The HWND is stable; the title is not. So the HWND is pinned here and the title is
 * re-read before every single operation. That is strictly safer than the title lookup
 * it replaces, because the host still re-verifies the live title on each call - we
 * simply stop depending on it to find the window in the first place.
 */
export function saveWorkspace(win) {
  const json = JSON.stringify({ hwnd: win.hwnd, pid: win.pid, cls: win.class })
  execFileSync(PS, ['-NoProfile', '-Command', `[System.IO.File]::WriteAllText('${WORKSPACE_STATE}', @'\n${json}\n'@)`], { encoding: 'utf8' })
}

export function loadWorkspace() {
  try {
    const raw = execFileSync(PS, ['-NoProfile', '-Command', `[System.IO.File]::ReadAllText('${WORKSPACE_STATE}')`], { encoding: 'utf8' })
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/**
 * Resolve the workspace window, verifying identity rather than trusting the pin.
 * Falls back to a class search only when the pin is unusable, so a stale state file
 * degrades to a fresh lookup instead of a wrong target.
 */
export async function resolveWorkspace({ timeoutMs = 15000 } = {}) {
  const saved = loadWorkspace()
  if (saved && saved.hwnd) {
    const hit = (await listWindows()).find((w) => w.hwnd === saved.hwnd)
    if (hit && hit.pid === saved.pid && !hit.minimized) return hit
  }
  return findWindow((w) => w.class === 'CASCADIA_HOSTING_WINDOW_CLASS' && !w.minimized && w.title !== 'Windows PowerShell', {
    timeoutMs,
    label: 'the operator terminal (no usable pinned HWND)',
  })
}
