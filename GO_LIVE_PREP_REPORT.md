# Go-Live Prep Report (2026-05-29)

## TL;DR

**Chain is code-ready for the operator's armed run. All five preconditions below must be satisfied on the UZ machine before launching.**

The one caveat that is unverifiable from here: **payment wall probability**. VFS requires manual fee payment for some D-visa sub-categories before confirming the slot. The bot is now instrumented to detect it and Telegram "reached payment wall" — but the operator must be present to complete payment manually. This is a PARTIAL success (appointment reserved), not a failure.

---

## Task 1 — Hands-off OTP readiness

### Key present

`backend/.env.worker` exists and contains all four required keys:
- `MAILSAC_API_KEY` — **PRESENT** ✓
- `WORKER_TOKEN` — PRESENT ✓
- `DATABASE_URL` — PRESENT ✓
- `PROFILE_ENCRYPTION_KEY` — PRESENT ✓

### Propagation to Python subprocess

The `spawnAndWatch` call in `orchestrator-worker.ts` uses:
```typescript
const child = spawn(cmd, args, {
  env: { ...process.env, ...spawnEnv },
  ...
});
```

`MAILSAC_API_KEY` was previously propagated via `...process.env` only (inherited from the launcher loading `.env.worker`). This was correct but implicit. **Fixed in this session:** `MAILSAC_API_KEY` and `SUBCAT` are now also in `spawnEnv` explicitly (`orchestrator-worker.ts` line ~328), making the intent explicit and safe against stripped-env shells.

Python reads it at `auto_pipeline.py:47`:
```python
MAILSAC_KEY = os.environ.get("MAILSAC_API_KEY", "")
```

Propagation path confirmed: **YES** ✓

### Chosen Mailsac account

**Cannot be confirmed from this environment** — the prod Railway DB is not accessible here. The operator must run on the UZ machine:

```powershell
railway run --service backend npx tsx scripts/find-clean-account.ts
```

From `find-clean-account.ts`, two known Mailsac accounts are in the pool:
- `vfs-8c3032554c49@mailsac.com` (default in `check-test-account.ts`, was throttled — check current status)
- `vfs-621f423d81d1@mailsac.com`

Select one that shows `ACTIVE` status, `lastWarmedAt` within the last 12 hours, and `profiles: 1`.

### Profile + passport image

**Passport image:** `passports/p1.png` (1.37 MB) — **EXISTS** ✓ on this machine.  
Default path in Python: `pathlib.Path(__file__).parent.parent / "passports" / "p1.png"` → resolves to repo root regardless of working dir.

**Profile link:** Cannot verify from here. Operator must confirm via `check-test-account.ts`. If no profile is linked, run with `LINK=1` to auto-link the first free active profile, then fill in the `vfsPassword` via the dashboard Profiles page.

### Operator preconditions (from Task 1)

1. ✅ Confirm a Mailsac account is ACTIVE + cooled-down + has profile linked
2. ✅ Confirm `MAILSAC_API_KEY` is non-empty in `.env.worker`
3. ✅ Confirm `passports/p1.png` exists (or set `PASSPORT_IMAGE` env to a valid scan path)
4. ✅ Confirm linked profile has `vfsPassword` set

---

## Task 2 — Telegram per step

### Notification path

```
auto_pipeline.py  →  stdout: "MILESTONE {...}"
      ↓
orchestrator-worker.ts spawnAndWatch (regex parser)
      ↓
postMilestone() → POST /api/pipeline/event (Railway)
      ↓
pipeline.router.ts → sendTelegram / dispatchNotification
```

### Step → Milestone → Telegram table (after this session's changes)

| Step | milestone() in Python | Telegram message | Previously missing? |
|---|---|---|---|
| Login failed | `failed` (login_failed) | ❌ Booking failed | ✓ was present |
| **Logged in** | `logged_in` | `🔐 Logged in: {email}` | **GAP FILLED** |
| Wizard entered | `monitoring` (no slotId) | `🔍 No slots · ... · {time}` | ✓ was present |
| No slot (each check) | `monitoring` (with detail) | `🔍 No slots · check #N...` | ✓ was present |
| Slot found | `slot_found` | SLOT_DETECTED (rich Telegram) | ✓ was present |
| **OTP requested** | `otp_requested` | `📨 OTP requested — polling Mailsac: {email}` | **GAP FILLED** |
| **OTP filled** | `otp_filled` | `✅ OTP filled: {email}` | **GAP FILLED** |
| **OTP timeout** | `otp_timeout` | `⏱ OTP timeout — check MAILSAC_API_KEY: {email}` | **GAP FILLED** |
| **Booking confirmed** | `booked` (with confirmation) | `✅ Booked / Conf: {ref}` (BOOKING_SUCCESS) | ✓ was present |
| **Payment wall** | `booking_submitted` (detail=payment_wall) | `⚠️ Reached payment wall ... manual payment needed` | **GAP FILLED** |
| **Dry-run complete** | `booking_submitted` (detail=dry_run) | `📸 DRY-RUN complete ... not submitted` | **GAP FILLED** |
| Booking failed | `failed` | ❌ Booking failed (NOTIFY_BOOKING_FAILURES gate) | ✓ was present |
| Exception | `failed` | ❌ Booking failed | ✓ was present |
| **Registered** | `registered` (from worker) | `✅ Registered: {email}` | **GAP FILLED** |
| **Activated** | `activation_visited` (from worker) | `✅ Activated: {email}` | **GAP FILLED** |

