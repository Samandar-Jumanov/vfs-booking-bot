# Phase 1 — Progress Log (rung-by-rung, evidence-first)

Session start: 2026-05-23. Branch `main`. npm only.
Rule: a rung is GREEN only with its concrete success evidence. No evidence = UNVERIFIED.

---

## Stage A — Autonomous code work

### Task 1 — Port `trustedFill` into the register flow (coordinator, done)
- File: `extension/content/vfs-bridge.ts`.
- Added helper `trustedFillFirst(selectors, value)` (mirrors `typeIntoFirst` but uses `trustedFill` → real chrome.debugger keystrokes).
- Replaced the email / password / confirm-password `typeIntoFirst` calls in `runRegisterSteps` with `trustedFillFirst` (lines 412/420/425). Added a `trustedKey('Tab')` after the fills to mark the form touched, mirroring `runLoginSteps`.
- Left `selectDialCode998()`, the contact (mobile) fill, and the consent-checkbox logic untouched, as instructed.
- Bumped `VFS_BRIDGE_VERSION` → `2026-05-23-register-trustedfill`.
- Evidence: extension `npm run build` compiled successfully (webpack, `content/vfs-bridge.js` 67.5 KiB emitted). Grep confirms `trustedFillFirst` used at lines 412/420/425 inside `runRegisterSteps`.

### Task 2 — Activation outcome logging (Agent 1, done)
- File: `backend/src/modules/accounts/accountActivationService.ts`.
- Added `logEvent` lines (existing winston+Prisma logger) at: link found, `EMAIL_LINK_NOT_RECEIVED`, link-visit status, link-visit failure (>=400), link-visit threw (catch), and final flip to ACTIVE.
- Logging-only; no control-flow change.
- Evidence: backend `npm run build` exit 0.

### Task 3 — Polling probe (Agent 3, done)
- File: `backend/scripts/trigger-poll.ts` (new).
- Mints admin token like `trigger-auto-login.ts`; the monitor module has NO dedicated "poll now" route, so the script does the only supported path: `POST /api/monitor/start` (uzb→lva, mode=manual) → wait → `GET /api/monitor/status`, printing HTTP status + raw body for both. Env-overridable (ACCOUNT_ID, SOURCE, DEST, VISA_TYPE, INTERVAL_MS, WAIT_MS).
- Caveat (from agent): on prod `EXTENSION_BOOKING=true`, real slot JSON only appears in `/status` when the operator's extension is WS-connected with a logged-in VFS tab. Matches the rung-9 precondition.
- Evidence: backend `npm run build` exit 0 (incl. script type-check).

### Task 4 — Auto-logout patch draft (Agent 2, proposal only — held for operator DOM)
- Read-only investigation. No file edits.
- Root cause: `findLogoutSpaElement` assumes the Logout control is already in the DOM, but on the VFS UZ Angular Material SPA it lives inside a closed profile/`mat-menu` that must be opened (trusted-clicked) first — so both the selector pass and the text scan find nothing → `LOGOUT_BUTTON_NOT_FOUND`.
- Proposal: two-phase — find+trusted-click profile/account-menu trigger, `waitForElement` on the CDK overlay panel, THEN scan the open panel for the logout item; distinct error strings for each failure mode.
- ⚠ Open risk flagged: the logout label may be localized (Russian "Выйти" / Uzbek "Chiqish"); current `logout|sign out` regex would MISS it.
- Needs operator DOM dump before applying (DOM-probe one-liner ready). Tracked for Rung 8.

---

## The 0→10 Ladder

