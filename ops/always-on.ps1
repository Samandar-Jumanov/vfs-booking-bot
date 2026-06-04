# always-on.ps1 - ONE-TIME setup (run ONCE from an elevated PowerShell on the VPS).
#
# PURPOSE: make the VFS bot survive RDP disconnect by having it run in the
# CONSOLE session (auto-logon on boot) rather than in an RDP session that
# suspends when you disconnect.
#
# WHAT IT DOES:
#   1. Disables sleep / hibernate / screensaver / monitor-off (AC power only)
#   2. Disables the workstation lock so the console session never freezes
#   3. Configures auto-logon for the current user (password stored in registry)
#   4. Registers the VFS-Booking-Worker autostart task (calls install-autostart.ps1)
#
# SECURITY NOTE: The auto-logon password is written to HKLM\...\Winlogon in
# plain text - the same thing netplwiz does internally. This is acceptable on
# a dedicated, single-purpose bot VPS but is NOT a shared/multi-user machine
# practice. Sysinternals Autologon.exe (free) is a more secure alternative
# because it uses LSA secret storage. One-line usage:
#   autologon.exe <username> <domain> <password>
# Download: https://learn.microsoft.com/en-us/sysinternals/downloads/autologon
#
# PREREQUISITES:
#   * Run as Administrator.
#   * backend\.env.worker already exists with WORKER_TOKEN / DATABASE_URL /
#     PROFILE_ENCRYPTION_KEY (see launch-worker.ps1 header).
#   * Repo is on this machine and this script lives at <repo>\ops\always-on.ps1.
#
# USAGE:
#   .\ops\always-on.ps1                 # worker DRY-RUN (no real submit)
#   .\ops\always-on.ps1 -WorkerBook     # arm real booking submit

[CmdletBinding()]
param(
    [switch]$WorkerBook,
    [switch]$WithChrome
)

$ErrorActionPreference = 'Stop'

Write-Host ''
Write-Host '=====================================================' -ForegroundColor Cyan
Write-Host '  VFS Bot - Always-On Console Session Setup' -ForegroundColor Cyan
Write-Host '=====================================================' -ForegroundColor Cyan
Write-Host ''

# ---------------------------------------------------------------------------
# 0. Verify elevated
# ---------------------------------------------------------------------------
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host 'ERROR: Run this script from an ELEVATED (Administrator) PowerShell.' -ForegroundColor Red
    exit 1
}

# ---------------------------------------------------------------------------
# 1. Power plan - disable all sleep/hibernate (AC power)
# ---------------------------------------------------------------------------
Write-Host '[1/4] Configuring power plan (no sleep / no hibernate / no monitor-off)...' -ForegroundColor Yellow

try {
    # Activate High Performance plan (SCHEME_MIN)
    $hpResult = powercfg -setactive SCHEME_MIN 2>&1
    Write-Host ('  High-Performance plan: ' + $hpResult) -ForegroundColor DarkGray
} catch {
    Write-Host ('  WARN: Could not set High-Performance plan: ' + $_.Exception.Message) -ForegroundColor Yellow
}

try { powercfg /change standby-timeout-ac 0 }   catch { Write-Host ('  WARN standby: ' + $_.Exception.Message) -ForegroundColor Yellow }
try { powercfg /change hibernate-timeout-ac 0 }  catch { Write-Host ('  WARN hibernate: ' + $_.Exception.Message) -ForegroundColor Yellow }
try { powercfg /change monitor-timeout-ac 0 }    catch { Write-Host ('  WARN monitor: ' + $_.Exception.Message) -ForegroundColor Yellow }
try { powercfg /change disk-timeout-ac 0 }       catch { Write-Host ('  WARN disk: ' + $_.Exception.Message) -ForegroundColor Yellow }

Write-Host '  Power timeouts set to 0 (never).' -ForegroundColor Green

# ---------------------------------------------------------------------------
# 2. Disable screensaver + workstation lock
# ---------------------------------------------------------------------------
Write-Host '[2/4] Disabling screensaver and workstation lock...' -ForegroundColor Yellow

try {
    $desktopPath = 'HKCU:\Control Panel\Desktop'
    Set-ItemProperty -Path $desktopPath -Name 'ScreenSaveActive'      -Value '0' -Type String
    Set-ItemProperty -Path $desktopPath -Name 'ScreenSaverIsSecure'   -Value '0' -Type String
    Set-ItemProperty -Path $desktopPath -Name 'ScreenSaveTimeOut'     -Value '0' -Type String
    Write-Host '  Screensaver disabled (HKCU\Control Panel\Desktop).' -ForegroundColor Green
} catch {
    Write-Host ('  WARN screensaver keys: ' + $_.Exception.Message) -ForegroundColor Yellow
}

try {
    $policyPath = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System'
    if (-not (Test-Path $policyPath)) {
        New-Item -Path $policyPath -Force | Out-Null
    }
    Set-ItemProperty -Path $policyPath -Name 'DisableLockWorkstation' -Value 1 -Type DWord
    Write-Host '  DisableLockWorkstation=1 set (HKLM policy).' -ForegroundColor Green
} catch {
    Write-Host ('  WARN DisableLockWorkstation: ' + $_.Exception.Message) -ForegroundColor Yellow
}

# Disable the lock screen via Personalization policy (Windows 10/2016+)
try {
    $personPath = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\Personalization'
    if (-not (Test-Path $personPath)) {
        New-Item -Path $personPath -Force | Out-Null
    }
    Set-ItemProperty -Path $personPath -Name 'NoLockScreen' -Value 1 -Type DWord
    Write-Host '  NoLockScreen=1 set (HKLM Personalization policy).' -ForegroundColor Green
} catch {
    Write-Host ('  WARN NoLockScreen: ' + $_.Exception.Message) -ForegroundColor Yellow
}

