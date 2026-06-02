# wait-and-start.ps1 — SILENT cooldown timer.
#
# CRITICAL: VFS's 429201 cooldown resets to a full 2 hours on EVERY request that
# hits it — including a curl check or opening the page in a browser. So the only
# way to recover is TOTAL SILENCE: zero contact with VFS for the full window.
# This script does NOT touch VFS at all — it just waits, then launches the worker
# once (the worker's first real login is the only test we run).
#
#   cd C:\Users\Administrator\Documents\vfs-booking-bot
#   .\wait-and-start.ps1                 # default 125 min
#   .\wait-and-start.ps1 -WaitMinutes 130

param([int]$WaitMinutes = 125)

Write-Host ""
Write-Host "=== VFS SILENT cooldown timer ===" -ForegroundColor Cyan
Write-Host "Waiting $WaitMinutes min with ZERO contact to VFS, then auto-starting the worker." -ForegroundColor Cyan
Write-Host "DO NOT open VFS, run curl, or start anything during this time —" -ForegroundColor Yellow
Write-Host "ANY request resets VFS's 2-hour clock and you start over." -ForegroundColor Yellow
Write-Host ""

$end = (Get-Date).AddMinutes($WaitMinutes)
while ((Get-Date) -lt $end) {
    $left = [int][math]::Ceiling((($end - (Get-Date)).TotalMinutes))
    Write-Host ("[{0}] silent wait — {1} min left (NOT touching VFS)" -f (Get-Date -Format 'HH:mm:ss'), $left) -ForegroundColor DarkGray
    Start-Sleep -Seconds 900   # 15-min heartbeat, but NO network call
}

Write-Host ""
Write-Host ">>> Cooldown complete. Launching worker — its first login is the real test." -ForegroundColor Green
Write-Host ">>> After it starts, click 'Start Scenario' (or ping to queue the run)." -ForegroundColor Green
Write-Host ""
& "$PSScriptRoot\launch-worker.ps1"