| Rung | Test | Status | Evidence |
|---|---|---|---|
| 0 | All 3 builds pass | ✅ GREEN | extension webpack OK; frontend `next build` route table printed; backend `tsc` exit 0 |
| 1 | Backend smoke scripts pass | ⛔ UNVERIFIED-INFRA | `smoke-polling-role.ts` → `Can't reach database server at localhost:5433`. Local dev DB on 5433 is NOT running (Docker off, no docker-compose in repo). Only local PG is `postgresql-x64-17` on default 5432 with unknown creds/schema for this project. NOT a code bug — script + build are valid. Needs operator: how is the 5433 dev DB started? |
| 2 | `trustedFill` in register; type-check green | ✅ GREEN | extension build OK; grep: `trustedFillFirst` at vfs-bridge.ts:412,420,425 inside `runRegisterSteps` |
| 3 | Backend healthy on prod | ✅ GREEN | `GET /api/health/full` → HTTP 200, `{status:ok, postgres ok 7ms, redis ok, account-pool total=11 active=7, profiles active=12}` |
| 4 | Extension connects + cookie sync | ⏸ PENDING OPERATOR | Requires bot Chrome live (see setup below) |
| 5 | One LOGIN | ⏸ PENDING OPERATOR | `trigger-auto-login.ts` → `{"success":true}` |
| 6 | One REGISTER hands-off | ⏸ PENDING OPERATOR | new account row, no manual clicks |
| 7 | Activation last-mile | ⏸ PENDING OPERATOR | PENDING → ACTIVE in list-accounts |
| 8 | Auto-logout works | ⏸ PENDING OPERATOR | bot returns to login form unaided (Agent 2 patch ready to apply after DOM dump) |
| 9 | Slot polling real data | ⏸ PENDING OPERATOR (auth-interceptor wired, build-verified) | `trigger-poll.ts` → HTTP 200 + real slot JSON |
| 10 | One BOOKING end-to-end | ⏸ PENDING OPERATOR | confirmation number + DB row + Telegram |

---

## Notes
- Rungs 0, 2, 3 green autonomously. Rung 1 blocked on local-DB infra (not code). Rungs 4–10 require operator-driven bot Chrome + a non-403 VFS state.
- Stage-A code committed (not pushed — awaiting operator OK).

## Auth interceptor (AUTH_INTERCEPTOR_TASK.md) — fixes the polling 401
Root cause: VFS holds the lift-api bearer in-app (NOT in localStorage), so cookie-only `pollSlot` → 401. Fix (Option A): a MAIN-world sniffer wraps fetch/XHR, captures the real header set VFS sends to `lift-api.vfsglobal.com`, relays via `window.postMessage('vfs-lift-auth')` → content script caches in `liftHeaders` (+ chrome.storage) → `pollSlot` replays them.

Implemented + build-verified (autonomous):
- `extension/content/lift-auth-sniffer.ts` (new, MAIN-world, crash-safe, masks Authorization in logs).
- `webpack.config.js`: entry `content/lift-auth-sniffer` → **emits `dist/content/lift-auth-sniffer.js` (4934 B)**.
- `service-worker.ts`: injects the sniffer MAIN-world at both content-script injection sites; `SW_VERSION=2026-05-24-lift-auth-sniffer`.
- `vfs-bridge.ts`: `liftHeaders` cache + hydrate/persist + `vfs-lift-auth` listener; `pollSlot` merges captured headers, returns `POLL_NO_AUTH_CAPTURED` (status 0) if none seen yet; `VFS_BRIDGE_VERSION=2026-05-24-lift-auth-sniffer`.
- Evidence: `cd extension && npm run build` exit 0; `dist/content/lift-auth-sniffer.js` present.

⚠ **Seeding required (operator):** the sniffer only captures once VFS itself calls lift-api — which happens when the booking/appointment section is opened. So on a logged-in tab, **open "Book/Schedule Appointment" once** to fire a real authenticated lift-api call → sniffer captures headers → subsequent polls reuse them. Until then `pollSlot` returns `POLL_NO_AUTH_CAPTURED`.

Live verification (operator, Rung 9): logged-in VFS tab + F12 closed → open booking once → run `trigger-poll.ts` → expect backend `EXT_POLL_RESULT status=200` with real slot JSON, NOT 401.
