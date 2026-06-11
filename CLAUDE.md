# VFS Global Appointment Automation System

> **⚠️ Reader note:** Sections above "Current State & Known Issues" describe the original Phase-1 vision (Angola→Brazil/Portugal, Playwright, full SPA). The actual build is UZ→Latvia D-visa, nodriver + Chrome extension. For what is built and working today, jump to **Current State & Known Issues** below.

## Project Overview

You are an expert full-stack developer building an automated visa appointment booking system targeting **vfsglobal.com** for Angola → Brazil and Angola → Portugal routes. The system must monitor slots in real time, auto-fill applicant data, handle captchas and IP blocks, and book appointments within seconds of availability.

---

## Tech Stack

### Backend / Automation
- **Runtime:** Node.js (TypeScript preferred) or Python
- **Browser Automation:** Playwright (primary), Puppeteer (fallback)
- **API Framework:** Express.js (Node) or FastAPI (Python)
- **Captcha Solving:** 2Captcha API or Anti-Captcha API
- **Proxy Providers:** BrightData / SmartProxy / Oxylabs (residential/mobile)

### Frontend Dashboard
- **Framework:** Next.js (React)
- **Styling:** Tailwind CSS
- **UI Pattern:** Desktop-first, responsive
- **State Management:** Zustand or React Query

### Database
- **Primary:** PostgreSQL (preferred) or MongoDB
- **Sensitive fields:** AES-256 encrypted at rest
- **ORM:** Prisma (Node) or SQLAlchemy (Python)

### Notifications
- **Telegram:** Telegram Bot API
- **Email:** SMTP via Gmail or SendGrid
- **Desktop:** Web Push / OS native notification

---

## System Architecture

```
User Dashboard (Next.js)
       |
   REST API / WebSocket
       |
   API Server (Express / FastAPI)
       |
   Automation Engine (Playwright)
       |
   VFS Global Website
       |
   Proxy Pool ←→ Captcha Service
```

---

## Core Modules

### 1. Appointment Monitor (`/monitor`)
- Poll VFS appointment availability endpoint at configurable intervals (5s–60s)
- Support selection of: origin country (Angola), destination (Brazil / Portugal), visa category
- Diff slot state between polls — fire event on newly detected slot
- Emit WebSocket event to dashboard on slot detection
- Immediately trigger Auto Booking on slot detection if auto-mode is enabled

### 2. Automation Engine (`/engine`)
- Playwright-based browser controller with stealth plugin (avoid bot detection)
- Human-like behavior: randomized mouse movement, typing delays, scroll simulation
- Session persistence via cookie storage — resume sessions without full re-login
- On slot detection: auto-select earliest date/time, auto-fill applicant form, auto-submit
- Manual override window: configurable pause (e.g. 3–10 seconds) before final submit
- Retry logic: exponential backoff on booking failure, max 3 retries per attempt
- Detect and handle page-level errors (rate limits, session expiry, CAPTCHA walls)

### 3. Captcha Handler (`/captcha`)
- Detect captcha type on page: reCAPTCHA v2/v3, image/text captcha
- Primary: call 2Captcha / Anti-Captcha API with site key + page URL
- Fallback: pause automation and show manual captcha input popup in dashboard
- Resume automation flow after captcha token is injected

### 4. Proxy Manager (`/proxy`)
- Maintain a pool of residential/mobile proxy credentials
- Route requests through Angola or destination-country IPs as needed
- Detect block signals (403, redirect to error page, rate limit headers)
- Auto-rotate to next proxy on block detection
- Log which proxy was used per session

### 5. Profile Manager (`/profiles`)
- CRUD for applicant profiles stored in DB
- Fields: full name, passport number, DOB, passport expiry, nationality, email, phone
- Priority flag: High / Normal (determines booking order when multiple profiles queued)
- One-click profile selection for active booking session
- Bulk import via Excel/CSV upload (parse with `xlsx` or `pandas`)
- Encrypted storage for passport number and DOB

