Write-Host "Checking AIOS Assistant..."
# Find AIOS forms
$forms = [System.Windows.Forms.Application]::OpenForms()
Write-Host "Total open forms: $($forms.Count)" 2>&1
foreach ($f in $forms) {
    Write-Host "  Form: `"$($f.Text)`" Visible=$($f.Visible)" 2>&1
}
# Try to find and bring to front
$aiosForm = $forms | Where-Object { $f.Text -eq "AIOS Assistant" }
if ($aiosForm) {
    Write-Host "Found AIOS Assistant! Bringing to front..." 2>&1
    $null = $aiosForm.TopMost = $true
    $null = $aiosForm.BringToFront()
} else {
    Write-Host "AIOS Assistant form NOT found among open forms" 2>&1