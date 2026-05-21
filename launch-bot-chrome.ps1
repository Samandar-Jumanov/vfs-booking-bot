# Launches a dedicated Chrome instance with the VFS Booking Bot extension
# pre-loaded AND BrightData UZ proxy routing ONLY VFS traffic. Uses a
# persistent profile so cookies/sessions survive between runs.
#
# Edit $brightDataUser / $brightDataPass below with your zone credentials.
# Chrome will prompt for proxy auth on first VFS visit — paste creds and
# tick "Remember" so it doesn't ask again.

$chromeExe = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$extPath   = "C:\Users\saman\OneDrive\Documents\vfs-booking-bot-main\extension\dist"
$profile   = "C:\Users\saman\vfs-bot-chrome-profile"
$dashboard = "https://frontend-production-840c.up.railway.app/account-pool"

# BrightData proxy config — only VFS traffic gets routed through this.
$brightDataHost = "brd.superproxy.io"
$brightDataPort = 33335
# Username can include -country-uz-session-XYZ for sticky UZ exit.
# Chrome --proxy-auth doesn't support inline user:pass for HTTP proxies, so
# Chrome will prompt once when first VFS page is loaded.

# Proxy bypass list: everything EXCEPT vfsglobal.com goes direct.
$proxyBypass = "<-loopback>;*;!*.vfsglobal.com"

function Test-BrightDataCertificateInstalled {
    $certStores = @(
        "Cert:\CurrentUser\Root",
        "Cert:\LocalMachine\Root",
        "Cert:\CurrentUser\CA",
        "Cert:\LocalMachine\CA"
    )

    foreach ($store in $certStores) {
        if (-not (Test-Path $store)) {
            continue
        }

        $matches = Get-ChildItem -Path $store -ErrorAction SilentlyContinue | Where-Object {
            $_.Subject -match "Bright\s*Data|BrightData" -or
            $_.Issuer -match "Bright\s*Data|BrightData" -or
            $_.FriendlyName -match "Bright\s*Data|BrightData"
        }

        if ($matches) {
            return $true
        }
    }

    return $false
}

if (-not (Test-Path $chromeExe)) {
    Write-Host "Chrome not found at $chromeExe" -ForegroundColor Red
    exit 1
}
if (-not (Test-Path $extPath)) {
    Write-Host "Extension dist folder not found at $extPath" -ForegroundColor Red
    exit 1
}
if (-not (Test-Path $profile)) {
    New-Item -ItemType Directory -Path $profile | Out-Null
    Write-Host "Created dedicated profile at $profile" -ForegroundColor Green
}

Write-Host "Launching Chrome with VFS Booking Bot extension..." -ForegroundColor Cyan
Write-Host "  Extension: $extPath" -ForegroundColor Gray
Write-Host "  Profile:   $profile" -ForegroundColor Gray
Write-Host "  Dashboard: $dashboard" -ForegroundColor Gray
Write-Host "  Proxy:     http://${brightDataHost}:${brightDataPort} (VFS only)" -ForegroundColor Gray
Write-Host ""
Write-Host "When Chrome prompts for proxy authentication on first VFS visit:" -ForegroundColor Yellow
Write-Host "  Username: brd-customer-hl_XXXXX-zone-residential_proxy2-country-uz-session-vfsdemo" -ForegroundColor Yellow
Write-Host "  Password: <your BrightData password>" -ForegroundColor Yellow
Write-Host "  Tick 'Remember my credentials'" -ForegroundColor Yellow

$chromeArgs = @(
    "--load-extension=$extPath",
    "--user-data-dir=$profile",
    "--no-first-run",
    "--no-default-browser-check",
    "--proxy-server=http=${brightDataHost}:${brightDataPort}",
    "--proxy-bypass-list=$proxyBypass"
)

if (Test-BrightDataCertificateInstalled) {
    Write-Host ""
    Write-Host "BrightData CA certificate found in Windows certificate stores." -ForegroundColor Green
    Write-Host "Chrome will use normal certificate validation." -ForegroundColor Green
} else {
    Write-Host ""
    Write-Host "WARNING: BrightData CA certificate was not found in Windows certificate stores." -ForegroundColor Yellow
    Write-Host "Chrome will launch with --ignore-certificate-errors as a temporary fallback." -ForegroundColor Yellow
    Write-Host "Install the BrightData CA once using deployments\brightdata-cert-install.md, then relaunch Chrome." -ForegroundColor Yellow
    $chromeArgs += "--ignore-certificate-errors"
    $chromeArgs += "--test-type"
}

$chromeArgs += $dashboard

& $chromeExe @chromeArgs
