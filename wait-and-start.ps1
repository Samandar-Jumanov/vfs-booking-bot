# wait-and-start.ps1
# Run this ONCE and walk away. It watches the VPS IP and AUTO-STARTS the worker
# the moment VFS stops blocking it — so you never mis-time the restart (which is
# what kept resetting the 2-hour cooldown).
#
# It only makes ONE lightweight GET per check (NOT a login), every 15 min, so the
# check itself won't trip the lift-api rate limit. On GREEN it launches the worker.
#
#   cd C:\Users\Administrator\Documents\vfs-booking-bot
#   .\wait-and-start.ps1

$ErrorActionPreference = 'SilentlyContinue'
$target      = 'https://visa.vfsglobal.com/uzb/en/lva/login'
$intervalMin = 15

Write-Host ""
Write-Host "=== VFS IP watcher ===" -ForegroundColor Cyan
Write-Host "Checking every $intervalMin min. Will auto-start the worker when the IP is CLEAR." -ForegroundColor Cyan
Write-Host "Leave this window open. Ctrl+C to abort." -ForegroundColor Cyan
Write-Host ""

while ($true) {
    $o = curl.exe -s -L -o NUL -w "%{http_code} %{url_effective}" $target
    $stamp = Get-Date -Format 'HH:mm:ss'
    if ($o -match '^200 ' -and $o -notmatch 'page-not-found') {
        Write-Host "[$stamp] GREEN - IP is CLEAR ($o)" -ForegroundColor Green
        Write-Host "[$stamp] Starting the worker now..." -ForegroundColor Green
        break
    }
    Write-Host "[$stamp] RED - still blocked ($o). Waiting $intervalMin min..." -ForegroundColor Yellow
    Start-Sleep -Seconds ($intervalMin * 60)
}

Write-Host ""
Write-Host ">>> IP clear. Launching worker. After it starts, click 'Start Scenario' on the dashboard." -ForegroundColor Green
Write-Host ""
& "$PSScriptRoot\launch-worker.ps1"
