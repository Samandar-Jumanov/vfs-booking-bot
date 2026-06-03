# ADD_BOX.md — Bring a New UZ Windows VPS Online (Lean Bot)

Copy-paste runbook to stand up a second (or Nth) box running the VFS booking worker.
Each box runs with its own `BOX_ID` so the DB-backed worker lock is namespaced per box —
no box refuses another.

---

## 0. Prerequisites — read before spending time on setup

**The #1 go/no-go: does VFS load from this IP?**

Open Chrome on the new VPS and visit:

```
https://visa.vfsglobal.com/uzb/en/lva/login
```

- **GO** — login form renders (email + password fields visible). Continue.
- **NO-GO** — redirects to `/page-not-found` or shows a block page. STOP.
  This VPS IP is Datadome-blocked. Do not invest further. Use the Contabo + UZ residential
  proxy fallback instead (separate runbook).

> After any connectivity tests, let the IP **cool down for 2 hours** before the first
> real booking run. Every request — including curl checks — resets the sliding 429201
> rate-limit window.

---

## 1. Install toolchain via Chocolatey

> **WARNING — use `choco`, NOT `winget`.** Windows Server VPS images often ship without
> `winget` (App Installer). `winget` is a desktop-app-store tool that is absent on most
> headless Server SKUs. `choco` is reliable on Windows Server.

From an **elevated PowerShell** (Run as Administrator):

```powershell
# Install Chocolatey if not present
Set-ExecutionPolicy Bypass -Scope Process -Force
[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072
iex ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))

# Close and reopen an elevated PowerShell so `choco` is on PATH, then:
choco install -y nodejs-lts          # Node LTS (20.x or 22.x)
choco install -y python312           # Python 3.12 EXACTLY — see WARNING below
choco install -y googlechrome        # headed Chrome (bot uses it)
choco install -y git                 # Git for cloning

# Refresh PATH in the current session
$env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' +
            [System.Environment]::GetEnvironmentVariable('Path','User')
```

> **WARNING — Python 3.12, NOT 3.13 or 3.14.**
> `nodriver` (the hands-off login/booking library) is broken on Python 3.13+ as of 2026-06.
> The Chocolatey package id is `python312`. If you accidentally install a newer version,
> uninstall it (`choco uninstall python`) and install `python312` explicitly.

Verify:

```powershell
node --version     # v20.x or v22.x
python --version   # Python 3.12.x  <-- must be 3.12
git --version
```

If any tool shows "not recognised", **close and reopen** the elevated PowerShell — PATH
updates only take effect in new shells.

---

## 2. Clone the repo

```powershell
git clone https://github.com/<your-org>/vfs-booking-bot.git C:\vfs-booking-bot
cd C:\vfs-booking-bot
```

> If the repo is private, authenticate first:
> `git config --global credential.helper wincred` then clone — Windows will prompt for
> GitHub credentials (or use a Personal Access Token as the password).

---

## 3. Install backend Node deps

```powershell
cd C:\vfs-booking-bot\backend
npm ci
```

`npm ci` (not `npm install`) is preferred on deploy boxes — it installs exactly what
`package-lock.json` specifies.

---

## 4. Install Python deps

```powershell
# Find the Python 3.12 executable (may be `python`, `python3`, or `py -3.12`)
python --version   # confirm 3.12.x

python -m pip install --upgrade pip
python -m pip install nodriver
```

> **Set PYTHON_BIN to the direct exe path** (see Step 5). The worker launches Python via
> this env var. If left unset, it defaults to `python` which may resolve to a wrong version
> if multiple Pythons are installed. Find the path with:
> ```powershell
> (Get-Command python).Source
> # e.g.  C:\Python312\python.exe  or  C:\ProgramData\chocolatey\bin\python.exe
> ```

---

## 5. Create `backend\.env.worker`

