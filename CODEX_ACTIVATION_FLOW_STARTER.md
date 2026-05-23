# Account activation flow — auto-activate PENDING accounts before login

Repo: `C:/Users/saman/OneDrive/Documents/vfs-booking-bot-main`.
Branch: stay on whatever branch your worktree is on. Do NOT switch.
Package manager: **npm only** (use `npm.cmd` if blocked).
**Do NOT commit. Do NOT push. Do NOT touch `.ps1`, `.env`, captcha modules, proxy modules, BrightData wiring, register flow, monitor flow.**
Every shell command MUST have a timeout (`timeout 90 ...`).
**Hard cap: 300 LOC net added across all files.**

---

## The problem

The "Login All Stale" batch fails for accounts whose `status` is `PENDING` — these were auto-registered but never had their email activation link visited. On VFS, the login form for such accounts has an `Activate my account` link instead of letting the operator sign in. Currently the bot just sees a disabled Sign In button and times out.

The fix: before each login attempt, check the account's status. If `PENDING`, run an activation flow first, mark `ACTIVE`, then continue to normal login. If `ACTIVE`, login as before. All flow must use SPA navigation (no `chrome.tabs.create` / `page.goto` — Datadome block).

---

## Reusable code that ALREADY exists — do NOT duplicate

| Helper | Location | Purpose |
|---|---|---|
| `fetchEmailVerificationLink(email)` | `backend/src/modules/accounts/accountAutoRegister.service.ts:263` | Polls Mailsac/custom-domain inbox for the VFS activation link (handles quoted-printable line-wrapping). |
| `visitActivationLink(link)` | `backend/src/modules/accounts/accountAutoRegister.service.ts:223` | GETs the link through BrightData proxy so VFS sees the visit from a UZ IP. |
| `findWarmVfsTab()` | `extension/background/service-worker.ts:318` | Already used by SPA login. |
| `trustedClick(el)` | `extension/content/vfs-bridge.ts` | chrome.debugger trusted click. |
| `trustedKey(key)` | `extension/content/vfs-bridge.ts:1345` | chrome.debugger trusted keypress (use for Tab to wake Angular). |
| `typeIntoFirst`, `setInputValue`, `clickLoginSubmit`, `findButtonByText` | `vfs-bridge.ts` | Same patterns as login. |
| `clickRegisterSubmit` style polling | `vfs-bridge.ts:1013` | Pattern to copy for activation submit (enabled-check + retry). |

Read these before writing anything.

---

## Detection strategy

**Check `account.status` BEFORE dispatching login.** If `PENDING` → run activation, then login. If `ACTIVE` → login directly. This is cleaner than catching a "not activated" page after-the-fact because it avoids a wasted Turnstile solve.

The `loginAccount(accountId)` flow in `backend/src/modules/accounts/accountLoginService.ts:29` is the entry point. Modify it to branch on status.

---

## Stages

### Stage 1 — Extension shared types

File: `extension/shared/types.ts`

Add to `BackendMessage` union:
```ts
| { type: 'BG_ACTIVATE_VFS_ACCOUNT'; email: string; loginUrl: string; correlationId: string }
| { type: 'BG_ACTIVATION_DONE'; correlationId: string; ok: boolean; reason?: string }
```

Add to `ExtensionEvent` union:
```ts
| { type: 'EXT_ACTIVATION_NEED_LINK'; correlationId: string; email: string }
| { type: 'EXT_ACTIVATION_SUBMITTED'; correlationId: string; email: string }
| { type: 'EXT_ACTIVATION_SUCCESS'; correlationId: string; email: string }
| { type: 'EXT_ACTIVATION_FAILED'; correlationId: string; email: string; reason: string }
```

Add to `ContentCommand` union:
```ts
| { type: 'ACTIVATE_VIA_SPA'; payload: { email: string; correlationId: string } }
| { type: 'ACTIVATION_LINK_VISITED'; correlationId: string; ok: boolean }
```

### Stage 2 — Backend: branch loginAccount on PENDING status

File: `backend/src/modules/accounts/accountLoginService.ts`

