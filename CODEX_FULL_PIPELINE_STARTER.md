# Goal

Make the VFS booking bot work end-to-end with zero manual clicks: auto-register a new VFS UZ account, capture cookies, poll for slots, fire Telegram alerts, auto-book when a slot drops. Validate every feature with automated test scenarios BEFORE handing off for human QA.

Treat this file as an execution spec. Read every section. Use parallel subagents where indicated. Do not stop until acceptance criteria pass.

---

# Repository state

- Branch: `track-7-extension`
- Latest commits on main: see `git log --oneline -20`
- Stack: TypeScript backend (Express + Prisma + Postgres on Railway), Next.js frontend (Railway), Chrome MV3 extension built with webpack (`extension/dist`).
- Backend URL (prod): `https://backend-production-24c3.up.railway.app`
- Frontend URL (prod): `https://frontend-production-840c.up.railway.app`
- Bot operates inside the operator's Chrome via the MV3 extension. The launcher at `launch-bot-chrome.ps1` opens a dedicated Chrome profile at `C:\Users\saman\vfs-bot-chrome-profile` with `--load-extension="extension\dist"`.
- chrome.debugger is enabled (manifest `permissions: ["debugger", "tabs", ...]`) and used for trusted clicks via `extension/background/debugger.helper.ts`.

---

# CRITICAL BUG #1 — Material MDC panel does not open

## Symptom

In `extension/content/vfs-bridge.ts` the function `selectDialCode998` does this:

1. Finds the trigger: `mat-select[formcontrolname="dialcode"]` — **WORKS** (confirmed in trace `dial-code trigger found {tag: MAT-SELECT, fcn: dialcode, id: mat-select-0}`).
2. Asks the background service worker for a TRUSTED click at the trigger's viewport center via `chrome.runtime.sendMessage({type: 'TRUSTED_CLICK', x, y})`. The SW uses `chrome.debugger.attach` + `Input.dispatchMouseEvent` (mouseMoved → mousePressed → mouseReleased, button: left).
3. Trusted click returns `{ok: true}` — **WORKS** (confirmed in trace `dial-code trusted click on trigger result {"ok":true}`).
4. Polls for the option element matching `/\b\+?998\b|uzbekistan/i` in any `mat-option, .mat-mdc-option, [role="option"]` element.
5. **FAILS** at this step — trace shows `dial-code option not found after trusted open {"panelCount":0,"anyOptions":0}` — the dropdown panel never renders.

So Material accepted the click as "trusted" but did not open the overlay panel. Either:
- (a) The click landed somewhere the mat-select doesn't consider "inside the trigger" (clicking the .mat-mdc-select-value child instead of the .mat-mdc-select-trigger or the mat-select host).
- (b) The mat-select is disabled or blocked by a sibling overlay we cannot see.
- (c) Material's MDC build on VFS UZ requires a specific event sequence (e.g. a focus event before mousedown, or a touch event sequence).
- (d) The dropdown DOES open very briefly but is immediately closed by a focusout event triggered when the mouse coordinate is calculated.

## Required investigation steps

Run these in order, recording results in `deployments/dialcode-debug.md` as you go:

### Step 1: dump the mat-select structure
- In the operator Chrome (already launched), navigate to `https://visa.vfsglobal.com/uzb/en/lva/register`.
- In console (page tab, NOT extension SW) run:
  ```js
  const ms = document.querySelector('mat-select[formcontrolname="dialcode"]');
  console.log({
    outerHTML: ms.outerHTML.slice(0, 500),
    rect: ms.getBoundingClientRect(),
    triggerRect: ms.querySelector('.mat-mdc-select-trigger')?.getBoundingClientRect(),
    valueRect: ms.querySelector('.mat-mdc-select-value')?.getBoundingClientRect(),
    arrowRect: ms.querySelector('.mat-mdc-select-arrow-wrapper')?.getBoundingClientRect(),
    disabled: ms.getAttribute('aria-disabled'),
    ariaExpanded: ms.getAttribute('aria-expanded'),
    classList: Array.from(ms.classList),
  });
  ```
