# Launches a dedicated Chrome instance with the VFS Booking Bot extension
# pre-loaded AND BrightData UZ proxy routing ONLY VFS traffic. Uses a
# persistent profile so cookies/sessions survive between runs.
#
# Edit $brightDataUser / $brightDataPass below with your zone credentials.
# Chrome will prompt for proxy auth on first VFS visit - paste creds and
# tick "Remember" so it doesn't ask again.

$chromeExe = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$repoRoot  = Split-Path -Parent $MyInvocation.MyCommand.Path
$extPath   = Join-Path $repoRoot "extension\dist"
# Profile: set $env:VFS_FRESH_PROFILE='true' to use a brand-new profile (clean
# Cloudflare cookies - defeats a flagged profile). Otherwise reuse the standard one.
if ($env:VFS_FRESH_PROFILE -eq 'true') {
  $profile = "C:\vfs-chrome-profile-" + (Get-Date -Format 'yyyyMMdd-HHmmss')
} else {
  $profile = "C:\vfs-chrome-profile"
}
$dashboard = "https://frontend-production-840c.up.railway.app/account-pool"

# BrightData proxy config - only VFS traffic gets routed through this.
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

# Disable Chrome's password manager + autofill so it doesn't inject the
# operator's saved credentials into the VFS login form (which fights the bot's
# trusted-fill and causes wrong-account / "*" validation failures). Patch the
# profile Preferences before launch.
$prefPath = Join-Path $profile "Default\Preferences"
try {
    if (Test-Path $prefPath) {
        $prefs = Get-Content $prefPath -Raw | ConvertFrom-Json
    } else {
        New-Item -ItemType Directory -Path (Split-Path $prefPath) -Force | Out-Null
        $prefs = [pscustomobject]@{}
    }
    function Set-Prop($obj, $name, $value) {
        if ($obj.PSObject.Properties[$name]) { $obj.$name = $value }
        else { $obj | Add-Member -NotePropertyName $name -NotePropertyValue $value }
    }
    if (-not $prefs.PSObject.Properties['credentials_enable_service']) {
        $prefs | Add-Member -NotePropertyName 'credentials_enable_service' -NotePropertyValue $false
    } else { $prefs.credentials_enable_service = $false }
    if (-not $prefs.PSObject.Properties['profile']) {
        $prefs | Add-Member -NotePropertyName 'profile' -NotePropertyValue ([pscustomobject]@{})
    }
    Set-Prop $prefs.profile 'password_manager_enabled' $false
    if (-not $prefs.PSObject.Properties['autofill']) {
        $prefs | Add-Member -NotePropertyName 'autofill' -NotePropertyValue ([pscustomobject]@{})
    }
    Set-Prop $prefs.autofill 'profile_enabled' $false
    Set-Prop $prefs.autofill 'credit_card_enabled' $false
    ($prefs | ConvertTo-Json -Depth 100) | Set-Content $prefPath -Encoding utf8
    Write-Host "Disabled Chrome password manager + autofill in profile prefs." -ForegroundColor Green
} catch {
    Write-Host "WARN: could not patch prefs to disable password manager: $($_.Exception.Message)" -ForegroundColor Yellow
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

# Set $UseProxy = $true only if this machine is NOT in Uzbekistan. If you're
# already on a UZ residential IP (check ipinfo.io), leave it $false - VFS loads
# directly on your clean IP and you avoid all BrightData proxy issues
# (allowlist, KYC, auth hangs). Override with env VFS_USE_PROXY=true.
$UseProxy = ($env:VFS_USE_PROXY -eq 'true')

$chromeArgs = @(
    "--load-extension=$extPath",
    "--user-data-dir=$profile",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=AutofillServerCommunication,PasswordManagerOnboarding,AutofillEnableAccountWalletStorage",
    "--disable-save-password-bubble"
)
if ($UseProxy) {
    Write-Host "Proxy ENABLED: routing VFS through BrightData UZ." -ForegroundColor Cyan
    $chromeArgs += "--proxy-server=http=${brightDataHost}:${brightDataPort}"
    $chromeArgs += "--proxy-bypass-list=$proxyBypass"
} else {
    Write-Host "Proxy DISABLED: using this machine's direct IP (assumed UZ)." -ForegroundColor Cyan
}

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
