# AIOS Assistant launcher.
#
# WHY THIS SCRIPT CHANGED (2026-10-15) - the Media Player defect
# --------------------------------------------------------------
# It previously ran the harness with PowerShell's call operator:
#
#     $cmd = "& 'C:\...\run-aios-chat.ts' 60599 562e768442e645a8879a3af3"
#
# PowerShell cannot execute a `.ts` file. Given one, it hands the path to the Windows shell,
# which resolves it through the file association - and on this machine
#
#     > cmd /c assoc .ts
#     .ts=WMP11.AssocFile.TTS
#
# `.ts` is Windows Media Player's MPEG transport-stream type. So double-clicking the desktop
# shortcut opened Media Player and AIOS never started, with the failure hidden because the
# PowerShell carrying it was launched with -WindowStyle Hidden. Every other harness in
# package.json already goes through `node --experimental-strip-types`; this one did not.
#
# WHY THIS SCRIPT CHANGED (2026-10-15, later) - the interface
# -----------------------------------------------------------
# The WinForms window was replaced by an HTML interface served from the chat server on
# 127.0.0.1, opened in browser APP MODE. App mode means a standalone window: no tabs, no
# address bar, no browser chrome. It still looks and behaves like the desktop app it always was.
#
# This is still entirely local. The page, the script and the stylesheet all come out of this
# repository over loopback; nothing is fetched from the internet, and no billable model is ever
# offered. Edge is already installed, so this adds no dependency.
#
# The console stays hidden, as before, but its output is kept so a failure is no longer
# invisible:  %USERPROFILE%\.aios\agent\launcher.log

$ErrorActionPreference = 'Stop'

$repo    = Split-Path -Parent $MyInvocation.MyCommand.Path
$harness = Join-Path $repo 'packages\mission-engine\live\run-aios-chat.ts'
$logDir  = Join-Path $env:USERPROFILE '.aios\agent'
$log     = Join-Path $logDir 'launcher.log'

function Fail([string]$why) {
  try { New-Item -ItemType Directory -Force -Path $logDir | Out-Null
        ("[{0}] FAILED: {1}" -f (Get-Date -Format o), $why) | Out-File -Append -FilePath $log } catch { }
  try { Add-Type -AssemblyName System.Windows.Forms
        [void][System.Windows.Forms.MessageBox]::Show(
          "AIOS Assistant could not start.`r`n`r`n$why`r`n`r`nSee: $log", 'AIOS Assistant') } catch { }
  exit 1
}

if (-not (Test-Path -LiteralPath $harness)) { Fail "harness not found:`r`n$harness" }

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Fail 'node was not found on PATH.' }

# ---- make sure the operator host is up, with a CLEAN guard.
#
# The guard lives inside the operator host process. If that process has been running for hours
# it can be holding a latched emergency stop, and then every desktop action is refused with
# "EMERGENCY_STOP latched; an explicit re-arm is required" - which reads exactly like a broken
# product and is not one. That happened for real: a latch left by an earlier test blocked all
# desktop input until the host was restarted.
#
# Starting the host is not bypassing anything: the guard IS this process, and a fresh one starts
# from a clean state. It is what happens on every cold start of the app.

$hostFile = Join-Path $repo 'packages\control-core\host.json'
function Test-OperatorHost {
  if (-not (Test-Path -LiteralPath $hostFile)) { return $false }
  try {
    $hs = Get-Content $hostFile -Raw | ConvertFrom-Json
    if (-not $hs.port) { return $false }
    $r = Invoke-RestMethod ("http://127.0.0.1:{0}/guard" -f $hs.port) -TimeoutSec 3
    return [bool]$r
  } catch { return $false }
}

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

