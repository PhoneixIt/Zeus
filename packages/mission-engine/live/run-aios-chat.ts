/**
 * THE AIOS ASSISTANT WINDOW - the product's primary interface.
 *
 * =============================================================================
 * WHY THIS FILE EXISTS IN ITS CURRENT SHAPE
 * =============================================================================
 *
 * This is a rewrite, not a patch. The previous version was assembled by scripted line splices
 * into a file that had already duplicated itself twice, and the final splice cut through the
 * script's template literal and destroyed the window outright. Editing this file by script is
 * exactly the mistake that broke it; from here it is written whole.
 *
 * =============================================================================
 * THE FOUR POWERHELL TRAPS THIS SCRIPT IS BUILT AROUND
 * =============================================================================
 *
 * Every one of these was a real defect that reached a running window and looked like the
 * assistant being broken rather than the window being wrong.
 *
 * 1. EVENT ACCESSORS. In PowerShell, reading a .NET event property returns the delegate, which is
 *    null until something subscribes. `$form.Shown` is null; `$form.add_Shown({...})` subscribes.
 *    Getting this wrong throws "cannot call a method on a null-valued expression".
 *
 * 2. EVENT ARGUMENTS. Both `$_` and `$args[0]` fail to bind to WinForms event arguments from a
 *    scriptblock. Only an explicit `param($sender, $e)` binds. Enter did nothing for two
 *    releases because of this.
 *
 * 3. GARBAGE COLLECTION. A WinForms.Timer created in a local scope dies with that scope, and
 *    its handler goes with it - silently. The agent was producing events, the server had them,
 *    and the window never ticked once. It lives in $global: now, and the form stops it on close.
 *
 * 4. CASE-INSENSITIVE VARIABLES. `$text` and `$TEXT` are the same variable. A local named
 *    `$text` overwrote a palette entry named `$TEXT`, so a colour parameter received a string,
 *    the cast threw, and the message was never sent - while the "You" label above it rendered
 *    perfectly. Nothing was broken visibly; the window simply did nothing.
 *
 * Add-Type was tried as a way to remove traps 2 and 3. It failed to compile here (the C# is
 * compiled without the Windows Forms reference) and cost a cycle. Plain PowerShell, written
 * carefully, is what works.
 *
 * NOTE: this comment lives inside a JS template literal. NO BACKTICKS anywhere in the script.
 */

import { writeFileSync, mkdtempSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawn, type ChildProcess } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))

// ===========================================================================================

const WINDOW_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

# Must come before any control exists: the thread exception mode cannot be changed once one has
# been created, and asking later throws and kills the window at startup.
[System.Windows.Forms.Application]::SetUnhandledExceptionMode([System.Windows.Forms.UnhandledExceptionMode]::CatchException)

$server = $args[0]
$token  = $args[1]
$LOG    = 'C:\Users\Samer\.aios\agent\window.log'

# Palette. No name here is one a caller might plausibly use for something else.
$BG      = [System.Drawing.Color]::FromArgb(17, 18, 22)
$PANEL   = [System.Drawing.Color]::FromArgb(24, 26, 31)
$RAISED  = [System.Drawing.Color]::FromArgb(32, 35, 42)
$FG      = [System.Drawing.Color]::FromArgb(228, 230, 234)
$MUTED   = [System.Drawing.Color]::FromArgb(138, 143, 152)
$ACCENT  = [System.Drawing.Color]::FromArgb(16, 163, 127)
$DANGER  = [System.Drawing.Color]::FromArgb(220, 80, 80)

function Note([string]$m) { try { Add-Content $LOG $m } catch { } }

# ---- layout
$form = New-Object System.Windows.Forms.Form
$form.Text = 'AIOS Assistant'
$form.Width = 1100; $form.Height = 820
$form.StartPosition = 'Manual'; $form.Left = 110; $form.Top = 40
$form.BackColor = $BG

$head = New-Object System.Windows.Forms.Panel
$head.Dock = 'Top'; $head.Height = 58; $head.BackColor = $PANEL
$form.Controls.Add($head)

