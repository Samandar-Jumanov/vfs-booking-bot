# Fleet Coordination Update

Updated: 2026-06-11

## What Changed

Added a practical coordination layer for the existing 10-12 Windows VPS fleet so boxes can monitor, book, and create accounts without repeatedly burning VFS/Datadome trust.

The main goals addressed:

- Stop immediately when a VPS shows throttle/block/page-withholding signals.
- Track each VPS live status in the dashboard.
- Centralize burst-window configuration.
- Prevent two boxes from driving the same VFS account at the same time.
- Keep creator, watcher, and booker roles separate.

## Root Cause Addressed

The blocker is not installation. The system was already able to run, but VFS/Datadome trust is limited per IP/session. Repeated retries after signals like `429201`, `403201`, `/page-not-found`, `form_not_rendered`, Turnstile not enabling, or login/page withholding make a box worse.

The update makes workers stop active flows and cool down instead of continuing to retry.

## Backend Updates

### Added Prisma Models

Updated `backend/prisma/schema.prisma` with:

- `WorkerBoxRole`
- `WorkerBoxStatus`
- `WorkerBox`
- `AccountLease`
- `VfsAccount.leases`

Added migration:

```text
backend/prisma/migrations/20260611090000_add_fleet_coordination/migration.sql
```

### Added Fleet API

Added:

```text
backend/src/modules/fleet/fleet.router.ts
```

Registered in:

```text
backend/src/app.ts
```

New API surface:

- `GET /api/fleet/status`
- `GET /api/fleet/burst-config`
- `PUT /api/fleet/burst-config`
- `POST /api/fleet/worker/heartbeat`
- `POST /api/fleet/worker/cooldown`
- `POST /api/fleet/worker/leases/acquire`
- `POST /api/fleet/worker/leases/release`
- `POST /api/fleet/worker/creation-event`

Dashboard endpoints require normal auth. Worker write endpoints use the existing `WORKER_TOKEN` bearer pattern.

## Worker Updates

Updated:

```text
backend/scripts/orchestrator-worker.ts
```

Added:

- Per-box heartbeat into `WorkerBox`.
- Box roles: `CREATOR`, `WATCHER`, `BOOKER`, `COOLDOWN`, `OFFLINE`.
- Box status: `ONLINE`, `WORKING`, `COOLDOWN`, `OFFLINE`.
- Stop-on-throttle behavior.
- Account leases before driving watcher accounts.
- Separate leases for paired booker accounts.
- Lease heartbeats/extension while the worker is alive.
- Lease expiry if a worker dies.
- Box cooldown on IP/session trust-loss signals.
- Creator success/failure counters.
- Dashboard burst config loading from DB into Python env.

Trust-loss signals now stop the active flow and mark the box cooling down:

- `429201`
- `429202`
- `403`
- `403201`
- `rate_limit`
- `datadome`
- `page_not_found`
- `/page-not-found`
- `form_not_rendered`
- `register never enabled`
- `turnstile`
- `login_failed`
- `budget_rate_limit`
- `budget_exhausted`
- `session_invalid`

Important distinction:

- `429001` remains account-level and can still use account rotation.
- IP/session-level failures now cool down the whole box.

## Frontend Updates

Added dashboard page:

```text
frontend/src/app/(protected)/fleet/page.tsx
```

Updated sidebar:

```text
frontend/src/components/layout/ModernSidebar.tsx
```

New dashboard route:

```text
/fleet
```

The Fleet Status page shows:

- box ID
- role
- online/offline heartbeat
- assigned account
- last successful check
- last error/block reason
- cooldownUntil
- current URL if reported
- creator success/failure count
- active account leases
- burst-window configuration

## Burst Window Config

Dashboard config is stored in `Settings` under:

```text
fleet_burst_config
```

Default example:

```json
{
  "timezone": "Asia/Tashkent",
  "windows": [{ "start": "11:55", "end": "12:15" }],
  "burstIntervalSeconds": 3,
  "idleIntervalSeconds": 300,
  "staggerSeconds": 0
}
```

The worker reads this setting and passes it to `nodriver-spike/auto_pipeline.py` as:

- `BURST_WINDOWS`
- `BURST_TZ`
- `BURST_INTERVAL`
- `IDLE_INTERVAL`

If a VPS already sets those env vars directly, local env overrides DB config.

## Rollout Commands

On Railway/backend production DB:

```powershell
Set-Location .\backend
npx.cmd prisma migrate deploy
npx.cmd prisma generate
```

On each VPS after pulling:

```powershell
git pull
npm.cmd install
npm.cmd run build --workspace=backend
```

Watcher example:

```powershell
$env:BOX_ID='box1'
$env:BOX_COUNT='10'
$env:BOX_ROLE='WATCHER'
$env:WORKER_DIRECT='1'
$env:AUTO_STAGGER='1'
$env:BOOKING_ONLY='1'
$env:POOL_MIN='0'
$env:BOX_COOLDOWN_MIN='120'
Set-Location .\backend
npx.cmd tsx scripts/orchestrator-worker.ts
```

Creator example:

```powershell
$env:BOX_ID='creator1'
$env:BOX_ROLE='CREATOR'
$env:WORKER_MODE='pool_builder'
$env:POOL_MIN='10'
$env:REG_INTERVAL_MIN='20'
$env:MAX_REG_PER_DAY='10'
$env:REGISTER_STAGGER_SEC='120'
$env:BOX_COOLDOWN_MIN='120'
Set-Location .\backend
npx.cmd tsx scripts/orchestrator-worker.ts
```

## Verification Already Run

Passed:

```powershell
npx.cmd prisma generate
npx.cmd prisma validate
npm.cmd run build --workspace=backend
Set-Location .\frontend
npm.cmd run build
```

Frontend build still reports pre-existing warnings unrelated to this change:

- setup page hook dependency warning
- app layout font warning
- status page hook dependency warning
- CaptchaModal image warning

## Still Needs Live Validation

These require real VPS/VFS operation:

- Confirm every VPS appears on `/fleet`.
- Confirm cooled-down boxes stop active flows and do not keep retrying.
- Confirm overlapping boxes cannot lease the same account.
- Confirm watcher and booker leases both appear during watcher/booker operation.
- Confirm burst config appears in Python logs as `BURST: windows parsed`.
- Confirm a throttled creator box stops and enters cooldown after page withholding.

## Operational Notes

- Do not run large creation batches.
- Use one-account gate tests on creator boxes.
- Recommended creator batch behavior remains `REGISTER_COUNT=10`, max 15, `REGISTER_STAGGER_SEC=120`.
- Keep booker accounts clean and do not use them for noisy checking.
- Do not mark accounts `ACTIVE` unless VFS activation/login is confirmed.
- Do not commit generated password reports or credential exports.
