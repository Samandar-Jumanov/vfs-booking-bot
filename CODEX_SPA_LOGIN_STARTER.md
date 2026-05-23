# SPA-only batch login (Datadome-safe)

You are working on the VFS booking bot at `C:/Users/saman/OneDrive/Documents/vfs-booking-bot-main`.
Branch: stay on whatever branch your worktree is on. Do NOT switch.
Package manager: **npm only**. Never use `pnpm`. Use `npm.cmd` if `npm.exe` is blocked.
**Do NOT commit. Do NOT push. Do NOT touch any `.ps1` script, `.env`, captcha modules, proxy modules, or BrightData wiring.**
Every shell command MUST have a timeout (`timeout 90 ...`).

---

## The problem we are solving

Currently, when backend dispatches `BG_LOGIN_VFS_ACCOUNT` to the extension, the service worker calls `chrome.tabs.create({ url: msg.loginUrl })` (service-worker.ts:298). This creates a fresh top-level navigation, which Datadome's bot-detector treats as a `page.goto()` and responds with 403201 + 1h IP ban. As a result, every fresh-account login in the batch silently times out at 90s.

VFS's SPA navigation through "Logout → Login" buttons is NOT blocked by Datadome (this is the path memory `[[project_auto_login_proven]]` confirmed working on 2026-05-16). We must make the extension's batch-login flow use that SPA path exclusively.

---

## Required flow (the contract)

When backend sends `BG_LOGIN_VFS_ACCOUNT`:

1. Service worker calls a new helper `findWarmVfsTab()` that returns the most-recently-active tab matching `*://*.vfsglobal.com/*` AND whose URL is NOT `/page-not-found`. If none → emit `EXT_LOGIN_FAILED` with reason `WARM_TAB_REQUIRED` and return immediately.
2. Service worker focuses that tab (`chrome.tabs.update(tabId, { active: true })`) and sends a NEW content command `LOGIN_VIA_SPA` carrying `{ email, password, correlationId }`. **It MUST NOT call `chrome.tabs.create`.**
3. The content-script handler `handleLoginViaSpa(payload)` in `vfs-bridge.ts`:
   a. Detects current page state. Three cases:
      - **Already on login form** (has `input[formcontrolname="emailid"]`) → skip to step (d).
      - **On dashboard or any post-login VFS page** → call new helper `clickLogoutSpa()` which finds the Logout / Profile-menu button by selector + visible text, trusted-clicks it, waits for the login form to appear (`waitForElement` for the email input, 20 s).
      - **On page-not-found or unknown** → throw `WARM_TAB_NOT_VFS`.
   b. After login form is visible, run the existing `runLoginSteps(payload)` exactly as it is today. Do NOT modify `runLoginSteps`.
4. On success → existing `EXT_LOGIN_SUCCESS`. On failure → existing `EXT_LOGIN_FAILED` with the thrown error message.

The existing `BG_LOGIN_VFS_ACCOUNT` → `runLoginFlow` pathway in service-worker.ts:296-324 is REPLACED. Do not keep both code paths.

---

## Files you will change (only these)

### `extension/background/service-worker.ts`

- Replace `runLoginFlow` (line 296-324) with a new implementation that:
  - Calls `findWarmVfsTab()`.
  - Emits `EXT_LOGIN_FAILED { reason: 'WARM_TAB_REQUIRED' }` if none.
  - Focuses the tab, sends `LOGIN_VIA_SPA` content command (no setTimeout, send immediately — the content script is already loaded since the tab matches `*.vfsglobal.com`).
  - Catches errors and emits `EXT_LOGIN_FAILED` with the message.

- Add helper:
```ts
async function findWarmVfsTab(): Promise<chrome.tabs.Tab | null> {
  const tabs = await chrome.tabs.query({ url: '*://*.vfsglobal.com/*' });
  const warm = tabs
    .filter(t => t.id != null && t.url && !t.url.includes('/page-not-found'))
    .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
  return warm[0] ?? null;
}
```

(If `lastAccessed` is not in the Chrome typings for our manifest version, fall back to sorting by tab `.id` descending — newest tab ID = most recent.)

### `extension/shared/types.ts`

- Add `'LOGIN_VIA_SPA'` to the `ContentCommand` union with payload `{ payload: LoginFormPayload }`.
- Do NOT remove `'LOGIN_FILL_FORM'` — booking flow may still use it.

### `extension/content/vfs-bridge.ts`

