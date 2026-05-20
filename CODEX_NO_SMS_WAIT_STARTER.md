# Task: Stop waiting for SMS OTP during VFS auto-register

## Why

VFS UZ does NOT send SMS during account signup. It only sends an **email
verification link**. SMS OTP appears later (when adding an applicant /
booking an appointment).

Our current `autoRegisterAccount` flow buys a real OnlineSIM number, dispatches
to the extension, and then waits up to 5 minutes for an extension
`EXT_REGISTER_COMPLETED` event that itself depends on receiving SMS. Result:
every register attempt times out with `EXTENSION_TIMEOUT` / `WAIT_TIMEOUT`,
even though the form was submitted successfully.

Keep buying the OnlineSIM number (for uniqueness + later booking OTP), but
replace the SMS-completion wait with an email-link wait.

## Files to change

1. `backend/src/modules/accounts/accountAutoRegister.service.ts`
2. `extension/content/vfs-bridge.ts`
3. `extension/background/service-worker.ts`
4. `backend/src/modules/extension/extension.state.ts` (only if a new event name is added)

## Backend change — `accountAutoRegister.service.ts`

Inside `autoRegisterAccount`, after the dispatch-with-retry loop:

- **Keep** the OnlineSIM buy + dispatch with retry (existing code).
- **Replace** the existing `pending` promise (which waits for `EXT_REGISTER_COMPLETED`)
  with a new sequence:
  1. Wait up to **90 s** for an `EXT_REGISTER_SUBMITTED` extension trace
     (sent right after the register form submit returns 2xx). On timeout,
     return `{ ok: false, reason: 'REGISTER_FORM_NOT_SUBMITTED' }`.
  2. Then call `fetchEmailVerificationLink(email)` (already exists, line ~169).
     It polls the inbox up to 120 s for a URL containing
     `verify|confirm|activate`. On `null` return, return
     `{ ok: false, reason: 'EMAIL_LINK_NOT_RECEIVED' }`.
  3. GET the verification link with `axios` (server-side, no proxy needed —
     these endpoints are public). 200/302 = success. Anything else = return
     `{ ok: false, reason: 'EMAIL_LINK_VISIT_FAILED', status }`.
  4. On full success, persist the account exactly as today and return
     `{ ok: true, accountId, email }`.

- Move OnlineSIM `releaseNumber` out of the failure path for now — we keep
  the number ACTIVE so it can be reused for SMS OTP at booking time. Store
  `smsActivateId` on the `VfsAccount` row (add column `smsExternalId String?`
  via a new Prisma migration if it doesn't already exist).

- Keep `resolveAutoRegister` for backward-compat but it is no longer the
  primary success path.

## Extension change — `vfs-bridge.ts`

In the `BG_REGISTER_VFS_ACCOUNT` handler, after the form submits:

- Existing: waits for SMS OTP message from background, types it in, finalizes.
- New: read the post-submit page for a "verification email sent" success
  signal. Typical VFS markers:
  - URL contains `register/success` or `verify-email`
  - DOM contains text matching `/verification.*email/i` or `/check your inbox/i`
  - HTTP register response was 200/201 (already observable from the network
    layer if we wired it up — otherwise rely on DOM)
- Send `REGISTER_TRACE` with `event: 'EXT_REGISTER_SUBMITTED'`,
  `correlationId`, `email`. Use the existing HTTP fallback
  (`postRegisterTrace` → `/api/extension/trace`).
- Do NOT poll for SMS. Do NOT wait for `BG_INJECT_OTP`. Just terminate the
  register flow with that single trace.

## Extension change — `service-worker.ts`

Remove the `BG_INJECT_OTP` round-trip from the register flow. Keep the
handler defined (booking flow still uses it later), but the register flow
no longer awaits it.

## Backend change — `extension.state.ts` (and `extension.router.ts` if needed)

- Add a new event case `EXT_REGISTER_SUBMITTED` that calls
  `resolveAutoRegisterSubmitted(correlationId)` — this is what unblocks the
  90s wait in step 1 above.
- Existing `EXT_REGISTER_COMPLETED` / `EXT_REGISTER_FAILED` still log but no
  longer drive the new flow.

## Prisma migration

If `VfsAccount.smsExternalId` does not exist:

```prisma
model VfsAccount {
  // ...existing fields
  smsExternalId String?
}
```

Run `npx prisma migrate dev --name vfs_account_sms_external_id` and commit
the generated SQL.

## Test plan (manual, after deploy)

1. Operator's Chrome is logged into dashboard and VFS, extension connected.
2. Trigger auto-register from dashboard.
3. Watch `/api/extension/trace` POSTs in backend logs — expect
   `EXT_REGISTER_SUBMITTED` within 30 s of dispatch.
4. Watch backend logs — expect `fetching email verification link for <email>`
   then `email link visited: <url>` within 60–120 s.
5. Dashboard should show new account row, status `ACTIVE`, with the same
   email + phone we bought.
6. Manually log into VFS with the new credentials to confirm it works.

## Out of scope

- Booking flow SMS handling (no change — still uses OnlineSIM at booking time).
- Account pool warmer.
- Any change to captcha / Datadome handling.

## Done when

- Auto-register success rate ≥ 4/5 attempts on first try.
- No `EXTENSION_TIMEOUT` / `WAIT_TIMEOUT` in 5 consecutive dispatches.
- New `VfsAccount` rows have populated `smsExternalId`.
- Backend + extension compile clean (`pnpm -C backend build`, `pnpm -C extension build`).