**Previously missing steps that now have Telegram: 7** (logged_in, otp_requested, otp_filled, otp_timeout, payment_wall, dry_run, registered, activation_visited)

### Key diffs

**`pipeline.router.ts`** — extended step enum + handlers:
```typescript
// New steps in enum:
'otp_requested', 'otp_filled', 'otp_timeout'

// New Telegram blocks added in Step 4 section:
if (body.step === 'registered') { await tg(`✅ Registered: ${em}`) }
else if (body.step === 'activation_visited') { await tg(`✅ Activated: ${em}`) }
else if (body.step === 'logged_in') { await tg(`🔐 Logged in: ${em}`) }
else if (body.step === 'otp_requested') { await tg(`📨 OTP requested...`) }
else if (body.step === 'otp_filled') { await tg(`✅ OTP filled: ${em}`) }
else if (body.step === 'otp_timeout') { await tg(`⏱ OTP timeout — check MAILSAC_API_KEY: ${em}`) }
else if (body.step === 'booking_submitted') {
  // payment_wall / dry_run / confirmed sub-outcomes
}
```

**`auto_pipeline.py`** — OTP milestones added:
```python
# Before polling:
milestone("otp_requested", email=EMAIL)
# After OTP filled:
milestone("otp_filled", email=EMAIL)
# On timeout:
milestone("otp_timeout", email=EMAIL, error="otp_timeout")
```

**Note:** `NOTIFY_BOOKING_FAILURES=false` (the default) suppresses the `BOOKING_FAILED` Telegram. The operator should set `NOTIFY_BOOKING_FAILURES=true` in `.env.worker` before the armed run to receive failure alerts.

---

## Task 3 — Slot-gating + submit-outcome capture

### Slot gating

The monitor loop in `auto_pipeline.py` only calls `book()` when `select_route()` returns a non-None value (line ~580: `if slot:`). `select_route()` returns None unless the selected sub-category has the Continue button enabled (= VFS confirmed slots available). This is correct.

**SUBCAT** is now explicit in `spawnEnv` (propagated from `process.env.SUBCAT` which comes from `$env:SUBCAT='ocma'` in the launch). Operator must set this before launching.

### Submit outcome branches (hardened in `book()`)

After clicking Submit/Confirm/Pay, the bot now waits 5s, then detects which of three outcomes occurred:

| Outcome | Detection | Screenshot | Milestone | Telegram |
|---|---|---|---|---|
| **Confirmed** | Regex for `confirmation/reference/booking` + code pattern (`[A-Z0-9]{6,20}`) on page | `shots/pipe_confirmed.png` | `booked` (with `confirmation=<ref>`) | 🎉 `BOOKING_SUCCESS` with confirmation number |
| **Payment wall** | Keywords: `payment`, `pay now`, `proceed to payment`, `total amount`, `amount due`, `fee payable` | `shots/pipe_payment_wall.png` | `booking_submitted` (detail=payment_wall) | ⚠️ "Reached payment wall — manual payment needed" |
| **Failed/uncertain** | Neither of the above | `shots/pipe_submit_uncertain.png` | `failed` with error text | ❌ `BOOKING_FAILED` (if `NOTIFY_BOOKING_FAILURES=true`) |