- Save the JSON output. This shows whether the trigger's visible center is the same as the mat-select host center.

### Step 2: try clicking specific sub-elements
- In `selectDialCode998`, BEFORE the existing trusted click, try clicking each of these in sequence, polling for `aria-expanded="true"` on the mat-select after each:
  1. `.mat-mdc-select-trigger` (current target)
  2. `.mat-mdc-select-value`
  3. `.mat-mdc-select-arrow-wrapper`
  4. `.mat-mdc-select-arrow`
- Whichever opens the panel (`aria-expanded` flips to true or `.mat-mdc-select-panel` appears in DOM), use that as the click target going forward.

### Step 3: try focus + keyboard
- chrome.debugger supports `Input.dispatchKeyEvent`. If pointer clicks don't open the panel, try:
  - dispatch mouseMoved to the trigger center
  - dispatch Key 'Tab' until the mat-select receives focus (verify `document.activeElement === ms`)
  - dispatch Key 'Enter' or 'Space' or 'ArrowDown'
- The mat-select MDC keyboard handler opens the panel on Enter/Space/ArrowDown when focused.

### Step 4: try Angular component access (last resort)
- In the page context, look for `window.ng?.getComponent(ms)?.open()`. Angular CDK exposes this in development mode and sometimes in production. If `window.ng` is available, call `.open()` directly. This bypasses the DOM event problem entirely.
- Wrap in try/catch since `window.ng` may not exist.

### Step 5: report findings
- Update `deployments/dialcode-debug.md` with what worked. Commit. Implement the winning approach in `selectDialCode998`.

## Acceptance criteria for Bug #1

- Bot trigger Auto-create from `/account-pool` button
- VFS register tab opens
- Form auto-fills email, password, confirm password, mobile number, all 3 consents
- Captcha solves (already working, no change needed)
- Dial code dropdown auto-opens, "Uzbekistan(998)" auto-selects, displayed value contains "998"
- Register button auto-clicks (already wired via trustedClick)
- Page transitions to "verification email sent"
- Backend receives EXT_REGISTER_SUBMITTED, polls Mailsac, visits verify link, persists VfsAccount row
- New account appears in `/account-pool` as ACTIVE
- All of the above happens **without any human interaction** on the VFS tab

---

# UNTESTED FEATURES — must be exercised end-to-end

Each of these has working code but has never been validated against real services. Write a test scenario for each (see Testing section below) and run it.

## 1. Cookie sync from logged-in Chrome → backend DB

**Where:** `extension/background/service-worker.ts` `pushCookiesToBackend` + `extension/content/vfs-bridge.ts` `syncSessionToBackend` + backend `POST /api/accounts/inject-cookies` route.

**Expected:**
- When operator is logged into VFS in the bot Chrome, the extension grabs all `vfsglobal.com` cookies (including HttpOnly ones via `chrome.cookies.getAll`).
- POSTs to `/api/accounts/inject-cookies` every 30 s (heartbeat alarm) AND immediately on cookie change events.
- Backend updates the matching `VfsAccount.cookieStore` with the jar.
- `lastWarmedAt` is set to `new Date()` IF the jar includes a `datadome` cookie.
- `cookieFresh = true` is reflected on `/account-pool` page.

**How to test:**
- Have one VfsAccount row already in DB (use Add Existing form or `POST /api/accounts`).
- Open a VFS tab in bot Chrome, log in to that account.
- Within 60 s, `GET /api/accounts/warmup-status` should return that account with `cookieFresh: true`.
- Test with HttpOnly datadome cookie present and absent — `cookieFresh` only flips when datadome is present.

## 2. Manual cookie injection via `/inject-cookies` page

**Where:** `frontend/src/app/(protected)/inject-cookies/page.tsx` + `POST /api/accounts/inject-cookies`.

**Expected:**
- Operator pastes JSON cookies (exported via the Cookie-Editor Chrome extension) into the form.
- Backend stores them on the matching VfsAccount.
- Same `cookieFresh` flip as #1.