### 6. Notification Service (`/notifications`)
- Fire alerts on three events: `SLOT_DETECTED`, `BOOKING_SUCCESS`, `BOOKING_FAILED`
- Telegram: send formatted message via Bot API to configured chat ID
- Email: send HTML email via SMTP with booking details
- Desktop: Web Push notification through service worker
- All channels configurable per-user in settings

### 7. Logger (`/logs`)
- Structured JSON logs with timestamps for: slot detection, booking attempts, errors, IP blocks
- Log levels: INFO, WARN, ERROR
- Store logs in DB with fields: timestamp, event_type, profile_id, destination, result, proxy_used
- Export endpoint: download as CSV or TXT filtered by date range / profile / result

---

## API Endpoints

```
POST   /api/auth/login
POST   /api/auth/logout
GET    /api/dashboard/status

POST   /api/monitor/start
POST   /api/monitor/stop
GET    /api/monitor/status

GET    /api/profiles
POST   /api/profiles
PUT    /api/profiles/:id
DELETE /api/profiles/:id
POST   /api/profiles/bulk-upload

POST   /api/booking/trigger
POST   /api/booking/cancel
GET    /api/booking/history

GET    /api/logs
GET    /api/logs/export

PUT    /api/settings/notifications
PUT    /api/settings/proxy
PUT    /api/settings/captcha
```

---

## UI Screens

### Login (`/login`)
- Email + password form
- Role-based access: Admin (full control) / Operator (booking only, no settings)
- JWT auth, secure httpOnly cookie

### Dashboard (`/`)
- Appointment status cards: Active monitors, Last slot detected, Last booking result
- Live logs panel (WebSocket feed, auto-scroll)
- Active sessions counter
- Quick start/stop monitor toggle

### Appointment Setup (`/setup`)
- Dropdowns: Origin Country, Destination Country, Visa Type
- Date range preference picker
- Refresh interval slider (5s–60s)
- Auto / Manual mode toggle
- Start Monitor button

### Applicant Profiles (`/profiles`)
- Table: name, passport no (masked), priority, actions
- Add/Edit modal form
- Delete with confirmation
- Bulk upload via Excel drag-and-drop
- Priority badge toggle per profile

### Logs & History (`/logs`)
- Filterable table: date range, profile, event type, result
- Color-coded rows: success (green), failed (red), detected (yellow)
- Download CSV/TXT button

### Settings (`/settings`)
- Notification settings: Telegram token/chat ID, SMTP config
- Proxy settings: provider, credentials, rotation policy
- Captcha settings: API key, manual fallback toggle
- General: refresh interval defaults, retry count

---

## Security Requirements

- Never hardcode secrets — use `.env` with `dotenv` / environment variables
- Encrypt sensitive DB fields (passport number, DOB) using AES-256
- JWT tokens with short expiry (15min access + refresh token rotation)
- Rate limit dashboard API routes (express-rate-limit or similar)
- All proxy credentials anonymized — never exposed to frontend
- Input validation on all API endpoints (Zod / Joi / Pydantic)

---

## Non-Functional Requirements

- Slot detection to booking submission: under 3 seconds
- Support 50–200 concurrent applicant profiles
- Automation must simulate human behavior to minimize bot detection
- System uptime target: 99%+ during active monitoring windows
- Sensitive data encrypted both in transit (HTTPS) and at rest

---

## Development Guidelines

- Use TypeScript throughout (strict mode)
- Modular architecture: each core module is independently testable
- All async operations use proper error handling (try/catch, Result types)
- Environment config via `.env` — provide `.env.example` with all keys documented
- Use a queue (Bull / BullMQ with Redis) to manage concurrent booking jobs
- Write unit tests for: profile manager, captcha handler, proxy rotation logic
- Docker Compose setup: app + db + redis services
- Provide seed script for test profiles and mock monitoring data

---

## Out of Scope (Phase 1)

- Payment automation (user completes payment manually)
- Passport/document delivery tracking
- Mobile app

---

## Success Criteria

- Appointment booked within seconds of slot release
- Minimal IP bans / session blocks during operation
- Non-technical operators can run the system with zero CLI interaction

---

## Current State & Known Issues (updated 2026-06-11)

