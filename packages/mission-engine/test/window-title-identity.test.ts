/**
 * A WINDOW'S TITLE IS A LABEL, NOT ITS IDENTITY
 * ==============================================
 *
 * OBSERVED LIVE, not hypothesised. The goal "open notepad and type hello world from aios" produced
 * a seven-step plan. Step 1 launched Notepad correctly - a real window, a real handle, a real
 * process - and was rejected with:
 *
 *     window 1640262 is titled "Untitled - Notepad" now, not "Notepad"
 *
 * Because a launch that fails satisfies no dependency, every remaining step was skipped:
 *
 *     a2-s2 ended as failed, which does not satisfy a dependency
 *     a2-s3 ended as skipped, ...
 *
 * One label mismatch silently deleted an entire mission that had done precisely the right thing,
 * and the user was told "0 of 7 step(s) verified" about work that had never really been attempted.
 *
 * THE CONVENTION BEING RELIED ON
 * ------------------------------
 * Windows titles a window `<document> - <application>`. An application showing no document still
 * obeys it: Windows 11 Notepad calls an empty editor "Untitled - Notepad". So the APPLICATION is
 * the trailing segment, and comparing the trailing segment identifies the application while
 * tolerating whatever document name sits in front of it.
 *
 * This is not a loosening. The window's handle, its owning process and its continued existence are
 * all verified before this runs; this decides only WHICH APPLICATION the window is. The negatives
 * below are the load-bearing half: a wrong application must still be refused, or the change is
 * just a hole with a comment attached.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { join } from 'node:path'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const CAPS = pathToFileURL(join(HERE, '..', 'live', 'agent', 'capabilities.ts')).href

/**
 * Drive the REAL launch verifier, with only the host's window observation stubbed.
 *
 * The verifier re-observes through `liveControl`, so the stub replaces that object's methods and
 * nothing else. The identity checks, the process-ownership check, the title comparison under test
 * and the final verdict all run for real - which is the point. A test that reimplemented the
 * comparison would pass while the shipped verifier stayed broken, and this bug already cost one
 * live mission.
 */
async function verifyLaunch(
  launchData: Record<string, unknown>,
  liveTitle: string,
): Promise<{ ok: boolean; reason?: string }> {
  const liveControlMod = await import(pathToFileURL(join(HERE, '..', 'live', 'live-control.ts')).href)
  const real = liveControlMod.liveControl as unknown as Record<string, unknown>
  const saved = {
    observe: real.observe,
    windows: real.windows,
    screenshot: real.screenshot,
  }
  const hwnd = Number(launchData.hwnd ?? 0)
  const pid = Number(launchData.pid ?? 0)
  try {
    real.observe = async () => ({
      screen: { width: 1920, height: 1080 },
      windows: [{
        hwnd, pid, title: liveTitle, processName: 'Notepad.exe', visible: true,
        bounds: { x: 0, y: 0, width: 800, height: 600 },
      }],
      activeHwnd: hwnd,
    })
    real.windows = async () => [{ hwnd, pid, title: liveTitle, processName: 'Notepad.exe', visible: true }]
    real.screenshot = async () => ({ ok: true, data: '' })

    const { resolveCapability } = await import(CAPS)
    const cap = resolveCapability('launch-app')
    assert.ok(cap, 'launch-app must resolve')
    const step = { id: 's1', intent: 'open Notepad', tool: 'launch-app', args: { app: 'notepad' } }
    const v = await cap.verifier.verify(step as never, liveControlMod.liveControl as never, launchData as never)
    if ('rejected' in v && typeof v.rejected === 'string') return { ok: false, reason: v.rejected }
    return { ok: true, reason: undefined }
  } finally {
    const savedAsRecord = saved as Record<string, unknown>
    for (const k of Object.keys(savedAsRecord)) real[k] = savedAsRecord[k]
  }
}

const LAUNCH = { hwnd: 1640262, pid: 9000, title: 'Notepad', path: '', app: 'notepad' }

// ============================================================ the live failure, verbatim

test('"Untitled - Notepad" is Notepad', async () => {
  // The exact title observed on this machine, against the exact record the launch produced.
  const r = await verifyLaunch(LAUNCH, 'Untitled - Notepad')
  assert.equal(r.ok, true, `a real Notepad window was rejected: ${r.reason}`)
})

test('a modified empty document is still Notepad', async () => {
  const r = await verifyLaunch(LAUNCH, '*Untitled - Notepad')
  assert.equal(r.ok, true, `Notepad marks a modified document with a leading asterisk: ${r.reason}`)
})

test('an unchanged title still verifies', async () => {
  const r = await verifyLaunch(LAUNCH, 'Notepad')
  assert.equal(r.ok, true, `the ordinary case regressed: ${r.reason}`)
})

test('an opened document is still Notepad', async () => {
  const r = await verifyLaunch({ ...LAUNCH, title: 'Notepad', path: 'C:\\x\\notes.txt' }, 'notes.txt - Notepad')
  assert.equal(r.ok, true, `Notepad adopting its document was regressed: ${r.reason}`)
})

// ============================================================ the negatives

test('a DIFFERENT application is still refused', async () => {
  // The whole justification for the fix is that it identifies the application. If it accepted a
  // wrong one it would be worse than the bug: a window that is not the one asked for would be
  // reported as proof that it is.
  const r = await verifyLaunch(LAUNCH, 'Untitled - WordPad')
  assert.equal(r.ok, false, 'a WordPad window must not satisfy a request for Notepad')
  assert.match(String(r.reason), /titled "Untitled - WordPad"/)
})

test('an unrelated window is still refused', async () => {
  const r = await verifyLaunch(LAUNCH, 'Administrator: Windows PowerShell')
  assert.equal(r.ok, false, 'an unrelated window must not verify')
})

test('a title that merely CONTAINS the app name is not enough', async () => {
  // Only the trailing segment identifies the application. "Notepad - Restore Files" is a dialog,
  // not the editor, and matching on a substring would accept it.
  const r = await verifyLaunch(LAUNCH, 'Notepad - Restore Files')
  assert.equal(r.ok, false, 'the application must be the TRAILING segment, not a substring')
})

test('an empty live title is still refused', async () => {
  const r = await verifyLaunch(LAUNCH, '')
  assert.equal(r.ok, false, 'a window with no title proves nothing')
})