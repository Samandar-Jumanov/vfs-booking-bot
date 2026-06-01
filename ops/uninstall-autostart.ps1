# uninstall-autostart.ps1 - remove the VFS booking engine auto-start tasks.
#
# RUN (elevated PowerShell):
#   .\ops\uninstall-autostart.ps1
#
# Stops and removes both scheduled tasks registered by install-autostart.ps1.
# Does NOT touch the repo, .env.worker, or any data - only the auto-start tasks.

$ErrorActionPreference = 'Stop'

foreach ($name in @('VFS-Booking-Worker', 'VFS-Booking-Chrome')) {
  $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  if ($task) {
    try { Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue } catch {}
    Unregister-ScheduledTask -TaskName $name -Confirm:$false
    Write-Host ("Removed scheduled task: " + $name) -ForegroundColor Green
  } else {
    Write-Host ("Not found (already removed): " + $name) -ForegroundColor DarkGray
  }
}

Write-Host ''
Write-Host 'Auto-start removed. The engine will no longer launch on logon.' -ForegroundColor Cyan
Write-Host 'Any worker started by the task in THIS session keeps running until you close it' -ForegroundColor DarkGray
Write-Host 'or reboot.' -ForegroundColor DarkGray
