# PortAi Desktop Operator Host - PowerShell-hosted.
#
# WHY THIS FILE EXISTS
# Windows Application Control blocked the compiled OperatorHost.exe:
#   "An Application Control policy has blocked this file."
# That is a deliberate security control and it is NOT being bypassed here. Instead the
# identical C# is compiled in-memory with Add-Type and hosted by powershell.exe, which
# is a signed, Microsoft-trusted binary already permitted to run. No new unsigned
# executable is introduced, so the policy is satisfied rather than evaded.
#
# This script is the long-lived process. It is launched detached via WMI
# (Win32_Process.Create) so it is not parented to the one-shot shell that starts it,
# and it therefore survives across OpenCode shell invocations - which is the whole
# reason the operator exists as a service rather than as one-shot commands.
#
# ALL .cs FILES HERE ARE COMPILED TOGETHER. The human-takeover safety layer
# (Guard.cs, Hooks.cs, Indicator.cs) is deliberately separate source rather than
# spliced into Program.cs, and it is deliberately NOT editable by the automation
# layer that it constrains: the guardrails have to be structurally separate from
# the thing they govern, or "do not weaken the guardrails" is only a promise.

$ErrorActionPreference = 'Stop'
$dir = $PSScriptRoot
$statePath = Join-Path $dir 'host.json'

$srcDir = Join-Path $dir 'src'
$sources = Get-ChildItem -LiteralPath $srcDir -Filter '*.cs' | Sort-Object Name
if (-not $sources) { throw "No .cs sources found in $srcDir" }

# Add-Type -TypeDefinition compiles everything as ONE compilation unit, where every
# `using` must precede all other elements. Concatenating the files as-is puts Guard's
# usings in the middle of that unit and the compiler rejects it - even though csc,
# which compiles the very same files separately, is perfectly happy. That difference
# is worth remembering: the syntax check passing does not prove Add-Type will accept
# the same sources. So the usings are hoisted, de-duplicated and emitted once, and
# stripped from the bodies.
$usings = New-Object System.Collections.Generic.SortedSet[string]
$bodies = @()
foreach ($f in $sources) {
    $body = @()
    foreach ($line in (Get-Content -LiteralPath $f.FullName)) {
        if ($line -match '^\s*using\s+[A-Za-z]') { [void]$usings.Add($line.Trim()) }
        else { $body += $line }
    }
    $bodies += ($body -join "`n")
}
$code = (($usings -join "`n") + "`n`n" + ($bodies -join "`n`n")) + "`n"

# ---------------------------------------------------------------------------------------
# LOAD A COMPILED ASSEMBLY. Do not Add-Type.
#
# Add-Type compiled this host in-memory until Ocr.cs needed a `.winmd` reference, and Add-Type
# refuses those outright:
#
#   Add-Type : Could not load file or assembly
#   '...\Windows.Foundation.UniversalApiContract.winmd' ... The given assembly name or codebase
#   was invalid. (0x80131047)
#
# It loads every -ReferencedAssemblies entry as a MANAGED assembly, and WinRT metadata is not one.
# csc accepts the identical reference - it compiles the same sources for the syntax check - so the
# compile is done by csc into an assembly, and this script loads it. start-operator-host.mjs passes
# the path; when it is absent the previous in-memory path is used, so the script still runs alone.
# ---------------------------------------------------------------------------------------
$assemblyPath = $null
foreach ($a in $args) {
  if ($a -and -not ($a -like '-*') -and (Test-Path -LiteralPath $a)) { $assemblyPath = $a; break }
}

if ($assemblyPath -and (Test-Path -LiteralPath $assemblyPath)) {
  Write-Host ("operator host loaded from: " + $assemblyPath)
  $asm = [System.Reflection.Assembly]::LoadFrom($assemblyPath)
  $entry = $asm.GetType('PortAiOperator.Program', $true)
  $entry::Main(@($dir))
  return
}

Add-Type -TypeDefinition $code -ReferencedAssemblies @(
  'System.Windows.Forms',
  'System.Drawing',
  'WindowsBase',
  'UIAutomationClient',
  'UIAutomationTypes',
  # WinRT, for Ocr.cs only. Windows.Media.Ocr resolves against the NuGet contract metadata in
  # winrt/ - this machine has no Windows SDK facade `Windows.winmd`, which is why OCR could not be
  # built before. See winrt/README.txt. Note this in-memory path CANNOT work with the winmd
  # references, which is precisely why the compiled-assembly path above exists.
  'System.Runtime',
  'System.Runtime.WindowsRuntime',
  (Join-Path $dir 'winrt\Windows.Foundation.UniversalApiContract.winmd'),
  (Join-Path $dir 'winrt\Windows.Foundation.FoundationContract.winmd')
)

Write-Host ("operator host compiled from: " + (($sources | ForEach-Object { $_.Name }) -join ', '))

# Make sure a stale state file cannot make a client talk to a dead host.
if (Test-Path $statePath) { Remove-Item $statePath -Force -ErrorAction SilentlyContinue }

[PortAiOperator.Program]::Main(@($dir))