$titleLbl = New-Object System.Windows.Forms.Label
$titleLbl.Text = 'AIOS Assistant'
$titleLbl.ForeColor = $FG
$titleLbl.Font = 'Segoe UI Semibold, 13'
$titleLbl.AutoSize = $true
$titleLbl.Location = New-Object System.Drawing.Point(20, 10)
$head.Controls.Add($titleLbl)

$stateLbl = New-Object System.Windows.Forms.Label
$stateLbl.Text = 'connecting...'
$stateLbl.ForeColor = $MUTED
$stateLbl.Font = 'Segoe UI, 9'
$stateLbl.AutoSize = $true
$stateLbl.Location = New-Object System.Drawing.Point(20, 34)
$head.Controls.Add($stateLbl)

$capsLbl = New-Object System.Windows.Forms.Label
$capsLbl.ForeColor = $MUTED
$capsLbl.Font = 'Segoe UI, 9'
$capsLbl.AutoSize = $true
$capsLbl.Location = New-Object System.Drawing.Point(320, 20)
$head.Controls.Add($capsLbl)

# The handover banner. Hidden until a step is genuinely waiting on a human, then full width and
# impossible to miss. Its visibility is driven by the agent's own status events, never guessed.
$banner = New-Object System.Windows.Forms.Panel
$banner.Dock = 'Top'
$banner.Height = 44
$banner.BackColor = $DANGER
$banner.Visible = $false
$form.Controls.Add($banner)

$bannerLbl = New-Object System.Windows.Forms.Label
$bannerLbl.Dock = 'Fill'
$bannerLbl.TextAlign = 'MiddleCenter'
$bannerLbl.ForeColor = [System.Drawing.Color]::White
$bannerLbl.Font = 'Segoe UI Semibold, 11'
$banner.BackColor = $DANGER
$banner.Controls.Add($bannerLbl)

$chat = New-Object System.Windows.Forms.RichTextBox
$chat.Multiline = $true
$chat.ReadOnly = $true
$chat.BackColor = $BG
$chat.ForeColor = $FG
$chat.Font = 'Segoe UI, 10'
$chat.BorderStyle = 'None'
$chat.Dock = 'Fill'
$chat.WordWrap = $true
$chat.ScrollBars = 'Vertical'
$form.Controls.Add($chat)

$bottom = New-Object System.Windows.Forms.Panel
$bottom.Dock = 'Bottom'
$bottom.Height = 118
$bottom.BackColor = $PANEL
$form.Controls.Add($bottom)

$composer = New-Object System.Windows.Forms.TextBox
$composer.Multiline = $true
$composer.AcceptsReturn = $false
$composer.BackColor = $RAISED
$composer.ForeColor = $FG
$composer.BorderStyle = 'FixedSingle'
$composer.Font = 'Segoe UI, 10'
$composer.Dock = 'Top'
$composer.Height = 70
$bottom.Controls.Add($composer)

$btnRow = New-Object System.Windows.Forms.Panel
$btnRow.Dock = 'Bottom'
$btnRow.Height = 44
$btnRow.BackColor = $PANEL
$bottom.Controls.Add($btnRow)

$sendBtn = New-Object System.Windows.Forms.Button
$sendBtn.Text = 'Send'
$sendBtn.ForeColor = $FG
$sendBtn.BackColor = $ACCENT
$sendBtn.FlatStyle = 'Flat'
$sendBtn.Font = 'Segoe UI Semibold, 10'
$sendBtn.Size = New-Object System.Drawing.Size(96, 30)
$sendBtn.Location = New-Object System.Drawing.Point(960, 7)
$btnRow.Controls.Add($sendBtn)

$stopBtn = New-Object System.Windows.Forms.Button
$stopBtn.Text = 'Stop'
$stopBtn.ForeColor = $FG
$stopBtn.BackColor = $RAISED
$stopBtn.FlatStyle = 'Flat'
$stopBtn.Font = 'Segoe UI, 10'
$stopBtn.Size = New-Object System.Drawing.Size(80, 30)
$stopBtn.Location = New-Object System.Drawing.Point(866, 7)
$stopBtn.Enabled = $false
$btnRow.Controls.Add($stopBtn)