Scope: **UZ → Latvia D-visa (work/cargo)**, Model-A per-customer accounts. Architecture: Node/TS backend + Next.js dashboard on **Railway**; **nodriver** Python engine (`nodriver-spike/auto_pipeline.py`) for hands-off register/login/monitor/book, driven by `backend/scripts/orchestrator-worker.ts`. Package manager is **npm**.

**HOSTING — deployed + running:** the engine (worker + visible Chrome) runs on an **Eskiz Windows Server 2022 VPS in Tashkent** (`45.138.159.150`, ~$30/mo). A UZ datacenter IP beats Datadome; **no proxy**. Backend + dashboard on Railway. ⚠️ The worker runs **locally on the VPS** — pushing to Railway does NOT update it; `git pull` + **restart the worker** on the VPS to load new code. Access via RDP (`.\Administrator`) or VMmanager VNC.
⚠️ **24/7 unattended needs an active desktop session:** the bot drives a VISIBLE Chrome (headless is blocked by VFS), which is suspended when RDP disconnects or the box sleeps. Set `powercfg /change *-timeout-ac 0` and keep the session alive with `tscon <id> /dest:console` before disconnecting, OR run `ops/always-on.ps1` (auto-logon console + no-lock/no-sleep + autostart task) for true reboot/disconnect survival. See `ops/ADD_BOX.md` + `ops/ALWAYS_ON.md`.
⚠️ **VPN/datacenter exit = instant block (2026-06-05 lesson):** if traffic routes through a VPN or datacenter IP, VFS returns **`403201`** and the login form never renders — this looks like a rate-limit but is NOT. ALWAYS verify the exit IP is a clean UZ residential/mobile/datacenter IP (`curl https://ipinfo.io/json` → `country:UZ`, not "Datacamp"/US) before blaming rate-limits.
⚠️ **Windows QuickEdit Mode freezes the worker:** clicking inside the worker's console window pauses the process until Enter is pressed (looks like "it stopped"). Disable once: `Set-ItemProperty 'HKCU:\Console' QuickEdit 0` then relaunch.

**Monitoring = lift-api direct (no UI walk).** After login the engine enters the wizard ONCE to capture auth headers (`authorize`/`clientsource`) + the real category codes, then polls `CheckIsSlotAvailable` directly. **`error.code 1035` = "No slots available"** (a valid negative, not a block). The UI/wizard walk is only a fallback. OCMA codes: Work-D Uzbek `LSHMEDCL`, OCMA Uzbek `LNGOTHR`; vac `TAS`, parent `ZaremaT`.

**Working / proven (2026-06-03, live on the VPS):**
- Hands-off **register → activate (Mailsac link, no extension) → login (auto-Turnstile) → monitor → detect** — full chain, single "Start".
- **OCMA detection proof DELIVERED to client** via Telegram (`ocma_available` milestone + `telegram(force=True)`).
- **OCMA = detect+alert only (never booked); Work-D = book** (the real target). Per-category split in the monitor loop.
- **drive-by-linked:** worker drives only accounts holding a client `profileIds` (idle spares rest); passport injected from the DB (`Profile.passportImageEnc` → `.passport-cache/<id>.png`).
- **auto-rotate on `429001`:** moves the client's profile to a ready spare + quarantines the blocked account (cap 2 swaps/run); only on account-blocks, not IP-blocks.
- **one-worker lock** (DB `worker_lock[_${BOX_ID}]`, heartbeat) — refuses a 2nd instance; `BOX_ID` namespaces it per box.
- **lean polling:** drops irrelevant Tajik categories (`NATIONALITY_FILTER` default `uzbek|turkmen`) → 1 call/cycle (real) / 2 (demo). On `429/429201` → silent `RATELIMIT_BACKOFF_MIN` (default 20m) backoff, on `403` → re-login refresh; neither falls back to the UI hammer.
- Dashboard operator controls (Start/Stop, engine light, Stop countdown); block-alert reason codes + Telegram photo.

