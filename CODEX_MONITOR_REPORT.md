# Monitor Redesign Report

## Stage 0 - Baseline OK

- **Status:** PASS
- **Files changed:**
  - CODEX_MONITOR_REPORT.md (+15 / -0)
- **Endpoints added/changed:**
  - None
- **Tests added:**
  - None
- **Verification:**
  - `npm.cmd --prefix backend run build` -> PASS
  - `npm.cmd --prefix frontend run build` -> PASS
  - `npm.cmd --prefix extension run build` -> PASS
- **Manual smoke (if applicable):** Not applicable
- **Surprises / deviations:** PowerShell blocks `npm.ps1` by execution policy, so npm commands are run through `npm.cmd`. Current branch is `main`; I did not switch branches.
- **Time spent:** ~5 minutes
- **Commit at start:** c159af078b073f1569221b053b19ecc75d6fa22a

## Stage 1 - Setup wizard

- **Status:** PASS
- **Files changed:**
  - frontend/src/app/(protected)/setup/page.tsx (+436 / -319)
  - frontend/.eslintrc.json (+6 / -0)
  - CODEX_MONITOR_REPORT.md (+17 / -0)
- **Endpoints added/changed:**
  - None
- **Tests added:**
  - None
- **Verification:**
  - `npm.cmd --prefix frontend run build` -> PASS
  - `npm.cmd --prefix frontend run lint` -> PASS
- **Manual smoke (if applicable):** Screenshot capture skipped. No local browser automation tool was exposed in this session, and `/setup` is auth-protected.
- **Surprises / deviations:** Added minimal `frontend/.eslintrc.json` so `next lint` runs non-interactively. The wizard posts the existing `/monitor/start` payload shape (`visaType`, not a new `visaCategoryCode` field).
- **Time spent:** ~35 minutes

## Stage 3 - PollingRole (PASS after orchestrator unblock)

- **Status:** PASS
- **Files changed by Codex:**
  - backend/prisma/schema.prisma (PollingRole enum + VfsAccount.pollingRole field)
  - backend/prisma/migrations/20260523042315_add_polling_role/migration.sql
  - backend/src/modules/accounts/accounts.controller.ts (PATCH /:id/polling-role)
  - backend/src/modules/accounts/accounts.router.ts (route wiring)
  - backend/src/modules/booking/extension-dispatch.service.ts (booker-only selection, BOOKING_ON_POLLER_ACCOUNT warn)
  - backend/src/modules/monitor/monitor.service.ts (watcher-only polling selection)
  - backend/scripts/smoke-polling-role.ts (smoke harness)
- **Orchestrator unblock fix:**
  - extension-dispatch.service.ts:168 — added explicit `(typeof candidates)[number] | null` annotation on `account` so the `?? null` fallback typechecks (TS was widening the array-element type to non-null and rejecting the `findFirst` reassignment).
- **Endpoints added/changed:**
  - PATCH /api/accounts/:id/polling-role
- **Smoke script result:**
  - `npx tsx scripts/smoke-polling-role.ts` -> exit 0
  - Output: `poller=smoke-watcher-...` `booker=smoke-booker-...` (correct role routing verified)
- **Verification:**
  - `cd backend && npm run build` -> PASS
  - `cd backend && npx prisma migrate status` -> PASS
- **Resumption point:** Stage 4 (loginBatch service + endpoints).

## Stage 4 - Batch auto-login endpoints

- **Status:** PASS
- **Files changed:**
  - backend/src/modules/accounts/loginBatch.service.ts (+137 / -0)
  - backend/src/modules/accounts/accounts.router.ts (+37 / -0)
  - backend/scripts/smoke-login-batch.ts (+66 / -0)
- **Endpoints added/changed:**
  - POST /api/accounts/login-batch - starts a sequential account auto-login batch.
  - GET /api/accounts/login-batch/:jobId - returns current batch progress.
  - POST /api/accounts/login-batch/:jobId/cancel - requests cancellation.
- **Smoke script result:**
  - backend/scripts/smoke-login-batch.ts -> exit 0
  - Output: `states=success,failed,success`
