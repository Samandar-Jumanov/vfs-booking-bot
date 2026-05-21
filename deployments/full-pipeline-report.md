# Finish-Line Pipeline Report

Date: 2026-05-21
Branch: `main`
Commit status: local commit prepared; not pushed.

## Summary

This pass implemented the remaining code/test work that can be completed without controlling the operator Chrome window or live service flags.

Completed:
- Bug X: BrightData certificate install docs and launcher certificate detection.
- Bug Y: Reveal Password endpoint and `/account-pool` UI modal, plus password reveal e2e coverage.
- Bug Z: Stored-cookie lift-api polling path now uses fresh `VfsAccount.cookieStore` cookies through the configured proxy.
- Bug AA: `SLOT_DETECTED` Telegram messages include destination, slot date, and account email; live test routes to `TELEGRAM_TEST_CHAT_ID`.
- Bug BB: Booking dispatch now picks an ACTIVE, cookie-fresh Datadome account and the live booking test requires both VFS and extension live flags plus a known slot.
- Feature scripts 7-14 were strengthened and pass in dry/local mode.
- Backend, frontend, and extension builds pass via npm. Extension also passes via pnpm.

Not completed:
- The live-only acceptance items were not run because this shell does not have live flags/auth/test chat/known slot inputs, and Chrome must not be relaunched by instruction.
- `pnpm -C backend build` is blocked by `pnpm approve-builds` for Prisma/esbuild packages.
- `pnpm -C frontend build` timed out while pnpm was installing/downloading Next dependencies.

## Changes By Bug

### Bug X: BrightData Certificate

Files:
- `launch-bot-chrome.ps1`
- `deployments/brightdata-cert-install.md`

Result:
- Launcher checks Windows certificate stores for a BrightData CA.
- If present, Chrome launches without `--ignore-certificate-errors`.
- If absent, launcher keeps the current workaround and logs a warning.
- Manual operator instructions are documented.

Validation:
- PowerShell parser check passed in the subagent.
- Chrome was not relaunched.

### Bug Y: Cookie Sync + Reveal Password

Files:
- `backend/src/modules/accounts/accounts.router.ts`
- `frontend/src/app/(protected)/account-pool/page.tsx`
- `backend/scripts/e2e-tests/02-manual-cookie-injection.ts`
- `backend/scripts/e2e-tests/15-cookie-sync-on-login.ts`

Result:
- Added `GET /api/accounts/:id/password`, admin-auth protected, returning decrypted password only on demand.
- `/account-pool` now has a per-row `Reveal password` modal with copy buttons and 30 second auto-hide.
- `Open login` copies the email and opens VFS login with `?email=...`.
- Manual cookie injection and warmup status still require `datadome` before marking cookies fresh.
- New live-gated cookie-sync-on-login script exists, but requires explicit permission to launch its own Playwright Chrome via `E2E_ALLOW_TEST_CHROME=1`; default behavior respects the instruction not to relaunch Chrome.

Validation:
- Dry e2e password reveal route coverage: PASS.
- Live cookie login sync: SKIP, requires `E2E_LIVE_VFS=1` and operator-approved test Chrome launch.

### Bug Z: Slot Polling

Files:
- `backend/src/modules/monitor/monitor.service.ts`
- `backend/src/modules/monitor/playwright.fetch.ts`
- `backend/scripts/e2e-tests/03-slot-polling-real-vfs.ts`

Result:
- Monitor hydrates fresh stored `VfsAccount.cookieStore` cookies with `datadome`.
- Stored-cookie lift-api polling uses configured proxy via `HttpsProxyAgent`.
- Polling fails explicitly if stored VFS cookies are used without a configured proxy.
- Live e2e waits for `EXT_POLL_RESULT` with HTTP 200 in logs.

Validation:
- Monitor unit test run by subagent: PASS.
- Local script without live flag: SKIP.

### Bug AA: Telegram Alert

Files:
- `backend/src/modules/notifications/notification.service.ts`
- `backend/src/modules/notifications/telegram.bot.ts`
- `backend/scripts/e2e-tests/04-slot-detection-telegram-alert.ts`

Result:
- `SLOT_DETECTED` Telegram text includes destination, date, and account email.
- Telegram send records last delivery for live assertion.
- With `E2E_LIVE_TELEGRAM=1`, default Telegram sends route to `TELEGRAM_TEST_CHAT_ID` rather than production chat.

Validation:
- Local script without live flag: SKIP.
- Live delivery: not run, requires `E2E_LIVE_TELEGRAM=1`, `TELEGRAM_TEST_CHAT_ID`, and token.

### Bug BB: Auto-Booking

Files:
- `backend/src/modules/booking/extension-dispatch.service.ts`
- `backend/src/modules/engine/engine.service.ts`
- `backend/src/modules/engine/vfs/vfs.navigator.ts`
- `backend/scripts/e2e-tests/05-auto-booking-dispatch.ts`
- `backend/scripts/e2e-tests/06-booking-confirmation-extraction.ts`

Result:
- Extension booking dispatch picks a fresh ACTIVE account containing `datadome`.
- Confirmation extraction avoids capturing label words like `number` or `Reference`.
- Live booking test requires `E2E_LIVE_EXTENSION=1`, `E2E_LIVE_VFS=1`, and `E2E_VFS_SLOT_DATE`/`E2E_VFS_SLOT_TIME`.
- If a real slot is unavailable, the script reports `blocked-on-real-slot`.