**KEY CONSTRAINT (measured 2026-06-03):** the VFS per-IP limit is a **cumulative budget of ~10 `CheckIsSlotAvailable` calls per ~2h**, speed-independent (`429201`, sliding ~2h, resets on ANY request). The lift token is **IP/cookie-bound** (direct cookieless replay = 403). ⟹ one IP ≈ ~10 checks/2h and CANNOT sustain continuous monitoring; **fast/continuous coverage requires MULTIPLE UZ IPs** (each its own VPS+session, staggered). See `ops/MULTI_BOX_DESIGN.md` + `ops/ADD_BOX.md`.

**SLOT BEHAVIOR (observed 2026-06-05 — first real data):** a real **Work-D UZ→LVA slot DOES appear** (opened ~**12:00 Tashkent**, lasted **< ~5 min**). The bot was watching on the VPS but checked every ~5 min (11:59 → 12:04) and the slot opened+closed inside that gap → **MISSED.** ⟹ to catch a sub-5-min slot you need **dense checks AT the release window** (burst, every few sec) + **multiple staggered UZ IPs** (one IP's ~10-call budget can't densely cover the window). Release cadence (daily vs specific days) still unconfirmed — ask the client.

**Remaining blockers:**

**2026-06-11 live ops update - multi-VPS account factory / activation / CSV export:**
- **Dashboard CSV export was implemented and pushed** in commit `470587b` (`Add account pool CSV export`). The protected account pool page has a **Download CSV** action, backed by `GET /api/accounts/export-csv`, exporting account email, decrypted password, phone, status, role, cookie metadata, timestamps, linked profile count, and tab URL. Treat this endpoint as high-sensitivity: it exposes usable credentials and must remain authenticated/admin-only.
- **Last observed production account pool after manual updates:** `ACTIVE=108`, `PENDING=7`, `BLOCKED=1`. Treat this as a session snapshot, not a source of truth; query the DB before making decisions.
- **Account creation across Eskiz VPSs is throttle-sensitive.** Running `REGISTER_COUNT=50` caused several boxes to hit `form_not_rendered`, `/page-not-found`, or "Register never enabled". The safer pattern is: test each box with `REGISTER_COUNT=1`; if good, run batches of `REGISTER_COUNT=10` (max 15) with `REGISTER_STAGGER_SEC=120`; then cool the IP for 1-2h after a throttle/page-not-found.
- **Main root cause of creator failures:** VFS/Datadome per-IP/session throttling and page withholding, not missing npm/python installs. Symptoms: no register form fields, `/page-not-found`, Turnstile never enabling submit, consent overlay covering submit, or no `register/user` POST. Do not keep hammering a box after those symptoms.
- **Pending activation workflow exists locally:** `backend/scripts/export-pending-activation-report.ts` exports PENDING accounts with inbox links, activation link status, phone, and decrypted password into `ops/pending-activation-accounts.csv` / `.md`; `backend/scripts/mark-activation-report-active.ts` marks manually confirmed rows ACTIVE; `backend/scripts/bulk-trigger-recover.ts` asks the deployed backend to trigger recovery for pending Mailsac/elite accounts. Generated reports contain passwords and must not be committed or shared.
- **Do not mark PENDING accounts ACTIVE unless VFS confirms activation/login.** Some PENDING rows are recoverable via "inactive/resend activation"; others may return "email id is not registered", meaning the registration POST never happened and the DB row is not usable.
- **Local reconciliation limitation:** running `reconcile-pending.ts` locally can query DB/Mailsac, but activation through the extension socket only works where the production backend has a connected extension/Chrome session. Use the production recovery endpoint when the extension is live, or manually open the Mailsac activation links.
- **RDP/VPS session fragility remains:** visible Chrome automation can pause or disconnect when RDP drops. Use VMmanager VNC or the always-on/console-session setup for long runs; do not restart/reconnect boxes that are already working unless necessary.

