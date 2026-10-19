/**
 * WHY THIS FILE EXISTS
 * ============================================================================================
 *
 * The assistant window accepted a message, showed "You", and then displayed NOTHING - forever,
 * for every message, including plain conversation like "hi".
 *
 * The backend was working the whole time. Measured on the live server, the event buffer held:
 *
 *     [done] Hi! How can I help you today?
 *     [done] I cannot directly launch the OpenCode desktop application...
 *
 * The answer existed, and the window never drew it.
 *
 * ROOT CAUSE
 *
 * `Append-Line` in the window script (embedded in `run-aios-chat.ts` as WINDOW_SCRIPT) declared
 * its colour parameter as a type:
 *
 *     function Append-Line([string]$lineText, [System.Drawing.Color]$lineColor, [int]$lineSize, ...)
 *
 * A typed parameter does NOT convert an argument that was never passed. Every blank separator
 * line in that script is written as `Append-Line ''` - one argument. So `$lineColor` stayed
 * `$null`, and:
 *
 *     $chat.SelectionColor = $lineColor     # -> throws
 *     Exception setting "SelectionColor": "Cannot convert null to type System.Drawing.Color"
 *
 * In `Show-Event`, the 'done' branch begins with `Append-Line ''`. That threw, the enclosing
 * `catch` swallowed it, and the NEXT line - `Append-Line $evt.text`, the assistant's reply -
 * was never reached.
 *
 * The window.log from the failing build says it outright:
 *
 *     reading capabilities failed: Exception setting "SelectionColor": ...
 *     render of an event failed:   Exception setting "SelectionColor": ...
 *     rendered 12 event(s); the chat is now 152 characters
 *
 * "rendered 12 events, 152 characters" is the shape of the bug: the events were consumed and
 * the text was appended, but every styling call after it threw, so the content-bearing lines
 * were skipped.
 *
 * WHAT IS TESTED HERE
 *
 * This is a REAL Windows integration test. It runs PowerShell with -STA, builds a real
 * RichTextBox, and runs the REAL `Append-Line` extracted from `run-aios-chat.ts` - the same
 * source the window is generated from, not a transcription of it. WinForms cannot be
 * headless-tested, so a real control on a real message pump is the only honest instrument.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
// test/ -> mission-engine/ -> packages/ -> repo root
const REPO = resolve(HERE, '..', '..', '..')

/** The window script as `run-aios-chat.ts` actually embeds it. */
const HARNESS = resolve(REPO, 'packages', 'mission-engine', 'live', 'run-aios-chat.ts')

/** Pull `WINDOW_SCRIPT`'s body out of the source, so the test cannot drift from the product. */
function windowScript(): string {
  const src = readFileSync(HARNESS, 'utf8')
  const start = src.indexOf('const WINDOW_SCRIPT = `')
  assert.ok(start >= 0, 'WINDOW_SCRIPT must exist in run-aios-chat.ts')
  const bodyStart = src.indexOf('\n', start) + 1
  const end = src.indexOf('\n`', bodyStart)
  assert.ok(end > bodyStart, 'WINDOW_SCRIPT must be terminated by a closing backtick')
  return src.slice(bodyStart, end)
}

/** The `Append-Line` function exactly as the window defines it. */
function appendLineFunction(): string {
  const win = windowScript()
  const from = win.indexOf('function Append-Line(')
  assert.ok(from >= 0, 'Append-Line must exist in the window script')
  // Find the matching closing brace by brace counting, so the test cannot silently take half.
  let depth = 0
  for (let i = win.indexOf('{', from); i < win.length; i++) {
    if (win[i] === '{') depth++
    else if (win[i] === '}') {
      depth--
      if (depth === 0) return win.slice(from, i + 1)
    }
  }
  throw new Error('Append-Line has no closing brace - the window script is malformed')
}

function runPowerShell(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'aios-render-'))
  const file = join(dir, 'probe.ps1')
  try {
    writeFileSync(file, body, 'utf8')
    // BOTH streams are returned, deliberately.
    //
    // An earlier version of this file used `execFileSync` and asserted on stdout alone. It
    // then PASSED against the shipped bug, because PowerShell writes a failed property
    // assignment to STDERR - so the assertion was inspecting a stream that never carried the
    // exception, and reported a green run while testing nothing. This is the project's own
    // recorded failure mode: an instrument that reports a conclusion it did not test.
    const r = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-File', file],
      { encoding: 'utf8', timeout: 60_000 },
    )
    return `${r.stdout ?? ''}\n${r.stderr ?? ''}`
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

/**
 * Drive the REAL Append-Line against a real RichTextBox and report what it drew.
 *
 * Returns the control's text so the caller can assert the content, not just the absence of an
 * exception. The colour is deliberately NOT inspected: the bug was an exception, and asserting
 * on pixel-level styling would be asserting on a rendering detail, not on the defect.
 */