Validation:
- Confirmation extraction: PASS.
- Live booking: SKIP, requires live extension/VFS and a known slot.

## E2E Status

Dry command:

```powershell
npx tsx -r tsconfig-paths/register scripts/e2e-tests/run-all.ts --dry
```

Result: 11 passed, 5 skipped, 0 failed.

| # | Feature | Dry Result | Live Requirement / Next Action |
|---|---|---:|---|
| 1 | Cookie sync event contract | PASS | Run real login sync after operator opens Chrome/login tabs. |
| 2 | Manual cookie injection + Reveal Password route | PASS | UI path still needs operator browser QA. |
| 3 | Real lift-api slot polling | SKIP | Set `E2E_LIVE_VFS=1`; needs at least one fresh Datadome account and proxy env. |
| 4 | Telegram slot alert | SKIP | Set `E2E_LIVE_TELEGRAM=1` and `TELEGRAM_TEST_CHAT_ID`. |
| 5 | Auto-booking dispatch | SKIP | Set `E2E_LIVE_EXTENSION=1`, `E2E_LIVE_VFS=1`, `E2E_VFS_SLOT_DATE`, `E2E_VFS_SLOT_TIME`. |
| 6 | Confirmation extraction | PASS | Covered locally. |
| 7 | Account pool 12h freshness | PASS | Covered locally. |
| 8 | Multi-account rotation | PASS | Now isolates test accounts. |
| 9 | 429 cooldown | PASS | Covered locally. |
| 10 | Profile CRUD/encryption/bulk upload | PASS | Covered locally through API/service path. |
| 11 | Notification preferences | PASS | SMTP requires `E2E_LIVE_SMTP=1`; push requires `E2E_LIVE_PUSH=1`. |
| 12 | Logs list + CSV export | PASS | Covered via endpoints. |
| 13 | Vendor balance fetching | PASS | Live non-null balances require `E2E_LIVE_VENDOR_BALANCE=1` and provider keys. |
| 14 | Datadome freshness detection | PASS | Covered locally. |
| 15a | Auto-register e2e | SKIP | Set `E2E_LIVE_AUTO_CREATE=1`, `E2E_BASE_URL`, `E2E_AUTH_TOKEN`; operator extension must be connected. |
| 15b | Cookie sync on login | SKIP | Set `E2E_LIVE_VFS=1` and `E2E_ALLOW_TEST_CHROME=1`, or run manually with operator Chrome. |

## Build Status

Passing:
- `npm run build` in `backend`: PASS
- `npm run build` in `frontend`: PASS
- `npm run build` in `extension`: PASS
- `pnpm -C extension build`: PASS

Blocked:
- `pnpm -C backend build`: blocked before build by `ERR_PNPM_IGNORED_BUILDS`; requires `pnpm approve-builds` for Prisma/esbuild-related packages.
- `pnpm -C frontend build`: pnpm dependency install timed out downloading Next/SWC packages. Existing npm build passes.

Additional:
- `git diff --check`: PASS, line-ending warnings only.

## Done-When Status

| Criterion | Status |
|---|---:|
| 1. Auto-register works end-to-end, 3 consecutive ACTIVE rows | BLOCKED: needs live auto-create flags/auth and connected operator extension |
| 2. At least one account cookieFresh within 60s via cookie-sync e2e | BLOCKED: needs live VFS login/Chrome; script exists and is gated |
| 3. Real lift-api polling returns 200 | BLOCKED: needs live fresh cookies/proxy and `E2E_LIVE_VFS=1` |
| 4. Telegram test-chat delivery confirmed | BLOCKED: needs `E2E_LIVE_TELEGRAM=1` and `TELEGRAM_TEST_CHAT_ID` |
| 5. Booking dispatch passes or blocked-on-real-slot documented | DOCUMENTED: script reports `blocked-on-real-slot` when no known slot is provided |
| 6. All e2e scripts pass with live flags; skips documented | PARTIAL: dry suite 11 pass / 5 skip; live flags missing |
| 7. Report updated | MET |
| 8. Builds pass with requested pnpm commands | PARTIAL: npm builds pass; pnpm backend/frontend blocked as above |
| 9. Local commits only, no push | MET after local commit |

## Recommended Next Actions

1. Operator installs BrightData CA using `deployments/brightdata-cert-install.md`, then launches Chrome normally.
2. Operator uses `/account-pool` Open login + Reveal password for one account and confirms cookieFresh flips.
3. Run live tests in order:

```powershell
cd backend
$env:E2E_LIVE_VFS='1'; npx tsx -r tsconfig-paths/register scripts/e2e-tests/03-slot-polling-real-vfs.ts
$env:E2E_LIVE_TELEGRAM='1'; $env:TELEGRAM_TEST_CHAT_ID='<test-chat>'; npx tsx -r tsconfig-paths/register scripts/e2e-tests/04-slot-detection-telegram-alert.ts
$env:E2E_LIVE_EXTENSION='1'; $env:E2E_VFS_SLOT_DATE='<yyyy-mm-dd>'; $env:E2E_VFS_SLOT_TIME='<hh:mm>'; npx tsx -r tsconfig-paths/register scripts/e2e-tests/05-auto-booking-dispatch.ts
```

4. Run `pnpm approve-builds` if pnpm builds are required as the canonical build path.
