# install-autostart.ps1 - ONE-TIME setup (run by a technical person, NOT the client).
#
# Registers a Windows Scheduled Task that auto-starts the VFS booking engine at
# logon and keeps it alive, so the client never has to open a terminal again.
# After this runs once, the client operates everything from the dashboard.
#
# WHAT IT REGISTERS:
#   "VFS-Booking-Worker"  -> runs launch-worker.ps1 at logon (the engine).
#   "VFS-Booking-Chrome"  -> runs launch-bot-chrome.ps1 at logon (only if you pass
#                            -WithChrome; needed when account ACTIVATION must go
#                            through the operator's real Chrome extension).
#
# PREREQUISITES (must already be true on this machine):
#   * backend\.env.worker exists with WORKER_TOKEN / DATABASE_URL /
#     PROFILE_ENCRYPTION_KEY / MAILSAC_API_KEY  (see launch-worker.ps1 header).
#   * This is the always-on host on a clean UZ residential IP (no VPN).
#   * The Windows user auto-logs-in on boot (so the AtLogon trigger fires
#     unattended). Configure that separately (netplwiz / autologon).
#
# RUN (from an elevated PowerShell, in the repo root or anywhere):
#   .\ops\install-autostart.ps1                 # worker only
#   .\ops\install-autostart.ps1 -WithChrome     # worker + bot Chrome (for activation)
#   .\ops\install-autostart.ps1 -WithChrome -WorkerBook   # also arm REAL booking submit
#
# To remove: .\ops\uninstall-autostart.ps1

[CmdletBinding()]
param(
  [switch]$WithChrome,
  [switch]$WorkerBook
)

$ErrorActionPreference = 'Stop'

# Resolve the repo root (this script lives in <repo>\ops).
$repo = Split-Path -Parent $PSScriptRoot
$workerScript = Join-Path $repo 'launch-worker.ps1'
$chromeScript = Join-Path $repo 'launch-bot-chrome.ps1'

if (-not (Test-Path $workerScript)) {
  Write-Host ("Cannot find " + $workerScript + " - run this from the cloned repo.") -ForegroundColor Red
  exit 1
}

$envWorker = Join-Path $repo 'backend\.env.worker'
if (-not (Test-Path $envWorker)) {
  Write-Host ("WARNING: " + $envWorker + " not found. The worker will fail at launch") -ForegroundColor Yellow
  Write-Host "until you create it (see launch-worker.ps1 header)." -ForegroundColor Yellow
}

$user = "$env:USERDOMAIN\$env:USERNAME"

function Register-EngineTask {
  param([string]$Name, [string]$Script, [hashtable]$EnvVars)

  # Build a command that sets any env vars then launches the keep-alive script.
  $prefix = ''
  if ($EnvVars) {
    foreach ($k in $EnvVars.Keys) { $prefix += ('$env:' + $k + "='" + $EnvVars[$k] + "'; ") }
  }
  $command = $prefix + "& '" + $Script + "'"

  $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument ("-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command `"" + $command + "`"")

  # AtLogOn: the bot needs an interactive desktop session (headed Chrome/nodriver),
  # so it runs in the logged-on user's session, not as a background service.
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user

  # Keep it alive: restart on failure; run indefinitely.
  $settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
    -StartWhenAvailable

  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Highest

  # Replace any existing task with the same name.
  Unregister-ScheduledTask -TaskName $Name -Confirm:$false -ErrorAction SilentlyContinue | Out-Null

  Register-ScheduledTask -TaskName $Name -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal `
    -Description 'VFS booking engine auto-start (managed by ops/install-autostart.ps1)' | Out-Null

  Write-Host ("Registered scheduled task: " + $Name) -ForegroundColor Green
}

# Worker task - optionally arm real booking submit.
$workerEnv = @{}
if ($WorkerBook) { $workerEnv['WORKER_BOOK'] = '1' }
Register-EngineTask -Name 'VFS-Booking-Worker' -Script $workerScript -EnvVars $workerEnv

if ($WithChrome) {
  if (Test-Path $chromeScript) {
    Register-EngineTask -Name 'VFS-Booking-Chrome' -Script $chromeScript -EnvVars @{}
  } else {
    Write-Host ("Skipping Chrome task - " + $chromeScript + " not found.") -ForegroundColor Yellow
  }
}

Write-Host ''
Write-Host 'Auto-start installed. The engine will launch on the next logon.' -ForegroundColor Cyan
Write-Host 'To start it NOW without rebooting, run:' -ForegroundColor Cyan
Write-Host '  Start-ScheduledTask -TaskName VFS-Booking-Worker' -ForegroundColor Gray
if ($WithChrome) {
  Write-Host '  Start-ScheduledTask -TaskName VFS-Booking-Chrome' -ForegroundColor Gray
}
Write-Host ''
Write-Host 'NOTE: after pulling new code, restart the engine so it runs the new version:' -ForegroundColor Yellow
Write-Host '  Stop-ScheduledTask -TaskName VFS-Booking-Worker; Start-ScheduledTask -TaskName VFS-Booking-Worker' -ForegroundColor Gray