- **Verification:**
  - `cd backend && npm run build` -> PASS
- **Surprises / deviations:** This branch has `accountLoginService.ts` rather than `accountAutoLogin.service.ts`, so the batch service reuses `loginAccount`. The smoke script injects a runner stub through a smoke-only setter.
- **Time spent:** ~25 minutes

## Stage 5 - Login All Stale account-pool button

- **Status:** PASS
- **Files changed:**
  - frontend/src/app/(protected)/account-pool/page.tsx (+154 / -0)
- **Endpoints added/changed:**
  - None; consumes Stage 4 `POST /api/accounts/login-batch`, `GET /api/accounts/login-batch/:jobId`, and cancel endpoint.
- **Smoke script result:**
  - Not applicable.
- **Verification:**
  - `cd frontend && npm run build` -> PASS
  - `cd frontend && npm run lint` -> PASS
- **Surprises / deviations:** Manual smoke skipped; no browser tool was requested/exposed for this stage. Lint exits 0 with existing warning-style output.
- **Time spent:** ~25 minutes

## Stage 6 - PollingRole chips

- **Status:** PASS
- **Files changed:**
  - frontend/src/app/(protected)/account-pool/page.tsx (+38 / -1)
- **Endpoints added/changed:**
  - None; consumes Stage 3 `PATCH /api/accounts/:id/polling-role`.
- **Smoke script result:**
  - Not applicable.
- **Verification:**
  - `cd frontend && npm run build` -> PASS
  - `cd frontend && npm run lint` -> PASS
- **Surprises / deviations:** Existing lint warnings remain outside the changed role-chip code path; lint exits 0.
- **Time spent:** ~15 minutes

## Stage 7 - Final sweep

- **Status:** PASS
- **Files changed:**
  - CODEX_MONITOR_REPORT.md
  - backend/src/modules/accounts/accounts.router.ts
  - backend/src/modules/accounts/loginBatch.service.ts
  - backend/scripts/smoke-login-batch.ts
  - frontend/src/app/(protected)/account-pool/page.tsx
- **Endpoints added/changed:**
  - POST /api/accounts/login-batch
  - GET /api/accounts/login-batch/:jobId
  - POST /api/accounts/login-batch/:jobId/cancel
- **Smoke script result:**
  - backend/scripts/smoke-login-batch.ts -> exit 0
- **Verification:**
  - `cd backend && npm run build` -> PASS
  - `cd frontend && npm run build` -> PASS
  - `cd extension && npm run build` -> PASS
- **Diff stat:**
```text
 CODEX_MONITOR_REPORT.md                            |  49 ++++
 backend/src/modules/accounts/accounts.router.ts    |  36 +++
 frontend/src/app/(protected)/account-pool/page.tsx | 255 ++++++++++++++++++++-
 3 files changed, 338 insertions(+), 2 deletions(-)
```
- **Surprises / deviations:** `git diff --stat HEAD` does not include untracked files, so the new Stage 4 files `backend/src/modules/accounts/loginBatch.service.ts` and `backend/scripts/smoke-login-batch.ts` are not represented in the stat until the orchestrator stages them. Frontend build still prints existing lint warnings, but exits 0.
- **Time spent:** ~10 minutes

## SPA Login Refactor

- **Status:** PASS
- **Files changed:**
  - extension/background/service-worker.ts (+20 / -26)
  - extension/shared/types.ts (+1 / -0)
  - extension/content/vfs-bridge.ts (+76 / -0)
  - frontend/src/app/(protected)/account-pool/page.tsx (+6 / -0)
- **Old code removed:** `chrome.tabs.create` call from `runLoginFlow`
- **New helpers:** `findWarmVfsTab`, `ensureOnLoginPage`, `handleLoginViaSpa`, `LOGIN_VIA_SPA` command
- **Verification:**
  - extension build -> PASS
  - backend build -> PASS
  - frontend build -> PASS
- **Surprises:** The login completion cleanup had to stop removing `activeLoginTabs` tab IDs from Chrome; the SPA path reuses the operator's warm tab, so completion now only clears the correlation map.
- **Time spent:** ~20 minutes
