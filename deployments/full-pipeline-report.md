# Full Pipeline Report

Date: 2026-05-21
Branch: `main`

## Executive Summary

This run fixed the original post-submit detection blocker and added the pending-account safety net, but the full "Done when" criteria are not all green.

Completed:
- Fix A: VFS UZ post-submit success panel is now detected. The live snapshot showed the success-panel prefix `Almo`, matching the real phrase `Almost there`; `isEmailVerificationStep()` now matches `almost there`.
- Fix B: auto-create now persists generated credentials before extension dispatch as a `PENDING` `VfsAccount`, then flips the same row to `ACTIVE` after email verification. Failed attempts stay recoverable.
- Fix C: debugger attach failures and trusted-click failures now clearly tell the operator to close DevTools on the VFS tab.
- Added/updated 15 e2e scripts and added `test:e2e:dry`.
- Backend, extension, and frontend production builds pass.
- Dry e2e suite passes its deterministic coverage: 9 passed, 6 skipped, 0 failed.

Not completed:
- 3 consecutive full Auto-create runs did not pass. Live Fix A validation reached `[REGISTER-TRACE] submitted, handing off to backend for email link`, then the backend returned `409` because `EMAIL_LINK_NOT_RECEIVED`.
- Live e2e scripts requiring `E2E_LIVE_*`, `E2E_BASE_URL`, and `E2E_AUTH_TOKEN` could not be run from this shell because those env vars were missing.
- Real Telegram, SMTP/web-push delivery, live VFS lift-api polling, and live extension booking dispatch remain unproven.

## Fix A: Post-Submit Success Detection

Changed files:
- `extension/content/vfs-bridge.ts`
- `deployments/post-submit-actual.md`

Implementation:
- Added `almost there` to `isEmailVerificationStep()`.
- Kept the existing fallback matchers for verification email, check inbox, successfully created, activation, and related variants.
- Added `postSubmitBodySample()` so future page snapshots focus around known success text instead of losing the useful text to truncation.
- Bumped the content script version marker to `2026-05-21-success-detection-v13`.

Live evidence:
- `/logs` captured `post-submit page snapshot` with `hasEmailField:false`.
- `/logs` captured `[REGISTER-TRACE] submitted, handing off to backend for email link`.
- The later auto-create response failed with `EMAIL_LINK_NOT_RECEIVED`, so post-submit detection is fixed but activation was blocked by email-link retrieval.

## Fix B: Pending Account Persistence

Changed files:
- `backend/prisma/schema.prisma`
- `backend/prisma/migrations/20260521120000_new_pending_status/migration.sql`
- `backend/src/modules/accounts/accountAutoRegister.service.ts`
- `backend/src/modules/accounts/accounts.router.ts`
- `frontend/src/app/(protected)/account-pool/page.tsx`

Implementation:
- Added `PENDING` to `AccountStatus`.
- `autoRegisterAccount()` now creates a `VfsAccount` row with encrypted password, phone, SMS external id, and `PENDING` status before dispatching to the extension.
- Success path updates the same row to `ACTIVE`.
- Dispatch timeout, form timeout, email-link timeout, and visit failures leave the row `PENDING`.
- `/api/accounts/recover-from-mailsac` now accepts `{ accountId }`, decrypts the stored password server-side, polls for the link, and activates pending rows.
- `/account-pool` shows pending count/status and a `Retry activation` action.

## Fix C: DevTools Conflict UX

Changed files:
- `extension/background/debugger.helper.ts`
- `extension/content/vfs-bridge.ts`

Implementation:
- `debuggerAttach()` timeout/failure errors now explicitly mention that DevTools may be open on the VFS tab.
- Trusted-click failures show this operator banner:
  `Bot click blocked. Close DevTools on this VFS tab and retry Auto-create. (Open DevTools on a different tab - e.g. the dashboard - instead.)`

## E2E Test Scripts

Updated runner:
- `backend/package.json`: `test:e2e`
- `backend/package.json`: `test:e2e:dry`
- `backend/scripts/e2e-tests/run-all.ts`
- `backend/scripts/e2e-tests/common.ts`

Scripts now covered:

