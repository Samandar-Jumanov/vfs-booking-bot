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
