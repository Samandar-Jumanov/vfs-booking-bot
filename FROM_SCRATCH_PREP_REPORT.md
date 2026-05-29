# From-Scratch Prep Report (2026-05-29)

## TL;DR

**Yes — the operator can run from zero.** The zero-state chain (register → activate → login → monitor → book) is code-complete and fully instrumented. The single most important caveat: **activation requires the Chrome extension to be running** on the operator's machine (the extension visits the Mailsac activation link). Without the extension online, the newly-registered account stays PENDING and is never driven to login/book.

---

## Task 1 — Zero-state chain trace

### The exact from-scratch trigger

```powershell
$env:POOL_MIN      = '1'
$env:RUN_LIMIT     = '1'
$env:SUBCAT        = 'ocma'
$env:WORKER_BOOK   = '1'
$env:NOTIFY_BOOKING_FAILURES = 'true'
.\launch-worker.ps1
```

Then click **Start Scenario** in the dashboard. The worker polls every 10s for a `scenario_run` with `status='requested'` in the Settings table. When found, `driveRun()` executes:

1. **Pool top-up check** (`orchestrator-worker.ts:507`): `POOL_MIN=1`, `spareCount()=0` → registers 1 account via `registerOne()`
2. `registerOne()` spawns `register_spike.py` synchronously (up to 5 min)
3. On success: creates `vfsAccount` row (status=PENDING), calls `/api/pipeline/reconcile` → backend activates via extension → row flips to ACTIVE
4. **Load ACTIVE accounts** (`orchestrator-worker.ts:535`): finds the freshly-activated account
5. `driveAccountReal()` spawns `auto_pipeline.py` with `VFS_EMAIL`, `VFS_PASSWORD`, `MAILSAC_API_KEY`, `SUBCAT`, `WORKER_BOOK`, etc.
6. Pipeline runs: login → wizard → monitor OCMA → book on slot

`POOL_MIN=1` ensures exactly 1 account is registered (not 2, the default). `RUN_LIMIT=1` caps the drive loop to 1 account per cycle.

### Fresh-account activation path

1. `register_spike.py` registers with VFS (Turnstile auto-passes via nodriver)
2. Sets `WORKER_BRIDGED=1` → spike does NOT visit the activation link itself (would consume the one-time token)
3. Worker's `registerOne()` persists account as `status='PENDING'` (`orchestrator-worker.ts:440-447`)
4. Worker calls `POST /api/pipeline/reconcile` with the new email (`orchestrator-worker.ts:465`)
5. Backend's `tryActivate()`: fetches activation link from Mailsac → triggers activation visit via **Chrome extension** (`reconciliation.service.ts:73-96`)
6. Extension opens the activation URL in the operator's real Chrome (CF-cleared) → VFS activates the account
7. Backend flips `status='ACTIVE'`, `lifecycleState='ACTIVE'` in DB
8. Worker receives `{ ok: true }` → posts `activation_visited` milestone → Telegram fires

**Activation requires the extension to be live.** If `!isExtensionLive(operatorUserId)`, reconcile returns `'failed'` and account stays PENDING — it will NOT be picked up by `findMany({ status: 'ACTIVE' })`.

### FIELD-BY-FIELD VERDICT: Does an unlinked fresh account book with only p1.png?

**Answer: YES. No profile link is needed. The `PROFILE` dict in `auto_pipeline.py` is dead code.**

Evidence:
```
grep -n "PROFILE\[" nodriver-spike/auto_pipeline.py
→ (no output)
```

The `PROFILE` dict is built at module load (lines 333-340) from `PROFILE_*` env vars with hardcoded defaults, but **is never accessed in any booking step**. Full search for `PROFILE` in `auto_pipeline.py` shows only the dict definition — zero accesses.

Field-by-field breakdown of what each booking step actually needs:

| Booking step | Fields needed | Source |
|---|---|---|
| Step 1 — Appointment Details | sub-category selection | `SUBCAT` env (→ UI selection) |
| Step 2 — Your Details (passport) | Passport BIO-page image | `PASSPORT_IMAGE` env, default `passports/p1.png` |
| Step 2 — VFS OCR extracts | Name, DOB, passport number, nationality, expiry | OCR of `p1.png` by VFS server — no `PROFILE_*` used |
| Step 3 — OTP gate | Email for OTP delivery, Mailsac API key | `VFS_EMAIL` (account email) + `MAILSAC_API_KEY` |
| Step 3b — Book Appointment | Date + slot selection | UI interaction only |
| Step 4 — Services | None | Click Continue only |
| Step 5 — Review → Submit | Nothing additional | Click Submit only |

**Conclusion:** A fresh, ACTIVE, unlinked account with `passports/p1.png` present can complete all 5 booking steps. No linked profile is needed. The `PROFILE` dict's defaults (including the fabricated `"AB1234567"` passport number) are irrelevant — they're never used.

---

## Task 2 — Registration milestones + reliability

### Milestone set (added in this session)

**`register_spike.py`** — 4 new milestone calls:

| Where | Milestone | When |
|---|---|---|
| After email generation (`register_spike.py:155`) | `register_started` | Immediately, before browser launch |
| After form-ready check succeeds (`register_spike.py:198`) | `form_rendered` | Form hydrated, all fields + consents visible |
| After consent loop confirms all ticked (`register_spike.py:312`) | `consents_ticked` | All 3 mat-checkboxes verified checked |
| After submit loop confirms POST fired (`register_spike.py:383`) | `register_submitted` | `/user/registration` POST confirmed |

