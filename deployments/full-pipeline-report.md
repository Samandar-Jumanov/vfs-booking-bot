# Full Pipeline Report

Date: 2026-05-21
Branch: `main`

## Executive Summary

The code-level pipeline work is partially complete, but the 5 "Done when" criteria are not all met.

Completed:
- Implemented Bug #1 dial-code MDC fallback strategy in the extension.
- Rebuilt the extension successfully.
- Added 14 backend e2e scripts under `backend/scripts/e2e-tests/`.
- Fixed manual cookie injection so `lastWarmedAt` only refreshes when the cookie jar includes `datadome`.
- Fixed `/api/accounts/warmup-status` so `cookieFresh` requires both a recent warm time and a `datadome` cookie.
- Ran the full 14-script e2e runner: 9 passed, 5 skipped, 0 failed.
- Backend, extension, and frontend production builds pass.

Not completed:
- Live VFS/operator Chrome validation was unavailable, so the dial-code dropdown cannot be claimed proven on the real page.
- Auto-create account creation was not validated end-to-end against VFS.
- Real lift-api polling, Telegram delivery, extension booking dispatch, and live notification delivery were skipped because live flags/credentials/connected Chrome were not available.
- Production push/deploy/smoke test was not performed because the full acceptance criteria were not met.

## Bug #1: Material MDC Dial-Code Selector

Changed files:
- `extension/content/vfs-bridge.ts`
- `extension/background/service-worker.ts`
- `extension/background/debugger.helper.ts`
- `deployments/dialcode-debug.md`

Implementation:
- `selectDialCode998` now dumps the `mat-select` structure and rects to Activity Logs.
- It tries trusted debugger clicks against MDC sub-elements in this order:
  1. `.mat-mdc-select-trigger`
  2. `.mat-mdc-select-value`
  3. `.mat-mdc-select-arrow-wrapper`
  4. `.mat-mdc-select-arrow`
  5. `mat-select` host
- It falls back to page-world Angular component access via `window.ng.getComponent(ms).open()`.
- It then falls back to trusted keypresses: `Enter`, `Space`, `ArrowDown`.
- The background service worker now handles `TRUSTED_KEY`.

Verification:
- `npm run build` in `extension`: PASS
- Live VFS proof: BLOCKED, no interactive operator Chrome/VFS register session was available.

## E2E Test Scripts

Added:
- `backend/scripts/e2e-tests/run-all.ts`
- `backend/scripts/e2e-tests/common.ts`
- `backend/scripts/e2e-tests/01-cookie-sync-from-chrome.ts`
- `backend/scripts/e2e-tests/02-manual-cookie-injection.ts`
- `backend/scripts/e2e-tests/03-slot-polling-real-vfs.ts`
- `backend/scripts/e2e-tests/04-slot-detection-telegram-alert.ts`
- `backend/scripts/e2e-tests/05-auto-booking-dispatch.ts`
- `backend/scripts/e2e-tests/06-booking-confirmation-extraction.ts`
- `backend/scripts/e2e-tests/07-account-pool-warming.ts`
- `backend/scripts/e2e-tests/08-multi-account-rotation.ts`
- `backend/scripts/e2e-tests/09-cooldown-after-429.ts`
- `backend/scripts/e2e-tests/10-profile-crud.ts`
- `backend/scripts/e2e-tests/11-notification-preferences.ts`
- `backend/scripts/e2e-tests/12-logs-viewer-export.ts`
- `backend/scripts/e2e-tests/13-vendor-balance-fetching.ts`
- `backend/scripts/e2e-tests/14-datadome-cookie-freshness.ts`

Package script:
- `backend/package.json`: `test:e2e = "tsx -r tsconfig-paths/register scripts/e2e-tests/run-all.ts"`

Full runner result:

| # | Feature | Result | Notes |
|---|---|---:|---|
| 1 | Cookie sync from Chrome to DB | PASS | `EXT_SESSION_SYNC` does not mark warm without `datadome`; marks ACTIVE with `datadome`. |
| 2 | Manual cookie injection | PASS | Fixed during this run; route now preserves stale state without `datadome`. |
| 3 | Real VFS slot polling | SKIP | Requires `E2E_LIVE_VFS=1` and live cookies. |
| 4 | Slot detection to Telegram alert | SKIP | Requires `E2E_LIVE_TELEGRAM=1` and test Telegram credentials/chat. |
| 5 | Auto-booking dispatch | SKIP | Requires `E2E_LIVE_EXTENSION=1` and connected operator Chrome extension. |
| 6 | Booking confirmation extraction | PASS | Regex extraction test passed. |
| 7 | Account pool warming | PASS | Three-account datadome warmup path passed. |
| 8 | Multi-account rotation | SKIP | Script refused to mutate one unrelated ACTIVE account in the DB. |
| 9 | Cooldown after 429 | PASS | Cooldown mutation test passed. |
| 10 | Profile CRUD and bulk upload | PASS | Encrypted fields verified; CRUD and XLSX bulk import passed. |
| 11 | Notification preferences | SKIP | Local setting persistence passed; live Telegram/SMTP/web-push requires `E2E_LIVE_NOTIFICATIONS=1`. |
| 12 | Logs filters and CSV export | PASS | Filtered query and CSV export passed. |
| 13 | Vendor balance fetching | PASS | Provider result shape passed; one transient OnlineSIM network warning was handled. |
| 14 | Datadome freshness detection | PASS | Missing `datadome` stays stale; present `datadome` marks fresh/ACTIVE. |