| # | Feature | Result | Notes |
|---|---|---:|---|
| 1 | Cookie sync from Chrome to backend | PASS | Dry contract verifies datadome is required for freshness. |
| 2 | Manual cookie injection | PASS | Missing datadome preserves stale state; datadome marks fresh. |
| 3 | Real lift-api slot polling | SKIP | Requires `E2E_LIVE_VFS=1` and fresh live cookies. |
| 4 | Slot detection to Telegram alert | SKIP | Requires `E2E_LIVE_TELEGRAM=1` and test Telegram settings. |
| 5 | Auto-booking dispatch | SKIP | Requires `E2E_LIVE_EXTENSION=1` and connected operator Chrome. |
| 6 | Booking confirmation extraction | PASS | Snapshot/parser contract passes. |
| 7 | Account pool warming over 12h | PASS | Stale/fresh window contract passes. |
| 8 | Multi-account rotation | SKIP | Refused to mutate 1 unrelated ACTIVE account in the DB. |
| 9 | 429 cooldown | PASS | Cooldown contract passes. |
| 10 | Profile CRUD | PASS | CRUD, encryption, and bulk import contract pass. |
| 11 | Notification channels | SKIP | Local settings pass; live delivery requires `E2E_LIVE_NOTIFICATIONS=1`. |
| 12 | Logs viewer + CSV export | PASS | Filter and CSV contract pass. |
| 13 | Vendor balance fetching | PASS | Provider result-shape contract passes. |
| 14 | Datadome cookie freshness detection | PASS | Missing/present datadome behavior passes. |
| 15 | Fix A post-submit detection | SKIP in dry suite | Live run reached handoff, but ACTIVE persistence failed with `EMAIL_LINK_NOT_RECEIVED`. |

Dry command run:

```powershell
npm.cmd run test:e2e:dry
```

Result: 9 passed, 6 skipped, 0 failed.

Live env availability in this shell:
- `E2E_LIVE_AUTO_CREATE`: missing
- `E2E_LIVE_VFS`: missing
- `E2E_LIVE_TELEGRAM`: missing
- `E2E_LIVE_EXTENSION`: missing
- `E2E_LIVE_NOTIFICATIONS`: missing
- `E2E_BASE_URL`: missing
- `E2E_AUTH_TOKEN`: missing
- `TELEGRAM_TEST_CHAT_ID`: missing

## Builds

Commands run:

```powershell
npm.cmd run build
```

Results:
- Backend build: PASS
- Extension build: PASS
- Frontend build: PASS

Additional validation:
- `git diff --check`: PASS, with line-ending warnings and an existing user-level git-ignore permission warning.
- Frontend build warning: Google Fonts stylesheet optimization was skipped because the stylesheet download failed; build still completed.

## Remaining Blockers

1. Email verification link retrieval is now the blocker after Fix A.
   - Evidence: live Auto-create reached `submitted, handing off to backend for email link`.
   - Failure: backend returned `409` / `EMAIL_LINK_NOT_RECEIVED`.
   - Next check: inspect Mailsac/custom email provider list/read behavior for the exact generated inbox and confirm whether the Welcome email body is reachable by `fetchEmailVerificationLink()`.

2. Three consecutive full Auto-create runs are not proven.
   - Required after email-link retrieval is fixed.
   - The already-running Chrome may need the extension reloaded so content script `v13` is active.

3. Live e2e tests are not runnable from this shell without explicit live env vars and auth.
   - Required vars are listed above.

4. Multi-account rotation needs an isolated test DB or an opt-in flag.
   - The script intentionally refused to mutate one unrelated ACTIVE production account.

## Done-When Status

| Criterion | Status |
|---|---:|
| 1. Auto-create creates a new ACTIVE row across 3 consecutive runs | NOT MET: post-submit handoff works; email link retrieval failed |
| 2. Pending account recovery flow is live | MET at code/build level |
| 3. All 15 e2e scripts pass with appropriate live flags | NOT MET: dry suite 9 pass / 6 skip; live flags missing |
| 4. Report is updated with results | MET |
| 5. All builds pass on latest commit | MET |
| 6. Commit but do not push | Pending commit |

## Next Validation

After fixing email-link retrieval and reloading the extension:

```powershell
cd backend
npm.cmd run test:e2e:dry
$env:E2E_LIVE_AUTO_CREATE='1'; $env:E2E_BASE_URL='https://backend-production-24c3.up.railway.app'; $env:E2E_AUTH_TOKEN='<operator token>'; npm.cmd run test:e2e -- 15-fix-a-post-submit-detection.ts
```

Then run three consecutive Auto-create attempts from `/account-pool` and verify each creates an `ACTIVE` row.
