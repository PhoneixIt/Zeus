# Inspect and fix the AIOS Assistant shortcut
Write-Host "=== AIOS Shortcut Repair ===" 2>&1

$linkPath = "C:\Users\Samer\Desktop\AIOS Assistant.lnk"

# Check if file exists
if (-not (Test-Path $linkPath)) {
    Write-Host "ERROR: Shortcut not found at $linkPath" 2>&1
    exit 1
}

# Read the shortcut using .NET
$wsh = New-Object -ComObject "WScript.Shell"
$shortcut = $wsh.CreateShortcut($linkPath)

Write-Host "Current shortcut settings:" 2>&1
Write-Host "  TargetPath: $($shortcut.TargetPath)" 2>&1
Write-Host "  Arguments:   $($shortcut.Arguments)" 2>&1
Write-Host "  WorkingDirectory: $($shortcut.WorkingDirectory)" 2>&1

# The correct launch should be:
# powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\Samer\Projects\aios\launch-aos.ps1"
$correctTarget = "powershell.exe"
$correctArgs = "-NoProfile -ExecutionPolicy Bypass `"C:\Users\Samer\Projects\aios\launch-aos.ps1`""
$correctWD = "C:\Users\Samer\Projects\aios"

# Check if it's correct
$targetOK = $shortcut.TargetPath -eq $correctTarget
$argsOK = $shortcut.Arguments -eq $correctArgs
$wdOK = $shortcut.WorkingDirectory -eq $correctWD

Write-Host "Target correct: $targetOK" 2>&1
Write-Host "Args correct: $argsOK" 2>&1
Write-Host "WD correct: $wdOK" 2>&1

if (!($targetOK -and $argsOK -and $wdOK)) {
    Write-Host "Fixing shortcut..." 2>&1
    $shortcut.TargetPath = $correctTarget
    $shortcut.Arguments = $correctArgs
    $shortcut.WorkingDirectory = $correctWD
    $shortcut.Save()
    Write-Host "Shortcut saved with correct settings." 2>&1
}

# Verify
Write-Host "Verified shortcut settings:" 2>&1
Write-Host "  TargetPath: $($shortcut.TargetPath)" 2>&1
Write-Host "  Arguments:   $($shortcut.Arguments)" 2>&1
Write-Host "  WorkingDirectory: $($shortcut.WorkingDirectory)" 2>&1

Write-Host "=== Done ===" 2>&1