- Add a top-level command handler branch in the existing message-dispatch switch:
```ts
case 'LOGIN_VIA_SPA':
  await handleLoginViaSpa(command.payload);
  break;
```

- Implement `handleLoginViaSpa(payload: LoginFormPayload)`:
  - Try-catch identical wrapping as `handleLoginFlow` (line 70-82): on throw, emit `EXT_LOGIN_FAILED` with `(error as Error).message`.
  - Inside try:
    - Detect page: `const onLoginForm = !!document.querySelector('input[formcontrolname="emailid"]')`.
    - If not on login form → call `await ensureOnLoginPage()` (new helper, below). This must either land on the login form within 20 s or throw.
    - Then call `await runLoginSteps(payload)`. Reuse the existing function untouched.
  - On success path, emit the same `EXT_LOGIN_SUCCESS` event as today.

- Implement `ensureOnLoginPage()`:
  - If URL contains `/page-not-found` → `throw new Error('WARM_TAB_NOT_VFS')`.
  - Try selectors in order, click the first one that matches a visible, enabled element:
    - `button[aria-label*="logout" i]`
    - `a[href*="logout" i]`
    - `button:has(svg[data-icon*="user"])` (profile menu trigger — may need follow-up click on a "Logout" item)
    - `[data-test-id*="logout" i]`
  - Use the existing `trustedClick(el)` helper for the click (do NOT use synthetic `el.click()` — must be a chrome.debugger-driven trusted click to bypass Material MDC's `isTrusted` check, same as register flow).
  - After clicking, `await waitForElement('input[formcontrolname="emailid"]', 20_000)`. If it never appears, throw `'LOGOUT_NEVER_REACHED_LOGIN_FORM'`.
  - If NO logout button was found, throw `'LOGOUT_BUTTON_NOT_FOUND'`.

### Optional clarification in `frontend/src/app/(protected)/account-pool/page.tsx`

- In the Login-All-Stale modal where `item.error` is rendered, if any item's error equals `WARM_TAB_REQUIRED` show a helper text at the top of the modal:

  > *"Open bot Chrome and navigate to any VFS page before running the batch. The bot reuses your warm tab to avoid Datadome."*

- Use the same Tailwind callout style as other warnings in this file. Do not add new dependencies.

---

## Verification

```bash
cd extension && timeout 60 npm run build && cd ..
cd backend && timeout 90 npm run build && cd ..
cd frontend && timeout 180 npm run build && cd ..
```

All three MUST pass. No jest. No smoke script needed (this is browser-extension behavior; smoke would require a real Chrome).

Manual test (operator will run, you don't):
1. Open bot Chrome via the launcher script, land on `https://visa.vfsglobal.com/uzb/en/lva/dashboard` (any logged-in account works).
2. Trigger `POST /api/accounts/login-batch` with 2-3 fresh account IDs.
3. Watch the existing tab cycle: logout → login form → fill → captcha → submit, repeated per account.
4. Confirm no new tabs were created at any point.

---

## Report

Append a single `## SPA Login Refactor` block to `CODEX_MONITOR_REPORT.md`:

```markdown
## SPA Login Refactor

- **Status:** PASS | FAIL | BLOCKED
- **Files changed:**
  - extension/background/service-worker.ts (+L1 / -L2)
  - extension/shared/types.ts (+L1 / -L2)
  - extension/content/vfs-bridge.ts (+L1 / -L2)
  - frontend/src/app/(protected)/account-pool/page.tsx (+L1 / -L2)  // if modal copy was added
- **Old code removed:** chrome.tabs.create call from runLoginFlow
- **New helpers:** findWarmVfsTab, ensureOnLoginPage, handleLoginViaSpa, LOGIN_VIA_SPA command
- **Verification:**
  - extension build → PASS|FAIL
  - backend build → PASS|FAIL
  - frontend build → PASS|FAIL
- **Surprises:** any deviation from this spec
- **Time spent:**
```

If any verification fails or you hit a roadblock (e.g., `lastAccessed` not typed, Material MDC selector ambiguity), write a `## SPA Login Refactor — BLOCKER` block instead and STOP.

---

## Hard rules

1. No commits, no pushes, no branch switch.
2. No new npm packages.
3. Do NOT touch: `launch-bot-chrome.ps1`, any `.ps1`, `.env`, captcha modules, proxy modules, BrightData wiring.
4. Reuse existing helpers: `trustedClick`, `waitForElement`, `runLoginSteps`. Do NOT inline copies.
5. Surgical changes only — do not "improve" unrelated code.
6. Hard cap: ≤ 200 LOC net added across all files.