Summary: 9 passed, 5 skipped, 0 failed.

## Builds

Commands run:
- `npx prisma generate`: PASS
- `npm run build` in `backend`: PASS
- `npm run build` in `extension`: PASS
- `npm run build` in `frontend`: PASS

Additional validation:
- `git diff --check`: PASS, with line-ending warnings only.
- `npm test --workspace=backend`: TIMED OUT after 10 minutes. No passing/failing Jest summary was produced.

## Fixes Made During Validation

### Manual Cookie Injection Freshness

Problem:
- `/api/accounts/inject-cookies` set `lastWarmedAt = now` and `status = ACTIVE` for any non-empty cookie array.
- This violated the requirement that freshness only flips when `datadome` is present.

Fix:
- Added `cookieStoreHasDatadome(cookieStore)` in `backend/src/modules/accounts/accounts.router.ts`.
- Existing accounts now preserve `lastWarmedAt` and `status` when injected cookies lack `datadome`.
- New accounts without `datadome` are created with `lastWarmedAt = null`.
- `warmup-status` now calculates `cookieFresh` from both `lastWarmedAt` freshness and `datadome` presence.

Verification:
- `01-cookie-sync-from-chrome.ts`: PASS
- `02-manual-cookie-injection.ts`: PASS
- `07-account-pool-warming.ts`: PASS
- `14-datadome-cookie-freshness.ts`: PASS

## Remaining Blockers

1. Live operator Chrome/VFS validation is required.
   - Need a running bot Chrome profile with extension loaded.
   - Need to trigger Auto-create from `/account-pool`.
   - Need to observe Activity Logs for `dial-code 998 SELECTED`.

2. Real account auto-create is not proven.
   - Captcha, VFS register submit, email verification, and DB persistence were not executed end-to-end in this session.

3. Real VFS lift-api polling is not proven.
   - Requires live fresh cookies and `E2E_LIVE_VFS=1`.

4. Telegram/SMTP/web-push delivery is not proven.
   - Requires explicit live test flags and test-channel credentials.

5. Auto-booking through the extension is not proven.
   - Requires connected operator extension and a booking page/session.

6. Multi-account rotation was skipped to avoid mutating an unrelated ACTIVE account.
   - Run against an isolated test DB or temporarily remove unrelated ACTIVE accounts.

7. Backend Jest suite needs investigation.
   - It timed out after 10 minutes.

## Done-When Status

| Criterion | Status |
|---|---:|
| 1. `selectDialCode998` opens the panel and selects Uzbekistan(998) every time | BLOCKED: code implemented/builds, live VFS proof missing |
| 2. Auto-create creates one new VfsAccount without manual intervention | BLOCKED: live VFS/operator Chrome proof missing |
| 3. All 14 e2e scripts pass | NOT MET: 9 pass, 5 explicit live-service skips |
| 4. Report exists and states what passed/failed/remains broken | MET |
| 5. Push to `main`, Railway deploys, smoke test production once | NOT MET: not pushed because criteria 1-3 are not satisfied |

## Next Live Validation Commands

From `backend`:

```powershell
npm run test:e2e
$env:E2E_LIVE_VFS='1'; npx tsx -r tsconfig-paths/register scripts/e2e-tests/03-slot-polling-real-vfs.ts
$env:E2E_LIVE_TELEGRAM='1'; npx tsx -r tsconfig-paths/register scripts/e2e-tests/04-slot-detection-telegram-alert.ts
$env:E2E_LIVE_EXTENSION='1'; npx tsx -r tsconfig-paths/register scripts/e2e-tests/05-auto-booking-dispatch.ts
$env:E2E_LIVE_NOTIFICATIONS='1'; npx tsx -r tsconfig-paths/register scripts/e2e-tests/11-notification-preferences.ts
```

Then run Auto-create from `/account-pool` with the bot Chrome launched via `launch-bot-chrome.ps1`.