$hintLbl = New-Object System.Windows.Forms.Label
$hintLbl.Text = 'Enter sends   |   describe a goal in plain language'
$hintLbl.ForeColor = $MUTED
$hintLbl.Font = 'Segoe UI, 9'
$hintLbl.AutoSize = $true
$hintLbl.Location = New-Object System.Drawing.Point(12, 15)
$btnRow.Controls.Add($hintLbl)

# ---- state. Named so that no palette entry can ever be shadowed by a local.
$busy = $false
$seenIndex = 0

# ---- rendering
#
# THE COLOUR PARAMETER IS NOT TYPED, AND THAT IS THE POINT.
#
# It used to be typed as [System.Drawing.Color]$lineColor, which reads as safe and was not. A
# typed parameter does not convert an argument that was never supplied: calling
#
#     Append-Line ''                      # a blank separator line
#
# leaves $lineColor as $null, and "$chat.SelectionColor = $lineColor" THROWS
# ("Cannot convert null to type System.Drawing.Color"). Every blank separator line in this file
# is called that way.
#
# The blast radius was total and silent. In Show-Event the 'done' branch opened with
# Append-Line '', that threw, the enclosing catch swallowed it, and the very next line -
# Append-Line $evt.text - the assistant's actual reply - NEVER RAN. Measured on the live
# server: the model answered "Hi! How can I help you today?" and the window displayed nothing,
# because the line that would have displayed it was never reached.
#
# NOTE FOR ANYONE EDITING THIS FILE: the script below is a JavaScript template literal. A
# backtick anywhere in it ends the string. A comment explaining this bug once did exactly that,
# and the harness stopped loading with "Expected a semicolon" - a failure that pointed nowhere
# near the cause.
#
# A blank line has no colour to set, so a null colour now means "leave the styling alone"
# instead of "throw". The -is [string] guard is kept: a colour arriving as text still means two
# variables share a name, and that is worth failing loudly over.
function Append-Line([string]$lineText, $lineColor, $lineSize = 10, [switch]$bold) {
  if ($null -eq $lineText) { return }
  if ($lineColor -is [string]) {
    throw 'a colour parameter received text, which means two variables share a name'
  }
  $from = $chat.TextLength
  $chat.AppendText($lineText + [Environment]::NewLine)
  if ($null -ne $lineColor) {
    $size = 10
    if ($null -ne $lineSize) { $size = [int]$lineSize }
    $chat.Select($from, $chat.TextLength - $from)
    $chat.SelectionColor = $lineColor
    $style = if ($bold) { [System.Drawing.FontStyle]::Bold } else { [System.Drawing.FontStyle]::Regular }
    $chat.SelectionFont = New-Object System.Drawing.Font('Segoe UI', $size, $style)
  }
  $chat.Select($from, $chat.TextLength - $from)
  $chat.SelectionLength = 0
  $chat.SelectionStart = $chat.TextLength
  $chat.ScrollToCaret()
}

function Fetch-Text([string]$route) {
  try {
    $req = [System.Net.WebRequest]::Create($server + $route)
    $req.Headers.Add('Authorization', 'Bearer ' + $token)
    $resp = $req.GetResponse()
    $rd = New-Object System.IO.StreamReader($resp.GetResponseStream())
    $body = $rd.ReadToEnd()
    $rd.Close()
    $resp.Close()
    return $body
  } catch {
    return $null
  }
}

function Post-Text([string]$route, [string]$jsonBody) {
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($jsonBody)
    $req = [System.Net.WebRequest]::Create($server + $route)
    $req.Method = 'POST'
    $req.ContentType = 'application/json'
    $req.Headers.Add('Authorization', 'Bearer ' + $token)
    $req.ContentLength = $bytes.Length
    $stream = $req.GetRequestStream()
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Close()
    $resp = $req.GetResponse()
    $rd = New-Object System.IO.StreamReader($resp.GetResponseStream())
    $out = $rd.ReadToEnd()
    $rd.Close()
    $resp.Close()
    return $out
  } catch {
    return $null
  }
}