In `loginAccount(accountId)`, after fetching the account but before the existing `BG_LOGIN_VFS_ACCOUNT` dispatch:

```ts
if (account.status === AccountStatus.PENDING) {
  const activationResult = await runActivation(account.id, account.email, operatorUserId);
  if (!activationResult.ok) {
    return { success: false, accountId: account.id, email: account.email, reason: `ACTIVATION_FAILED:${activationResult.reason}` };
  }
  // refresh: status is now ACTIVE, fall through to normal login
}
// existing dispatch unchanged
```

Add a new file `backend/src/modules/accounts/accountActivationService.ts`:

```ts
// Pseudocode — implement in TS
type ActivationResult = { ok: true } | { ok: false; reason: string };

const ACTIVATION_TOTAL_TIMEOUT_MS = 180_000;       // 3 minutes total
const ACTIVATION_LINK_POLL_TIMEOUT_MS = 120_000;   // 2 minutes for Mailsac

const pendingActivations = new Map<string, {
  resolve: (r: ActivationResult) => void;
  timer: NodeJS.Timeout;
  accountId: string;
  email: string;
}>();

export async function runActivation(accountId: string, email: string, operatorUserId: string): Promise<ActivationResult>;
export function resolveActivationSubmitted(correlationId: string): void;
export function resolveActivationSuccess(correlationId: string): void;
export function resolveActivationFailed(correlationId: string, reason: string): void;
```

Implementation:
1. Generate a correlationId
2. Send `BG_ACTIVATE_VFS_ACCOUNT { email, loginUrl, correlationId }` to the operator's extension (via `sendToExtension`). If no operator → return `{ ok: false, reason: 'OPERATOR_EXTENSION_OFFLINE' }`.
3. Set total timeout (180s) → on fire, return `{ ok: false, reason: 'ACTIVATION_TIMEOUT' }`.
4. Register pending entry.
5. Wait for `EXT_ACTIVATION_SUBMITTED` (extension confirms it sent the email-resend form). When received:
   - Call `fetchEmailVerificationLink(email)` with retries (existing function already has internal retries).
   - If link found → call `visitActivationLink(link)` (existing function, already routes through BrightData).
   - If link visit succeeded (status 200) → mark account `ACTIVE` in DB (`prisma.vfsAccount.update({ where: { id }, data: { status: 'ACTIVE' } })`).
   - Then send `BG_ACTIVATION_DONE { ok: true }` to extension and wait for `EXT_ACTIVATION_SUCCESS` (the extension may want to redirect back to login page first).
   - On `EXT_ACTIVATION_SUCCESS` → resolve `{ ok: true }`.
6. On any failure path → resolve with appropriate reason and emit `BG_ACTIVATION_DONE { ok: false, reason }`.

### Stage 3 — Backend: wire activation events from extension.state.ts

File: `backend/src/modules/extension/extension.state.ts`

Find the existing `EXT_LOGIN_FAILED` / `EXT_LOGIN_SUCCESS` handlers (around line 297-299). Add parallel handlers for the new `EXT_ACTIVATION_*` events, calling the resolvers exported from `accountActivationService.ts`.

Add the event types to the existing allow-list (line ~147).

### Stage 4 — Extension: service-worker dispatch

File: `extension/background/service-worker.ts`

Mirror the existing `runLoginFlow` (which uses `findWarmVfsTab`) but for activation:

```ts
async function runActivationFlow(msg: Extract<BackendMessage, { type: 'BG_ACTIVATE_VFS_ACCOUNT' }>): Promise<void> {
  try {
    const tab = await findWarmVfsTab();
    if (!tab || !tab.id) {
      sendEvent({ type: 'EXT_ACTIVATION_FAILED', correlationId: msg.correlationId, email: msg.email, reason: 'WARM_TAB_REQUIRED' });
      return;
    }
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.tabs.sendMessage(tab.id, {
      type: 'ACTIVATE_VIA_SPA',
      payload: { email: msg.email, correlationId: msg.correlationId },
    });
  } catch (err) {
    sendEvent({ type: 'EXT_ACTIVATION_FAILED', correlationId: msg.correlationId, email: msg.email, reason: (err as Error).message });
  }
}
```

