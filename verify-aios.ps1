# Verify AIOS status
Write-Host "=== AIOS Verification ==="

# Check 1: Host state
Write-Host "Check 1: Operator host state"
$hostPath = "C:\Users\Samer\Projects\aios\packages\control-core\host.json"
if (Test-Path $hostPath) {
    Write-Host "  Host JSON exists - reading port..."
    $hostContent = Get-Content $hostPath -Raw
    if ($hostContent -match '"port"\s*:\s*(\d+)') {
        $port = $Matches[1]
        Write-Host "  Operator host port: $port"
    }
    if ($hostContent -match '"pid"\s*:\s*(\d+)') {
        $pid = $Matches[1]
        Write-Host "  Operator host PID: $pid"
    }
} else {
    Write-Host "  Host JSON NOT found"
}

# Check 2: Server file
Write-Host "Check 2: Agent server file"
$serverPath = "C:\Users\Samer\.aios\agent\server.json"
if (Test-Path $serverPath) {
    Write-Host "  Agent server file exists"
    $serverContent = Get-Content $serverPath -Raw
    if ($serverContent -match '"port"\s*:\s*(\d+)') {
        Write-Host "  Server port: $($Matches[1])"
    }
} else {
    Write-Host "  Agent server file NOT found"
}

# Check 3: Shortcut
Write-Host "Check 3: Desktop shortcut"
$linkPath = "C:\Users\Samer\Desktop\AIOS Assistant.lnk"
if (Test-Path $linkPath) {
    Write-Host "  Shortcut exists"
    $wsh = New-Object -ComObject WScript.Shell
    $shortcut = $wsh.CreateShortcut($linkPath)
    Write-Host "  Target: $($shortcut.TargetPath)"
    Write-Host "  Arguments: $($shortcut.Arguments)"
    Write-Host "  WD: $($shortcut.WorkingDirectory)"
    $args = $shortcut.Arguments
    if ($args -match "launch-aos.ps1") {
        Write-Host "  Arguments good: contains launch-aos.ps1"
    } else {
        Write-Host "  Arguments check: " $args
    }
} else {
    Write-Host "  Shortcut NOT found"
}

Write-Host "=== Verification Complete ==="