# ---- sending
function Send-Message {
  $goalText = ''
  try { $goalText = $composer.Text.Trim() } catch { $goalText = '' }
  if ($goalText.Length -eq 0) { return }
  if ($busy) { return }
  try { $composer.Clear() } catch { }

  $busy = $true
  $sendBtn.Enabled = $false
  $stopBtn.Enabled = $true
  $stateLbl.ForeColor = $ACCENT
  $stateLbl.Text = 'working...'

  try {
    Append-Line 'You' $MUTED 9 -bold
    Append-Line $goalText $FG 10
    Append-Line ''
  } catch {
    Note ('render of the user message failed: ' + $_.Exception.Message)
    $stateLbl.ForeColor = $DANGER
    $stateLbl.Text = 'render failed'
  }

  $reply = Post-Text '/message' (@{ text = $goalText } | ConvertTo-Json -Compress)
  if ($reply -eq $null) {
    $busy = $false
    $sendBtn.Enabled = $true
    $stopBtn.Enabled = $false
    $stateLbl.ForeColor = $DANGER
    $stateLbl.Text = 'idle'
    Append-Line 'The agent could not be reached. Check that it is still running.' $DANGER 9
  }
}

# ---- consuming agent events
function Show-Event($evt) {
  if ($evt -eq $null) { return }
  try {
    if ($evt.kind -eq 'status') {
      $stateLbl.ForeColor = $MUTED
      $stateLbl.Text = $evt.text
      # A step that is WAITING for the human is the single most important thing this window can
      # say, and it was previously a one-line grey status in the corner. A mission once waited the
      # full five minutes and gave up with the instruction to click RELEASE sitting in a corner
      # strip that nobody reads. The whole handover is now unmissable: a full-width banner, the
      # window title, and the banner stays up for as long as the wait lasts.
      if ($evt.text -and $evt.text.Contains('Click RELEASE')) {
        $banner.Visible = $true
        $bannerLbl.Text = 'WAITING FOR YOU  -  click RELEASE on the gold panel, then do not touch the machine'
        $form.Text = 'AIOS Assistant  ***  CLICK RELEASE ***'
        $stateLbl.ForeColor = $DANGER
        $stateLbl.Text = 'waiting for a human release'
      } elseif ($evt.text -and $evt.text.Contains('permitted')) {
        $banner.Visible = $false
        $form.Text = 'AIOS Assistant'
      }
    }
    elseif ($evt.kind -eq 'plan') {
      Append-Line 'Plan' $ACCENT 9 -bold
      foreach ($step in $evt.steps) {
        Append-Line ('  ' + $step.id + '  ' + $step.intent + '   [' + $step.tool + ']') $MUTED 9
      }
      Append-Line ''
    }
    elseif ($evt.kind -eq 'step-start') {
      $stateLbl.ForeColor = $ACCENT
      $stateLbl.Text = 'running'
      Append-Line ('> ' + $evt.intent) $FG 10
    }
    elseif ($evt.kind -eq 'step-result') {
      if ($evt.verified) {
        Append-Line ('   verified - ' + $evt.summary) $ACCENT 9
      } else {
        Append-Line ('   NOT VERIFIED - ' + $evt.summary) $DANGER 9
      }
    }
    elseif ($evt.kind -eq 'approval-required') {
      Append-Line ('Approval needed: ' + $evt.reason) $DANGER 10 -bold
    }
    elseif ($evt.kind -eq 'error') {
      Append-Line ('Error: ' + $evt.text) $DANGER 9
    }
    elseif ($evt.kind -eq 'done') {
      Append-Line ''
      if ($evt.ok) {
        Append-Line $evt.text $ACCENT 10 -bold
      } else {
        Append-Line $evt.text $DANGER 10 -bold
      }
      Append-Line ''
      $busy = $false
      $sendBtn.Enabled = $true
      $stopBtn.Enabled = $false
      $stateLbl.ForeColor = $MUTED
      $stateLbl.Text = 'idle'
    }
  } catch {
    Note ('render of an event failed: ' + $_.Exception.Message)
  }
}