In `C:\vfs-booking-bot\backend\`, create a file named `.env.worker` (this file is
gitignored — never commit it).

> **WARNING — no UTF-8 BOM.** Windows Notepad and some editors save UTF-8 files with a
> BOM (byte-order mark). The worker reads this file line-by-line with a simple split; a
> BOM causes the first key to be silently misread. Use VS Code, Notepad++ (Encoding →
> UTF-8 without BOM), or paste the content via PowerShell `Set-Content -Encoding utf8`
> (PowerShell 7) / `[System.IO.File]::WriteAllText(...)` (PS 5).

> **WARNING — use PUBLIC Railway URLs**, not internal Railway URLs.
> `DATABASE_URL` must be the **public** Postgres proxy URL (from Railway: select Postgres
> service → Variables → `DATABASE_PUBLIC_URL`). The VPS cannot reach Railway's private
> network. Same for `BACKEND_URL` — use `https://<your-app>.up.railway.app`, not
> `http://backend.railway.internal`.

```
# ── Identity ────────────────────────────────────────────────────────────────
BOX_ID=box2
# ^ Unique per box. Use box1, box2, box3 … or a short slug (eskiz, contabo, etc.)
# ^ This namespaces the DB worker lock so boxes don't refuse each other.

# ── Railway backend auth ─────────────────────────────────────────────────────
WORKER_TOKEN=<same value set on Railway backend WORKER_TOKEN env var>

# ── Database (PUBLIC proxy URL) ───────────────────────────────────────────────
DATABASE_URL=<Railway Postgres PUBLIC URL — e.g. postgresql://postgres:xxx@roundhouse.proxy.rlwy.net:NNNNN/railway>

# ── Crypto ───────────────────────────────────────────────────────────────────
PROFILE_ENCRYPTION_KEY=<same AES key as Railway backend PROFILE_ENCRYPTION_KEY — the PROD value>

# ── OTP / Mailsac ────────────────────────────────────────────────────────────
MAILSAC_API_KEY=<your Mailsac API key — required for hands-off OTP; free tier 429s under load, paid tier recommended>

# ── Backend (public Railway URL) ──────────────────────────────────────────────
BACKEND_URL=https://<your-railway-backend>.up.railway.app

# ── Telegram alerts ──────────────────────────────────────────────────────────
TELEGRAM_BOT_TOKEN=<your Telegram bot token>
TELEGRAM_CHAT_ID=<your Telegram chat ID>

# ── Redis (if used for BullMQ) ────────────────────────────────────────────────
REDIS_URL=<Railway Redis public URL, or leave blank if not wired>

# ── JWT (must match Railway backend values exactly) ───────────────────────────
JWT_SECRET=<same value as Railway backend JWT_SECRET>
JWT_REFRESH_SECRET=<same value as Railway backend JWT_REFRESH_SECRET>

# ── Python binary ────────────────────────────────────────────────────────────
PYTHON_BIN=C:\Python312\python.exe
# ^ Set to the direct .exe path found in Step 4. Do NOT leave blank on multi-Python boxes.

# ── Optional tuning (leave blank to use defaults shown) ──────────────────────
# POOL_MIN=1                # minimum accounts to keep active in the pool
# RUN_LIMIT=1               # max concurrent booking runs
# SUBCAT=ocma               # visa sub-category to monitor (ocma has slots; Work-D rarely does)
# MONITOR_INTERVAL=120      # seconds between slot polls PER ACCOUNT
#                           # BUDGET: ~10 calls per IP per 2h window before 429201.
#                           # With 1 account: 1 call/120s = 60 calls/2h — already over budget.
#                           # Safer: 240-360s (1 call/4-6 min = 20-30 calls/2h).
#                           # Each additional account multiplies the call count.
#                           # NEVER lower below 90s.
```

---

## 6. Launch the lean worker

Open a PowerShell terminal (does NOT need to be elevated for the worker itself):

```powershell
cd C:\vfs-booking-bot

# Lean booking-only run on this box (BOOKING_ONLY skips register/activate on this box;
# the box drives already-ACTIVE accounts from the shared DB pool):
$env:BOX_ID      = 'box2'      # must match BOX_ID in .env.worker
$env:BOOKING_ONLY = '1'         # skip registration on this box (accounts created on box1)
$env:WORKER_BOOK  = '1'         # arm real booking submit (omit for DRY-RUN testing)

.\launch-worker.ps1
```

