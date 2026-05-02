# VFS Booking Bot — Complete Project Documentation

> **Version**: 1.0.0 | **Environment**: Production-Ready | **Last Updated**: April 2026

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [System Architecture](#2-system-architecture)
3. [Technology Stack](#3-technology-stack)
4. [Project Structure](#4-project-structure)
5. [Core Modules](#5-core-modules)
6. [Database Schema](#6-database-schema)
7. [API Reference](#7-api-reference)
8. [Configuration & Environment Variables](#8-configuration--environment-variables)
9. [Docker Setup](#9-docker-setup)
10. [How the Bot Works](#10-how-the-bot-works)
11. [Proxy Strategy](#11-proxy-strategy)
12. [Telegram Bot Commands](#12-telegram-bot-commands)
13. [Frontend Dashboard](#13-frontend-dashboard)
14. [Error Handling & Recovery](#14-error-handling--recovery)
15. [Operational Guide](#15-operational-guide)
16. [Admin Credentials](#16-admin-credentials)
17. [Known Behaviors](#17-known-behaviors)
18. [Troubleshooting](#18-troubleshooting)

---

## 1. Project Overview

The **VFS Booking Bot** is a fully automated visa appointment monitoring and booking system designed for VFS Global portals. It continuously monitors VFS Global websites across multiple countries and destinations, detects available appointment slots, and can automatically book them for registered applicants.

### What It Does
- **Monitors** the VFS Global portal 24/7 for available visa appointment slots
- **Bypasses** VFS's anti-bot protection (Cloudflare, 403 blocks) using residential proxies and headless browser warming
- **Notifies** operators via Telegram when slots are found or when system events occur
- **Books** appointments automatically when slots become available
- **Manages** multiple applicants with different priorities, nationalities, and destinations
- **Provides** a real-time web dashboard for monitoring and management

### Who Uses It
- **Admin**: Full access to all features — add/remove applicants, view logs, manage settings
- **Operator**: Can monitor streams and view logs, limited management access
- **Telegram Bot**: Provides real-time status updates and commands to the team

---

## 2. System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        CLIENT LAYER                              │
│         Web Browser (Dashboard at localhost:3000)               │
│         Telegram Bot (Real-time notifications)                  │
└────────────────────┬────────────────────────────────────────────┘
                     │ HTTP/WebSocket
┌────────────────────▼────────────────────────────────────────────┐
│                      FRONTEND                                    │
│           Next.js Dashboard (Port 3000)                         │
│   • Login • Applicant Management • Live Logs • Settings        │
└────────────────────┬────────────────────────────────────────────┘
                     │ REST API + WebSocket
┌────────────────────▼────────────────────────────────────────────┐
│                    BACKEND API                                   │
│              Node.js + Express (Port 3001)                      │
│                                                                  │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────────┐  │
│  │   Auth   │ │ Monitor  │ │ Booking  │ │  Notifications   │  │
│  │  Module  │ │  Module  │ │  Module  │ │  (Telegram)      │  │
│  └──────────┘ └──────────┘ └──────────┘ └──────────────────┘  │
│                                                                  │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────────┐  │
│  │ Profiles │ │  Proxy   │ │ Captcha  │ │   WebSocket      │  │
│  │  Module  │ │  Module  │ │  Module  │ │    Module        │  │
│  └──────────┘ └──────────┘ └──────────┘ └──────────────────┘  │
└──────┬──────────────┬──────────────────────────────────────────┘
       │              │
┌──────▼──────┐ ┌─────▼───────┐
│ PostgreSQL  │ │    Redis     │
│  Database   │ │   Cache      │
│  (Port 5432)│ │  (Port 6379) │
└─────────────┘ └─────────────┘
                     │
┌────────────────────▼────────────────────────────────────────────┐
│                  VFS GLOBAL PORTAL                               │
│          https://visa.vfsglobal.com/{source}/{dest}/en/         │
│     Accessed via: Residential Proxies + Headless Chromium       │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. Technology Stack

### Backend
| Technology | Version | Purpose |
|:---|:---|:---|
| **Node.js** | 20.x (Alpine) | Runtime environment |
| **TypeScript** | 5.x | Type-safe development |
| **Express.js** | 4.x | REST API framework |
| **Prisma** | 5.22.0 | Database ORM |
| **Playwright** | Latest | Headless browser automation |
| **Chromium** | 146.x (Alpine) | Browser for VFS bypass |
| **Socket.IO** | 4.x | Real-time WebSocket |
| **BullMQ** | Latest | Job queue management |
| **Winston** | Latest | Logging |
| **bcryptjs** | Latest | Password hashing |
| **jsonwebtoken** | Latest | JWT authentication |
| **node-telegram-bot-api** | Latest | Telegram notifications |

### Frontend
| Technology | Version | Purpose |
|:---|:---|:---|
| **Next.js** | 14.x | React framework |
| **TypeScript** | 5.x | Type safety |
| **Tailwind CSS** | 3.x | Styling |
| **Socket.IO Client** | 4.x | Real-time updates |

### Infrastructure
| Technology | Purpose |
|:---|:---|
| **Docker** | Containerization |
| **Docker Compose** | Service orchestration |
| **PostgreSQL 16** | Primary database |
| **Redis 7** | Caching & job queue |
| **Proxyrack** | Residential proxy provider |
| **2Captcha** | Automated CAPTCHA solving |

---

## 4. Project Structure

```
VFS BOOKING BOT/
├── backend/                          # Node.js API Server
│   ├── src/
│   │   ├── index.ts                  # Entry point — starts server
│   │   ├── app.ts                    # Express app setup, middleware
│   │   ├── config/
│   │   │   ├── database.ts           # Prisma client singleton
│   │   │   ├── env.ts                # Environment variable validation
│   │   │   └── redis.ts              # Redis connection
│   │   ├── middleware/
│   │   │   ├── auth.middleware.ts    # JWT verification
│   │   │   └── errorHandler.ts      # Global error handler
│   │   ├── utils/
│   │   │   ├── jwt.ts                # JWT sign/verify helpers
│   │   │   └── crypto.ts             # AES-256-GCM encryption
│   │   └── modules/
│   │       ├── auth/                 # Login, logout, refresh token
│   │       ├── monitor/              # Core monitoring engine
│   │       │   ├── monitor.service.ts    # Main poll loop
│   │       │   ├── monitor.controller.ts # API routes
│   │       │   └── session.warmer.ts     # Browser bypass logic
│   │       ├── booking/              # Booking management
│   │       ├── profiles/             # Applicant profiles
│   │       ├── notifications/        # Telegram bot
│   │       ├── logs/                 # Event logging
│   │       ├── proxy/                # Proxy management
│   │       ├── captcha/              # CAPTCHA solving
│   │       ├── settings/             # System settings
│   │       ├── engine/               # Automation engine
│   │       └── websocket/            # Real-time socket events
│   ├── prisma/
│   │   ├── schema.prisma             # Database schema definition
│   │   ├── seed.ts                   # Database seeder (Admin only)
│   │   └── migrations/               # Database migration history
│   ├── Dockerfile.dev                # Docker image definition
│   ├── .env                          # Backend environment variables
│   └── package.json
│
├── frontend/                         # Next.js Dashboard
│   ├── src/
│   │   ├── app/                      # Next.js App Router pages
│   │   ├── components/               # Reusable UI components
│   │   └── lib/                      # API client, utilities
│   └── Dockerfile.dev
│
├── docker-compose.dev.yml            # Development Docker config
├── docker-compose.yml                # Production Docker config
├── .env                              # Root environment variables
└── PROJECT_DOCUMENTATION.md         # This file
```

---

## 5. Core Modules

### 5.1 Monitor Module (`monitor.service.ts`)
The heart of the system. This module:

1. **Auto-starts** all active monitors from the database when the backend boots
2. **Polls** the VFS API on a configurable interval (default: 30 seconds)
3. **Detects** available appointment slots
4. **Handles** 403 blocks by triggering the Session Warmer
5. **Manages** cooldown states when VFS is slow or blocking

**Key functions:**
- `autoStartMonitors()` — reads all active bookings on startup and starts monitoring
- `poll(bookingId)` — the core loop that hits VFS API and checks for slots
- `startMonitor(bookingId)` — initializes a new monitor for a specific booking
- `stopMonitor(bookingId)` — gracefully stops a running monitor

**Monitor States:**
- `RUNNING` — Actively checking VFS
- `COOLING_DOWN` — Waiting after a block/error (300 seconds)
- `STOPPED` — Monitor has been manually stopped

---

### 5.2 Session Warmer (`session.warmer.ts`)
When the standard HTTP fetch gets a 403 (blocked), this module fires up a headless Chromium browser to:

1. Navigate to the VFS login page using a **residential proxy**
2. Dismiss cookie banners (OneTrust)
3. Fill in the applicant's login credentials
4. Navigate to the scheduling page
5. Extract the session cookies (XSRF token, session ID)
6. Return cookies to the main monitor for use in subsequent API calls

**Browser Configuration:**
- `--no-sandbox` + `--disable-setuid-sandbox` — Required for Docker
- `--disable-dev-shm-usage` — Uses disk instead of shared memory
- `--disable-gpu` — No GPU needed in headless mode
- `--disable-blink-features=AutomationControlled` — Hides automation detection

---

### 5.3 Auth Module (`auth.service.ts`)
Handles user authentication:

- **Login**: Validates email/password using bcrypt, returns JWT access token (15 min) + refresh token (7 days)
- **Refresh**: Exchanges a valid refresh token for a new access token
- **Logout**: Invalidates the refresh token in the database

---

### 5.4 Notifications Module (`telegram.bot.ts`)
Real-time Telegram notifications for:

- Slot available alerts
- Monitor start/stop events
- Cooldown notifications
- System errors

**Commands available via Telegram:**
- `/status` — Shows all active monitors and their current state
- `/help` — Lists all available commands
- `/profile` — Shows active applicant profiles

---

### 5.5 Profiles Module
Manages applicant profiles securely:

- All sensitive data (passport number, VFS password, date of birth) is **encrypted at rest** using AES-256-GCM
- Each profile is linked to one or more bookings
- Profiles can be marked active/inactive

---

### 5.6 Proxy Module
Manages residential proxy connections via **Proxyrack**:

- Generates unique **sticky session IDs** per request to force IP rotation
- Format: `username-session-{random_string}`
- Ensures each failed attempt gets a fresh IP address

---

## 6. Database Schema

### Users Table
| Field | Type | Description |
|:---|:---|:---|
| `id` | UUID | Primary key |
| `email` | String (unique) | Login email |
| `passwordHash` | String | Bcrypt hashed password |
| `role` | Enum (ADMIN/OPERATOR) | Access level |
| `refreshTokenHash` | String? | SHA-256 of current refresh token |
| `createdAt` | DateTime | Account creation time |

### Profiles Table (Applicants)
| Field | Type | Description |
|:---|:---|:---|
| `id` | UUID | Primary key |
| `fullName` | String | Applicant full name |
| `email` | String (unique) | Applicant email |
| `phone` | String? | Phone number |
| `nationality` | String | Source country code (e.g., `uk`, `usa`) |
| `gender` | Enum | MALE / FEMALE |
| `passportNumberEnc` | String | AES-256 encrypted passport number |
| `vfsPasswordEnc` | String | AES-256 encrypted VFS portal password |
| `dobEnc` | String | AES-256 encrypted date of birth |
| `passportExpiry` | DateTime | Passport expiry date |
| `passportIssueDate` | DateTime | Passport issue date |
| `priority` | Enum | HIGH / NORMAL |
| `isActive` | Boolean | Whether profile is currently active |

### Bookings Table
| Field | Type | Description |
|:---|:---|:---|
| `id` | UUID | Primary key |
| `profileId` | UUID | FK → Profiles |
| `userId` | UUID | FK → Users (who created it) |
| `destination` | String | Destination country (e.g., `portugal`) |
| `visaType` | String | Visa category (e.g., `Tourist Visa`) |
| `status` | Enum | QUEUED / IN_PROGRESS / SUCCESS / FAILED / CANCELLED |
| `attempt` | Int | Number of attempts made |
| `slotDate` | DateTime? | Found slot date (if any) |
| `confirmationNo` | String? | Booking confirmation number |
| `errorMessage` | String? | Last error message |
| `createdAt` | DateTime | When booking was created |
| `completedAt` | DateTime? | When booking was completed |

### Logs Table
| Field | Type | Description |
|:---|:---|:---|
| `id` | UUID | Primary key |
| `timestamp` | DateTime | When event occurred |
| `level` | Enum | INFO / WARN / ERROR |
| `eventType` | Enum | MONITOR_STARTED / IP_BLOCKED / BOOKING_FAILED / SLOT_FOUND / etc. |
| `message` | String | Human-readable log message |
| `profileId` | UUID? | Related profile (if applicable) |
| `destination` | String? | Related destination |
| `proxyUsed` | String? | Proxy IP used |

### Settings Table
| Field | Type | Description |
|:---|:---|:---|
| `key` | String (unique) | Setting name |
| `value` | JSON | Setting value |

**Default Settings:**
- `notifications.telegram.enabled` → `true`
- `captcha.solver` → `manual` (or `twocaptcha`)
- `monitor.defaultIntervalMs` → `30000` (30 seconds)

---

## 7. API Reference

All API endpoints are prefixed with `/api`. Authentication required unless marked public.

### Authentication
| Method | Endpoint | Description |
|:---|:---|:---|
| `POST` | `/api/auth/login` | Login with email/password — returns JWT |
| `POST` | `/api/auth/refresh` | Refresh access token |
| `POST` | `/api/auth/logout` | Invalidate session |

### Profiles (Applicants)
| Method | Endpoint | Description |
|:---|:---|:---|
| `GET` | `/api/profiles` | List all applicant profiles |
| `POST` | `/api/profiles` | Create new applicant profile |
| `GET` | `/api/profiles/:id` | Get specific profile |
| `PUT` | `/api/profiles/:id` | Update profile |
| `DELETE` | `/api/profiles/:id` | Delete profile |

### Bookings (Monitors)
| Method | Endpoint | Description |
|:---|:---|:---|
| `GET` | `/api/bookings` | List all bookings |
| `POST` | `/api/bookings` | Create booking & start monitor |
| `GET` | `/api/bookings/:id` | Get specific booking |
| `DELETE` | `/api/bookings/:id` | Cancel booking & stop monitor |

### Monitor Control
| Method | Endpoint | Description |
|:---|:---|:---|
| `POST` | `/api/monitor/:id/start` | Manually start a monitor |
| `POST` | `/api/monitor/:id/stop` | Manually stop a monitor |
| `GET` | `/api/monitor/status` | Get all monitor states |

### Logs
| Method | Endpoint | Description |
|:---|:---|:---|
| `GET` | `/api/logs` | Paginated log history |
| `GET` | `/api/logs/stream` | (WebSocket) Real-time log stream |

### Settings
| Method | Endpoint | Description |
|:---|:---|:---|
| `GET` | `/api/settings` | Get all settings |
| `PUT` | `/api/settings/:key` | Update a specific setting |

---

## 8. Configuration & Environment Variables

Located in: `d:\VFS BOOKING BOT\.env`

### Server
```env
NODE_ENV=development
PORT=3001
FRONTEND_URL=http://localhost:3000
```

### Database
```env
DATABASE_URL=postgresql://vfsuser:vfspass@localhost:5432/vfsdb
```
*(Inside Docker, `localhost` becomes the service name `postgres`)*

### Redis
```env
REDIS_URL=redis://:redispass@localhost:6379
```

### Authentication (JWT)
```env
JWT_ACCESS_SECRET=<64-byte hex string>     # Access token signing key
JWT_REFRESH_SECRET=<64-byte hex string>    # Refresh token signing key
JWT_ACCESS_EXPIRY=15m                       # Access token lifetime
JWT_REFRESH_EXPIRY=7d                       # Refresh token lifetime
```

### Encryption
```env
PROFILE_ENCRYPTION_KEY=<32-byte hex string>   # AES-256-GCM key for profile data
```

### Proxy (Proxyrack)
```env
PROXY_DEFAULT_PROVIDER=proxyrack
PROXY_HOST=premium.residential.proxyrack.net
PROXY_PORT=10000
PROXY_USERNAME=jennyjones                      # Proxyrack account username
PROXY_PASSWORD=<proxyrack-password>            # Proxyrack account password
```

### Telegram
```env
TELEGRAM_BOT_TOKEN=<bot-token-from-botfather>
TELEGRAM_CHAT_ID=<your-telegram-chat-id>
TELEGRAM_PROXY=http://user:pass@host:port     # Optional: proxy for Telegram
```

### CAPTCHA
```env
TWOCAPTCHA_API_KEY=<your-2captcha-key>        # Leave empty for manual mode
CAPTCHA_SOLVER=twocaptcha                      # Options: twocaptcha | manual
```

### Automation
```env
BOOKING_CONCURRENCY=3                          # Max concurrent booking jobs
MONITOR_DEFAULT_INTERVAL_MS=30000             # Poll interval (30 seconds)
SESSION_DIR=/app/sessions                      # Cookie storage path
BOOKING_MAX_RETRIES=3                          # Max booking retry attempts
```

---

## 9. Docker Setup

### Services in `docker-compose.dev.yml`

| Service | Image | Port | Purpose |
|:---|:---|:---|:---|
| `postgres` | postgres:16-alpine | 5432 | Primary database |
| `redis` | redis:7-alpine | 6379 | Cache & job queue |
| `backend` | Custom (Node + Chromium) | 3001 | API server |
| `frontend` | Custom (Next.js) | 3000 | Web dashboard |

### Backend Docker Image
The backend image (`Dockerfile.dev`) installs:
- Node.js 20 (Alpine base)
- **Chromium** browser + all required system libraries (192 packages)
- Sets `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium`
- `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` (uses system Chromium, not Playwright's bundled one)

### Memory Configuration
- `shm_size: 512mb` — Shared memory for browser (uses disk via `--disable-dev-shm-usage`)
- WSL 2 memory: **6GB** allocated via `C:\Users\HP\.wslconfig`

### Starting the System
```bash
# Start all services
docker-compose -f docker-compose.dev.yml up -d

# View backend logs
docker-compose -f docker-compose.dev.yml logs -f backend

# Stop all services
docker-compose -f docker-compose.dev.yml down

# Full reset (deletes all data)
docker-compose -f docker-compose.dev.yml down -v
```

### Restoring Admin Account (After Volume Reset)
```bash
docker-compose -f docker-compose.dev.yml exec -T backend \
  npx ts-node -r tsconfig-paths/register prisma/seed.ts
```

---

## 10. How the Bot Works

### Step-by-Step Flow

```
1. SYSTEM STARTUP
   └── autoStartMonitors() fires
   └── Reads all QUEUED/IN_PROGRESS bookings from database
   └── Starts a poll loop for each active booking

2. POLL CYCLE (every 30 seconds)
   └── Makes HTTP GET to VFS API:
       https://visa.vfsglobal.com/{source}/{dest}/en/api/get-slots

3a. SUCCESS (200 OK)
   └── Parses available slot dates
   └── If slot found → triggers booking engine
   └── Sends Telegram notification

3b. BLOCKED (403 Forbidden)
   └── Logs: "403 Forbidden — Attempting Browser Warming"
   └── Triggers Session Warmer

4. SESSION WARMER (Browser Bypass)
   └── Launches headless Chromium
   └── Connects via Proxyrack residential proxy (new sticky session = new IP)
   └── Navigates to VFS login page
   └── Dismisses cookie banners
   └── Fills in applicant credentials
   └── Extracts session cookies (XSRF token)
   └── Returns cookies to poll cycle

5a. BROWSER SUCCESS
   └── Poll cycle retries with new cookies
   └── Continues monitoring

5b. BROWSER FAILED (Timeout / 500 Error)
   └── Logs failure + saves screenshot to recordings/latest_failure.png
   └── Enters COOLDOWN state (300 seconds)
   └── After cooldown → automatically retries with fresh proxy IP

6. SLOT FOUND
   └── Telegram alert sent immediately
   └── Booking engine auto-books the slot
   └── Booking status updated to SUCCESS
   └── Monitor stops for that applicant
```

---

## 11. Proxy Strategy

### Provider: Proxyrack Residential Proxies
- **Host**: `premium.residential.proxyrack.net`
- **Port**: `10000`
- **Type**: Rotating Residential (real home IP addresses)

### How IP Rotation Works
Each browser session uses a **unique sticky session ID**:
```
username: jennyjones-session-{random_7_chars}
```
This forces Proxyrack to assign a **new IP address** for every attempt, ensuring that if one IP gets blocked, the next attempt comes from a completely different location.

### Why Residential Proxies?
VFS Global's Cloudflare protection blocks:
- ❌ Datacenter IPs (AWS, Google Cloud, etc.)
- ❌ Known VPN ranges
- ✅ Residential IPs (real home internet connections)

---

## 12. Telegram Bot Commands

| Command | Access | Description |
|:---|:---|:---|
| `/status` | Admin/Operator | Shows all active monitors and their states (Running/Cooling Down/Stopped) |
| `/help` | All | Lists all available commands |
| `/profile` | Admin | Shows current active applicant profiles |

### Status Message Example
```
🤖 VFS Bot Status

👤 Scott Kirk
   📍 UK → Portugal (Tourist Visa)
   🟢 RUNNING — Checking every 30s
   ⏱ Last check: 2 minutes ago

📊 Total Monitors: 1 Active | 0 Cooling | 0 Stopped
```

---

## 13. Frontend Dashboard

**URL**: `http://localhost:3000`

### Pages
| Page | Description |
|:---|:---|
| **Login** | Secure login with JWT authentication |
| **Dashboard / Home** | Overview of all active monitors and recent logs |
| **Active Streams** | Real-time monitor status for all applicants |
| **Applicants** | Add, view, edit, and delete applicant profiles |
| **Logs** | Full event history with filtering by level and type |
| **Settings** | Configure poll interval, captcha mode, notifications |

### Real-time Updates
The dashboard uses **WebSocket (Socket.IO)** to push live updates:
- New log entries appear instantly in the Diagnostic Stream
- Monitor status changes reflect immediately
- No page refresh required

---

## 14. Error Handling & Recovery

| Error | Cause | Bot Response |
|:---|:---|:---|
| `403 Forbidden` | VFS blocked the IP | Browser warming triggered with new proxy IP |
| `500 Internal Server Error` | VFS server overloaded | 300s cooldown, then retry |
| `locator.fill Timeout` | VFS login form didn't load | Screenshot saved, 300s cooldown |
| `page.goto: Target crashed` | Browser OOM (memory issue) | Fixed via WSL 6GB + disk shm |
| `Executable not found` | Chromium not in image | Fixed in Dockerfile.dev (pre-installed) |
| `P3005 Schema not empty` | DB already has tables during migrate | Use `prisma db push` instead |

### Automatic Recovery
- Every error triggers a **300-second cooldown**
- After cooldown, the monitor **automatically retries** with a **new proxy IP**
- No manual intervention is ever needed for standard errors

---

## 15. Operational Guide

### Adding a New Applicant (Step by Step)

1. Open browser → `http://localhost:3000`
2. Login with admin credentials
3. Click **"Applicants"** → **"Add Applicant"**
4. Fill in all required fields:
   - Full Legal Name
   - Email Address (applicant's VFS-registered email)
   - VFS Portal Password
   - Nationality (source country)
   - Destination country
   - Visa Category
   - Passport Number, Issue Date, Expiry Date
   - Date of Birth
5. Click **Save**
6. Navigate to **"Active Streams"** — the monitor will appear automatically

### Monitoring Health
- **Dashboard**: Check the Diagnostic Stream for real-time logs
- **Telegram**: Send `/status` to get instant monitor health report
- **Logs Page**: Filter by ERROR level to see failures only

### Stopping a Monitor
1. Go to **Active Streams**
2. Find the applicant
3. Click **Stop**

### Viewing Failure Screenshots
When the browser warmer fails, a screenshot is saved:
```
d:\VFS BOOKING BOT\backend\recordings\latest_failure.png
```
This shows exactly what VFS was displaying when the failure occurred.

---

## 16. Admin Credentials

| Role | Email | Password |
|:---|:---|:---|
| **Admin** | `admin@vfsbot.local` | `admin1234` |
| **Operator** | `operator@vfsbot.local` | `operator1234` |

> ⚠️ **Security Note**: Change these passwords in production by updating the seed file and re-running the seeder.

---

## 17. Known Behaviors

### "VFS SERVER SLOW (TIMEOUT)" — Normal
This is NOT an error with the bot. VFS occasionally serves 500 errors or loads very slowly. The bot correctly:
1. Detects the slow response
2. Enters 300s cooldown
3. Tries again automatically

### "403 Forbidden on standard fetch" — Normal
Every monitoring cycle starts with a standard HTTP request. VFS almost always blocks this on the first call. The bot then switches to headless browser mode. This is the **expected and correct behavior**.

### Monitor shows "UK → PORTUGAL" — Correct
This means the bot is using the correct VFS portal for UK citizens applying for Portugal visas:
`https://visa.vfsglobal.com/gbr/prt/en/login`

### Bot restarts automatically — By Design
`ts-node-dev` with `--respawn` flag automatically restarts the backend when code changes. This is the development hot-reload feature.

---

## 18. Troubleshooting

### "Invalid Credentials" on Login
**Cause**: Admin account not seeded in database
**Fix**: Run the seeder inside Docker:
```bash
docker-compose -f docker-compose.dev.yml exec -T backend \
  npx ts-node -r tsconfig-paths/register prisma/seed.ts
```

### "Network Error" on Login Page
**Cause**: Backend container not running
**Fix**:
```bash
docker-compose -f docker-compose.dev.yml up -d
docker-compose -f docker-compose.dev.yml ps   # Check all services are "Up"
```

### Docker Won't Start
**Cause**: WSL 2 needs restart after `.wslconfig` change
**Fix**:
```powershell
wsl --shutdown
# Then restart Docker Desktop manually
```

### "Page crashed" in logs
**Cause**: Browser out of memory
**Fix**: Ensure WSL has 6GB RAM in `C:\Users\HP\.wslconfig`:
```ini
[wsl2]
memory=6GB
processors=4
swap=2GB
```

### Bot keeps showing old "Student" monitor
**Cause**: Stale data in Docker volumes
**Fix**: Full volume reset:
```bash
docker-compose -f docker-compose.dev.yml down -v
docker-compose -f docker-compose.dev.yml up -d
# Then re-seed admin account
```

### Check Live Logs
```bash
docker-compose -f docker-compose.dev.yml logs -f backend
```

---

*Documentation prepared for VFS Booking Bot v1.0.0 — April 2026*
*System successfully stabilized, tested, and delivered in production-ready state.*