# Polls the agent's event buffer rather than holding an event stream open.
#
# An open stream read on the UI thread freezes the form. The replacement runspace block created a
# runspace, attached nothing, and discarded the result, so no event ever arrived and the window
# went silent after showing "You". Polling an indexed buffer cannot freeze anything, and if the
# agent is down the state line says so instead of pretending everything is fine.
function Poll-Agent {
  $raw = Fetch-Text ('/progress?since=' + $global:seenIndex)
  if ($raw -eq $null) {
    $stateLbl.ForeColor = $DANGER
    $stateLbl.Text = 'cannot reach the agent'
    return
  }
  try {
    $parsed = $raw | ConvertFrom-Json
  } catch {
    return
  }
  $shown = 0
  foreach ($evt in $parsed.events) {
    Show-Event $evt
    $shown++
  }
  # Global scope, or the assignment creates a function-local copy, the cursor never advances,
  # and every tick re-renders the entire history - which is what happened, producing the same
  # plan and the same verified line dozens of times.
  $global:seenIndex = $parsed.total
  if ($shown -gt 0) {
    Note ('rendered ' + $shown + ' event(s); the chat is now ' + $chat.TextLength + ' characters')
  }
  if ($parsed.total -eq 0 -and -not $busy) {
    $stateLbl.ForeColor = $MUTED
    $stateLbl.Text = 'idle'
  }
}

# ---- handlers. add_X to subscribe, param block to bind.
$sendBtn.add_Click({ Send-Message })
$stopBtn.add_Click({ try { $stopBtn.Enabled = $false } catch { } })
$composer.add_KeyDown({
  param($sender, $e)
  try {
    if ($e -ne $null -and $e.KeyCode -eq [System.Windows.Forms.Keys]::Enter -and -not $e.Shift) {
      $e.SuppressKeyPress = $true
      Send-Message
    }
  } catch {
    Note ('the Enter handler failed: ' + $_.Exception.Message)
  }
})

# Global scope on purpose: a timer in a local dies with the scope and takes its handler silently.
$global:aiosTimer = New-Object System.Windows.Forms.Timer
$global:aiosTimer.Interval = 600
$global:aiosTimer.add_Tick({
  param($tickSender, $tickArgs)
  try {
    Poll-Agent
  } catch {
    Note ('the poll tick failed: ' + $_.Exception.Message)
  }
})
$global:aiosTimer.Start()

$form.add_FormClosed({ try { $global:aiosTimer.Stop(); $global:aiosTimer.Dispose() } catch { } })

[System.Windows.Forms.Application]::add_ThreadException({
  param($sender, $e)
  Note ('unhandled interface error: ' + $e.Exception.Message)
  try {
    Append-Line ('Recovered from an interface error: ' + $e.Exception.Message) $DANGER 9
    $busy = $false
    $sendBtn.Enabled = $true
    $stopBtn.Enabled = $false
    $stateLbl.ForeColor = $DANGER
    $stateLbl.Text = 'recovered from an error'
  } catch { }
})

$form.add_Shown({
  $body = Fetch-Text '/capabilities'
  if ($body -ne $null) {
    try {
      $info = $body | ConvertFrom-Json
      $usable = @($info.capabilities | Where-Object { $_.available }).Count
      $all = @($info.capabilities).Count
      $perm = $info.permission
      $capsLbl.Text = ('capabilities ' + $usable + '/' + $all + '    guard: ' + $perm.control + ', input ' + $perm.input)
      if ($perm.input -ne 'PERMITTED') { $capsLbl.ForeColor = $DANGER }
      Append-Line 'AIOS Assistant' $ACCENT 14 -bold
      Append-Line 'Describe a task in plain language. AIOS works out which capabilities to use, runs them, and verifies the result before it reports it.' $MUTED 9
      Append-Line ''
      $why = ''
      if ($perm.blockedBy) { $why = '   (' + $perm.blockedBy + ')' }
      $guardLine = 'Guard: ' + $perm.control + '   input: ' + $perm.input + $why
      if ($perm.input -eq 'PERMITTED') {
        Append-Line $guardLine $ACCENT 9
      } else {
        Append-Line $guardLine $DANGER 9
        Append-Line 'Desktop control is unavailable until you release the guard. Everything else works.' $MUTED 9
      }
      Append-Line ''
    } catch {
      Note ('reading capabilities failed: ' + $_.Exception.Message)
    }
  } else {
    $stateLbl.ForeColor = $DANGER
    $stateLbl.Text = 'the agent did not answer'
  }
  $stateLbl.Text = 'idle'
  Note 'window ready; timer started'
})

