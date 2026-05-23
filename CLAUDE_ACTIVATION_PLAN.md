# Activation flow — Claude Code execution plan

This is what I (Claude Code) will do if you say "go". Stages are sequential. I will pause for your OK after **Stage 1** and **Stage 3** so you can review before the next batch of changes.

---

## Goal

When the batch tries to log in an account whose DB `status === 'PENDING'`, the bot should:

1. SPA-click "Activate my account" on the VFS UZ login form
2. Fill the email field
3. Submit the activation-resend form
4. Backend polls Mailsac for the activation link
5. Backend visits the activation link via BrightData (UZ exit)
6. DB row flips to `ACTIVE`
7. Bot SPA-returns to login form, runs the normal login

No new tabs created. Everything SPA-driven inside the operator's warm bot Chrome tab.

---

## Stages

### Stage 1 — Backend skeleton (no UI changes yet) — ~80 LOC

I will:

- Create `backend/src/modules/accounts/accountActivationService.ts` with:
  - `runActivation(accountId, email, operatorUserId)` returning `{ ok, reason? }`
  - Pending-correlations map (mirrors `pendingLogins` in accountLoginService.ts)
  - `resolveActivationSubmitted`, `resolveActivationSuccess`, `resolveActivationFailed` exports
  - 180 s total timeout; reuses `fetchEmailVerificationLink` and `visitActivationLink` from `accountAutoRegister.service.ts` (already exported)
- Modify `accountLoginService.ts:loginAccount` to branch on `PENDING`:
  - If PENDING → call `runActivation` first, if ok continue to existing dispatch; if fail return `{ success: false, reason: 'ACTIVATION_FAILED:${reason}' }`
- Wire activation events through `backend/src/modules/extension/extension.state.ts`:
  - Add `EXT_ACTIVATION_NEED_LINK`, `EXT_ACTIVATION_SUBMITTED`, `EXT_ACTIVATION_SUCCESS`, `EXT_ACTIVATION_FAILED` to the allow-list and to the dispatcher

Verify: `cd backend && timeout 90 npm run build` passes.

🛑 **Checkpoint 1** — I'll show you the diff. You eyeball + say "continue".

### Stage 2 — Extension shared types — ~10 LOC

I will:

- Edit `extension/shared/types.ts` to add the new message types to `BackendMessage`, `ExtensionEvent`, `ContentCommand` unions:
  - `BG_ACTIVATE_VFS_ACCOUNT`, `BG_ACTIVATION_DONE`
  - `EXT_ACTIVATION_NEED_LINK`, `EXT_ACTIVATION_SUBMITTED`, `EXT_ACTIVATION_SUCCESS`, `EXT_ACTIVATION_FAILED`
  - `ACTIVATE_VIA_SPA`, `ACTIVATION_LINK_VISITED`

Verify: `cd extension && timeout 60 npm run build` passes.

### Stage 3 — Extension service worker + content script — ~150 LOC

I will:

- In `extension/background/service-worker.ts`:
  - Add `runActivationFlow(msg)` mirroring `runLoginFlow` (uses `findWarmVfsTab`, no `chrome.tabs.create`)
  - Add `BG_ACTIVATION_DONE` relay → forwards as `ACTIVATION_LINK_VISITED` to the active activation tab
  - Wire both into the existing `onMessage` switch
- In `extension/content/vfs-bridge.ts`:
  - Add `handleActivationViaSpa(payload)` + `runActivationSteps(payload)` (mirror `handleLoginViaSpa`)
  - Add `clickActivationSubmit(initialUrl)` (near-copy of `clickLoginSubmit`)
  - Add `findActivateMyAccountLink()` helper (text-match `/activate my account/i`)
  - Add `waitForActivationSignal(name, timeout)` (mirror `waitForRegisterSignal`)
  - Dispatch `ACTIVATE_VIA_SPA` and `ACTIVATION_LINK_VISITED` in the top-level command switch
  - Bump `VFS_BRIDGE_VERSION` to `2026-05-23-activation-flow`

Verify: `cd extension && timeout 60 npm run build` passes.

🛑 **Checkpoint 2** — I'll show you the extension diff. You eyeball + say "continue".

### Stage 4 — Frontend hint + smoke script — ~40 LOC

I will:

- In `frontend/src/app/(protected)/account-pool/page.tsx`: when `item.error?.startsWith('ACTIVATION_FAILED:')`, render it as a yellow warning pill with the prefix stripped. 3-line change.
- Create `backend/scripts/smoke-activation-detection.ts`:
  - Adds a `setSendToExtensionForSmoke` setter to `accountActivationService.ts`
  - Creates one PENDING + one ACTIVE dummy account in DB
  - Stubs `sendToExtension` to capture dispatched message types
  - Calls `loginAccount(pendingId)` → asserts first message is `BG_ACTIVATE_VFS_ACCOUNT`
  - Calls `loginAccount(activeId)` → asserts first message is `BG_LOGIN_VFS_ACCOUNT`
  - Cleans up

Verify:
- `cd frontend && timeout 180 npm run build`
- `cd backend && timeout 30 npx tsx scripts/smoke-activation-detection.ts` → exit 0

### Stage 5 — Commit + push — ~0 LOC

I will:
- `git add` the touched files
- One commit: `feat(accounts): auto-activate PENDING accounts via SPA flow`
- **Pause** before push — you say "push" when you're ready to test on prod

---

## What could go wrong (risks I'm flagging up-front)

| Risk | Mitigation |
|---|---|
| The "Activate my account" link selector might be wrong on VFS UZ | I'll match by visible text `/activate my account/i` rather than CSS — survives DOM changes |
| The activation form's email field selector might differ from login | I'll try the same fallback list as `runLoginSteps` (`emailid`, `email`, `[type=email]`) |
| Mailsac quota might rate-limit if 10 accounts activate at once | Existing `fetchEmailVerificationLink` already polls with backoff. Worst case: a few accounts get `EMAIL_LINK_NOT_RECEIVED` and stay PENDING for retry |
| VFS might redirect to a different URL after activation success (not the login page) | I'll detect by trying both: URL contains `/login` OR the email input reappears in DOM |
| Reload-extension dance — you have to reload after push | Same as last two fixes. I'll remind you in the post-push message |

---

## Total

- ~280 LOC across 6 files
- 1 new backend file, 1 new smoke script
- 2 checkpoints for you to intervene
- Estimated wall time: 15-25 min (Claude Code, not Codex)
- Builds + smoke verified before commit

---

## To start

Say **"go"**, **"do it"**, or **"start"**.

To abort mid-execution, say **"stop"** or **"abort"** at any time — I'll roll back what I haven't committed.
