# launch-worker.ps1 - run the VFS orchestrator worker persistently on the UZ machine.
#
# The dashboard "Start Scenario" button only SIGNALS a run; THIS worker is what
# actually drives register -> activate -> login -> monitor -> book and reports
# progress back to the dashboard + Telegram. It MUST stay running for Start to do
# anything. This script keeps it alive (auto-restarts on crash).
#
# SETUP (once): create backend\.env.worker with these KEY=VALUE lines (gitignored):
#   WORKER_TOKEN=<same value set on Railway backend>
#   DATABASE_URL=<Railway PUBLIC db url: railway service Postgres; railway variables --kv | findstr DATABASE_PUBLIC_URL>
#   PROFILE_ENCRYPTION_KEY=<Railway backend PROFILE_ENCRYPTION_KEY (prod key, NOT the local .env one)>
#   MAILSAC_API_KEY=<mailsac key>   (only needed for real registration)
#
# RUN:
#   .\launch-worker.ps1                    REAL mode, booking DRY-RUN (safe: no real submit)
#   $env:WORKER_BOOK='1'; .\launch-worker.ps1        REAL + actually submit bookings (only when ready)
#
# Optional env: RUN_LIMIT, STAGGER_SEC, JITTER_SEC, POLL_INTERVAL_SEC

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$backend = Join-Path $root 'backend'

# --- load secrets from backend\.env.worker (KEY=VALUE lines) ---
$envFile = Join-Path $backend '.env.worker'
if (Test-Path $envFile) {
  Get-Content $envFile | ForEach-Object {
    $line = $_.Trim()
    if ($line -and -not $line.StartsWith('#') -and $line.Contains('=')) {
      $parts = $line -split '=', 2
      Set-Item -Path ('env:' + $parts[0].Trim()) -Value $parts[1].Trim()
    }
  }
  Write-Host ('Loaded secrets from ' + $envFile) -ForegroundColor DarkGray
} else {
  Write-Host ('NOTE: ' + $envFile + ' not found - relying on current environment variables.') -ForegroundColor Yellow
}

# --- defaults ---
if (-not $env:BACKEND_URL) { $env:BACKEND_URL = 'https://backend-production-24c3.up.railway.app' }
if (-not $env:POLL_INTERVAL_SEC) { $env:POLL_INTERVAL_SEC = '10' }
if (-not $env:STAGGER_SEC) { $env:STAGGER_SEC = '45' }
if (-not $env:JITTER_SEC) { $env:JITTER_SEC = '20' }

# --- mode toggles ---
# Booking is DRY-RUN unless WORKER_BOOK=1 (a real run will NOT submit until you opt in)
if ($env:WORKER_BOOK -eq '1') { $env:BOOK_ENABLED = '1'; $env:BOOK_DRY_RUN = '' } else { $env:BOOK_ENABLED = ''; $env:BOOK_DRY_RUN = '1' }
$env:WORKER_BRIDGED = '1'   # doers report via the backend (no crude per-doer telegram)
$env:PYTHONUTF8 = '1'

# --- validate required secrets ---
$missing = @()
foreach ($k in @('WORKER_TOKEN', 'DATABASE_URL', 'PROFILE_ENCRYPTION_KEY')) {
  if (-not (Get-Item ('env:' + $k) -ErrorAction SilentlyContinue)) { $missing += $k }
}
if ($missing.Count -gt 0) {
  Write-Host ('MISSING required env: ' + ($missing -join ', ')) -ForegroundColor Red
  Write-Host 'Add them to backend\.env.worker (see header of this script).' -ForegroundColor Red
  exit 1
}

if ($env:BOOK_ENABLED -eq '1') { $mode = 'REAL + BOOK (live submit!)' }
else { $mode = 'REAL + booking DRY-RUN' }
Write-Host ('Starting orchestrator worker - mode: ' + $mode) -ForegroundColor Cyan
Write-Host ('Backend: ' + $env:BACKEND_URL + ' | poll ' + $env:POLL_INTERVAL_SEC + 's stagger ' + $env:STAGGER_SEC + 's') -ForegroundColor DarkGray
Write-Host 'Ctrl+C to stop. Auto-restarts on crash.' -ForegroundColor DarkGray

Set-Location $backend
# --- keep-alive loop: restart the worker if it ever exits ---
while ($true) {
  npx tsx scripts/orchestrator-worker.ts
  Write-Host ('[launch-worker] worker exited (code ' + $LASTEXITCODE + ') - restarting in 5s') -ForegroundColor Yellow
  Start-Sleep -Seconds 5
}