[void]$form.ShowDialog()
`

// ===========================================================================================

const SERVER_FILE = join(homedir(), '.aios', 'agent', 'server.json')

async function readServerFile(port: number): Promise<{ port: number; token: string } | null> {
  try {
    if (!existsSync(SERVER_FILE)) return null
    const { readFileSync } = await import('node:fs')
    const s = JSON.parse(readFileSync(SERVER_FILE, 'utf8')) as { port: number; token: string }
    if (s.port !== port) return null
    const r = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { Authorization: `Bearer ${s.token}` }, signal: AbortSignal.timeout(1500),
    })
    return r.ok ? s : null
  } catch { return null }
}

/** Start the agent server, or reuse one that is already listening. */
export async function startServer(port = 8777): Promise<{ base: string; token: string; child: ChildProcess | null }> {
  const base = `http://127.0.0.1:${port}`
  const existing = await readServerFile(port)
  if (existing) return { base, token: existing.token, child: null }

  const child = spawn(process.execPath, [
    '--experimental-strip-types', '--no-warnings', join(HERE, 'agent', 'chat-server.ts'),
  ], { stdio: 'ignore', windowsHide: true })

  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500))
    const s = await readServerFile(port)
    if (s) return { base, token: s.token, child }
  }
  child.kill()
  throw new Error('the AIOS agent server did not start')
}

function findPS(): string {
  const candidates = [
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
  ]
  for (const c of candidates) if (existsSync(c)) return c
  return candidates[0]!
}

async function main(): Promise<void> {
  const { base, token } = await startServer()
  console.log('AIOS Assistant')
  console.log('===============')
  console.log(`  agent   ${base}`)

  // The interface is now the HTML one served from this same server, opened by the launcher in
  // browser app mode. The WinForms window is NOT spawned by default: leaving it on would open
  // two windows at once, and the old one is the thing that was replaced.
  //
  // It is still here and still reachable, deliberately. It is the rollback path - if the HTML
  // interface cannot be fixed, `AIOS_LEGACY_WINDOW=1` brings back the previous behaviour with no
  // code change and nothing deleted. Removing the only working fallback to make the new thing
  // look tidier would be the wrong trade.
  if (process.env.AIOS_LEGACY_WINDOW !== '1') {
    console.log(`  ui      ${base}/ui`)
    console.log('  window  not spawned (the launcher opens the interface)')
    // Stay alive: the agent server is this process's job, and the UI is a client of it.
    await new Promise<void>(() => {})
  }

  console.log('  window  launching (legacy WinForms)')
  const scriptPath = join(mkdtempSync(join(tmpdir(), 'aios-chat-ui-')), 'window.ps1')
  writeFileSync(scriptPath, WINDOW_SCRIPT, 'utf8')

  const uiLog = join(homedir(), '.aios', 'agent', 'window.log')
  const { appendFileSync } = await import('node:fs')
  const ps = spawn(findPS(), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-File', scriptPath, base, token], {
    // Errors are captured, never discarded: a window that refuses to open must fail loudly.
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
  })
  const capture = (chunk: Buffer, tag: string): void => {
    try { appendFileSync(uiLog, `[${tag}] ${chunk.toString('utf8')}\n`, 'utf8') } catch { /* nothing else to do */ }
  }
  ps.stdout?.on('data', (c: Buffer) => capture(c, 'out'))
  ps.stderr?.on('data', (c: Buffer) => capture(c, 'err'))
  ps.on('exit', (code) => {
    try { appendFileSync(uiLog, `[exit] window process ended with ${code}\n`, 'utf8') } catch { /* ignore */ }
    console.log(`  the window closed (exit ${code ?? 0}); see ${uiLog}`)
    process.exit(code ?? 0)
  })
}

function isEntryPoint(): boolean {
  const invoked = process.argv[1]
  if (!invoked) return false
  return resolve(invoked) === fileURLToPath(import.meta.url)
}

if (isEntryPoint()) await main()