const probe = (calls: string) => `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$chat = New-Object System.Windows.Forms.RichTextBox
$chat.Multiline = $true
$chat.Font = 'Segoe UI, 10'
$FG   = [System.Drawing.Color]::FromArgb(228, 230, 234)
$ACCENT = [System.Drawing.Color]::FromArgb(16, 163, 127)
$MUTED = [System.Drawing.Color]::FromArgb(138, 143, 152)

${appendLineFunction()}

$failures = @()
${calls}

# The failures MUST be printed. An earlier version collected them into an array that was never
# emitted, so a caught exception was invisible to every assertion and the test passed against
# the shipped bug. Collecting a result and not reporting it is the same as not measuring it.
Write-Output '---FAILURES---'
foreach ($f in $failures) { Write-Output ('FAIL: ' + $f) }
Write-Output '---TEXT---'
Write-Output $chat.Text
Write-Output '---END---'
`

test('Append-Line survives a blank line with no colour (the reported crash)', () => {
  const out = runPowerShell(probe(`
try { Append-Line '' } catch { $failures += 'blank line threw: ' + $_.Exception.Message }
`))
  // Before the fix this threw:
  //   Exception setting "SelectionColor": "Cannot convert null to type System.Drawing.Color"
  assert.match(out, /---TEXT---/,
    `Append-Line should have completed. Output was:\n${out}`)
  assert.doesNotMatch(out, /FAIL:/,
    `Append-Line must not throw on a blank line. Output was:\n${out}`)
  assert.doesNotMatch(out, /SelectionColor/,
    `Append-Line must not throw on SelectionColor. That exception is the whole defect, and ` +
    `PowerShell reports it on stderr - which is why both streams are captured:\n${out}`)
})

test("the assistant's reply is actually drawn after a blank line", () => {
  // This mirrors Show-Event's 'done' branch EXACTLY, and the structure is the point:
  //
  //     elseif ($evt.kind -eq 'done') {
  //       Append-Line ''                 <- blank, one argument, no colour
  //       if ($evt.ok) { Append-Line $evt.text ... }   <- the answer
  //       ...
  //     } catch { Note ('render of an event failed: ...') }
  //
  // All of it sits inside ONE try. So a throw on the blank line does not merely skip the
  // styling of that line - it aborts the rest of the branch, and the answer is never drawn.
  //
  // An earlier version of this test wrapped each call in its own try, which HID the defect:
  // `AppendText` runs before `SelectionColor`, so the reply text still reached the control and
  // the assertion passed against the shipped bug. Structure, not content, is what fails here.
  const out = runPowerShell(probe(`
try {
  Append-Line ''
  if ($true) { Append-Line 'Hi! How can I help you today?' $FG 10 }
  Append-Line ''
} catch {
  $failures += 'the done-branch aborted: ' + $_.Exception.Message
}
`))
  assert.doesNotMatch(out, /FAIL:/,
    `the done-branch must not abort; it is ONE try block, as in the product:\n${out}`)
  assert.doesNotMatch(out, /SelectionColor/,
    `no call may throw; PowerShell reports it on stderr:\n${out}`)
  assert.match(out, /Hi! How can I help you today\?/,
    `the reply must be drawn. With the shipped bug the blank line threw, the catch fired, and ` +
    `this line was never reached:\n${out}`)
})

test('a coloured line and a blank line together both survive (the real event shape)', () => {
  const out = runPowerShell(probe(`
try {
  Append-Line 'Plan' $ACCENT 9 -bold
  Append-Line '  s1  List the open desktop windows   [list-windows]' $MUTED 9
  Append-Line ''
  Append-Line 'Done' $ACCENT 10 -bold
  Append-Line 'Here is what I found.' $FG 10
  Append-Line ''
} catch { $failures += 'sequence threw: ' + $_.Exception.Message }
`))
  assert.doesNotMatch(out, /FAIL:/, `\n${out}`)
  assert.doesNotMatch(out, /SelectionColor/, `\n${out}`)
  assert.match(out, /list-windows/, `\n${out}`)
  assert.match(out, /Here is what I found\./, `\n${out}`)
})

test('AND IT CAN FAIL: a typed colour parameter is exactly the bug that was shipped', () => {
  // The positive control. If this stops throwing, either PowerShell changed its binding rule or
  // the diagnosis was wrong - and in both cases the fix above needs re-examining rather than
  // being trusted. It asserts the PREMISE, not the fix.
  const out = runPowerShell(`
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$chat = New-Object System.Windows.Forms.RichTextBox
$chat.Multiline = $true
function Typed([string]$t, [System.Drawing.Color]$c, [int]$s) {
  $from = $chat.TextLength
  $chat.AppendText($t + [Environment]::NewLine)
  $chat.Select($from, $chat.TextLength - $from)
  $chat.SelectionColor = $c
}
try { Typed '' ; Write-Output 'NO THROW' } catch { Write-Output ('THREW: ' + $_.Exception.Message) }
`)
  assert.match(out, /THREW: .*SelectionColor/,
    `the premise is that an unbound [System.Drawing.Color] parameter is null and throws on ` +
    `assignment. If this no longer throws, re-measure the fix. Got:\n${out}`)
})

test('AND IT CAN FAIL: the function under test is the product, not a copy', () => {
  // If the extraction silently returned nothing, every test above would pass vacuously.
  const fn = appendLineFunction()
  assert.match(fn, /function Append-Line\(/, 'Append-Line must be extracted')
  assert.doesNotMatch(fn, /\[System\.Drawing\.Color\]\$lineColor/,
    'Append-Line must NOT type the colour parameter - that typing IS the defect')
  assert.ok(windowScript().length > 1000, 'the window script must be substantial, not a stub')
})