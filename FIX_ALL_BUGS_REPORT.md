# Fix All Bugs Report — v0.2.7

Build verified: extension typecheck ✅ · extension webpack ✅ · backend typecheck ✅

---

## Task 1 — Turnstile auto-login wall ✅

**Root cause:** `lift-auth-sniffer.ts` captured Turnstile callbacks by wrapping `turnstile.render()`. VFS uses *implicit* rendering (an HTML element with `data-callback="globalFnName"`), so `turnstile.render()` is never called on login. `tsCallbacks[]` stays empty; firing them does nothing; Sign In stays disabled.

**Fix:** Inside the `vfs-apply-turnstile` message handler in `lift-auth-sniffer.ts` (MAIN world), after calling any captured `tsCallbacks`, look up the `data-callback` global directly:

```ts
try {
  const widget = document.querySelector<HTMLElement>('[data-callback]');
  const cbName = widget?.getAttribute('data-callback');
  if (cbName && typeof (window as any)[cbName] === 'function') {
    (window as any)[cbName](d.token);
  }
} catch {}
```

**Files changed:**
- `extension/content/lift-auth-sniffer.ts` — added `data-callback` global lookup
- `extension/content/vfs-bridge.ts` — version bumped to `0.2.7-turnstile-data-callback-logout`

**Type-check:** PASS (zero output)

**Operator test procedure:**

1. `.\launch-bot-chrome.ps1` — launch with existing (or fresh) profile.
2. Open the extension popup; confirm WS shows **connected**.
3. From Railway console: `railway run --service backend npx tsx scripts/trigger-auto-login.ts` (set `TARGET_ID` to a PENDING/INACTIVE account).
4. Watch the extension background service worker DevTools console.
5. **Success signal:** `[lift-auth-sniffer] applied token to data-callback global "cf-chl-widget-..."` then `tokenOk: true` in the bridge log, and `EXT_LOGIN_SUCCESS` arrives at the backend.
6. **Failure signal (was the old bug):** `tokenOk: false` / Sign In button never enabled.

**Still needs live validation** — cannot confirm Turnstile fires Sign In without an operator running a real session.

---

## Task 3 — Auto-logout via SPA click ✅

**Root cause:** `findLogoutSpaElement()` and `ensureOnLoginPage()` were fully implemented in `vfs-bridge.ts` but were never reachable from the backend — no `ContentCommand`, no `BackendMessage`, and no service-worker route existed for logout.

**Fix:** Wired the full message chain end-to-end:

| Layer | Change |
|---|---|
| `extension/shared/types.ts` | Added `BG_LOGOUT_VFS` to `BackendMessage`; added `LOGOUT_VIA_SPA` to `ContentCommand`; added `EXT_LOGOUT_SUCCESS` / `EXT_LOGOUT_FAILED` to `ExtensionEvent` |
| `extension/background/service-worker.ts` | Added `BG_LOGOUT_VFS` handler → `runLogoutFlow()` (finds warm VFS tab → `sendToTabEnsuringContentScript` with `LOGOUT_VIA_SPA`); forwarded `EXT_LOGOUT_SUCCESS` / `EXT_LOGOUT_FAILED` in `handleRuntimeMessage()` |
| `extension/content/vfs-bridge.ts` | Added `LOGOUT_VIA_SPA` case in `handleCommand()` → `handleLogoutViaSpa(correlationId)` which calls `clearVfsSessionStorage()` + `ensureOnLoginPage()` (existing SPA avatar-menu click) then sends `EXT_LOGOUT_SUCCESS` / `EXT_LOGOUT_FAILED` |

**Files changed:**
- `extension/shared/types.ts`
- `extension/background/service-worker.ts`
- `extension/content/vfs-bridge.ts`

**Type-check:** PASS (zero output)

**Operator test procedure:**

1. Extension connected, operator has a logged-in VFS tab open.
2. From backend REPL or a future `trigger-logout.ts` script, POST or directly call `sendToExtension(operatorId, { type: 'BG_LOGOUT_VFS', correlationId: 'test-123' })`.
3. **Success signal (bridge console):** `handleLogoutViaSpa SUCCESS` · `EXT_LOGOUT_SUCCESS` received at backend.
4. **Success signal (Chrome):** VFS tab navigates back to the login page; `sessionStorage` / `localStorage` cleared.
5. **Failure signals:** `EXT_LOGOUT_FAILED` with `NO_WARM_TAB` (no open VFS tab) or an error from `ensureOnLoginPage()`.

