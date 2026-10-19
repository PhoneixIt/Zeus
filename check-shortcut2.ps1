$wsh = new-object -comObject WScript.Shell
$shortcut = $wsh.CreateShortcut('C:\Users\Samer\Desktop\AIOS Assistant.lnk')
Write-Host "Target: $($shortcut.TargetPath)" 2>&1
Write-Host "Arguments: $($shortcut.Arguments)" 2>&1
Write-Host "WorkingDir: $($shortcut.WorkingDirectory)" 2>&1