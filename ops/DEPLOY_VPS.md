# Deploy the VFS Booking Engine on a Windows VPS (Tashkent)

This is the full operator runbook to stand the engine up on a **Windows VPS in
Tashkent** (Serverspace / Eskiz / any UZ host with a **native UZ IP**). It is
provider-neutral — only the provisioning details differ.

> **THE #1 RULE: run Step 1 (reachability go/no-go) FIRST.** The single biggest
> unknown is whether VFS even loads from this VPS's IP (datacenter ASNs are a
> Datadome risk). If the box is blocked, you find out in 5 minutes — *before*
> wasting an hour on setup. Do not skip ahead.

---

## 0. Provision the VPS

1. Order a **Windows Server** VPS in **Tashkent**: ~**8 GB RAM / 4 vCPU** (e.g.
   Eskiz VPS 4, or Serverspace Tashkent equivalent). The bot runs a headed Chrome
   + Node + Python, so don't go below 4 GB.
2. Confirm the **Windows license cost** with the provider (some charge extra for
   Windows Server). Pay via the provider's supported method (Payme/Click/card).
3. Get the **RDP details**: public IP, admin username, password.
4. From your machine, open **Remote Desktop Connection** (`mstsc`), connect to the
   public IP, log in.

---

## 1. ⛔ STEP 1 — Reachability go/no-go (DO THIS FIRST)

You are checking: **does VFS load from this VPS's IP, or is it Datadome-blocked?**

**A. Real-Chrome check (authoritative).** A plain script can be fooled — Datadome
often only challenges a real browser, so THIS is the deciding test:

1. Install/open **Google Chrome** on the VPS (if not present yet, you can run the
   first part of `setup-vps.ps1` or just install Chrome).
2. Visit: `https://visa.vfsglobal.com/uzb/en/lva/login`
3. Read the result:
   - **GO** ✅ — the **login form renders** (email + password fields, Sign In).
   - **NO-GO** ❌ — it redirects to **/page-not-found**, or shows an
     access-denied / Cloudflare "Just a moment" / Datadome block page.

**B. Scripted signal (quick, secondary).** From the repo root on the VPS:

```powershell
node ops\check-vfs-direct.js
```

It prints `GO`, `UNCLEAR`, or `NO-GO`. This is a first signal only — a plain GET
can return the app shell even when a browser would be challenged, so **always
trust the real-Chrome result over the script.**

> (The older `backend\scripts\verify-vfs-reachable.js` routes through a BrightData
> proxy and is for the proxy path — not the direct UZ VPS. Use `check-vfs-direct.js`
> here.)

### Decision

- **GO** → continue to Step 2.
- **NO-GO** → **STOP.** This UZ-VPS path is Datadome-blocked for this IP. Do not
  invest in full setup. **Fallback:** a non-UZ VPS (e.g. Contabo) **plus a UZ
  residential/mobile proxy** (Oxylabs UZ or SOAX UZ) routing only VFS traffic
  (the `launch-bot-chrome.ps1` proxy-bypass pattern). That branch is a different
  deployment and is **not** built in this runbook — escalate before proceeding.

---

## 2. Run the setup script

From an **elevated PowerShell** (Run as Administrator):

```powershell
# If the repo isn't on the box yet, clone via the script:
powershell -NoProfile -ExecutionPolicy Bypass -File .\setup-vps.ps1 `
    -RepoUrl https://github.com/<your-org>/vfs-booking-bot.git -InstallDir C:\vfs-booking-bot

# If you already cloned, run it from inside the repo with no -RepoUrl.
```

It installs Node LTS, Python 3.12, Chrome, Git; clones/updates the repo; installs
backend npm deps; builds the extension; installs the Python `nodriver` package;
and prints tool versions. It is **idempotent** — safe to re-run. If it reports a
tool "NOT on PATH", **close and reopen PowerShell** and re-run (winget updates
PATH for new shells only).

---

## 3. Create `backend\.env.worker` (secrets — never committed)

In the repo's `backend\` folder, create a file named `.env.worker` with these
keys, copied from your **current working machine / Railway** (these are the same
values the engine uses today):

```
WORKER_TOKEN=<same token set on the Railway backend>
DATABASE_URL=<Railway PUBLIC Postgres URL>
PROFILE_ENCRYPTION_KEY=<Railway backend PROFILE_ENCRYPTION_KEY — the PROD key>
MAILSAC_API_KEY=<your Mailsac key>
BACKEND_URL=https://<your-railway-backend>.up.railway.app
```

> Get `DATABASE_URL` from Railway: select the Postgres service →
> `railway variables --kv | findstr DATABASE_PUBLIC_URL`. Never paste real
> secrets into chat, screenshots, or git.

(For block-alert photos in Telegram, also set `TELEGRAM_BOT_TOKEN` and
`TELEGRAM_CHAT_ID` in `.env.worker` — the worker passes them into the Python so it
can send the screenshot directly.)

---

## 4. Load the extension + confirm Online

The account **activation** step needs the operator's real Chrome extension:

1. Edit `launch-bot-chrome.ps1` if needed so `$extPath` points at this box's
   `…\vfs-booking-bot\extension\dist` and `$profile` is a valid local path (the
   committed copy hardcodes a `C:\Users\saman\…` path — change it to the VPS user).
2. Run it:
   ```powershell
   .\launch-bot-chrome.ps1
   ```
   It opens a dedicated Chrome with the MV3 extension loaded. (On the direct UZ
   VPS you do **not** need the BrightData proxy — leave `VFS_USE_PROXY` unset.)
3. Open the dashboard → **Extension Setup** page → confirm it shows **Online**.
   If it loads the unpacked extension manually instead: Chrome →
   `chrome://extensions` → Developer mode → **Load unpacked** → select
   `extension\dist`.

