# Pipeline Build Report

Generated: 2026-05-26  
Branch: main  
All plans implemented. `npx tsc --noEmit` clean. 57 unit tests green. No live VFS calls made.

---

## Plan 1 — Lifecycle Core (types, state machine, pacer)

**Status: COMPLETE**

| File | Description |
|---|---|
| `backend/src/modules/lifecycle/types.ts` | LifecycleState, ResultCode, DriverResult, LifecycleEvent, PacerConfig, AccountTiming |
| `backend/src/modules/lifecycle/state-machine.ts` | `nextState(current, event, ctx) → Transition` — pure function, no I/O |
| `backend/src/modules/lifecycle/pacer.ts` | `isDue`, `pickNextDue`, `permitsGlobalAction` — pure functions |
| `backend/src/modules/lifecycle/__tests__/state-machine.test.ts` | State machine tests |
| `backend/src/modules/lifecycle/__tests__/pacer.test.ts` | Pacer tests |

**Tests: 16** (state-machine: 10, pacer: 6)

**Commits:**
- `a9ba420` feat(lifecycle): core types
- `3d51d9d` feat(lifecycle): state machine register transitions
- `b139396` feat(lifecycle): activate/login/429/cooldown/stale transitions
- `9cb4621` feat(lifecycle): pacer

---

## Plan 2 — Persistence + LifecycleService + MockDriver

**Status: COMPLETE**

| File | Description |
|---|---|
| `backend/src/modules/lifecycle/browser-driver.ts` | BrowserDriver interface (register/login/logout/book/isReady) |
| `backend/src/modules/lifecycle/mock-browser-driver.ts` | Queue-based mock: enqueue* methods, default OK |
| `backend/src/modules/lifecycle/account-repo.ts` | AccountRepo interface + MockAccountRepo (in-memory) |
| `backend/src/modules/lifecycle/lifecycle.service.ts` | LifecycleService.tick() — stale WARM, pickNextDue, driveAccount |
| `backend/src/modules/lifecycle/lifecycle.scheduler.ts` | node-cron 30s tick, gated by LIFECYCLE_ENABLED=false |
| `backend/prisma/migrations/20260526100000_lifecycle_state/migration.sql` | Adds lifecycleState, attemptCount, lastAttemptAt, restrictedReason, lastError to VfsAccount |
| `backend/src/config/env.ts` | Added LIFECYCLE_ENABLED: z.coerce.boolean().default(false) |
| `backend/src/modules/lifecycle/__tests__/lifecycle.service.test.ts` | LifecycleService tests |

**Tests: 9** (lifecycle.service: 9)

**Commits:**
- `255a5ed` feat(lifecycle): BrowserDriver interface, MockBrowserDriver, AccountRepo
- `dfe1eb6` feat(lifecycle): prisma schema — LifecycleStateEnum + VfsAccount fields
- `8611754` feat(lifecycle): LifecycleService.tick() with in-memory repo + sessionFreshnessMs
- `318e5b8` feat(lifecycle): scheduler tick (LIFECYCLE_ENABLED=false by default)

---

## Plan 3 — ExtensionDriver + MailsacActivator + CaptchaSolver

**Status: COMPLETE**

| File | Description |
|---|---|
| `backend/src/modules/lifecycle/extension-driver.ts` | ExtensionDriver (DI-based), mapReasonToCode export |
| `backend/src/modules/lifecycle/mailsac-activator.ts` | ActivatorFn wrapping fetchEmailVerificationLink + visitActivationLink |
| `backend/src/modules/lifecycle/captcha-solver.ts` | Thin wrapper around existing solveTurnstile (null on failure) |
| `backend/src/modules/lifecycle/__tests__/extension-driver.test.ts` | mapReasonToCode + ExtensionDriver tests |

**Tests: 18** (extension-driver: 18)

**EXT → DriverResult mapping implemented:**

| Reason string contains | ResultCode |
|---|---|
| `429001` | `429001` |
| `429202` | `429202` |
| `TURNSTILE` | `TURNSTILE_FAILED` |
| `INVALID_CRED` or `WRONG_PASSWORD` | `INVALID_CREDS` |
| `NO_WARM_TAB` or `NO_TAB` | `NO_WARM_TAB` |
| `OFFLINE` or `NOT_CONNECTED` | `OPERATOR_OFFLINE` |
| `TIMEOUT` | `TIMEOUT` |
| anything else | `UNKNOWN` |

**Design note:** `ExtensionDriver.register()` returns `UNKNOWN` with a clear message — the register flow is handled by the existing `accountAutoRegister.service` via `ActivatorFn` injection in `LifecycleService`. This is intentional.

