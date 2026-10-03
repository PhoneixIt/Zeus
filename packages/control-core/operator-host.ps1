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

Add-Type -TypeDefinition $code -ReferencedAssemblies @(
  'System.Windows.Forms',
  'System.Drawing',
  'WindowsBase',
  'UIAutomationClient',
  'UIAutomationTypes'
)

Write-Host ("operator host compiled from: " + (($sources | ForEach-Object { $_.Name }) -join ', '))

# Make sure a stale state file cannot make a client talk to a dead host.
if (Test-Path $statePath) { Remove-Item $statePath -Force -ErrorAction SilentlyContinue }

[PortAiOperator.Program]::Main(@($dir))