1. **Catch + book a live Work-D slot — STILL UNPROVEN, but reframed (2026-06-05):** slots are real (see SLOT BEHAVIOR); the blocker is now CATCHING one (need noon-burst + multi-IP density) and then BOOKING it before VFS voids it. ⚠️ VFS states **bookings via "automated systems" are deleted** — so until auto-booking is proven to survive detection, lean on the instant Telegram alert + **manual booking**. Booking Steps 1–5 are coded + walked but never completed on a live Work-D slot.
2. **Multi-box coordination not built** — per-box lock (`BOX_ID`) exists, but running N boxes still needs work-partitioning (Model 1) or monitor-fan-out (Model 2) so they don't double-drive an account. Today: manual partition via `TARGET_EMAIL` per box.
3. **Mailsac free tier 429s** on activation/OTP → paid tier for reliable hands-off.
4. Backend `/api/pipeline/event` step enum lacks `ocma_available`/`activated` → cosmetic HTTP 400 (account still persists; Telegram still fires).

**Launcher env (`launch-worker.ps1` / orchestrator-worker):** `WORKER_BOOK=1` arms real submit (maps to `BOOK_ENABLED`; default = DRY-RUN). `PROVE_OCMA=1` also monitors+reports OCMA (demo). `BOOKING_ONLY=1` skips pool top-up (drive existing ACTIVE only). `WORKER_MODE=pool_builder` = paced registration only. `TARGET_EMAIL` pins to one account. `BOX_ID` (multi-box lock). `NATIONALITY_FILTER` (default `uzbek|turkmen`). `RATELIMIT_BACKOFF_MIN` (default 20). `POOL_MIN`, `MONITOR_INTERVAL`, `MAX_REG_PER_DAY`. ⚠️ `launch-worker.ps1` loads `backend/.env.worker` AFTER shell vars, so values in that file OVERRIDE `$env:` — edit the file for `POOL_MIN` etc.
⚠️ **pool_builder over-registers** (spare-count quirk) — watch `MAX_REG_PER_DAY`; heavy registration floods can flag the IP.

**NEW feature — burst + watcher/booker (commits `6dedaa8` + `6c1978a`, NOT pushed, OFF by default, NOT live-validated):** in `auto_pipeline.py`. (a) **Burst-at-release-window:** `BURST_WINDOWS` (e.g. `11:55-12:15`, empty=off), `BURST_INTERVAL` (sec, default 3), `IDLE_INTERVAL` (default 300), `BURST_TZ` (default `Asia/Tashkent`) → poll fast only at the release window, idle otherwise (needs `pip install tzdata` on Windows). (b) **Watcher/booker split:** `BOOKER_EMAIL/PASSWORD/PASSPORT_IMAGE/PROFILE_*` → a 2nd browser logs in a separate "booker" account, parks at dashboard, and books on the watcher's slot signal (worker pairs a `pollingRole=BOOKER` peer; idle spares excluded from drive). (c) **Test hook `TEST_BOOKER_ON_OCMA=1`** (+ `BOOK_DRY_RUN=1`) routes an OCMA hit to the booker so the handoff can be exercised without a rare Work-D slot. All unset = unchanged behavior. Code structurally verified (build/py_compile/unit test + booker login+park+fallback seen) but the full handoff is NOT yet seen end-to-end on a clean IP. Plan: `PLAN_WATCHER_BOOKER_BURST.md`.

