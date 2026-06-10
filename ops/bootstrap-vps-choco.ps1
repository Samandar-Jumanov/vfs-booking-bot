Set-ExecutionPolicy Bypass -Scope Process -Force
$ErrorActionPreference = 'Stop'

function Refresh-Path {
  $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
    [System.Environment]::GetEnvironmentVariable('Path', 'User')
}

Refresh-Path

if (-not (Get-Command choco -ErrorAction SilentlyContinue)) {
  [System.Net.ServicePointManager]::SecurityProtocol =
    [System.Net.ServicePointManager]::SecurityProtocol -bor 3072
  iex ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))
  Refresh-Path
}

choco install -y nodejs-lts python312 googlechrome git
Refresh-Path

Set-ItemProperty -Path HKCU:\Console -Name QuickEdit -Type DWord -Value 0
Set-ItemProperty -Path HKCU:\Console -Name InsertMode -Type DWord -Value 0

$repo = 'C:\Users\Administrator\Documents\vfs-booking-bot'
New-Item -ItemType Directory -Force -Path 'C:\Users\Administrator\Documents' | Out-Null

if (-not (Test-Path "$repo\.git")) {
  if (Test-Path $repo) {
    Rename-Item $repo ("vfs-booking-bot.backup-" + (Get-Date -Format yyyyMMddHHmmss))
  }
  git clone https://github.com/Samandar-Jumanov/vfs-booking-bot.git $repo
}

Set-Location $repo
git branch --set-upstream-to=origin/main main 2>$null
try {
  git pull --ff-only
} catch {
  git pull origin main
}

Set-Location "$repo\backend"
npm install --no-audit --no-fund
npm run build

python -m pip install --upgrade pip
python -m pip install nodriver tzdata

node --version
python --version
git --version

Write-Host "INSTALL DONE - bot repo ready at $repo" -ForegroundColor Green