Add `BG_ACTIVATION_DONE` handler that forwards to the active activation tab as `ACTIVATION_LINK_VISITED { ok, reason }`.

Wire `runActivationFlow` into the existing top-level `onMessage` switch alongside `runLoginFlow`.

### Stage 5 — Extension content: handleActivationViaSpa

File: `extension/content/vfs-bridge.ts`

Add a new top-level handler dispatched on `ACTIVATE_VIA_SPA`:

```ts
async function handleActivationViaSpa(payload: { email: string; correlationId: string }): Promise<void> {
  currentCorrelationId = payload.correlationId;
  try {
    await withTimeout(runActivationSteps(payload), 150_000, 'ACTIVATION_TIMEOUT');
  } catch (error) {
    await emitActivationEvent({
      type: 'EXT_ACTIVATION_FAILED',
      correlationId: payload.correlationId,
      email: payload.email,
      reason: (error as Error).message,
    });
  }
}
```

Implement `runActivationSteps(payload)`:

1. **Ensure on activation page**: if URL doesn't contain `/email-activation`, find the `Activate my account` link on the current page (selector: `a[href*="email-activation" i], a:has-text("Activate my account")` — use `findElementByText`-style matcher since `:has-text` isn't standard). Trusted-click it. Wait for the activation form to appear (`waitForElement('input[formcontrolname="emailid"], input[type="email"]', 20_000)`).
2. **Fill email**: `typeIntoFirst(['input[formcontrolname="emailid"]', 'input[name="emailid"]', 'input[type="email"]'], payload.email)`.
3. **Press Tab** to wake Angular: `await trustedKey('Tab')`. Wait 300 ms.
4. **Handle Turnstile if present** (same pattern as `runLoginSteps`).
5. **Click submit** via a new `clickActivationSubmit(initialUrl)` helper — copy the structure of `clickLoginSubmit` exactly; only the success condition differs (look for a "verification email sent" / "check your inbox" message OR URL containing "/activation-success").
6. **Emit** `EXT_ACTIVATION_SUBMITTED { correlationId, email }`. Backend will fetch + visit the link.
7. **Wait** for `ACTIVATION_LINK_VISITED { ok, reason }` from backend (use a new `waitForActivationSignal` modeled on the existing `waitForRegisterSignal`). Timeout 150 s.
8. **If ok**: SPA-click the "Sign in" link or `Logout`/`Back to login` to return to the login form. Wait for `input[formcontrolname="emailid"]` to appear. Emit `EXT_ACTIVATION_SUCCESS`.
9. **If not ok**: throw `ACTIVATION_LINK_VISIT_FAILED:${reason}`.

Add `clickActivationSubmit` as a near-copy of `clickLoginSubmit`. Do NOT generalise `clickLoginSubmit` — surgical changes only.

Add `findActivateMyAccountLink()` helper:
```ts
function findActivateMyAccountLink(): HTMLElement | null {
  const candidates = Array.from(document.querySelectorAll<HTMLElement>('a, button'));
  return candidates.find((el) => isVisible(el) && /activate my account/i.test(el.textContent ?? '')) ?? null;
}
```

Bump `VFS_BRIDGE_VERSION` to `2026-05-23-activation-flow`.

### Stage 6 — Frontend: surface "activating" state in batch modal

File: `frontend/src/app/(protected)/account-pool/page.tsx`

Where the batch modal renders per-item state pills:
- The backend will report the item as `running` while either activation OR login is happening — we don't change the API.
- BUT the `error` field for an in-progress activation will be empty, so the visible difference is in the timing. Skip this stage if it requires API contract changes.
- **Only addition**: if `item.error?.startsWith('ACTIVATION_FAILED:')`, render the part after the colon as a yellow warning pill (not red) and prepend "Activation: " to the error text. This is a 3-line change.

### Stage 7 — Smoke script

File: `backend/scripts/smoke-activation-detection.ts`

