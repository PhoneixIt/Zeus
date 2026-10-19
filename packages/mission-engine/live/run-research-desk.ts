/**
 * THE RESEARCH DESK - launcher.
 *
 * ONE COMMAND, and it puts a window on the desktop:
 *
 *     node --experimental-strip-types --no-warnings \
 *          packages/mission-engine/live/run-research-desk.ts
 *
 * `run-research-desk.ts` builds a small WinForms application on the fly and launches it in a
 * child process. The window is the interface: a URL box, a Research button, a live log, and a
 * results table. It drives `research-app.ts` for every run and shows the verdict.
 *
 * Why a child process rather than a window in this one: the engine kills a browser and holds
 * file handles, and a crash in it must not take the interface down with it. The window talks to
 * the engine over a line of JSON, so the two can be restarted independently.
 *
 * A `--headless-check` flag runs one engine call with no window, so the engine can be verified
 * in CI without a desktop session.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))

/** Durable state, shared with the engine. */
export const RESEARCH_ROOT = join(homedir(), '.aios', 'research')

const CHROME_CANDIDATES = [
  process.env.AIOS_CHROME,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter((x): x is string => typeof x === 'string' && x.length > 0)

export function findChrome(): string | undefined {
  return CHROME_CANDIDATES.find((c) => existsSync(c))
}

/**
 * The window script.
 *
 * Written as PowerShell + Add-Type rather than a compiled EXE for the same reason the operator
 * host is: Windows Application Control blocks freshly built executables on this machine, and
 * that policy is a deliberate security control rather than something to work around. Running
 * real WinForms inside the already-trusted powershell.exe satisfies it instead of evading it.
 */
export const WINDOW_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$root = '__ROOT__'
$engine = '__ENGINE__'
$chrome = '__CHROME__'
# URL to research at startup. Empty by default (normal use: a human types it and clicks
# Research). Set by passing a URL on the command line so the window itself can drive the run
# through the same Invoke-Research function the button uses.
# NOTE: no backticks anywhere in this comment block - this text lives inside a JS template
# literal and a backtick here silently terminates it, turning the rest of the window script
# into TypeScript syntax errors.
$autoUrl = '__AUTOURL__'
# The multi-page mission, run out of process so a browser it launches cannot take the window
# down with it. Same split the single-page engine already uses.
$briefEngine = '__BRIEFENGINE__'
# Set when the desk was started with --brief, so the window runs the multi-page mission at
# startup instead of the single-page one. Same reasoning as the URL auto-run: it lets the window
# exercise the mission through its own code path without anyone having to click.
$autoBrief = '__AUTOBRIEF__'

$form = New-Object System.Windows.Forms.Form
$form.Text = 'AIOS Research Desk'
$form.Width = 1000; $form.Height = 720
$form.StartPosition = 'Manual'; $form.Left = 90; $form.Top = 70
$form.BackColor = [System.Drawing.Color]::FromArgb(24, 26, 31)

$lbl = New-Object System.Windows.Forms.Label
$lbl.Text = 'Research a public HTTPS page'
$lbl.ForeColor = [System.Drawing.Color]::Gainsboro
$lbl.Font = 'Segoe UI, 11'
$lbl.AutoSize = $true
$form.Controls.Add($lbl)

$box = New-Object System.Windows.Forms.TextBox
$box.Text = 'https://www.iana.org/help/example-domains'
$box.Font = 'Consolas, 10'
$box.ForeColor = [System.Drawing.Color]::White
$box.BackColor = [System.Drawing.Color]::FromArgb(40, 43, 50)
$box.Dock = 'Top'; $box.Height = 28
$form.Controls.Add($box)

$btn = New-Object System.Windows.Forms.Button
$btn.Text = 'Research'
$btn.Font = 'Segoe UI, 10'
$btn.ForeColor = [System.Drawing.Color]::White
$btn.BackColor = [System.Drawing.Color]::FromArgb(0, 122, 204)
$btn.FlatStyle = 'Flat'; $btn.Dock = 'Top'; $btn.Height = 32
$form.Controls.Add($btn)

# ---------------------------------------------------------------------------------------------
# COMPANY BRIEF - a multi-page, evidence-backed mission, not a single page fetch.
#
# The "Research" button above answers "what is on this page". This answers "what does this
# company sell, and who is it for", which needs several pages, a bounded link policy, and a
# report whose every statement points at a stored quote. It shells out to the same mission the
# command line runs, so the window cannot drift into behaving differently from the documented
# command.
# ---------------------------------------------------------------------------------------------

$objLabel = New-Object System.Windows.Forms.Label
$objLabel.Text = 'Company brief - objective'
$objLabel.ForeColor = [System.Drawing.Color]::SteelBlue
$objLabel.Font = 'Segoe UI, 11'
$objLabel.AutoSize = $true
$objLabel.Dock = 'Top'
$objLabel.Height = 22
$form.Controls.Add($objLabel)

$objBox = New-Object System.Windows.Forms.TextBox
$objBox.Text = '__AUTOOBJECTIVE__'
if ($objBox.Text.Trim().Length -eq 0) { $objBox.Text = 'What does this company sell, and who is it for?' }
$objBox.Font = 'Consolas, 10'
$objBox.ForeColor = [System.Drawing.Color]::White
$objBox.BackColor = [System.Drawing.Color]::FromArgb(40, 43, 50)
$objBox.Dock = 'Top'; $objBox.Height = 28
$form.Controls.Add($objBox)

$briefBtn = New-Object System.Windows.Forms.Button
$briefBtn.Text = 'Build company brief (multi-page)'
$briefBtn.Font = 'Segoe UI, 10'
$briefBtn.ForeColor = [System.Drawing.Color]::White
$briefBtn.BackColor = [System.Drawing.Color]::FromArgb(20, 110, 70)
$briefBtn.FlatStyle = 'Flat'; $briefBtn.Dock = 'Top'; $briefBtn.Height = 32
$form.Controls.Add($briefBtn)

# SAVED BRIEFS, read from disk on startup like the run history above, so a brief produced by an
# earlier process is visible from a later one.
$briefBox = New-Object System.Windows.Forms.ListBox
$briefBox.Font = 'Consolas, 9'
$briefBox.ForeColor = [System.Drawing.Color]::Gainsboro
$briefBox.BackColor = [System.Drawing.Color]::FromArgb(28, 30, 36)
$briefBox.Dock = 'Bottom'
$briefBox.Height = 150
$form.Controls.Add($briefBox)

$briefLabel = New-Object System.Windows.Forms.Label
$briefLabel.Text = 'Saved company briefs (read from durable state)'
$briefLabel.ForeColor = [System.Drawing.Color]::SteelBlue
$briefLabel.Font = 'Segoe UI, 9'
$briefLabel.Dock = 'Bottom'
$briefLabel.Height = 20
$form.Controls.Add($briefLabel)

$log = New-Object System.Windows.Forms.TextBox
$log.Multiline = $true; $log.ReadOnly = $true
$log.Font = 'Consolas, 9'
$log.ForeColor = [System.Drawing.Color]::Gainsboro
$log.BackColor = [System.Drawing.Color]::FromArgb(18, 19, 23)
$log.Dock = 'Fill'
$form.Controls.Add($log)

# PREVIOUS RUNS. Populated from the durable history file on startup, so results survive a
# restart of this application. Without this the window could only ever show work done in the
# current session, which would make the app look like it had forgotten everything it had
# already learned - the exact "in-memory result that disappears when the process exits"
# failure the project treats as disqualifying.
$historyBox = New-Object System.Windows.Forms.ListBox
$historyBox.Font = 'Consolas, 9'
$historyBox.ForeColor = [System.Drawing.Color]::Gainsboro
$historyBox.BackColor = [System.Drawing.Color]::FromArgb(28, 30, 36)
$historyBox.Dock = 'Bottom'
$historyBox.Height = 170
$form.Controls.Add($historyBox)

$historyLabel = New-Object System.Windows.Forms.Label
$historyLabel.Text = 'Previous runs (read from durable history)'
$historyLabel.ForeColor = [System.Drawing.Color]::SteelBlue
$historyLabel.Font = 'Segoe UI, 9'
$historyLabel.Dock = 'Bottom'
$historyLabel.Height = 20
$form.Controls.Add($historyLabel)

function LoadHistory {
  $historyBox.Items.Clear()
  $file = Join-Path $root 'history.jsonl'
  if (-not (Test-Path $file)) { $historyBox.Items.Add('(no runs recorded yet)'); return 0 }
  $n = 0
  foreach ($line in (Get-Content $file)) {
    if ($line.Trim().Length -eq 0) { continue }
    try {
      $e = $line | ConvertFrom-Json
      $mark = if ($e.verified) { 'VERIFIED' } else { 'UNVERIFIED' }
      $scrolled = if ($e.interaction -and $e.interaction.scrolled) { 'scroll' } else { '      ' }
      $clicked = if ($e.interaction -and $e.interaction.clickedHref) { 'click' } else { '     ' }
      $backed  = if ($e.interaction -and $e.interaction.wentBack) { 'back' } else { '    ' }
      # [void] on every Add(). ListBox.Items.Add() RETURNS THE ITEM INDEX, so without it the
      # 0,1,2,3,... came out as the function's return value and the window reported
      # "Loaded 0 1 2 3 4 previous run(s)" instead of a count. A control that misreports its own
      # numbers is worse than one that shows nothing.
      [void]$historyBox.Items.Add(('{0}  {1,-11} {2} {3} {4} {5,3}el {6,2}fnd  {7}' -f $e.correlationId.Substring(0,8), $mark, $scrolled, $clicked, $backed, $e.elements, $e.findings, $e.title))
      $n++
    } catch { }
  }
  if ($n -eq 0) { $historyBox.Items.Add('(no runs recorded yet)') }
  return $n
}

function Say($m) { $log.AppendText($m + [Environment]::NewLine) }

# Saved briefs, read from the durable briefs directory. Same purpose as LoadHistory: state that
# outlives the process must be visible from any later process.
function LoadBriefs {
  $briefBox.Items.Clear()
  $dir = Join-Path $root 'briefs'
  if (-not (Test-Path $dir)) { [void]$briefBox.Items.Add('(no briefs yet)'); return 0 }
  $n = 0
  foreach ($f in (Get-ChildItem $dir -Filter *.brief.json -EA SilentlyContinue | Sort-Object Name)) {
    try {
      $b = Get-Content $f.FullName -Raw | ConvertFrom-Json
      $fact = @($b.claims | Where-Object { $_.kind -eq 'quoted-fact' }).Count
      $der = @($b.claims | Where-Object { $_.kind -eq 'rule-derived' }).Count
      $line = ('{0}  {1,-8} {2,2} src  {3,4} fact {4,2} unproven  {5}' -f $b.correlationId.Substring(0,8), $b.terminalState, @($b.sources).Count, $fact, $der, $b.objective)
      [void]$briefBox.Items.Add($line)
      $n++
    } catch { }
  }
  if ($n -eq 0) { [void]$briefBox.Items.Add('(no briefs yet)') }
  return $n
}

# Run the multi-page mission and render its verdict. The mission prints one line of JSON; the
# window shows what the MISSION said, not what the window believes, and then re-reads the saved
# briefs from disk so what is displayed is the persisted state.
function Invoke-Brief($objective, $url) {
  if ([string]::IsNullOrWhiteSpace($url)) { Say('    enter a starting URL first'); return }
  $briefBtn.Enabled = $false
  $briefBtn.Text = 'Running... (bounded, no model)'
  $box.Enabled = $false
  $objBox.Enabled = $false
  Say('')
  Say('=== COMPANY BRIEF: ' + $objective)
  Say('    start   ' + $url)
  Say('    mode    deterministic-extraction  (no model, no API key, $0)')
  try {
    $out = & node --experimental-strip-types --no-warnings $briefEngine --url $url --objective $objective --json 2>&1 | Out-String
    $line = ($out -split "\r?\n" | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -Last 1)
    if (-not $line) {
      Say('    FAILED: the mission produced no verdict line')
      Say('    ' + ($out.Trim() -replace '[\r\n]+', ' | '))
      return
    }
    $r = $line | ConvertFrom-Json
    Say('    ' + $r.stage.ToUpper() + '  ' + $r.terminalReason)
    Say('    correlation ' + $r.correlationId)
    Say('')
    Say('    SOURCES (' + @($r.sources).Count + ')')
    foreach ($s in $r.sources) {
      Say('      ' + $s.id + '  ' + $s.title)
      Say('          ' + $s.url)
      Say('          ' + $s.elements + ' elements, ' + $s.findings + ' finding(s)  [' + $s.selectedReason + ']')
    }
    Say('    CLAIMS  ' + $r.traceableClaims + ' quoted fact(s) traceable to a stored source')
    Say('            ' + $r.derivedClaims + ' rule-derived statement(s) NOT automatically verifiable')
    Say('')
    Say('    REPORT (as rendered by the mission, not re-summarised by this window)')
    foreach ($line in $r.report) { Say('    ' + $line) }
    if (@($r.warnings).Count -gt 0) {
      Say('')
      Say('    WARNINGS (' + @($r.warnings).Count + ')')
      foreach ($wn in $r.warnings) { Say('      ! ' + $wn) }
    }
    Say('')
    Say('    brief   ' + $r.briefPath)
    [void](LoadBriefs)
  } catch {
    Say('    FAILED: ' + $_.Exception.Message)
  } finally {
    $briefBtn.Enabled = $true
    $briefBtn.Text = 'Build company brief (multi-page)'
    $box.Enabled = $true
    $objBox.Enabled = $true
  }
}

$briefBtn.Add_Click({ Invoke-Brief $objBox.Text.Trim() $box.Text.Trim() })

# The body of the button handler, factored out into a function so that the window and the
# button drive exactly the same code path. Previously this logic lived only inside the click
# delegate, which meant the ONLY way to exercise the window's run path was for a human to
# physically click - and an automated check could never reach it.
function Invoke-Research($url) {
  if ([string]::IsNullOrWhiteSpace($url)) { Say('    enter a URL first'); return }
  $btn.Enabled = $false
  $box.Enabled = $false
  Say('--> researching ' + $url)
  try {
    $out = & node --experimental-strip-types --no-warnings $engine --json $url 2>&1 | Out-String
    foreach ($line in ($out -split "\r?\n")) {
      if ($line.Trim().Length -gt 0) { Say('    ' + $line.Trim()) }
    }
    Say('--> done. artifacts and history in ' + $root)
    [void](LoadHistory)
  } catch {
    Say('    FAILED: ' + $_.Exception.Message)
  } finally {
    $btn.Enabled = $true
    $box.Enabled = $true
  }
}

$btn.Add_Click({ Invoke-Research $box.Text.Trim() })

# add_Shown, not .Shown. In PowerShell, reading $form.Shown evaluates to the current event
# delegate, which is null until something subscribes - so calling .Add() on it throws
# "You cannot call a method on a null-valued expression" and the window never opens. The
# add_ prefix is the accessor that subscribes, and it is the only form that works here.
$form.add_Shown({
  $count = LoadHistory
  $bcount = LoadBriefs
  Say('AIOS Research Desk ready.')
  Say('engine : ' + $engine)
  Say('briefs : ' + $briefEngine)
  Say('browser: ' + $chrome)
  Say('state  : ' + $root)
  Say('')
  Say('Loaded ' + $count + ' previous run(s) and ' + $bcount + ' saved brief(s) from durable history.')
  Say('Those runs happened in EARLIER processes. They survived because they were written to disk.')
  if ($autoUrl -ne '') {
    Say('')
    Say('auto-run URL: ' + $autoUrl)
    $box.Text = $autoUrl
    if ($autoBrief -eq 'true') { Invoke-Brief $objBox.Text.Trim() $autoUrl } else { Invoke-Research $autoUrl }
  }
})
[void]$form.ShowDialog()
`

async function main(): Promise<void> {
  const chrome = findChrome()
  if (!chrome) {
    console.log('No Chrome or Edge binary found. Set AIOS_CHROME to one.')
    process.exit(2)
  }
  mkdirSync(RESEARCH_ROOT, { recursive: true })

  if (process.argv.includes('--headless-check')) {
    // No window. Used to verify the engine where there is no desktop session.
    // The window shells out to this engine, so importing it here must NOT launch another engine.
  // Without the flag, importing `findChrome` would start a run inside the window's own process.
  const engine = spawn(process.execPath, [
    '--experimental-strip-types', '--no-warnings',
    join(HERE, 'research-engine.ts'), '--json', ...process.argv.slice(2).filter((a) => a !== '--headless-check'),
  ], { stdio: 'inherit', env: { ...process.env, AIOS_ENGINE_CHILD: '1' } })
    process.exit((await new Promise<number>((r) => engine.on('exit', (c) => r(c ?? 1)))))
  }

  const scriptPath = join(RESEARCH_ROOT, 'research-desk.ps1')
  const enginePath = join(HERE, 'research-engine.ts')
  const briefEnginePath = join(HERE, 'run-company-brief.ts')
  const ps = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

  const { writeFileSync } = await import('node:fs')
  // Escape single quotes the PowerShell way (doubled), not the JS way, or a URL containing an
  // apostrophe would terminate the quoted string and the window would fail to launch.
  const argv = process.argv.slice(2)

  // A shell (PowerShell in particular) will split an argument that contains spaces unless it is
  // quoted, and the quotes may or may not survive to arrive here. The first version of this code
  // took "every argument that is not a flag" as the URL, so a multi-word objective leaked into
  // the URL and the mission was handed "does Nakivo sell, and who is it for? https://..." - which
  // it correctly REFUSED as not a URL. Refusing was right; being handed that at all was not.
  //
  // So: the objective is taken from --objective=X or from the token AFTER --objective, and the
  // URL is the first token that actually looks like an https URL. Everything else is ignored.
  const unquote = (s: string): string => {
    const t = s.trim()
    if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
      return t.slice(1, -1)
    }
    return t
  }
  let autoObjective = ''
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--objective=')) autoObjective = unquote(a.slice('--objective='.length))
    else if (a === '--objective' && i + 1 < argv.length) autoObjective = unquote(argv[++i])
  }
  const autoUrl = (argv.find((a) => a.startsWith('https://')) ?? '').trim()
  const autoBrief = argv.includes('--brief') ? 'true' : 'false'
  // PowerShell single-quotes are escaped by doubling; a stray apostrophe in an objective would
  // otherwise terminate the quoted string and the window would fail to launch.
  const psQuote = (s: string): string => s.replace(/'/g, "''")
  writeFileSync(
    scriptPath,
    WINDOW_SCRIPT
      .replace('__ROOT__', RESEARCH_ROOT)
      .replace('__ENGINE__', enginePath)
      .replace('__CHROME__', chrome)
      .replace('__AUTOURL__', psQuote(autoUrl))
      .replace('__BRIEFENGINE__', briefEnginePath)
      .replace('__AUTOBRIEF__', autoBrief)
      .replace('__AUTOOBJECTIVE__', psQuote(autoObjective)),
    'utf8',
  )

  console.log('AIOS Research Desk')
  console.log('==================')
  console.log(`  window   launching (PowerShell WinForms)`)
  console.log(`  engine   ${enginePath}`)
  console.log(`  browser  ${chrome} (headless, private profile)`)
  console.log(`  state    ${RESEARCH_ROOT}`)
  console.log('')
  console.log('  Close the window to exit.')

  const win = spawn(ps, ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
    stdio: 'ignore',
    windowsHide: false,
  })
  process.exit((await new Promise<number>((r) => win.on('exit', (c) => r(c ?? 0)))))
}

/**
 * Am I the process the person actually ran?
 *
 * This is NOT `import.meta.url.endsWith(<my name>)`. That check is true when the module is
 * merely IMPORTED, because a module's `import.meta.url` is always its own address - so the
 * engine importing `findChrome` from here would have launched a window and a whole second
 * research run inside its own process. Comparing against `process.argv[1]`, the file the
 * process was actually started with, is the only version of this question that means anything.
 */
function isEntryPoint(): boolean {
  const invoked = process.argv[1]
  if (!invoked) return false
  return resolve(invoked) === fileURLToPath(import.meta.url)
}

if (isEntryPoint()) await main()