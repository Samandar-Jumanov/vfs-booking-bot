# Hands-off VFS login via nodriver (auto-passes the Turnstile — no manual captcha).
# Usage:
#   .\login-nodriver.ps1 -Email "vfs-...@mailsac.com" -Password "..."            # logs in, captures tokens, closes
#   .\login-nodriver.ps1 -Email "..." -Password "..." -KeepAlive                 # logs in and LEAVES Chrome open
#
# After it runs, the captured session tokens are in nodriver-spike\session.json.
# NOTE: do not re-run on the same account within a few minutes — VFS rate-limits
# rapid logins (429). One login per account, then reuse the open window.
param(
    [Parameter(Mandatory = $true)][string]$Email,
    [Parameter(Mandatory = $true)][string]$Password,
    [switch]$KeepAlive
)

$env:PYTHONUTF8   = "1"
$env:VFS_EMAIL    = $Email
$env:VFS_PASSWORD = $Password
if ($KeepAlive) { $env:VFS_KEEP_ALIVE = "1" } else { Remove-Item Env:\VFS_KEEP_ALIVE -ErrorAction SilentlyContinue }

Write-Host "Logging in $Email via nodriver (hands-off, no captcha to solve)..." -ForegroundColor Cyan
python "$PSScriptRoot\nodriver-spike\login_spike.py"
