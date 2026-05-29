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

## Current State & Known Issues (updated 2026-05-29)

Scope is **UZ → Latvia D-visa (work/cargo)**, Model-A per-customer pool accounts. Architecture: Node/TS backend on Railway + Next.js frontend on Railway + **nodriver** Python spike (`nodriver-spike/auto_pipeline.py`) for hands-off login+booking on the operator's UZ machine. Chrome MV3 extension still runs the slot-monitor/auth-sniffer. Package manager is **npm** (not pnpm).

**Build & test status (verified 2026-05-29):**
- Backend TypeScript (`npm run build`) — **clean** (exit 0, zero errors).
- Frontend Next.js build — **clean** (16 static routes, 4 minor lint warnings only).
- Python spikes (`py_compile`) — **clean**.
- Unit tests: **166/166 green**. The previously failing `monitor.service.test.ts` test was stale — `selectFreshWatcherAccount` now correctly stamps `lastUsedAt` on account selection (round-robin pacing); test expectation updated to match.
- ESLint: 42 cosmetic errors (unused vars, empty blocks) — no runtime or logic impact.
- **Known footgun: `npm run test:e2e:dry` and worker `SIMULATE=1` both require a live Railway `DATABASE_URL`** — they read/write the prod DB even in "dry/simulate" mode. No safe local integration-test path exists yet.

**Working (proven):**
- **nodriver hands-off login**: `auto_pipeline.py` auto-passes Cloudflare Turnstile without the extension or `chrome.debugger`. Login→dashboard fully automated on a clean IP + fresh profile.
- **Auto-register + auto-activate**: `register_spike.py` registers hands-off; backend fetches Mailsac activation link and visits it via extension (clean UZ IP). Automated only for **Mailsac** pool emails (no API access to customers' personal inboxes).
- Slot monitoring + authenticated polling. lift-api auth = `authorize` + `clientsource` custom headers (NOT `Authorization`); captured via `chrome.webRequest` in the extension service-worker.
- Booking **Steps 1–5** coded in `auto_pipeline.py`:
  - Step 2 = passport-image upload (VFS OCR-extracts applicant identity from the bio-page scan).
  - **Step 3 = OTP gate: `mailsac_otp_code()` IS wired at `auto_pipeline.py:486`** — polls Mailsac and fills the OTP automatically. Blocker is **`MAILSAC_API_KEY`** not being set: if missing, `mailsac_otp_code()` times out after 120s and booking stalls at Step 3.
  - Step 5 Submit is reachable and **`BOOK_DRY_RUN`-guarded** (set `BOOK_DRY_RUN=1` to screenshot the review screen without submitting). **Still unvalidated on a live slot.**
- Full chain **create→activate→login→monitor** proven live (2026-05-28). Booking submit gated on a real slot appearing.
- Orchestrator worker (`backend/scripts/orchestrator-worker.ts`) wires the Python spikes to the Railway backend via MILESTONE lines. `SIMULATE=1` disables VFS browser hits but still requires a live prod DB (see footgun above).

**Active constraint — operator-assisted login for degraded accounts:**
- The fully hands-off nodriver path works for fresh accounts/IPs. For accounts flagged by heavy testing (poisoned `cf_clearance`), the operator logs in manually in a plain Chrome tab; the bot takes over for monitoring/booking.
- Fresh Chrome profile + clean UZ residential IP always passes Turnstile (manual or nodriver).

**Gotcha that cost a full day:** the operator's **VPN** poisons the BrightData proxy source IP → BrightData returns `ip_blacklisted` → surfaces as VFS "Session Expired". **Check VPN + BrightData IP-allowlist BEFORE blaming Datadome/VFS.**

**Proxy is now OPTIONAL** — the operator is in UZ on a clean residential IP (`84.54.x`, Tashkent), so VFS loads directly. Launcher (`launch-bot-chrome.ps1`) env flags:
- `VFS_USE_PROXY=true` → route VFS through BrightData (only if NOT in UZ). Default **off**.
- `VFS_FRESH_PROFILE=true` → launch a brand-new Chrome profile (clean Cloudflare cookies; defeats a flagged profile).

**Backend env flags (default OFF — see `backend/.env.example`):**
- `LOGIN_CRON_ENABLED` — the 6-hourly mass-login refresh; OFF because it logs in every stale account at once and triggers VFS **429001** "Access Restricted".
- `NOTIFY_BOOKING_FAILURES` — Telegram/email failure alerts; OFF so dev test fires don't spam the operator/client.

**Diagnostic/trigger scripts** (`backend/scripts/`, run via `railway run --service backend npx tsx scripts/<x>.ts`): `trigger-auto-login` (TARGET_ID), `trigger-register`, `trigger-recover` (activate PENDING via Mailsac), `trigger-booking`, `verify-proxy-exit.js`, `verify-vfs-reachable.js`.

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
