# Design — Hands-off Account Lifecycle Pipeline (register / activate / login)

**Date:** 2026-05-26
**Status:** Approved (design); pending spec review → implementation plan
**Goal:** A robust, hands-off, self-replenishing pool of VFS accounts — create → activate → login → keep warm — with zero human touch, that never burns the pool, works now for 20–50 accounts on the existing Chrome extension, and scales to 500+ later without rewriting the core logic.

---

## 1. Context & why

Today (2026-05-26) the account pool was wiped to `429001` "Access Restricted" because the system had **no rate-limiting, no cooldown tracking, and no separation between "our DB status" and "VFS's real restriction state."** A background process logged into every account repeatedly until VFS restricted them all. Separately, we discovered and fixed the real Turnstile blocker (the extension's MAIN-world `lift-auth-sniffer` was monkey-patching `fetch`/`XHR`/`turnstile`, so Cloudflare withheld the widget); with that fixed, login/register pages render Turnstile normally and real-keystroke form fill works.

Key facts that shape this design:
- **VFS UZ register requires NO SMS OTP** — phone is typed, not verified. Only **email activation (Mailsac)** verifies an account. → hands-off register is feasible.
- **Turnstile** gates both register and login. With the page un-tampered it renders; whether it auto-passes for the bot is unconfirmed, so a **2Captcha solver is built as the robust path**.
- **`429001` is account-scoped and persistent**; `429202` is IP/session and clears in ~2h. They must be handled differently.
- Source IP must be UZ; today the operator's clean home UZ IP works. Proxy pool is a future (500+) concern.

## 2. Architecture (Approach A — backend brain + pluggable driver)

```
AccountLifecycleService  ← scale-agnostic "brain" (backend)
   │  owns: state machine, pacing/rate-limit, 429-handling, retries, rotation
   ├── MailsacActivator     (poll Mailsac inbox → visit activation link)
   ├── CaptchaSolver        (2Captcha Turnstile; sitekey 0x4AAAAAABhlz7Ei4byodYjs)
   └── BrowserDriver (interface)   ← the swappable seam
         ├── ExtensionDriver   ← NOW: maps to BG_REGISTER_VFS / BG_LOGIN_VFS / BG_LOGOUT_VFS over WS
         └── StealthDriver      ← LATER (out of scope): nodriver + UZ proxy pool, same brain
```

**`BrowserDriver` interface** (the only boundary that makes 20→500 not a rewrite):
```ts
interface BrowserDriver {
  register(input: RegisterInput): Promise<DriverResult>;        // fill form, pass Turnstile, submit
  login(input: LoginInput): Promise<DriverResult>;              // fill, pass Turnstile, submit, capture session
  logout(input: LogoutInput): Promise<DriverResult>;
  isReady(): Promise<boolean>;                                  // connection/driver healthy
}
type DriverResult = {
  ok: boolean;
  code?: 'OK' | '429001' | '429202' | 'TURNSTILE_FAILED' | 'INVALID_CREDS'
       | 'NO_WARM_TAB' | 'OPERATOR_OFFLINE' | 'TIMEOUT' | 'UNKNOWN';
  reason?: string;
  data?: Record<string, unknown>;   // e.g. confirmation, capturedEmail
};
```
The lifecycle brain consumes only `DriverResult` — it never knows whether an extension or a stealth browser did the work.

## 3. Account state machine

Every account is in exactly one `lifecycleState`. Only `AccountLifecycleService` mutates it.

States: `NEW, REGISTERING, REGISTER_FAILED, PENDING_ACTIVATION, ACTIVATING, ACTIVE, LOGGING_IN, WARM, RESTRICTED, BLOCKED`.

Transitions:
- `NEW → REGISTERING → PENDING_ACTIVATION` (on driver register ok) ; on fail → `REGISTER_FAILED` → retry ≤ N → `NEW`, else `BLOCKED`.
- `PENDING_ACTIVATION → ACTIVATING → ACTIVE` (MailsacActivator visits link) ; on no-email after N polls → stay `PENDING_ACTIVATION` (retry later).
- `ACTIVE → LOGGING_IN → WARM` (driver login ok, session captured). `WARM` = bookable.
- `WARM → ACTIVE` when session older than freshness threshold (~12h) → needs re-login.
- **Any step returning `429001` → `RESTRICTED`** with `cooldownUntil = now + LONG` (config, hours) + `restrictedReason='429001'`; flagged for rotation. After cooldown → returns to the prior pre-restriction state.
- `429202` → short cooldown (~2h), retried; does not flag for rotation.
- VFS hard-kill / repeated `429001` past a cap → `BLOCKED` (terminal).

`VfsAccount` field changes (extends existing `status`, `cooldownUntil`, `lastWarmedAt`):
- `lifecycleState` (new enum, above) — authoritative; legacy `status` kept for back-compat/UI.
- `cooldownUntil` (reused) — set on RESTRICTED/429.
- `attemptCount`, `lastAttemptAt` — retry capping + pacing.
- `restrictedReason`, `lastError` — diagnostics.

**Invariants (these prevent today's failure):**
1. A `RESTRICTED` account is **never driven** until `cooldownUntil` passes.
2. **State is the single source of truth** — a 429 flips state immediately so nothing else touches the account.

## 4. Pacing & scheduling

- **Global rate limiter:** at most **one VFS-touching action at a time**, min gap 60–90s + jitter (config). Concurrency is config-driven so `StealthDriver` can raise it per-proxy later.
- **Per-account min interval:** an account cannot be re-driven within a min window after its last action.
- **Paced tick** (replaces the dangerous orchestrator; orchestrator/login-cron stay OFF): each cycle selects **ONE** account that is *due* for its next lifecycle action (respecting cooldown + global limiter), drives it, records the result. **Never iterates/batches the pool.**
- `selectBookableAccount()` → least-recently-used `WARM` account, skipping RESTRICTED/cooldown; booking uses this (never a hardcoded/burned account).

## 5. Turnstile handling

Driver loads the page (un-tampered → widget renders). If no `cf-turnstile-response` token appears within a timeout, call `CaptchaSolver` (2Captcha, known sitekey), inject the token via the existing MAIN-world token-inject path (response field + `data-callback`). 2Captcha is the robust path; auto-pass is a bonus, not a dependency.

## 6. Error handling

- Driver maps page outcomes to typed `DriverResult.code`; the service maps codes → transitions (table in §3).
- Booking/slot-polling 429s feed into the **same** state machine (one place owns restriction state).
- Retries are capped per step (`attemptCount`); exceeding the cap → `REGISTER_FAILED`/`BLOCKED` as appropriate.
- Driver unavailability (`OPERATOR_OFFLINE`/`NO_WARM_TAB`) → no state change, re-queued for a later tick.

## 7. Testing

- **Unit (no VFS):** every state-machine edge, pacing limiter, 429-code→state mapping, retry caps — against a **mock `BrowserDriver`**. This is the bulk of the logic.
- **Integration:** `ExtensionDriver` ↔ stubbed WS message mapping.
- **Live (manual, gated):** one register→activate→login cycle on a single account, operator-watched. No automated mass runs, ever.

## 8. Out of scope (YAGNI now)

- `StealthDriver` / nodriver implementation, proxy-pool management (the 500+ runtime) — deferred behind the interface.
- SMS-OTP handling — not needed (phone is typed, not verified).
- UI changes beyond surfacing `lifecycleState`.

## 9. Success criteria

- Pool advances NEW→WARM hands-off, paced, one account at a time.
- A `429001` never propagates into re-hitting the account; the pool is **not** wiped by any automated process.
- Booking always pulls a genuinely WARM account.
- The lifecycle brain is unit-tested without VFS access and reused unchanged when `StealthDriver` lands.
