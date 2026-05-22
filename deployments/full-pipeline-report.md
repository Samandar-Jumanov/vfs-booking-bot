# Full Pipeline Report

Date: 2026-05-22
Branch: `main`
Commit status: local commits only; not pushed.

## Summary

This pass implemented the production-readiness phases that can be completed from code and local validation without relaunching operator Chrome:

- Phase 1.1: batch account auto-create with sequential in-process queue, 429201 backoff, cancel, websocket progress, and `/account-pool` UI.
- Phase 1.2: extension-driven VFS auto-login, backend `loginAccount(accountId)`, `POST /api/accounts/:id/auto-login`, and six-hour sequential stale-cookie cron.
- Phase 1.3: monitor 401/403 stored-cookie failures trigger one extension auto-login retry, then mark the account stale and notify the operator if retry still fails.
- Phase 2.1: free local passport MRZ OCR via `sharp`, `tesseract.js`, and `mrz`, plus `/profiles` upload/prefill UI.
- Phase 2.2: public `/onboard` flow creates inactive pending-payment profiles and alerts the operator with the customer details and status link.
- Phase 2.3: public `/status/:token` page exposes booking/payment status without personal data.
- Phase 3: dashboard summary widgets, profile-account linking, booking history table, CSV export, and dispatcher preference for profile-linked accounts.

## Validation

Commands run locally:

```powershell
cd backend; npx prisma migrate deploy
cd backend; npm run build
cd extension; npm run build
cd frontend; if (Test-Path .next) { Remove-Item -Recurse -Force .next }; npm run build
cd backend; npm test -- --runInBand src/modules/accounts/accountBatch.service.test.ts src/modules/accounts/accountLoginService.test.ts src/modules/monitor/monitor.service.test.ts src/modules/profiles/passportOcr.service.test.ts src/modules/profiles/profiles.schema.test.ts
cd backend; npm run test:e2e:dry
cd backend; npx jest --runInBand --detectOpenHandles --forceExit
git diff --check
```

Results:

- Backend build: PASS
- Extension build: PASS
- Frontend build: PASS
- Focused new-feature tests: PASS, 5 suites / 24 tests
- Dry e2e harness: PASS, 11 passed / 5 live-gated skipped / 0 failed
- Full backend Jest suite: PASS, 11 suites / 76 tests, run with `--forceExit` because the suite otherwise leaves Redis-related handles open
- `git diff --check`: PASS, line-ending warnings only

## E2E Status

| # | Feature | Dry Result | Live Requirement |
|---|---|---:|---|
| 1 | Cookie sync event contract | PASS | Real login sync still needs operator Chrome/live VFS |
| 2 | Manual cookie injection | PASS | Covered locally |
| 3 | Real lift-api slot polling | SKIP | `E2E_LIVE_VFS=1`, fresh Datadome account, proxy env |
| 4 | Telegram slot alert | SKIP | `E2E_LIVE_TELEGRAM=1`, `TELEGRAM_TEST_CHAT_ID` |
| 5 | Auto-booking dispatch | SKIP | `E2E_LIVE_EXTENSION=1`, `E2E_LIVE_VFS=1`, known slot |
| 6 | Booking confirmation extraction | PASS | Covered locally |
| 7 | Account pool warming | PASS | Covered locally |
| 8 | Multi-account rotation | PASS | Covered locally |
| 9 | 429 cooldown | PASS | Covered locally |
| 10 | Profile CRUD/encryption/bulk upload | PASS | Covered locally after applying migration |
| 11 | Notification preferences | PASS | SMTP/push live flags optional |
| 12 | Logs viewer + CSV export | PASS | Covered locally |
| 13 | Vendor balance fetching | PASS | Live balances require provider keys |
| 14 | Datadome freshness detection | PASS | Covered locally |
| 15a | Auto-register e2e | SKIP | `E2E_LIVE_AUTO_CREATE=1`, auth, connected extension |
| 15b | Cookie sync on login | SKIP | `E2E_LIVE_VFS=1` and operator-approved Chrome/login flow |

## Done-When Status

| Criterion | Status |
|---|---:|
| 1. Create 10 accounts automatically | CODE COMPLETE; live run required due VFS rate limits |
| 2. Auto-login makes all 10 cookieFresh | CODE COMPLETE; requires connected operator Chrome and live VFS |
| 3. Cron refreshes cookies every 6h | CODE COMPLETE; locally build/test validated |
| 4. Passport photo prefills 6 fields | PASS locally, smoke-tested against sample passport |
| 5. `/onboard` creates profile and alerts operator | CODE COMPLETE; Telegram delivery live-gated |
| 6. `/status/:token` shows live status | PASS locally |
| 7. Dashboard summary shows counts | PASS build/UI route validation |
| 8. All 15 e2e scripts pass when flags are set | DRY PASS; live-gated scripts documented |
| 9. Report updated | PASS |
| 10. Backend/frontend/extension builds pass | PASS |
| 11. Local commits only | PASS after commit; no push performed |

## Remaining Live Checks

These require the operator-controlled Chrome window and live service flags:

```powershell
cd backend
$env:E2E_LIVE_VFS='1'; npm run test:e2e
$env:E2E_LIVE_TELEGRAM='1'; $env:TELEGRAM_TEST_CHAT_ID='<test-chat-id>'; npm run test:e2e
$env:E2E_LIVE_EXTENSION='1'; $env:E2E_VFS_SLOT_DATE='<yyyy-mm-dd>'; $env:E2E_VFS_SLOT_TIME='<hh:mm>'; npm run test:e2e
```

Operator Chrome was not relaunched during this pass.