# ---------------------------------------------------------------------------
# 3. Configure auto-logon
# ---------------------------------------------------------------------------
Write-Host '[3/4] Configuring auto-logon...' -ForegroundColor Yellow
Write-Host ''
Write-Host '  SECURITY NOTE: The password will be written to the registry in plain text' -ForegroundColor Yellow
Write-Host '  (HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon).' -ForegroundColor Yellow
Write-Host '  This is the same mechanism netplwiz uses. Acceptable on a dedicated bot VPS.' -ForegroundColor Yellow
Write-Host '  For better security, use Sysinternals Autologon.exe instead:' -ForegroundColor Yellow
Write-Host '    autologon.exe <username> <domain> <password>' -ForegroundColor DarkGray
Write-Host '  https://learn.microsoft.com/en-us/sysinternals/downloads/autologon' -ForegroundColor DarkGray
Write-Host ''

$currentUser   = $env:USERNAME
$currentDomain = $env:COMPUTERNAME

Write-Host ('  Current user: ' + $currentUser + ' / domain: ' + $currentDomain) -ForegroundColor DarkGray

$securePwd = Read-Host -AsSecureString ('  Enter the Windows password for ' + $currentUser + ' (will be stored in registry)')
$bstr      = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePwd)
$plainPwd  = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)

if ([string]::IsNullOrEmpty($plainPwd)) {
    Write-Host '  WARN: Empty password entered. Auto-logon may fail if the account has a password.' -ForegroundColor Yellow
}

try {
    $winlogonPath = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
    Set-ItemProperty -Path $winlogonPath -Name 'AutoAdminLogon'    -Value '1'           -Type String
    Set-ItemProperty -Path $winlogonPath -Name 'DefaultUserName'   -Value $currentUser  -Type String
    Set-ItemProperty -Path $winlogonPath -Name 'DefaultDomainName' -Value $currentDomain -Type String
    Set-ItemProperty -Path $winlogonPath -Name 'DefaultPassword'   -Value $plainPwd     -Type String
    Write-Host '  Auto-logon configured in HKLM\...\Winlogon.' -ForegroundColor Green
} catch {
    Write-Host ('  ERROR writing Winlogon keys: ' + $_.Exception.Message) -ForegroundColor Red
    Write-Host '  Auto-logon NOT configured. Use Sysinternals Autologon.exe manually.' -ForegroundColor Red
}

# Clear the plaintext from memory
$plainPwd = $null

# ---------------------------------------------------------------------------
# 4. Register the autostart task
# ---------------------------------------------------------------------------
Write-Host '[4/4] Registering autostart scheduled task...' -ForegroundColor Yellow

$repo           = Split-Path -Parent $PSScriptRoot
$installScript  = Join-Path $PSScriptRoot 'install-autostart.ps1'

if (-not (Test-Path $installScript)) {
    Write-Host ('  ERROR: ' + $installScript + ' not found.') -ForegroundColor Red
    Write-Host '  Autostart task NOT registered. Run install-autostart.ps1 manually.' -ForegroundColor Red
} else {
    $installArgs = @()
    if ($WorkerBook) { $installArgs += '-WorkerBook' }
    if ($WithChrome) { $installArgs += '-WithChrome' }

    if ($installArgs.Count -gt 0) {
        & $installScript @installArgs
    } else {
        & $installScript
    }
}

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
Write-Host ''
Write-Host '=====================================================' -ForegroundColor Cyan
Write-Host '  DONE - Always-On Setup Complete' -ForegroundColor Cyan
Write-Host '=====================================================' -ForegroundColor Cyan
Write-Host ''
Write-Host 'What was configured:' -ForegroundColor White
Write-Host '  * AC sleep / hibernate / monitor-off / disk timeouts -> 0 (never)' -ForegroundColor Gray
Write-Host '  * High Performance power plan activated (best-effort)' -ForegroundColor Gray
Write-Host '  * Screensaver disabled (HKCU)' -ForegroundColor Gray
Write-Host '  * WorkStation lock disabled (HKLM policy)' -ForegroundColor Gray
Write-Host '  * Lock screen disabled (HKLM Personalization policy)' -ForegroundColor Gray
Write-Host '  * Auto-logon: user=' + $currentUser + ', domain=' + $currentDomain -ForegroundColor Gray
Write-Host '  * VFS-Booking-Worker scheduled task registered (AtLogon + keep-alive)' -ForegroundColor Gray
Write-Host ''
Write-Host 'NEXT STEPS:' -ForegroundColor Yellow
Write-Host '  1. Verify backend\.env.worker has all required secrets.' -ForegroundColor White
Write-Host '  2. REBOOT the VPS (Start -> Restart, or via VMmanager).' -ForegroundColor White
Write-Host '  3. Do NOT connect via RDP after reboot.' -ForegroundColor White
Write-Host '     Watch the CONSOLE SESSION via VMmanager VNC instead.' -ForegroundColor White
Write-Host '  4. After ~60 seconds, confirm Telegram is sending slot-check or' -ForegroundColor White
Write-Host '     no-slots messages from the bot for 15+ minutes unattended.' -ForegroundColor White
Write-Host '  5. When you later connect via RDP, you get a SEPARATE session.' -ForegroundColor White
Write-Host '     The console session keeps running. Disconnect RDP freely.' -ForegroundColor White
Write-Host ''
Write-Host 'To restart the worker after git pull:' -ForegroundColor Yellow
Write-Host '  Stop-ScheduledTask -TaskName VFS-Booking-Worker' -ForegroundColor Gray
Write-Host '  Start-ScheduledTask -TaskName VFS-Booking-Worker' -ForegroundColor Gray
Write-Host ''