**How to test:**
- Export cookies from a logged-in VFS tab via Cookie-Editor.
- Paste into `/inject-cookies` form, save.
- Verify VfsAccount row updated.

## 3. Slot polling against real VFS lift-api with stored cookies

**Where:** `backend/src/modules/monitor/monitor.service.ts` `pollOnce` + Playwright/axios path + `extension/content/vfs-bridge.ts` `pollSlot` (which one is active depends on `EXTENSION_BOOKING` env).

**Expected:**
- After cookies are injected, `POST /api/monitor/start { source: 'uzb', destination: 'lva', visaCategoryCode, vacCode }` begins the monitor loop.
- Every 30 s the backend (or extension, depending on path) POSTs to `https://lift-api.vfsglobal.com/appointment/CheckIsSlotAvailable` with the right body.
- The response is logged. Status 200 with body containing `earliestDate` = slot found. Status 401/403 = session lost (need re-cookie). Status 429 = rate-limited (back off).
- For this test, focus on getting one successful 200 with proper response shape — even if no slot is available, just confirm the request completes.

**How to test:**
- With one ACTIVE + cookieFresh account, start monitor for `uzb/lva`.
- Watch `/logs` for `EXT_POLL_RESULT` entries with status 200.
- If status 401/403, the cookies are bad — re-warm and retry.

## 4. Slot detection → Telegram alert pipeline

**Where:** `backend/src/modules/notifications/notification.service.ts` `dispatchNotification` for the `SLOT_DETECTED` event + `backend/src/modules/notifications/telegram.service.ts`.

**Expected:**
- When `EXT_SLOT_DETECTED` event arrives at backend, it calls `dispatchNotification({event: 'SLOT_DETECTED', ...})`.
- That fires a Telegram message to the chat ID configured in `TELEGRAM_CHAT_ID` env.
- Message format includes destination, date, account email.

**How to test:**
- Since real slots are rare, dispatch a synthetic event by directly calling `POST /api/extension/trace` with `step: 'EXT_SLOT_DETECTED', meta: {destination: 'lva', date: '2026-06-15'}` OR by calling the notification service from a test script that sets `event=SLOT_DETECTED`.
- Verify the Telegram chat receives the message.
- Then disable the synthetic source — do not leave it on.

## 5. Auto-booking dispatch when slot detected

**Where:** `backend/src/modules/booking/booking.dispatcher.ts` (or wherever the worker lives) + `extension/background/service-worker.ts` `BOOK_FOR_CUSTOMER` handler.

**Expected:**
- On `SLOT_DETECTED`, if auto-mode is enabled, backend picks an active Profile + an ACTIVE VfsAccount with fresh cookies, and sends `BOOK_FOR_CUSTOMER` to the extension.
- Extension navigates the logged-in VFS tab to the booking page, fills the profile data, clicks Submit.
- Confirmation number is extracted from the post-submit page and sent back as `EXT_BOOKING_COMPLETED`.
- Backend creates a Booking row with status SUCCESS.

