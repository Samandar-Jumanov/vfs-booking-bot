# VFS Global Appointment Automation System

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

## Demo Preparation — Client Demo Sunday 2026-05-10

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
