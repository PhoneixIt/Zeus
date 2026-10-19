# Find AIOS Assistant window
Write-Host "Finding AIOS Assistant window..."
$forms = [System.Windows.Forms.Application]::OpenForms()
Write-Host "Total open forms: $($forms.Count)" 2>&1
$found = $false
foreach ($f in $forms) {
    $text = $f.Text
    $visible = $f.Visible
    Write-Host "  Form: `'$text`'" 2>&1
    if ($text -eq "AIOS Assistant") {
        $found = $true
        Write-Host "  ** FOUND AIOS Assistant! **'" 2>&1
        $f.TopMost = $true
        $f.BringToFront()
    }
}
if (!$found) {
    Write-Host "AIOS Assistant form NOT found among open forms" 2>&1
    # List all form titles to help debug
    foreach ($f in $forms) {
        Write-Host "  Available form: `'$($f.Text)`'" 2>&1
    }
}