# THE GOLD OVERLAY IS OFF BY DEFAULT.
#
# The operator host draws a small panel in the top-right corner reporting the guard's state. It
# was read every day on top of the user's screen, including on days when nothing was paused and
# input was permitted, and it was asked to stop. So it is suppressed unless this variable says
# otherwise.
#
# This hides a DIAGNOSTIC SURFACE and nothing else. The guard itself, the takeover detection, the
# emergency stop and the indicator's data all keep running, and the interface still surfaces the
# state the moment it actually blocks something - which is the only time a person needed to see it
# unmissable. Set AIOS_INDICATOR=1 before launching to get the panel back.
if ([string]::IsNullOrWhiteSpace($env:AIOS_INDICATOR)) { $env:AIOS_INDICATOR = '0' }

if (Test-OperatorHost) {
  ("[{0}] operator host already answering" -f (Get-Date -Format o)) | Out-File -Append -FilePath $log
} else {
  ("[{0}] operator host not answering; starting a clean one" -f (Get-Date -Format o)) |
    Out-File -Append -FilePath $log
  try {
    & $node (Join-Path $repo 'packages\control-core\start-operator-host.mjs') 2>&1 |
      Out-File -Append -FilePath $log
    Start-Sleep -Seconds 3

    # The operator host runs out of %TEMP%\opencode\operator, NOT out of the repository.
    # packages/control-core/host.json is only a MIRROR. That is why capture-helper.ps1 lived
    # in the repo but was missing where it was actually needed, and every /screen.png and
    # /panelgrid call failed - two milestones of "the capture endpoint does not respond" with
    # no idea why. The helper is read from the RUNTIME directory, so it must be put there.
    $runtime = Join-Path $env:TEMP 'opencode\operator'
    if (Test-Path -LiteralPath $runtime) {
      Copy-Item (Join-Path $repo 'packages\control-core\capture-helper.ps1') -Destination $runtime -Force
      ("[{0}] capture-helper.ps1 installed into the runtime directory" -f (Get-Date -Format o)) |
        Out-File -Append -FilePath $log
    } else {
      ("[{0}] WARNING: runtime directory {1} not found; screen capture will fail" -f (Get-Date -Format o), $runtime) |
        Out-File -Append -FilePath $log
    }
  } catch {
    ("[{0}] the operator host could not be started: {1}" -f (Get-Date -Format o), $_.Exception.Message) |
      Out-File -Append -FilePath $log
  }
}

("--- launcher run {0} ---`r`nnode {1}`r`nharness {2}" -f (Get-Date -Format o), $node, $harness) |
  Out-File -Append -FilePath $log

# A PREVIOUS server.json IS NOT EVIDENCE ABOUT THIS PROCESS.
#
# Measured on this machine: launcher runs at 03:42 and 10:37 each started a chat server that died
# instantly with `listen EADDRINUSE 127.0.0.1:8777`, because a server from the previous day still
# held the port. The readiness loop below then polled `/health`, the STALE server answered `ok`,
# and the launcher reported success and opened the interface - onto a process running the previous
# day's code. That is how a chat server from 20:48 the night before survived every restart, and why
# `fetch failed` kept happening while the launcher log said everything was fine.
#
# So the stale file is removed BEFORE the new process starts. It is evidence about a process that
# may no longer exist; leaving it in place lets it vouch for a different process.
$serverFile = Join-Path $logDir 'server.json'
Remove-Item -LiteralPath $serverFile -Force -ErrorAction SilentlyContinue

# ---- RECOVER A STALE SERVER, rather than only reporting one.
#
# Observed on this machine, 2026-10-19 12:25. A server left over from a test run held 8777, this
# launcher started a second one, and it died with EADDRINUSE. The readiness check below reported
# that honestly instead of opening onto the wrong process - correct, and also useless to a person
# holding a launcher that says the agent stopped. They cannot tell what to do about it, and the
# obvious action ("click it again") reproduces the failure exactly.
#
# So the stale holder is identified PRECISELY and ended, rather than the port being left to chance.
# "Precisely" matters: this ends a process only when every one of these is true.
#
#   1. It holds THIS launcher's port.
#   2. Its command line is this repository's own chat harness.
#   3. It is a node process.
#
# A browser, an editor, or any other program that happened to bind 8777 is left alone, and the
# launcher reports it instead. Killing a process the user did not start, on the strength of a port
# number alone, would be a much worse failure than the one being fixed.
#
# The Operator Host is never touched by this: it is a different port and a different process, and
# it holds the machine's real capability. Nothing here can reach it.
function Get-PortHolder([int]$Port) {
  try {
    $conn = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue |
            Select-Object -First 1
    if (-not $conn) { return $null }
    return (Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue)
  } catch { return $null }
}