**PATH TO CATCHING A SLOT (current direction):** noon-burst window + **~3 staggered clean UZ IPs** (you don't need 24/7 speed — just ~10 min of dense checking at noon). IPs can be VPS boxes (~$30 each) or phone-hotspot/mobile-SIM airplane-toggle rotation (cheaper, mobile beats Datadome). Instant Telegram alert on Work-D → manual booking as the reliable first path (sidesteps the "automated = deleted" risk). See [[ops/MULTI_BOX_DESIGN.md]].

**`ops/` folder:** `ADD_BOX.md` (new-box runbook + keep-alive), `MULTI_BOX_DESIGN.md`, `DEPLOY_VPS.md`, `setup-vps.ps1`, `install/uninstall-autostart.ps1`, `CLIENT_OPERATION.md`. Diagnostics: `nodriver-spike/rate_probe.py` (per-IP ceiling), `backend/scripts/get-account-pw.ts` (decrypt account pw).

---

## Demo Preparation — Client Demo Sunday 2026-05-10 (superseded — see Current State above)

### Target routes
- **UZB → Tajikistan** (`uzb/tjk`)
- **UZB → Latvia** (`uzb/lva`)

Source country is Uzbekistan. VFS test passports (UZB) and a VFS test account are available. Demo runs locally on developer laptop, screen-shared. Goal: end-to-end booking on the test account (real submit OK; account will be cancelled afterward).

### Root cause of "blocking" (current hypothesis)
Symptom is redirect to `/page-not-found` on `goto`. This is **VFS's standard response when the visiting IP is not in the source country** — not bot detection. Bot has only been tested without a UZ-targeted residential exit. Fix the geo-mismatch first before any fingerprint hardening.

### Proxy setup — IPRoyal residential with UZ country pin

Credentials live in `backend/.env`. Required vars (already supported by `backend/src/config/env.ts:27-31`):

```
PROXY_HOST=geo.iproyal.com
PROXY_PORT=12321
PROXY_USERNAME=<iproyal_username>_country-uz_session-vfsdemo
PROXY_PASSWORD=<iproyal_password>
```

The `_country-uz_session-vfsdemo` suffix on the username pins the exit to Uzbekistan with a sticky session (~30 min on same IP). Match the exact separator (`-` vs `_`) shown in IPRoyal's dashboard.

### Verification commands (run before touching code)

**1. Confirm UZ country tag in username:**
```powershell
cd backend
node -e "require('dotenv').config(); const u=process.env.PROXY_USERNAME; console.log('Username has country-uz tag:', /country[-_]uz/i.test(u||'')); console.log('Host:', process.env.PROXY_HOST, 'Port:', process.env.PROXY_PORT);"
```

**2. Confirm proxy actually exits in Uzbekistan:**
```powershell
cd backend
node -e "require('dotenv').config(); const{HttpsProxyAgent}=require('https-proxy-agent'); const axios=require('axios'); const u=encodeURIComponent(process.env.PROXY_USERNAME); const p=encodeURIComponent(process.env.PROXY_PASSWORD); const url=`http://${u}:${p}@${process.env.PROXY_HOST}:${process.env.PROXY_PORT}`; axios.get('https://ipinfo.io', {httpsAgent: new HttpsProxyAgent(url), proxy:false}).then(r=>console.log(r.data)).catch(e=>console.log('ERR:', e.message));"
```

Expected: `country: "UZ"`, city in Uzbekistan.

**3. Confirm VFS renders normally through the UZ proxy** — install FoxyProxy in real Chrome, route through IPRoyal UZ proxy, open `https://visa.vfsglobal.com/uzb/en/ltv/login` and `https://visa.vfsglobal.com/uzb/en/tjk/login`. Should see the login form, not page-not-found.

### Plan once UZ proxy verified

1. Wire UZ proxy as the default in `backend/src/modules/engine/browser.factory.ts` and `backend/src/modules/monitor/session.warmer.ts` (already reads from env / DB pool).
2. Align fingerprint timezone to `Asia/Tashkent` and locale to `uz-UZ` / `ru-RU` in `browser.factory.ts:78` (currently hardcoded to `Europe/London` / `en-US`).
3. Add diagnostics: on block, dump final URL, response headers (`x-dd-b`, `cf-mitigated`), screenshot, first 2KB of HTML — so we know *which* vendor flagged us if it ever happens again.
4. Run end-to-end test on UZB test account against test profile data.
5. Build a "demo dry-run" mode that runs the full flow up to final submit and screenshots the review screen — insurance if no real slot is available during the demo.

### Constraints / decisions
- Manual cookie injection path (already built — `injectManualCookies` in `monitor.service.ts:65`) is **not acceptable** — bot must work end-to-end on its own.
- Do not touch the proxy/account-pool architecture before Sunday. Single sticky UZ session for the demo run is enough.
- Do not introduce `playwright-extra` or rewrite the stealth layer this week. Surgical fixes only.
- BrightData is available as fallback if IPRoyal UZ pool is unstable (KYC may delay activation).
