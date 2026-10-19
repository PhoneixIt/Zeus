# AIOS Complete Launch Script
Write-Host "=== AIOS Complete Launch ==="

# Step 1: Ensure operator host is running
Write-Host "1. Ensuring operator host is running..." 2>&1
Get-Process powershell -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like "*start-operator*" } | Stop-Process -Force -ErrorAction SilentlyContinue 2>&1
Start-Sleep -Seconds 1

Write-Host "2. Starting operator host..." 2>&1
rm -Force -ErrorAction SilentlyContinue "C:\Users\Samer\.aios\agent\server.json" 2>&1
node C:\Users\Samer\Projects\aios\packages\control-core\start-operator-host.mjs 2>&1 | Write-Host
Start-Sleep -Seconds 4

# Step 2: Launch AIOS Assistant
Write-Host "3. Launching AIOS Assistant..." 2>&1
Write-Host "   This will open the AIOS Assistant window with chat interface" 2>&1
Start-Process powershell -ArgumentList "-NoProfile, -ExecutionPolicy, Bypass, -File, C:\Users\Samer\Projects\aios\launch-aos.ps1" -WindowStyle Hidden

Write-Host "4. Waiting for window to initialize..." 2>&1
Start-Sleep -Seconds 10

# Step 3: Find and show the window
Write-Host "5. Finding AIOS Assistant window..." 2>&1
$forms = [System.Windows.Forms.Application]::OpenForms()
Write-Host "   Total forms: $($forms.Count)" 2>&1

$aiosForm = $forms | Where-Object { $f.Text -eq "AIOS Assistant" }
if ($aiosForm) {
    Write-Host "6. AIOS Assistant Found! Bringing to front..." 2>&1
    $aiosForm.TopMost = $true
    $aiosForm.BringToFront()
    Write-Host "   Window title: `$aiosForm.Text`" 2>&1
    Write-Host "   Window height: `$aiosForm.Height`" 2>&1
    Write-Host "   Window width: `$aiosForm.Width`" 2>&1
} else {
    Write-Host "6. AIOS Assistant NOT found in open forms" 2>&1
    # List all form titles
    Write-Host "   Available forms:" 2>&1
    foreach ($f in $forms) {
        Write-Host "   - `$($f.Text)" 2>&1
    }
}

Write-Host "7. Launch complete" 2>&1