$stale = Get-PortHolder 8777
if ($stale) {
  $staleCmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$($stale.Id)" -ErrorAction SilentlyContinue).CommandLine
  # Match on the SCRIPT the process is running, not on the fact that its command line mentions
  # this repository. A match on the repo path alone would also fire for a test harness, an editor
  # task, or a REPL started in the project folder - none of which is an agent server, and all of
  # which a person may be using. What identifies one is running OUR entry point.
  $isOurServer = $staleCmd -and (
    ($staleCmd -match 'run-aios-chat') -or
    ($staleCmd -match '[\\/]chat-server\.(ts|js|mjs)')
  )
  if ($isOurServer) {
    ("[{0}] a previous agent server (pid {1}, started {2}) still held 8777; ending it" -f
      (Get-Date -Format o), $stale.Id, $stale.StartTime) | Out-File -Append -FilePath $log
    try {
      Stop-Process -Id $stale.Id -Force -ErrorAction Stop
      Start-Sleep -Seconds 2
      ("[{0}] ended stale server pid {1}; port 8777 free = {2}" -f (Get-Date -Format o), $stale.Id,
        -not (Get-NetTCPConnection -State Listen -LocalPort 8777 -ErrorAction SilentlyContinue)) |
        Out-File -Append -FilePath $log
    } catch {
      ("[{0}] could not end stale server pid {1}: {2}" -f (Get-Date -Format o), $stale.Id, $_.Exception.Message) |
        Out-File -Append -FilePath $log
    }
  } else {
    # Something else owns the port. Say so plainly and stop, rather than killing it: a program the
    # user did not start is not this launcher's to end, and `Fail` names the actual conflict.
    ("[{0}] port 8777 is held by pid {1} ({2}), which is NOT an agent server" -f
      (Get-Date -Format o), $stale.Id, $stale.ProcessName) | Out-File -Append -FilePath $log
    Fail ("Port 8777 is in use by another program (" + $stale.ProcessName + ", pid " + $stale.Id + ")." +
          [Environment]::NewLine +
          'Close it and try again. Zeus did not close it for you, because it is not Zeus''s process to close.' +
          [Environment]::NewLine + [Environment]::NewLine + 'See: ' + $log)
  }
}