Expected startup output:

```
Loaded secrets from C:\vfs-booking-bot\backend\.env.worker
Starting orchestrator worker - mode: REAL + BOOK (live submit!)
Backend: https://xxx.up.railway.app | poll 10s stagger 45s
Worker lock acquired (pid=NNNN)
```

> **NEVER run two workers on the same box.** The DB lock (`worker_lock_box2`) prevents a
> second instance from starting, but zombie processes from previous launches can accumulate
> if the worker is started via `Start-Process` / background tasks. Always launch via
> `launch-worker.ps1` and kill any existing node `orchestrator-worker` processes first:
>
> ```powershell
> Get-WmiObject Win32_Process | Where-Object { $_.CommandLine -like '*orchestrator-worker*' } |
>   ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
> ```

---

## 7. Install auto-start (optional — survives reboots)

```powershell
# Arms the worker to launch on logon (no terminal needed after setup):
.\ops\install-autostart.ps1 -WithChrome
# Add -WorkerBook when ready for real submits.

# Start immediately without rebooting:
Start-ScheduledTask -TaskName VFS-Booking-Worker
Start-ScheduledTask -TaskName VFS-Booking-Chrome
```

The VPS user must **auto-log-in on boot** for the AtLogon trigger to fire unattended
(configure via `netplwiz` or Sysinternals Autologon).

**Disconnect RDP — do NOT log off.** Closing the RDP window with the X disconnects the
session and leaves the bot running. Choosing "Sign out" kills the session and the bot.

---

## 8. Validate

1. Open the dashboard → Engine light should be **green** (worker heartbeat).
2. Click **Start Scenario**.
3. Watch Telegram: `Registering → Activated → Logged in → monitoring`.
4. Check DB: the lock row `worker_lock_box2` should appear in the `Settings` table.

---

## 9. Quick-reference — env keys checklist

| Key | Source | Notes |
|-----|---------|-------|
| `BOX_ID` | You set it | Unique per box; namespaces the DB lock |
| `WORKER_TOKEN` | Railway backend env | Must match exactly |
| `DATABASE_URL` | Railway Postgres → PUBLIC URL | Not the internal `.railway.internal` URL |
| `PROFILE_ENCRYPTION_KEY` | Railway backend env | Prod AES key — decrypt/encrypt profile data |
| `MAILSAC_API_KEY` | Mailsac dashboard | Paid tier recommended; free tier 429s |
| `BACKEND_URL` | Railway backend public URL | `https://xxx.up.railway.app` |
| `TELEGRAM_BOT_TOKEN` | BotFather | Block-alert photos sent here |
| `TELEGRAM_CHAT_ID` | Your Telegram chat | |
| `REDIS_URL` | Railway Redis → PUBLIC URL | Leave blank if not wired |
| `JWT_SECRET` | Railway backend env | Must match |
| `JWT_REFRESH_SECRET` | Railway backend env | Must match |
| `PYTHON_BIN` | Direct exe path on this box | Find via `(Get-Command python).Source` |

---

## 10. Known gotchas (baked in from Eskiz VPS deploy)

| Gotcha | Fix |
|--------|-----|
| `winget` missing on Windows Server | Use `choco` (see Step 1) |
| Python 3.13/3.14 breaks nodriver | Install `python312` exactly (see Step 1) |
| `PYTHON_BIN` not set — wrong Python picked | Set full .exe path in .env.worker (see Step 5) |
| `.env.worker` saved with UTF-8 BOM | Use VS Code or Notepad++ "UTF-8 without BOM" |
| `DATABASE_URL` is the internal Railway URL | Use the PUBLIC proxy URL (see Step 5) |
| Two workers on same box | Kill existing node processes before launch (see Step 6) |
| 429201 after connectivity check | IP rate-limit window resets on ANY request; 2h total silence needed |
| Operator VPN on the box | VPN poisons the UZ IP signal — disable completely before running |
| Bot stops on RDP close | You logged off; use Disconnect not Sign out (see Step 7) |
