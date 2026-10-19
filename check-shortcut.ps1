$wsh = new-object -comObject WScript.Shell
$shortcut = $wsh.CreateShortcut('C:\Users\Samer\Desktop\AIOS Assistant.lnk')
Write-Host "Target: $($shortcut.TargetPath)" 2>&1
Write-Host "Arguments: $($shortcut.Arguments)" 2>&1
Write-Host "WorkingDirectory: $($shortcut.WorkingDirectory)" 2>&1
Write-Host "Description: $($shortcut.Description)" 2>&1