**Note:** No `page.goto()` is used — logout is pure SPA UI clicks via the existing trusted-click mechanism.

**Still needs live validation** — needs a logged-in VFS session to confirm avatar menu opens and Sign Out click navigates to login.

---

## Task 2 — Booking Steps 2–5 + operator gate ✅

**Root cause:** All 5 booking steps (`runBookingSteps`) were already coded correctly. The only gap: no configurable pause before the irreversible Step 5 Confirm click, and `confirmPauseMs` was not threaded through the call chain from the backend trigger script.

**Fix:** Added `confirmPauseMs` through every layer and inserted the pause before Step 5:

| Layer | Change |
|---|---|
| `backend/scripts/trigger-booking.ts` | Reads `CONFIRM_PAUSE_MS` env, defaults `30_000` |
| `backend/src/modules/accounts/accounts.router.ts` | `/book-test` body passes `confirmPauseMs` (default `30_000`) to `triggerAutonomousBooking()` |
| `backend/src/modules/booking/extension-dispatch.service.ts` | `AutonomousBookingInput` gains `confirmPauseMs?: number`; forwarded in `BG_BOOK_VFS` payload |
| `extension/shared/types.ts` | `BG_BOOK_VFS` payload + `BOOK_VIA_SPA` payload both gain `confirmPauseMs?: number` |
| `extension/content/vfs-bridge.ts` | `BookingFlowPayload` interface gains `confirmPauseMs?: number`; `runBookingSteps()` pauses `confirmPauseMs` ms before Step 5 Confirm |

**Files changed:**
- `backend/scripts/trigger-booking.ts`
- `backend/src/modules/accounts/accounts.router.ts`
- `backend/src/modules/booking/extension-dispatch.service.ts`
- `extension/shared/types.ts`
- `extension/content/vfs-bridge.ts`

**Type-check:** PASS (zero output)  
**Backend typecheck:** PASS (zero output)

**Operator test procedure:**

1. Extension connected (`.\launch-bot-chrome.ps1`), operator is logged in on VFS (tab open, session warm).
2. From Railway: `railway run --service backend npx tsx scripts/trigger-booking.ts`
   - Default behaviour: 30 s operator-gate pause before Step 5 Confirm.
   - To skip pause: `CONFIRM_PAUSE_MS=0 railway run ...`
   - Custom pause: `CONFIRM_PAUSE_MS=60000 railway run ...`
3. Watch extension background DevTools console. Expected step-by-step trace:
   ```
   booking: step 1 — Appointment Details (centre, category, sub-category)
   booking: step 2 — ???   (fills next form fields)
   booking: step 3 — ???
   booking: step 4 — Review
   booking: CONFIRM PAUSE — operator gate { pauseMs: 30000 }
   booking: step 5 — Confirm
   ```
4. **Success signal:** `EXT_BOOKING_COMPLETED` with `confirmationNumber` arrives at backend; HTTP 200 from `/book-test`.
5. **Failure signals:** `EXT_BOOKING_FAILED` with a reason string, or `BOOKING_TIMEOUT` after 250 s.

**Still needs live validation** — Steps 2–5 DOM selectors were captured from a manual run (confirmed 2026-05-25) but the automated click path through all 5 steps has not been verified end-to-end against a real slot.

---

## Build verification

```
# Extension
cd extension && npm run typecheck   → 0 errors
cd extension && npm run build       → webpack compiled successfully in ~2099 ms

# Backend
cd backend && npx tsc --noEmit      → 0 errors
```

---

## Still needs operator / live validation

| Item | Blocker |
|---|---|
| Task 1 — Turnstile `data-callback` fires Sign In | Needs operator + fresh Chrome profile (flagged profile won't pass Turnstile even manually) |
| Task 3 — Logout avatar-menu click → login page | Needs a logged-in VFS session |
| Task 2 — Full 5-step booking end-to-end | Needs an active slot + logged-in session; Steps 2–4 selectors unvalidated in automation |
| `LOGIN_CRON_ENABLED` remains OFF | Mass-login triggers VFS 429001; re-enable only after per-account cooldown is confirmed safe |
| `NOTIFY_BOOKING_FAILURES` remains OFF | Dev test runs should not spam operator/client Telegram |