Goal: prove the branch logic in `loginAccount` selects activation flow for PENDING accounts and login for ACTIVE accounts. Do NOT actually call extensions or VFS — stub `sendToExtension` to capture which message types are sent.

```ts
// 1. Create one PENDING and one ACTIVE dummy VfsAccount
// 2. Stub sendToExtension to push into an array (do not actually send)
// 3. Call loginAccount(pendingId) — expect first dispatched message type === 'BG_ACTIVATE_VFS_ACCOUNT'
// 4. Call loginAccount(activeId) — expect first dispatched message type === 'BG_LOGIN_VFS_ACCOUNT'
// 5. Cleanup, exit 0 on both expectations met
```

Run with: `cd backend && timeout 30 npx tsx scripts/smoke-activation-detection.ts`.

Stubbing tip: replace the module-level `sendToExtension` reference using a small exported setter `setSendToExtensionForSmoke(fn)` — same pattern as `setLoginBatchRunnerForSmoke` in `loginBatch.service.ts`.

---

## Verification

After all stages:

```bash
cd extension && timeout 60 npm run build && cd ..
cd backend && timeout 90 npm run build && cd ..
cd frontend && timeout 180 npm run build && cd ..
cd backend && timeout 30 npx tsx scripts/smoke-activation-detection.ts && cd ..
```

All four MUST pass. No jest. No real-VFS test from Codex — operator will do that manually after reload.

---

## Report

Append one block to `CODEX_MONITOR_REPORT.md`:

```markdown
## Account Activation Flow

- **Status:** PASS | FAIL | BLOCKED
- **Files changed:**
  - extension/shared/types.ts (+L1)
  - extension/background/service-worker.ts (+L1)
  - extension/content/vfs-bridge.ts (+L1)
  - backend/src/modules/accounts/accountActivationService.ts (NEW)
  - backend/src/modules/accounts/accountLoginService.ts (+L1)
  - backend/src/modules/extension/extension.state.ts (+L1)
  - backend/scripts/smoke-activation-detection.ts (NEW)
  - frontend/src/app/(protected)/account-pool/page.tsx (+L1)  // optional Stage 6
- **New services/helpers:** runActivation, accountActivationService, handleActivationViaSpa, runActivationSteps, clickActivationSubmit, findActivateMyAccountLink
- **Reused (no duplication):** fetchEmailVerificationLink, visitActivationLink, findWarmVfsTab, trustedClick, trustedKey, typeIntoFirst
- **Smoke script result:** smoke-activation-detection.ts → exit 0 | (output)
- **Verification:**
  - extension build → PASS|FAIL
  - backend build → PASS|FAIL
  - frontend build → PASS|FAIL
- **Surprises:** any deviation
- **Time spent:**
```

If any verification fails, write a `## Account Activation Flow — BLOCKER` block instead and STOP.

---

## Hard rules

1. No commits, no pushes, no branch switch.
2. No new npm packages.
3. **REUSE** `fetchEmailVerificationLink` and `visitActivationLink` from `accountAutoRegister.service.ts`. Do not inline copies.
4. Surgical — do not modify `autoRegisterAccount`, register flow, monitor flow, captcha modules, proxy modules.
5. SPA only — no `chrome.tabs.create` (would trigger Datadome). Use `findWarmVfsTab` like the existing SPA login does.
6. ≤ 300 LOC net.
7. **Decision when PENDING + ACTIVATION_FAILED**: keep account at `PENDING` in DB; the next batch attempt will retry. Do NOT mark as BLOCKED — operator may resolve manually.

---

## What "done" looks like

- Operator opens bot Chrome on a warm VFS tab.
- Operator clicks `Login All Stale (N)`. Some accounts are PENDING.
- For each PENDING account: bot SPA-clicks "Activate my account" → fills email → submits → backend fetches & visits activation link → DB flips to ACTIVE → bot SPA-returns to login form → fills credentials → captcha → submits → SUCCESS.
- For each ACTIVE account: existing login flow runs as before.
- Modal shows per-item progress correctly; no new tabs created at any point.