---

## 5. Install auto-start (engine runs on boot, no terminal thereafter)

```powershell
.\ops\install-autostart.ps1 -WithChrome
# add -WorkerBook only when you are ready for REAL booking submits.
```

This registers Scheduled Tasks (`VFS-Booking-Worker`, `VFS-Booking-Chrome`) that
launch at logon and stay alive. To start immediately without rebooting:

```powershell
Start-ScheduledTask -TaskName VFS-Booking-Worker
Start-ScheduledTask -TaskName VFS-Booking-Chrome
```

> The VPS user must **auto-log-in on boot** so the AtLogon trigger fires
> unattended (the bot needs an interactive desktop for headed Chrome). Configure
> auto-logon separately (netplwiz / Sysinternals Autologon).

---

## 6. Validate the one-click chain

1. Open the **dashboard** in any browser → the **Engine** light should be
   **🟢 Online** (the worker's heartbeat). If 🔴, see Troubleshooting.
2. Click **Start Scenario**.
3. Watch the chain run hands-off (Telegram messages + dashboard):
   `🔄 Registering → ✅ Registered → ✅ Activated → 🔐 Logged in → 🔍 monitoring`.
4. Leave it **monitoring OCMA**. The first real slot drives the booking
   finish-line. With block-alert hardening, any block sends a **captioned
   screenshot photo** to Telegram with a specific reason code (e.g.
   `❌ Booking blocked: datadome_block`), so you're never blind.

To halt: click **Stop Scenario** (live countdown, self-clears even if the worker
died). See `ops/CLIENT_OPERATION.md` for the non-technical day-to-day guide.

---

## 7. RDP keep-alive (so it keeps running when you disconnect)

The engine runs in the **interactive session**, so the session must stay logged
in when you leave:

- **DISCONNECT, don't log off.** Closing the RDP window (the **X**) or
  `Disconnect` keeps the session — and the bot — running. Choosing **Sign out /
  Log off** kills the session and the bot.
- Some providers/Group Policy auto-disconnect idle RDP and then **lock or log
  off** the session. To survive that, ensure:
  - the user **auto-logs-in on boot** (so a reboot recovers unattended), and
  - the Scheduled Tasks are **AtLogon + keep-alive** (Step 5) so the engine
    relaunches on any fresh logon.
- If the provider hard-logs-off idle sessions, set the RDP session policy to
  *disconnect* (not log off) on idle, or schedule a periodic auto-logon.

---

## 8. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| **Step 1 NO-GO** (page-not-found / block) | VPS IP is Datadome-flagged. Don't proceed; use the Contabo + UZ-proxy fallback (Step 1 Decision). |
| **Engine 🔴 Offline** on the dashboard | Worker not running. Refresh once (a blip shows red ~30s). Still red → start it: `Start-ScheduledTask -TaskName VFS-Booking-Worker`, or check `backend\.env.worker` keys, or RDP session was logged off (Step 7). |
| **Extension shows Offline** | `launch-bot-chrome.ps1` not running, or `$extPath`/`$profile` wrong for this box. Re-launch; load `extension\dist` unpacked. Activation needs it. |
| **Telegram: `rate_limit_429202`** | IP/session rate limit. Cool down ~2h. Pacing is already conservative — don't lower `MONITOR_INTERVAL`. |
| **Telegram: `rate_limit_429001`** | Account/User-ID limit (persists). Quarantine that account; the pool rotates to others. |
| **Telegram: `session_expired`** | Re-login needed. On a direct UZ VPS this is usually transient; confirm no VPN is active on the box. |
| **Telegram: `turnstile_wall`** | Captcha not passing — relaunch Chrome with `$env:VFS_FRESH_PROFILE='true'` for a clean profile. |
| **Telegram: `otp_timeout`** | `MAILSAC_API_KEY` missing/wrong in `.env.worker`. |
| **`node ops\check-vfs-direct.js` says UNCLEAR** | Trust the real-Chrome check (Step 1A); the script is only a first signal. |
| **Tools "NOT on PATH" after setup** | Reopen PowerShell (winget updates PATH for new shells), re-run `setup-vps.ps1`. |
| **Bot stops when I close RDP** | You logged off instead of disconnecting. See Step 7 — **disconnect**, don't sign out. |

---

## Quick reference — referenced files

| File | Purpose |
|---|---|
| `ops/setup-vps.ps1` | One-shot idempotent installer (Node/Python/Chrome/Git + deps) |
| `ops/check-vfs-direct.js` | Direct (no-proxy) reachability go/no-go signal |
| `ops/install-autostart.ps1` / `uninstall-autostart.ps1` | Register/remove boot auto-start tasks |
| `ops/CLIENT_OPERATION.md` | Non-technical day-to-day guide for the client |
| `launch-bot-chrome.ps1` | Launch the extension Chrome (operator-login / activation) |
| `launch-worker.ps1` | Launch the engine worker (the keep-alive loop) |
