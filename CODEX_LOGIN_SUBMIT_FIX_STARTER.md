# Login submit fix — mirror register's enable-aware click

Repo: `C:/Users/saman/OneDrive/Documents/vfs-booking-bot-main`.
Branch: stay on whatever branch your worktree is on. Do NOT switch.
Package manager: **npm only** (use `npm.cmd` if blocked).
**Do NOT commit. Do NOT push. Do NOT touch `.ps1`, `.env`, captcha, proxy, BrightData.**
Every shell command MUST have a timeout.
**Hard cap: 80 LOC net added.**

---

## The bug

Operator reports: on the VFS UZ login page, after the bot fills email + password, the Sign In button is **disabled** until something else triggers Angular Material's validation cycle. The current login flow in `extension/content/vfs-bridge.ts:runLoginSteps` (lines 160-210) only checks if the button EXISTS, not if it's enabled, so the trusted-click fires against a disabled button and is silently ignored.

The register flow already handles this correctly via `clickRegisterSubmit` (line 1013-1078): waits for button + enabled-state + turnstile token, retries clicks, waits for re-enable between attempts.

## The fix

Mirror the register pattern in the login flow. Create a new `clickLoginSubmit()` helper modeled on `clickRegisterSubmit()` but adapted for login (no turnstile required if there's no `[data-sitekey]` on the page).

## Files you will change (only these)

### `extension/content/vfs-bridge.ts`

**1. Add a new function `clickLoginSubmit()`** near `clickRegisterSubmit()` (after line 1078). Adapt the register version:

```ts
async function clickLoginSubmit(initialUrl: string): Promise<void> {
  const findBtn = () => findLoginButton();
  const isEnabled = (btn: HTMLElement): boolean => {
    const asBtn = btn as HTMLButtonElement;
    if (asBtn.disabled) return false;
    if (btn.getAttribute('aria-disabled') === 'true') return false;
    if (btn.hasAttribute('disabled')) return false;
    return true;
  };
  // Turnstile is OPTIONAL on the login page — only enforce token presence
  // if a sitekey is actually rendered.
  const hasTurnstileToken = (): boolean => {
    const sitekeyEl = document.querySelector('[data-sitekey], .cf-turnstile');
    if (!sitekeyEl) return true;
    const t = document.querySelector<HTMLTextAreaElement | HTMLInputElement>('[name="cf-turnstile-response"]');
    return Boolean(t?.value);
  };

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const btn = findBtn();
    const tokenOk = hasTurnstileToken();
    const btnOk = btn ? isEnabled(btn) : false;
    if (btn && tokenOk && btnOk) {
      for (let attempt = 1; attempt <= 4; attempt++) {
        const ok = await trustedClick(btn);
        await new Promise((r) => setTimeout(r, 2000));
        if (
          window.location.href !== initialUrl ||
          isLoginSuccess(initialUrl) ||
          isLoginFailureVisible()
        ) {
          return;
        }
        const reBtn = findBtn();
        if (!reBtn) break;
        if (!isEnabled(reBtn)) {
          const reDeadline = Date.now() + 3000;
          while (Date.now() < reDeadline && !isEnabled(reBtn)) {
            await new Promise((r) => setTimeout(r, 200));
          }
        }
        if (!ok) continue;
      }
      return;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('LOGIN_SUBMIT_BUTTON_NEVER_ENABLED');
}
```

**2. Replace the click block in `runLoginSteps` (lines 195-201)** with a call to the new helper:

Old:
```ts
const initialUrl = window.location.href;
const button = await waitUntil(() => findLoginButton(), 30_000);
const clicked = await trustedClick(button);
if (!clicked) throw new Error('LOGIN_TRUSTED_CLICK_FAILED');

await waitUntil(() => isLoginSuccess(initialUrl) || isLoginFailureVisible(), 45_000);
```

New:
```ts
const initialUrl = window.location.href;
await clickLoginSubmit(initialUrl);
await waitUntil(() => isLoginSuccess(initialUrl) || isLoginFailureVisible(), 45_000);
```

**3. Bump the version marker** in this file (search for `VFS_BRIDGE_VERSION` constant; increment the date suffix to `2026-05-23-login-submit-fix`).

Do NOT modify anything else in this file. Do NOT touch register-side helpers.

---

## Verification

```bash
cd extension && timeout 60 npm run build && cd ..
cd backend && timeout 90 npm run build && cd ..
cd frontend && timeout 180 npm run build && cd ..
```

All three MUST pass.

---

## Report

Append one block to `CODEX_MONITOR_REPORT.md`:

```markdown
## Login Submit Fix

- **Status:** PASS | FAIL
- **Files changed:**
  - extension/content/vfs-bridge.ts (+L1 / -L2)
- **New helpers:** clickLoginSubmit
- **Old code removed:** naive `waitUntil(() => findLoginButton())` + single trustedClick in runLoginSteps
- **Verification:**
  - extension build → PASS|FAIL
  - backend build → PASS|FAIL
  - frontend build → PASS|FAIL
- **Surprises:** any deviation from this spec
- **Time spent:**
```

If anything fails, write `## Login Submit Fix — BLOCKER` instead and STOP.

---

## Hard rules

1. No commits, no pushes, no branch switch.
2. No new npm packages.
3. Surgical — do NOT change `clickRegisterSubmit`, `trustedClick`, `findLoginButton`, or `runRegisterSteps`.
4. Single file (vfs-bridge.ts). Only the two changes specified above.
5. ≤ 80 LOC net.