**Commits:**
- `5fe70a5` feat(lifecycle): ExtensionDriver + EXT→DriverResult mapping (DI, no live WS)
- `d4c5449` feat(lifecycle): MailsacActivator + CaptchaSolver wrappers

---

## Plan 4 — Booking Pipeline (SlotWatcher, SessionKeepalive, BookingPipeline)

**Status: COMPLETE**

| File | Description |
|---|---|
| `backend/src/modules/lifecycle/slot-watcher.ts` | SlotWatcher: first observation = baseline, subsequent = positive diff only |
| `backend/src/modules/lifecycle/session-keepalive.ts` | SessionKeepalive: configurable intervalMs, onSessionExpired callback |
| `backend/src/modules/lifecycle/booking.pipeline.ts` | BookingPipeline: LRU WARM selection, 429→state machine, saveTransition for LRU tracking |
| `backend/src/modules/lifecycle/__tests__/slot-watcher.test.ts` | SlotWatcher tests |
| `backend/src/modules/lifecycle/__tests__/session-keepalive.test.ts` | SessionKeepalive tests |
| `backend/src/modules/lifecycle/__tests__/booking.pipeline.test.ts` | BookingPipeline tests |

**Tests: 14** (slot-watcher: 4, session-keepalive: 4, booking.pipeline: 6)

**Commits:**
- `0fbd6ca` feat(booking): SlotWatcher
- `161cbb5` feat(booking): SessionKeepalive
- `d948a04` feat(booking): BookingPipeline

---

## Summary

| Plan | Tests | TypeScript | Status |
|---|---|---|---|
| Plan 1 — Core types + state machine + pacer | 16 | Clean | DONE |
| Plan 2 — Persistence + LifecycleService + MockDriver | 9 | Clean | DONE |
| Plan 3 — ExtensionDriver + MailsacActivator + CaptchaSolver | 18 | Clean | DONE |
| Plan 4 — SlotWatcher + SessionKeepalive + BookingPipeline | 14 | Clean | DONE |
| **Total** | **57** | **0 errors** | |

---

## Needs Live VFS Validation

None of the following has been run against VFS. These items require a real operator session on a clean UZ IP with a non-restricted account pool:

1. **Auto-register end-to-end** — `ExtensionDriver` `register()` stub is intentional; the real path is `accountAutoRegister.service` → `BG_REGISTER_VFS_ACCOUNT` WS → extension form fill. Validate that `ActivatorFn` receives the correct accountId after the WS flow completes.

2. **Auto-activate end-to-end** — `mailsacActivator` calls `fetchEmailVerificationLink` + `visitActivationLink`. Validate that the Mailsac API key is configured, the activation email arrives within the pacer window, and `visitActivationLink` returns HTTP 2xx.

3. **Auto-login end-to-end** — `ExtensionDriver.login()` calls `loginAccount(accountId)` which wraps `BG_LOGIN_VFS_ACCOUNT`. Validate the WS round-trip, that `lastWarmedAt` is populated, and that the `WARM` state persists correctly in the DB after `saveTransition`.

4. **Booking end-to-end** — `BookingPipeline.book()` calls `ExtensionDriver.book()` → `bookAccount()` → `BG_BOOK_VFS_ACCOUNT` WS → extension `runBookingSteps`. Validate all 5 booking steps complete, `confirmationNumber` is returned, and DB state reflects the booking.

5. **SessionKeepalive endpoint** — `session-keepalive.ts` calls a configurable keepalive function. Validate which VFS endpoint the slot-dropdown refresh actually hits (it may be the rate-limited slot endpoint), and confirm `intervalMs` is safely above the per-account 60-90s floor before enabling in production.

6. **429001 quarantine path** — Validate that a real `429001` response from VFS triggers `RESTRICTED` state with a 6-hour cooldown, that `saveTransition` persists correctly, and that the account is not retried during the cooldown window.

7. **429202 cooldown path** — Validate that a real `429202` (IP/session-level) response triggers a 2-hour cooldown and rotates correctly in production with IP rotation.

8. **Prisma migration deploy** — `migration.sql` was created but NOT deployed (`prisma migrate deploy` not run). Run in a staging environment before production.

9. **`LIFECYCLE_ENABLED=true` smoke test** — `startLifecycleScheduler` has never fired with real data. Run one complete register→activate→login cycle on a fresh test account with `LIFECYCLE_ENABLED=true` and one test account in `NEW` state before enabling for the full pool.
