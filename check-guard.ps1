$wc = New-Object Net.WebClient
Write-Output $wc.DownloadString('http://127.0.0.1:60599/guard')
$wc.Dispose()