Key diff in `book()` (Step 5):
```python
# Before: returned a bool, no outcome details
ok = await click_button_text(["submit","confirm","pay"], timeout=20)
await shot(page, "pipe_after_submit")
return ok

# After: detects outcome, takes targeted screenshots, returns tuple
ok = await click_button_text(["submit","confirm","pay"], timeout=20)
await asyncio.sleep(5)  # let VFS render outcome page
await shot(page, "pipe_after_submit")
url = await jeval(page, "location.href")
body_lower = body_raw.lower()
conf_m = re.search(r'confirmation|reference...')
if confirmation:
    await shot(page, "pipe_confirmed")
    return "confirmed", confirmation
elif is_payment:
    await shot(page, "pipe_payment_wall")
    return "payment_wall", None
else:
    await shot(page, "pipe_submit_uncertain")
    return "failed", reason
```

Main loop updated to handle tuple return:
```python
outcome, confirmation = await book(page, slot)
if outcome == "confirmed":
    milestone("booked", email=EMAIL, slotId=slot, confirmation=confirmation)
elif outcome == "payment_wall":
    milestone("booking_submitted", email=EMAIL, slotId=slot, detail="payment_wall")
else:
    milestone("failed", email=EMAIL, error=f"booking_{outcome}...", slotId=slot)
```

---

## Task 4 — Green suite

```
npm test  →  Tests: 166 passed, 166 total  (22 suites, 0 failed)
             Time: 4.316 s

npm run build  →
  > backend@1.0.0 build
  > tsc --project tsconfig.json && tsc-alias -p tsconfig.json
  (exit 0 — no errors)

python -m py_compile nodriver-spike/auto_pipeline.py nodriver-spike/register_spike.py
  → py_compile PASS (exit 0)
```

All three checks green after all changes.

---

## Task 5 — Runbook

`ARMED_RUN_RUNBOOK.md` written at repo root. Contains:
- 7-item preconditions checklist (VPN off, UZ IP, env file, MAILSAC key, account, profile/passport, SUBCAT verification)
- Exact PowerShell launch commands (armed run + dry-run variants)
- Expected Telegram sequence (11 ordered messages)
- Watch/abort table (6 scenarios: OTP timeout, 429x2, Turnstile, payment wall, success)
- Post-run cleanup (cancel test-account appointment)
- Troubleshooting table (9 entries)
- Screenshot reference

---

## Open risks / unknowns

1. **Payment wall probability (UNKNOWN)** — VFS may redirect to a payment page after Submit rather than showing a confirmation number directly. This is OUT OF SCOPE (per CLAUDE.md) and not automatically handled by the bot. The bot is now instrumented to detect it and alert "manual payment needed" — the operator must complete payment in the open browser. Whether this applies to Work D-visa or OCMA sub-categories won't be known until the first real run.

2. **OCMA slot availability** — OCMA slots have been mentioned as the most likely sub-category with available slots (vs Work D-visa which has none). Operator should confirm slots exist via manual VFS check before the armed run.

3. **Account cooldown state** — The Mailsac pool accounts were heavily tested in late May. Both `vfs-8c3032554c49@mailsac.com` and `vfs-621f423d81d1@mailsac.com` are in the SKIP list of `find-clean-account.ts` (marked throttled). Operator must confirm current status on prod DB and may need to wait for cooldown to expire or register a new Mailsac account.

4. **OTP path unvalidated end-to-end on a live slot** — The OTP milestone wiring is code-correct (verified by tracing), but the Step 3 OTP flow has not been run against a live slot + Mailsac email. If OTP fails (e.g. VFS sends SMS not email, or Mailsac delivery is slow), the booking stalls. The `otp_timeout` Telegram will fire after 120s.

5. **`NOTIFY_BOOKING_FAILURES` default is OFF** — failure Telegrams are suppressed unless the operator explicitly sets `NOTIFY_BOOKING_FAILURES=true` in `.env.worker`. For the armed run, enable this.

6. **429 risk from fresh run after recent heavy testing** — If accounts were used recently, the first login attempt may hit a 429001 account-level rate-limit. Build in a 6+ hour cooldown from the last test run before the armed run.

---

## What's staged (not committed)

| File | Change |
|---|---|
| `backend/scripts/orchestrator-worker.ts` | Added `MAILSAC_API_KEY` and `SUBCAT` to explicit spawnEnv |
| `backend/src/modules/pipeline/pipeline.router.ts` | Extended step enum (3 new OTP steps), added Telegram for 7 previously-silent steps, payment_wall and dry_run handling for `booking_submitted` |
| `nodriver-spike/auto_pipeline.py` | OTP milestones (requested/filled/timeout), hardened Step 5 outcome detection (3 branches), updated `main()` to handle tuple return from `book()` |
| `ARMED_RUN_RUNBOOK.md` | New file |
| `GO_LIVE_PREP_REPORT.md` | This file |

Nothing committed, nothing pushed. Operator + orchestrator to review and commit.