These 4 + the existing `registered` / `failed` milestones give a complete registration audit trail.

**`pipeline.router.ts`** — 4 new step enum values + Telegram messages:
```
register_started   → "🔄 Registering new Mailsac account: {email}"
form_rendered      → "📋 Register form ready — filling fields: {email}"
consents_ticked    → "☑️ Consents ticked — waiting for Turnstile: {email}"
register_submitted → "📤 Register submitted — waiting for activation email: {email}"
```

**`orchestrator-worker.ts` `registerOne()`** — 3 structural fixes:
1. **Real-time Telegram BEFORE spawnSync**: `"🔄 Registering new Mailsac account..."` fires immediately, before the blocking 5-minute call
2. **Reorder**: account created in DB FIRST, then milestones forwarded — so the pipeline endpoint can resolve the account email
3. **Filter**: skip `registered` and `activation_visited` in the forward loop (those are posted explicitly with `toState` for lifecycle state updates; forwarding them too would cause duplicate Telegrams)
4. **Direct Telegram for failures**: if no RESULT line / parse error / not-registered, sends `"❌ Registration failed: {reason}"` directly (previously: no Telegram for registration failures at all)

### Register button + consent reliability verdict

**Already solid — no changes needed.**

- `safe_click()` calls `await el.scroll_into_view()` before every click (lines 83-85 in `register_spike.py`) — the historical "below-the-fold" bug is fixed ✓
- Consent verification: `boxes_state()` checks all visible `mat-checkbox` inputs; the loop iterates up to 8 times with trusted-click + JS fallback; only proceeds when `checked_vis == total_vis` ✓
- Register click: overlay cleared (OneTrust + CDK backdrop removed) before click, overlap check logged, 6-attempt retry alternating trusted-click and JS `.click()` ✓

---

## Task 3 — Fresh-account booking gap

**No change needed.**

Evidence: `PROFILE` dict is defined but never accessed (`grep -n "PROFILE\[" auto_pipeline.py` → empty). Booking Steps 1–5 use only: passport image OCR (p1.png), account email for OTP delivery, and UI interactions. A fresh unlinked account has everything needed.

---

## Task 4 — Green suite

```
npm test  →  Tests: 166 passed, 166 total (22 suites, 0 failed)
             Time: 4.18 s

npm run build  →
  > backend@1.0.0 build
  > tsc --project tsconfig.json && tsc-alias -p tsconfig.json
  (exit 0)

python -m py_compile nodriver-spike/auto_pipeline.py nodriver-spike/register_spike.py
  → py_compile PASS (exit 0)
```

All three checks green after all changes.

---

## Task 5 — Runbook

`ARMED_RUN_RUNBOOK.md` updated with **Section 8: Start from scratch (zero state)**. Contains:
- Zero-state preconditions checklist (8 items, highlights extension requirement)
- Exact PowerShell launch command with `POOL_MIN=1`/`RUN_LIMIT=1` explained
- Expected Telegram sequence (12 steps from register_started to booked/payment_wall)
- Registration throttle warning (~5 attempts max)
- Abort criteria (5 scenarios)
- Post-run cleanup pointer

---

## Open risks

1. **Extension must be live for activation** — the single-biggest dependency for zero-state. If the extension is offline when `registerOne()` calls reconcile, the account stays PENDING and is never driven. Operator must verify extension status on dashboard before launching.

2. **Registration throttle (~5 attempts)** — VFS limits new registrations per IP. Each failed or partially-succeeded attempt counts. One clean run per IP per hour. If throttled: wait 30–60 minutes, do NOT retry immediately.

3. **OCMA slot availability unknown** — the worker will monitor continuously if no slot appears. The operator should manually verify OCMA has available slots in VFS before arming a real-booking run.

4. **OTP delivery: email vs SMS** — for pool accounts, OTP is sent to the Mailsac email address. If VFS changes to SMS OTP for new accounts, the `mailsac_otp_code()` timeout (120s) will fire and booking stalls at Step 3.

5. **Payment wall** — confirmed by code analysis but probability unknown until first live run. If VFS requires payment before finalizing the appointment, the bot detects it and Telegrams "reached payment wall" — operator completes payment manually. Appointment slot IS reserved.

6. **Fresh account Turnstile** — registration uses nodriver (which auto-passes Turnstile). Login after registration also uses nodriver. Both should work on a clean IP + fresh Chrome profile. Risk increases after 5+ attempts in a session (profile flags).

---

## What's staged (not committed)

| File | Change |
|---|---|
| `nodriver-spike/register_spike.py` | 4 new `milestone()` calls: `register_started`, `form_rendered`, `consents_ticked`, `register_submitted` |
| `backend/scripts/orchestrator-worker.ts` | `registerOne()` restructured: pre-spawnSync Telegram, create account before forwarding milestones, skip registered/activation_visited in forward loop, direct Telegram for failures |
| `backend/src/modules/pipeline/pipeline.router.ts` | 4 new step enum values + Telegram handlers for registration milestones |
| `ARMED_RUN_RUNBOOK.md` | Added Section 8: Start from scratch (zero state) |
| `FROM_SCRATCH_PREP_REPORT.md` | This file |

Nothing committed, nothing pushed.