**How to test:**
- With a real account + cookie + a seeded Profile in DB, manually dispatch a `BOOK_FOR_CUSTOMER` message to the extension via a script (don't wait for a real slot).
- The extension should drive the booking page. If it gets blocked by a Material MDC dropdown again, apply the same fix as Bug #1.

## 6. Booking confirmation extraction

**Where:** `extension/content/vfs-bridge.ts` `extractConfirmation`.

**Expected:**
- After booking submit succeeds, the page shows a confirmation number (alphanumeric, typically 8+ chars).
- `extractConfirmation` runs a regex over `document.body.innerText` and returns the first match.

**How to test:**
- Mock a confirmation page by injecting HTML into a test tab and verify the regex extracts correctly.
- Or use the booking test from #5 — confirmation number should land in the Booking row.

## 7. Account pool warming

**Where:** `backend/src/modules/accounts/accountPool.service.ts` + extension cookie sync.

**Expected:**
- The pool tracks `lastWarmedAt` per account.
- An account is "fresh" if its cookies have been refreshed within the last 12 h AND the cookieStore contains a datadome cookie.
- The pool table on `/account-pool` shows status (ACTIVE/BLOCKED/COOLDOWN), cookieFresh badge, lastWarmedAt timestamp.

**How to test:**
- Add 3 accounts via Add Existing form.
- Log into VFS as each one in succession (so cookies sync).
- Verify `/account-pool` shows all 3 as ACTIVE + cookieFresh.

## 8. Multi-account rotation

**Where:** `backend/src/modules/booking/booking.dispatcher.ts` account-picker logic.

**Expected:**
- When dispatching a booking, the worker picks an account that's: ACTIVE, cookieFresh, not in COOLDOWN, with `profileIds` not already at limit.
- Round-robins through accounts so we don't hammer one and trigger rate limits.

**How to test:**
- Pool has 3 accounts. Dispatch 3 bookings in quick succession. Verify each booking used a different account (check `Booking.accountId`).

## 9. Cooldown after 429 from VFS

**Where:** Extension SW `pollActiveMonitor` + backend `accountPool.cooldownMutation`.

**Expected:**
- On a 429 response from lift-api, the extension stores `pollBackoffUntil` and `pollBackoffMs` (exponential, capped at 5 min).
- Backend marks the account COOLDOWN for the same duration.
- Pool table reflects status COOLDOWN with countdown.

**How to test:**
- Manually inject a 429 response (intercept lift-api with a request mock OR set `pollBackoffUntil` to a future timestamp directly in storage).
- Verify next poll doesn't fire until the backoff clears.

## 10. Profile CRUD

**Where:** `backend/src/modules/profiles/profiles.router.ts` + `frontend/src/app/(protected)/profiles/page.tsx`.

**Expected:**
- Create, read, update, delete a Profile via the UI.
- Sensitive fields (passport number, DOB) are encrypted at rest using AES-256 (see `backend/src/utils/crypto.ts`).
- Bulk upload via Excel/CSV works (`POST /api/profiles/bulk-upload`).

**How to test:**
- Add a profile via UI. Verify the row in DB has `passportNumberEnc` (encrypted), not plaintext.
- Edit it. Delete it.
- Upload `CUSTOMERS_TEMPLATE.csv` (already in repo root) via bulk upload. Verify N rows created.

## 11. Notification preferences (Telegram, SMTP, web push)

**Where:** `backend/src/modules/notifications/*` + `frontend/src/app/(protected)/settings/page.tsx`.

**Expected:**
- Operator can configure each channel from Settings page.
- On a notifiable event (`SLOT_DETECTED`, `BOOKING_SUCCESS`, `BOOKING_FAILED`), all enabled channels fire.

**How to test:**
- Configure Telegram (already wired). Trigger a synthetic event. Verify message arrives.
- Configure SMTP. Same test. Verify email arrives.
- Configure Web Push. Same test. Verify desktop notification.

## 12. Logs viewer with filters + CSV export

**Where:** `backend/src/modules/logs/logs.router.ts` + `frontend/src/app/(protected)/logs/page.tsx`.

**Expected:**
- Logs page shows the LogEntry table with filters (date range, level, event type).
- "Export CSV" button downloads filtered logs.

**How to test:**
- Apply each filter, verify results match.
- Export CSV, open in Excel, verify column headers and data integrity.

## 13. Vendor balance fetching

**Where:** `backend/src/modules/vendor/balance.fetcher.ts` (and any UI on `/vendors` page).

**Expected:**
- Periodically fetches OnlineSIM, Vak-SMS, smsActivate, Mailsac, 2Captcha balances.
- Updates the `/vendors` dashboard showing remaining credit per provider.

**How to test:**
- Trigger a manual fetch. Verify each provider's balance is fetched and stored.
- Compare against actual balance on each provider's website.

## 14. Datadome cookie freshness detection

**Where:** `backend/src/modules/extension/extension.state.ts` `EXT_SESSION_SYNC` handler.

**Expected:**
- When cookies arrive, backend checks if the jar contains a cookie named matching `/datadome/i`.
- If yes: `lastWarmedAt = now`, `status = ACTIVE`.
- If no: account stays in its previous state (likely STALE).

**How to test:**
- Inject cookies WITHOUT a datadome cookie. Verify status stays unchanged.
- Inject cookies WITH a datadome cookie. Verify status flips to ACTIVE.

---

# Test scenarios (you must write and run these)

Create `backend/scripts/e2e-tests/` with one script per feature above. Each script:

1. Sets up state (creates a VfsAccount, Profile, etc.) via direct Prisma calls.
2. Triggers the action under test (calls the route, dispatches the event, etc.).
3. Asserts the expected outcome (DB row state, Telegram message sent, etc.).
4. Cleans up.

Run all scripts before declaring done. Add to `package.json`:
```json
"test:e2e": "tsx scripts/e2e-tests/run-all.ts"
```

For features that require a real browser (auto-register, booking), use the existing Playwright setup in `backend/src/modules/monitor/playwright.fetch.ts` patterns. For extension-driven flows, dispatch the message via the WS server and listen for the resulting EXT_* event.

For the Telegram test, use a test chat ID (different from the production one) so you don't spam the user's chat.

---

# Subagent strategy

Use parallel subagents wherever the work is independent. The following groups can run concurrently:

- **Group A — Bug #1 investigation + fix** (1 subagent, sequential):
  - Run Step 1-4 of the Bug #1 investigation
  - Implement the winning approach
  - Update `selectDialCode998`
  - Rebuild extension
  - Run auto-register e2e test until passes

- **Group B — Test infrastructure setup** (1 subagent, parallel to A):
  - Create `backend/scripts/e2e-tests/` directory + `run-all.ts` orchestrator
  - Write the 14 test scripts listed above
  - Each script must be runnable individually
  - Add the `test:e2e` script to `package.json`

- **Group C — Untested feature validation** (multiple subagents in parallel after A and B finish):
  - Spawn 1 subagent per feature group, running its e2e test script and reporting pass/fail
  - Feature groups: cookies (1, 2, 14), polling (3), notifications (4, 11), booking (5, 6), pool (7, 8, 9), data (10, 12), vendors (13)

- **Group D — Self-validation report** (1 subagent, after everything):
  - Read all test results
  - Run the full Auto-create → cookie sync → poll → alert → book → confirm chain in one go
  - Produce a markdown report at `deployments/full-pipeline-report.md` showing: which features passed, which failed, what was fixed, what remains broken
  - Commit and push

Use the dispatching-parallel-agents pattern from the available skills.

---

# Operating constraints

- Never push to `main` without confirming all builds (`pnpm -C backend build` AND `pnpm -C extension build` AND `pnpm -C frontend build`) pass.
- Never echo any password, API key, or Bearer token in logs, commit messages, or stdout.
- The bot Chrome profile lives at `C:\Users\saman\vfs-bot-chrome-profile`. If you need a clean state, wipe with `Remove-Item -Recurse -Force` and relaunch via `launch-bot-chrome.ps1`.
- chrome.debugger only works when DevTools is NOT open on the same tab. Test from the Activity Logs page on the dashboard tab — those traces show every step without needing DevTools on the VFS tab.
- Material MDC clicks need TRUSTED events (via chrome.debugger). Dispatched events do not work — already proven.

---

# Done when

1. `selectDialCode998` opens the mat-select panel and selects Uzbekistan(998) automatically, every time.
2. Auto-create from the dashboard creates one new VfsAccount in DB end-to-end without manual intervention.
3. All 14 e2e test scripts pass.
4. `deployments/full-pipeline-report.md` exists and reports green across the board OR a clear list of which features remain broken and why.
5. Push to `main`, Railway deploys, smoke test the production flow once.

Once all 5 are done, post the report path back to the operator and the goal is complete.