$proc = Start-Process -FilePath $node `
  -ArgumentList '--experimental-strip-types', '--no-warnings', $harness `
  -WorkingDirectory $repo `
  -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $logDir 'launcher.out.log') `
  -RedirectStandardError  (Join-Path $logDir 'launcher.err.log') `
  -PassThru

("started pid {0}" -f $proc.Id) | Out-File -Append -FilePath $log

# ---- open the interface once the agent is actually answering.
#
# Waiting for /health rather than sleeping a fixed time: a fixed sleep is a race that fails
# slowly and only on a loaded machine, and the symptom would be an interface that opened onto a
# connection error and looked broken. Polling a real readiness signal does not have that failure
# mode, and gives up with a real message instead of opening nothing.

$deadline   = (Get-Date).AddSeconds(60)
$info       = $null

while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 600

  # A process that has EXITED will never become ready. Polling for another 58 seconds would report
  # "did not start within 60 seconds" and hide the actual reason, which is sitting in
  # launcher.err.log right now.
  if ($proc.HasExited) {
    $why = (Get-Content (Join-Path $logDir 'launcher.err.log') -Raw -ErrorAction SilentlyContinue)
    if (-not $why) { $why = '(no output was captured)' }
    ("[{0}] the agent process {1} exited immediately (code {2}). Its error output:`r`n{3}" -f
      (Get-Date -Format o), $proc.Id, $proc.ExitCode, $why) | Out-File -Append -FilePath $log
    Fail ("The agent stopped immediately (exit code " + $proc.ExitCode + ")." + [Environment]::NewLine +
          $why + [Environment]::NewLine + [Environment]::NewLine + 'See: ' + $log)
  }

  if (-not (Test-Path -LiteralPath $serverFile)) { continue }
  try {
    $s = Get-Content $serverFile -Raw | ConvertFrom-Json
    if (-not $s.port -or -not $s.token) { continue }

    # The answering server must belong to the process tree this launcher just started.
    #
    # Identity, not just liveness: a live `/health` on 8777 is NOT sufficient, because a stale
    # server answers it too - that was the original defect.
    #
    # It is NOT simply `$s.pid -eq $proc.Id`, either, and getting that wrong produced a worse bug
    # than the one it fixed. The harness `run-aios-chat.ts` SPAWNS the chat server as a child
    # process, so `server.json` records the CHILD's pid (4556) while `$proc` is the harness
    # (6940). Requiring exact equality meant the check could never succeed, and the launcher
    # reported "the agent did not start within 60 seconds" on every single run - while Zeus was
    # in fact running and serving correctly. Observed at 12:36 on 2026-10-19.
    #
    # So the question is ancestry, not identity: is the answering process this harness, or a
    # descendant of it? A stale server from a previous run has no such ancestry.
    $answeringPid = $s.pid
    if ($answeringPid) {
      $descendsFromHere = $false
      $cursor = $answeringPid
      # Walk up at most a few levels. Bounded so a pathological or cyclic parent chain cannot hang
      # the launcher.
      for ($i = 0; $i -lt 6 -and $cursor -and $cursor -gt 0; $i++) {
        if ($cursor -eq $proc.Id) { $descendsFromHere = $true; break }
        $parent = (Get-CimInstance Win32_Process -Filter "ProcessId=$cursor" -ErrorAction SilentlyContinue).ParentProcessId
        if (-not $parent) { break }
        $cursor = $parent
      }
      if (-not $descendsFromHere) { continue }
    }

    $h = @{ Authorization = 'Bearer ' + $s.token }
    $r = Invoke-RestMethod ("http://127.0.0.1:{0}/health" -f $s.port) -Headers $h -TimeoutSec 3
    if ($r.ok) { $info = $s; break }
  } catch { }
}

if ($null -eq $info) {
  ("[{0}] the agent did not become ready within 60s" -f (Get-Date -Format o)) |
    Out-File -Append -FilePath $log
  Fail 'The agent did not start within 60 seconds. See the log for the reason.'
}

# The token goes into the FIRST url only. The server verifies it once, sets an HttpOnly cookie,
# and redirects to a clean /ui, so the credential is not left in the address bar or in history.
$ui = 'http://127.0.0.1:{0}/ui?k={1}' -f $info.port, $info.token

# Browser app mode: a standalone window with no tabs and no address bar.
$candidates = @(
  'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
  'C:\Program Files\Microsoft\Edge\Application\msedge.exe'
  "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe"
)
$browser = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1

if (-not $browser) {
  # A named fallback, tried before giving up, so a non-standard install still opens something.
  $browser = (Get-Command msedge -ErrorAction SilentlyContinue).Source
}

if ($browser) {
  Start-Process -FilePath $browser `
    -ArgumentList "--app=$ui", '--window-size=1280,860', '--new-window' `
    -WorkingDirectory $repo | Out-Null
  ("opened {0} at {1}" -f $browser, $ui) | Out-File -Append -FilePath $log
} else {
  # Do not open the user's full browser at a URL with no way back - just name it and stop.
  ("no Edge found; the interface is at {0}" -f $ui) | Out-File -Append -FilePath $log
  Fail ("AIOS is running, but no browser was found to show its interface.`r`n`r`n" +
        "Open this yourself:`r`n$ui")
}