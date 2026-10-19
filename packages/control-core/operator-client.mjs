// Reusable client for the PortAi desktop operator host.
//
// This is my side of the capability: the host owns the Windows session and the
// screen, this owns intent. Keeping them separate means the host can survive across
// shell invocations while I issue one operation at a time and read the evidence.
//
// Usage:
//   const op = await connect();
//   await op.ping()
//   await op.windows()
//   await op.screen('/tmp/shot.png')
//   await op.focus({ hwnd, pid, title })
//   await op.click({ hwnd, pid, x, y })
//   await op.type({ hwnd, pid, text })
//   await op.tree({ hwnd })
//
// Every input method takes the target window identity. That is not optional: the host
// refuses input it cannot verify, and it will not inject into a window that is not
// confirmed foreground.

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const STATE_DIR = process.env.PORTAI_OPERATOR_DIR
  || join(process.env.LOCALAPPDATA || '/tmp', 'Temp', 'opencode', 'operator')

export async function connect({ statePath = join(STATE_DIR, 'host.json') } = {}) {
  if (!existsSync(statePath)) {
    throw new Error(
      `Operator host is not running: no state file at ${statePath}. ` +
      `Start it with scripts/start-operator-host.mjs first.`,
    )
  }
  const state = JSON.parse(readFileSync(statePath, 'utf8'))
  const base = `http://127.0.0.1:${state.port}`

  const get = async (path) => {
    const res = await fetch(base + path)
    if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status}`)
    return res.json()
  }

  const post = async (path, body) => {
    const res = await fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, token: state.token }),
    })
    const text = await res.text()
    let parsed
    try { parsed = JSON.parse(text) } catch { throw new Error(`${path} returned non-JSON: ${text.slice(0, 200)}`) }
    if (parsed.refused) {
      throw new Error(`HOST REFUSED ${path}: ${parsed.error}`)
    }
    if (parsed.ok === false) throw new Error(`${path} failed: ${parsed.error || 'unknown'}`)
    return parsed
  }

  return {
    state,
    ping: () => get('/ping'),
    windows: () => get('/windows'),
    tree: ({ hwnd, depth = 4 }) => get(`/uia?hwnd=${hwnd}&depth=${depth}`),
    // Real UI Automation. These act on controls by NAME, not by coordinate.
    // uiainvoke/uiassetvalue are guarded exactly like a click: verify + mayInject + foreground.
    //
    // NOTE ON RELIABILITY, measured rather than assumed. Chromium populates its Windows
    // accessibility tree asynchronously, and repeated identical reads of the SAME page in
    // the SAME window returned 34, then 400, then 0 elements across three runs. A warm-up
    // read was tried to smooth this and made it worse, so it was reverted rather than left
    // in as a plausible-looking fix.
    //
    // Consequence, stated plainly: UIA on Chromium PAGE CONTENT is not reliable, and the
    // operator must not depend on it there. UIA IS reliable for the browser's own chrome and
    // for native applications - Edge, VS Code and File Explorer all return stable, deep,
    // name-addressable trees. For page content the operator uses the browser DOM, which is
    // stable and is a legitimate instrument in its own right.
    uiasurvey: (target) => post('/uiasurvey', { ...target, max: 400 }),
    uiafind: (target) => post('/uiafind', target),
    uiainvoke: (target) => post('/uiainvoke', target),
    uiasetvalue: (target) => post('/uiasetvalue', target),
    uiaread: (target) => post('/uiaread', target),
    // Put the CARET somewhere specific, and read back what ended up focused. This exists
    // because opening a file does not move the caret: the title updates, the keystrokes go
    // elsewhere, and the only way to know is to ask the application to focus the intended
    // control and then verify.
    uiafocus: (target) => post('/uiafocus', target),
    // Which tabs / tree items / list entries does the application itself consider current.
    uiselected: (target) => post('/uiselected', target),
    // Establish WHICH FILE will receive keystrokes, in a VS Code editor, and mint a
    // short-lived host-side authorization. /type physically cannot send text to a VS Code
    // window without one, so this cannot be forgotten or skipped by a caller.
    //
    // The proof is structural, not observational: assert no editor is open, open exactly
    // one through VS Code's own command interface, then assert the title now names it. With
    // one editor open the caret cannot be anywhere else.
    vstype: (target) => post('/vstype', target),
    async screen(destPath, region) {
      const q = region ? `?x=${region.x | 0}&y=${region.y | 0}&w=${region.w | 0}&h=${region.h | 0}` : ''
      const res = await fetch(`${base}/screen.png${q}`)
      if (!res.ok) throw new Error(`screen -> HTTP ${res.status}`)
      const buf = Buffer.from(await res.arrayBuffer())
      if (destPath) {
        writeFileSync(destPath, buf)
        return { path: destPath, bytes: buf.length }
      }
      return buf
    },
    focus: (target) => post('/focus', target),
    restore: (target) => post('/restore', target),
    show: (target) => post('/show', target),
    guard: () => post('/guard', {}),
    indicator: () => post('/indicator', {}),
    display: () => get('/display'),
    panelgrid: () => get('/panelgrid'),
    pixel: (x, y) => get(`/pixel?x=${x | 0}&y=${y | 0}`),
    arm: () => post('/arm', {}),
    observe: () => post('/observe', {}),
    pause: () => post('/pause', {}),
    release: () => post('/release', {}),
    emergencyStop: () => post('/emergency-stop', {}),
    rearm: () => post('/rearm', {}),
    autoRearm: () => post('/auto-rearm', {}),
    drain: () => post('/drain', {}),
    // Exposed so governance tests can reach a route the typed helpers deliberately do not
    // offer - for example to prove that /release REFUSES, which is impossible to test
    // through a helper that expects success. Returns { ok:false, refused: ... } as the
    // host sent it, so a refusal is observable rather than thrown away.
    raw: (path, opts = {}) => {
      const method = opts.method || 'GET'
      // The token is required for anything past the auth check. Without it the host answers
      // {"ok":false,"error":"unauthorized"} - which looks like a missing endpoint rather than
      // a rejected call, and cost a diagnostic cycle being misread.
      const body = method === 'GET' ? undefined : JSON.stringify({ ...(opts.body ?? {}), token: state.token })
      return fetch(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body,
      }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }))
    },
    move: (target) => post('/move', target),
    click: (target) => post('/click', target),
    type: (target) => post('/type', target),
    key: (target) => post('/key', target),
    scroll: (target) => post('/scroll', target),
    scanInput: (target) => post('/scaninput', target),
    wmChar: (target) => post('/wmchar', target),
    integrity: (pid) => get(`/integrity?pid=${pid}`),
    guiFocus: (hwnd) => get(`/guifocus?hwnd=${hwnd}`),
    shutdown: () => post('/shutdown', {}),

    /**
     * Resolves a window by title substring and returns its identity, or null.
     * Refuses to guess: an ambiguous match is an error, not a pick.
     */
    async findWindow(titleFragment, { requireForeground = false } = {}) {
      const all = await get('/windows')
      const matches = all.filter((w) => String(w.title).toLowerCase().includes(String(titleFragment).toLowerCase()))
      if (matches.length === 0) {
        const seen = all.map((w) => `${w.hwnd}:${w.title}`).join(' | ')
        throw new Error(`No window titled "${titleFragment}". Visible: ${seen}`)
      }
      if (matches.length > 1) {
        throw new Error(`Ambiguous title "${titleFragment}" matched ${matches.length} windows: ` +
          matches.map((m) => `${m.hwnd}("${m.title}")`).join(', '))
      }
      const w = matches[0]
      if (requireForeground && !w.foreground) {
        throw new Error(`Window "${w.title}" exists (hwnd ${w.hwnd}) but is not foreground; refusing to target it blindly.`)
      }
      return w
    },

    /** Centre point of a control, for clicking it by name rather than by coordinate. */
    controlByName(hwnd, nameFragment) {
      return get(`/uia?hwnd=${hwnd}&depth=6`).then((res) => {
        const hits = (res.tree || []).filter(
          (c) => String(c.name).toLowerCase().includes(String(nameFragment).toLowerCase()),
        )
        if (hits.length === 0) {
          throw new Error(`No control named "${nameFragment}" under hwnd ${hwnd}. ` +
            `Saw: ${(res.tree || []).map((c) => c.name).filter(Boolean).join(' | ') || '(none)'}`)
        }
        return hits[0]
      })
    },
  }
}
