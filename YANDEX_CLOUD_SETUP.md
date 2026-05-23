# Yandex Cloud — UZ residential bot host

Goal: get bot Chrome running 24/7 from a real Uzbekistan IP, so Datadome treats it as legitimate traffic. This replaces the local-laptop-+-IPRoyal stack for the 500-customer scale tier.

**Budget target:** $30-60 / month all-in.

---

## Why Yandex Cloud (and not Hetzner / Contabo / AWS)

| Provider | Has Tashkent region? | UZ-trust IP? |
|---|---|---|
| Yandex Cloud | ✅ `ru-central1` extends to Tashkent via `uzbekistan` zone | ✅ true UZ residential-class |
| AWS / GCP / Azure | ❌ closest is Frankfurt | ❌ |
| Hetzner | ❌ EU only | ❌ |
| Contabo | ❌ EU/US/Asia, no UZ | ❌ |
| DigitalOcean | ❌ no UZ | ❌ |

Yandex is the only mainstream cloud with a Tashkent footprint. No KYC required for personal accounts (verified 2026-05-23, may change — be ready with passport scan just in case).

---

## Step-by-step setup

### 1. Sign up
- Go to `https://console.yandex.cloud/` and create an account.
- Use a Russian-language UI (English isn't fully translated for some pages).
- Phone verification needed — any UZ or RU phone works.
- Add a payment method. Debit cards work (no crypto).
- $10 free trial credit gets activated.

### 2. Create the VM

- Region: **`ru-central1-a`** with availability zone **`uzbekistan-c`** (Tashkent).
- Image: **Windows Server 2022 Standard** (Chrome runs on Windows — keeps the existing extension + BrightData CA cert workflow identical to your laptop).
- Size: **`s-c1-m4-50`** equivalent — 2 vCPU, 4 GB RAM, 50 GB SSD. Smallest that runs Chrome smoothly.
- Network: public IPv4 (auto-assigned).
- Firewall: open inbound TCP 3389 (RDP) FROM YOUR HOME IP ONLY. Do not leave RDP open to the world.
- Set a strong admin password and save it in your password manager.

Expected monthly cost at this tier: ~$35-45.

### 3. First RDP login

- Connect via Microsoft Remote Desktop (built-in on Windows).
- Once inside the VM:
  - Install Chrome (Stable).
  - Disable Windows Defender real-time scanning for the Chrome profile folder (perf gain, optional).
  - Set timezone to **`Asia/Tashkent`** in Settings → Time & Language.
  - Set system locale to UZ or RU (Datadome reads `navigator.language`).

### 4. Verify the UZ IP

Open Chrome on the VM and visit `https://ipinfo.io`. Expected output:
```json
{
  "country": "UZ",
  "city": "Tashkent",
  "region": "Toshkent",
  "org": "AS47764 Yandex.Cloud LLC" (or similar)
}
```

If it shows RU or anywhere else, the zone selection was wrong — destroy the VM and recreate in `uzbekistan-c`.

### 5. Bring over the bot

Three options for getting your code on the VM:
- **(easiest)** `git clone` the repo, install Node 20, run frontend + backend locally on the VM. Same setup as your laptop.
- **(cleanest)** Run only the bot Chrome + extension on the VM, and keep backend + frontend on Railway. Extension connects to your Railway backend via the same WebSocket flow it uses today.
- **(most resilient)** Add the VM as a second backend deployment target — Railway prod stays primary, VM is a hot spare.

For demo + first 50 customers, go with the cleanest path:

1. Copy `extension/dist/` to the VM (one-time).
2. Load it as an unpacked extension in Chrome.
3. Set the extension's `EXT_BACKEND_URL` to your Railway production URL.
4. Set `EXTENSION_TOKEN` to a freshly minted token (generate one on `/extension-setup`).
5. Open Chrome to `https://visa.vfsglobal.com/uzb/en/lva/login`.
6. Solve any Datadome challenge once (manual). After that, the warm tab is preserved across sessions.

### 6. BrightData proxy — optional now, recommended later

With a true UZ Yandex IP, you can disable the BrightData proxy entirely. Test BOTH:
- **(A)** Direct from Yandex IP — VFS may flag fewer signals.
- **(B)** Yandex VM + BrightData proxy on top — adds latency but blends into BrightData's residential pool.

Memory `[[project_brightdata_funded]]` notes $20 credit available — keep BrightData wired but turned off until you measure block rates from option A.

### 7. Auto-restart Chrome on crash

In Task Scheduler on the VM:
- Trigger: at log on of operator + every 4 hours
- Action: launch Chrome with your existing `launch-bot-chrome.ps1` args (copy that script to the VM)
- Setting: "Run only when user is logged on" → use the admin account.

Then enable auto-login for that admin account (so RDP isn't required to start Chrome after a reboot). This is OK for a single-user box but DO NOT do this on a multi-user machine.

### 8. Monitor it

- Add a healthcheck endpoint that the VM hits every 5 minutes to prove it's alive.
- Telegram alert when 3 consecutive heartbeats are missed.
- Use the existing `/api/health/full` plus a tiny ping script on the VM.

---

## After setup — what changes for the operator

| Today (laptop) | After Yandex VM |
|---|---|
| Open Chrome manually every morning | Already running on VM 24/7 |
| Solve Datadome challenge by hand | Solve once on first VM boot, then survives across Chrome restarts |
| IPRoyal session pinning ($5-15/month) | Yandex public IP (free, included in VM cost) |
| Stop the bot when laptop sleeps | Always on |

---

## Cost reality check

- Yandex VM: ~$35-45/month
- Total: ~$45/month including Telegram bot, Mailsac, 2Captcha base fee
- Per customer at 500/month: $0.09/customer — fits the $200 budget easily

---

## Open questions for you to decide

1. Do you want to keep Railway for backend + frontend, or move everything to the VM? (Recommendation: keep Railway. Yandex VM = bot Chrome only.)
2. Do you have a UZ or RU phone for sign-up?
3. Do you want one bot Chrome instance (10 accounts) or multiple in parallel (one per browser profile, more accounts at once)?

Answer those three before you provision so we don't burn $30 on the wrong VM size.

---

## Order of operations

1. **Today**: dispatch `CODEX_SPA_LOGIN_STARTER.md` (Option 1 — code fix). Test against your laptop's bot Chrome. Ship the fix.
2. **This week**: provision Yandex VM, copy extension, warm a single tab, test batch login of 10 accounts from the VM.
3. **Next week**: if Datadome rate increases on Yandex IP, layer BrightData back in as fallback (memory `[[project_brightdata_funded]]`).
