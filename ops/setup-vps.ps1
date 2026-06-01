# setup-vps.ps1 - ONE-SHOT, idempotent installer for the VFS booking engine on a
# fresh Windows VPS (Tashkent / native UZ IP). Run it over RDP from an ELEVATED
# PowerShell. Safe to re-run: every step checks before it installs.
#
#   IMPORTANT: run the reachability go/no-go FIRST (ops/DEPLOY_VPS.md Step 1).
#   Don't install the full stack on a box that can't even load VFS.
#
# RUN:
#   # from anywhere (it will clone the repo if missing):
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\setup-vps.ps1 `
#       -RepoUrl https://github.com/<you>/vfs-booking-bot.git
#   # or, if you already cloned, run it from inside the repo with no -RepoUrl.
#
# WHAT IT DOES:
#   1. Installs Node LTS, Python 3.12, Google Chrome, Git via winget (check-first).
#   2. Clones the repo to -InstallDir (or `git pull` if already there).
#   3. Installs deps: backend npm, extension npm + build, Python `nodriver`.
#   4. Verifies tool versions and prints next steps.
# It does NOT write secrets - you create backend\.env.worker yourself (Step 5).

[CmdletBinding()]
param(
  [string]$RepoUrl = '',
  [string]$InstallDir = 'C:\vfs-booking-bot'
)

$ErrorActionPreference = 'Stop'

function Info($m)  { Write-Host $m -ForegroundColor Cyan }
function Ok($m)    { Write-Host ("  OK  " + $m) -ForegroundColor Green }
function Warn($m)  { Write-Host ("  !!  " + $m) -ForegroundColor Yellow }

function Have-Command($name) {
  return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

function Ensure-Winget {
  if (-not (Have-Command 'winget')) {
    Warn 'winget not found. Install "App Installer" from the Microsoft Store, then re-run.'
    Warn 'Alternatively use choco. This script assumes winget.'
    exit 1
  }
}

function Winget-Installed($id) {
  $list = winget list --id $id -e 2>$null | Out-String
  return ($list -match [Regex]::Escape($id))
}

function Install-WingetPackage($id, $friendly) {
  if (Winget-Installed $id) {
    Ok ($friendly + ' already installed (' + $id + ')')
    return
  }
  Info ('Installing ' + $friendly + ' (' + $id + ')…')
  winget install --id $id -e --silent --accept-source-agreements --accept-package-agreements | Out-Null
  Ok ($friendly + ' installed')
}

function Refresh-Path {
  # Pull machine + user PATH into this session so freshly-installed tools resolve.
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = ($machine, $user -join ';')
}

# ── 1. Prerequisites via winget ──────────────────────────────────────────────
Info '== Step A: prerequisites (Node / Python / Chrome / Git) =='
Ensure-Winget
Install-WingetPackage 'OpenJS.NodeJS.LTS'  'Node.js LTS'
Install-WingetPackage 'Python.Python.3.12' 'Python 3.12'
Install-WingetPackage 'Google.Chrome'      'Google Chrome'
Install-WingetPackage 'Git.Git'            'Git'
Refresh-Path

# ── 2. Clone or update the repo ──────────────────────────────────────────────
Info '== Step B: repository =='
$repo = $InstallDir
if (Test-Path (Join-Path $repo '.git')) {
  Info ('Repo exists at ' + $repo + ' - git pull…')
  Push-Location $repo
  git pull --ff-only
  Pop-Location
  Ok 'Repo updated'
} elseif ($RepoUrl) {
  Info ('Cloning ' + $RepoUrl + ' -> ' + $repo + '…')
  git clone $RepoUrl $repo
  Ok 'Repo cloned'
} else {
  # No -RepoUrl and not at InstallDir: assume we're being run from inside a clone.
  $here = Split-Path -Parent $PSScriptRoot   # <repo>\ops -> <repo>
  if (Test-Path (Join-Path $here 'backend\package.json')) {
    $repo = $here
    Ok ('Using current repo at ' + $repo)
  } else {
    Warn 'No -RepoUrl given and no repo found. Pass -RepoUrl or run from inside the repo.'
    exit 1
  }
}

# ── 3. Dependencies ──────────────────────────────────────────────────────────
Info '== Step C: backend npm install =='
Push-Location (Join-Path $repo 'backend')
npm install
Pop-Location
Ok 'backend deps installed'

Info '== Step D: extension build (MV3 dist for the operator-login Chrome) =='
$extDir = Join-Path $repo 'extension'
if (Test-Path (Join-Path $extDir 'package.json')) {
  Push-Location $extDir
  npm install
  npm run build
  Pop-Location
  Ok 'extension built (extension\dist)'
} else {
  Warn 'extension\package.json not found - skipping extension build'
}

Info '== Step E: Python pipeline deps =='
# The spikes only need the third-party package `nodriver` (everything else is
# Python stdlib: asyncio/os/re/sys/json/pathlib/urllib/secrets). Tested on 0.50.x.
$py = if (Have-Command 'py') { 'py -3' } elseif (Have-Command 'python') { 'python' } else { '' }
if ($py) {
  Info ('Installing nodriver via ' + $py + ' -m pip…')
  Invoke-Expression ($py + ' -m pip install --upgrade pip')
  Invoke-Expression ($py + ' -m pip install nodriver')
  Ok 'nodriver installed'
} else {
  Warn 'Python not on PATH yet. Reopen PowerShell and run:  py -3 -m pip install nodriver'
}

# ── 4. Verify versions ───────────────────────────────────────────────────────
Info '== Step F: versions =='
Refresh-Path
function Show-Version($cmd, $args) {
  if (Have-Command $cmd) {
    try { $v = (& $cmd $args 2>&1 | Select-Object -First 1); Ok ($cmd + ': ' + $v) }
    catch { Warn ($cmd + ': installed but version check failed') }
  } else { Warn ($cmd + ': NOT on PATH (reopen PowerShell)') }
}
Show-Version 'node' '--version'
Show-Version 'npm'  '--version'
Show-Version 'git'  '--version'
if (Have-Command 'py') { Show-Version 'py' '-3 --version' } else { Show-Version 'python' '--version' }
$chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
if (Test-Path $chrome) { Ok 'Chrome: installed' } else { Warn 'Chrome: not found at default path' }

# ── 5. Next steps ────────────────────────────────────────────────────────────
Info ''
Info '== Setup complete. NEXT STEPS (see ops/DEPLOY_VPS.md) =='
Write-Host ('  Repo: ' + $repo) -ForegroundColor Gray
Write-Host '  1. Create backend\.env.worker with WORKER_TOKEN / DATABASE_URL /' -ForegroundColor Gray
Write-Host '     PROFILE_ENCRYPTION_KEY / MAILSAC_API_KEY / BACKEND_URL  (no secrets in git).' -ForegroundColor Gray
Write-Host '  2. Launch the extension Chrome (launch-bot-chrome.ps1) and confirm the' -ForegroundColor Gray
Write-Host '     dashboard Extension page shows Online.' -ForegroundColor Gray
Write-Host '  3. Install auto-start:  .\ops\install-autostart.ps1 -WithChrome' -ForegroundColor Gray
Write-Host '  4. Open the dashboard -> Engine should be green -> click Start.' -ForegroundColor Gray
