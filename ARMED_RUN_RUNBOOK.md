# Armed Run Runbook — VFS D-visa Booking (UZ → Latvia)

**Version:** 2026-05-29  
**Who runs this:** Operator on the UZ machine  
**What it does:** Fully automated login → slot monitor → real booking submit on a Mailsac pool account  
**Risk level:** REAL submit — books a real appointment. Cancel test-account appointments immediately after.

---

## 1. Preconditions checklist

Check every item before launching. Do not start if any item is not ready.

| # | Check | How to verify |
|---|---|---|
| 1 | **No VPN active** | Windows taskbar / system tray — VPN must be OFF. VPN routes traffic through non-UZ IPs → BrightData ip_blacklisted → "Session Expired". |
| 2 | **UZ residential IP** | Open `https://ipinfo.io` in Chrome — must show `country: UZ`, city Tashkent (or other UZ city). |
| 3 | **`backend\.env.worker` present** | `Test-Path backend\.env.worker` → True. Must contain `WORKER_TOKEN`, `DATABASE_URL`, `PROFILE_ENCRYPTION_KEY`, `MAILSAC_API_KEY`. |
| 4 | **`MAILSAC_API_KEY` non-empty** | Open `backend\.env.worker` — confirm `MAILSAC_API_KEY=<some-key>` (not blank). This is the OTP gate. |
| 5 | **Mailsac account available** | Run `railway run --service backend npx tsx scripts/find-clean-account.ts` — pick a `@mailsac.com` account that is ACTIVE, not throttled, `lastWarmedAt` recent (within 12h), and has `profiles: 1` (linked applicant profile). |
| 6 | **Profile + passport image linked** | Run `TARGET_EMAIL=<chosen@mailsac.com> railway run --service backend npx tsx scripts/check-test-account.ts` — should show a linked profile with a name. The profile needs `vfsPassword` set. Passport image default: `passports/p1.png` (repo root) — must exist. |
| 7 | **SUBCAT confirms slots** | Open VFS in Chrome (logged in manually with the chosen account), go to Book Appointment, select centre → Long Stay → sub-categories. Confirm **OCMA** or **Cargo (Work)** shows the Continue button enabled (= slots available). Use that exact sub-cat name as your SUBCAT regex. |
| 8 | **Telegram bot reachable** | Send `/start` to the bot from the operator Telegram account — confirm it responds. |
| 9 | **Bot Chrome profile is fresh** | If the Chrome profile has been used for heavy testing recently, launch with `$env:VFS_FRESH_PROFILE='true'` (see launch-bot-chrome.ps1). |

> **If profile is missing:** Run with `LINK=1` via `check-test-account.ts` to auto-link the first free active profile — or create a profile via the dashboard → Profiles page first.

---

## 2. Exact launch command

Open **PowerShell** in the repo root (`C:\...\vfs-booking-bot-main`).

### Full armed run (real submit):

```powershell
# Set SUBCAT to the sub-category regex that shows available slots.
# "ocma" matches "OCMA (Work)" — use what you confirmed in precondition #7.
$env:SUBCAT        = 'ocma'

# Arm real booking submit — without this, the bot monitors only, never books.
$env:WORKER_BOOK   = '1'

# Optional: limit to one specific account for a controlled test.
# $env:TARGET_EMAIL = 'vfs-8c3032554c49@mailsac.com'

# Launch the worker (keeps itself alive on crash).
.\launch-worker.ps1
```

**What each flag means:**

| Flag | Value | Effect |
|---|---|---|
| `SUBCAT` | regex like `ocma` | Python uses this to pick the right sub-category (matches against option text). Default is `work.*d.visa` which matches Work D-visa — no slots currently. |
| `WORKER_BOOK` | `1` | Arms `BOOK_ENABLED=1` → bot submits the real booking when a slot is found. **Without this it only monitors.** |
| `TARGET_EMAIL` | Mailsac email | Limits the run to one specific account. Strongly recommended for the first armed test. |

### Dry-run (review screen only, no submit):

```powershell
$env:SUBCAT        = 'ocma'
$env:WORKER_BOOK   = ''     # no real booking
$env:BOOK_DRY_RUN  = '1'    # screenshot the review screen and stop
.\launch-worker.ps1
```

---

## 3. Expected Telegram sequence

You will see these messages in order when everything works. Use this as a live health check — a gap means a step silently failed.

| Order | Message | What it means |
|---|---|---|
| 1 | `🔐 Logged in: vfs-...@mailsac.com` | nodriver passed Turnstile, dashboard loaded |
| 2 | `🔍 No slots · check #1 — ...` | First slot check completed, no slot yet |
| 3 | *(repeats every MONITOR_INTERVAL seconds)* | Bot is watching |
| 4 | `📅 Slot found: <subcat>` (SLOT_DETECTED) | Slot appeared — booking starts immediately |
| 5 | `📨 OTP requested — polling Mailsac: ...` | Generate OTP clicked, polling Mailsac |
| 6 | `✅ OTP filled: ...` | OTP code received and entered |
| 7a | `🎉 Booked! Conf: <REFERENCE>` | **SUCCESS** — real appointment booked, screenshot in `shots/pipe_confirmed.png` |
| 7b | `⚠️ Reached payment wall for ... — manual payment needed` | **PARTIAL** — appointment reserved, complete payment manually |
| 7c | `❌ Booking failed: <reason>` | Failed — see Troubleshooting below |

> **Note:** If you set `NOTIFY_BOOKING_FAILURES=false` (the default), message 7c will be suppressed. Set `NOTIFY_BOOKING_FAILURES=true` in `backend/.env.worker` before the run to get failure alerts.

---

## 4. Watch / abort criteria

| Situation | Action |
|---|---|
| Telegram silent after `🔐 Logged in` | Worker is running but no slot found yet — this is normal. Wait. |
| `🔍 No slots` messages stop arriving | Worker may have crashed. Check PowerShell window for errors. Press Ctrl+C and restart. |
| `⏱ OTP timeout` Telegram | MAILSAC_API_KEY is wrong or the account email isn't on Mailsac. Check `.env.worker` and the account email domain. |
| 429 errors in PowerShell output | Rate-limited. Press **Ctrl+C**. Wait 2 hours (429202 = IP/session) or 6 hours (429001 = account-level). Do NOT restart immediately — it makes it worse. |
| Turnstile not passing (Sign In still disabled) | The Chrome profile is flagged. Press Ctrl+C. Launch with `$env:VFS_FRESH_PROFILE='true'` or manually log in once in a plain Chrome tab, then restart the worker. |
| `⚠️ Reached payment wall` | Do NOT stop. Complete the payment manually in the browser that the bot opened. The appointment slot IS reserved. |
| `🎉 Booked!` received | SUCCESS — see Post-run cleanup below. |

---

## 5. Post-run cleanup

**After a successful booking on a test account, cancel the appointment:**

1. Log into VFS at `https://visa.vfsglobal.com/uzb/en/lva/login` with the Mailsac account.
2. Go to **Manage Appointments** → find the new booking.
3. Click **Cancel Appointment** and confirm.
4. Send the confirmation cancellation email to Mailsac (it should arrive within a few minutes).

**Why:** Per the original CLAUDE.md test-account policy: "cancel after demo." Not cancelling wastes a real appointment slot and may block the account.

---

## 6. Troubleshooting

| Symptom | Most likely cause | Fix |
|---|---|---|
| `BOOK: no file input or passport image missing` | `passports/p1.png` not at repo root | Confirm file exists: `Test-Path passports\p1.png`. Copy a valid passport scan to that path. |
| `OTP: no code from Mailsac` | `MAILSAC_API_KEY` not set / wrong / Mailsac quota | Check `.env.worker`. Test: `curl -H "Mailsac-Key: <key>" "https://mailsac.com/api/addresses/<email>/messages"` — should return `[]` not `401`. |
| VFS shows "Inactive account" | Account not activated yet | Run `TARGET_EMAIL=<email> railway run ... npx tsx scripts/trigger-recover.ts` to re-activate. |
| Login takes > 60s or fails | IP flagged or too many retries | Use fresh Chrome profile (`VFS_FRESH_PROFILE=true`). Check IP is UZ. |
| `429202` in logs | IP/session rate-limited (2h reset) | Stop worker. Wait 2+ hours. |
| `429001` in logs | Account rate-limited (6h reset, persistent) | Stop worker. Switch to a different ACTIVE account. The flagged account needs 6h cooldown. |
| Submit click no-op (booking stuck at review) | CDK overlay backdrop intercepting click | The `click_button_text` function handles this — if still happening, check `shots/book_0_appointment_details.png` for what the page looks like. |
| `pipe_after_submit.png` shows error page | VFS rejected the booking | Check the error message. Common: slot taken by another user (retry next slot), missing applicant data (check profile completeness). |
| Payment wall reached | VFS requires fee before finalising | Complete payment manually in browser. Appointment is reserved but not confirmed until paid. |

---

## 7. Screenshots reference

All screenshots are in `nodriver-spike/shots/` on the UZ machine.

| Filename | When taken |
|---|---|
| `pipe_wizard.png` | After entering the booking wizard |
| `book_0_appointment_details.png` | Start of booking flow (slot selected) |
| `book_1_after_continue.png` | After Step 1 Continue |
| `book_2c_after_save.png` | After passport upload + Save |
| `book_3a_otp_gate.png` | OTP entry page |
| `book_3b_after_otp.png` | After OTP verification |
| `pipe_after_submit.png` | Immediately after Submit click |
| `pipe_confirmed.png` | Booking confirmed page |
| `pipe_payment_wall.png` | Payment wall reached |
| `pipe_submit_uncertain.png` | Submit outcome unknown — inspect manually |
| `dry_review_<ts>.png` | Dry-run review screen (no submit) |

---

## 8. Start from scratch (zero state)

Use this section when **no pool accounts exist** — the worker will register a fresh Mailsac account and drive it to book, completely hands-off.

### Zero-state preconditions

| # | Check |
|---|---|
| 1 | **No VPN** active (same as Section 1 #1) |
| 2 | **Clean UZ residential IP** — verify at `ipinfo.io` |
| 3 | `backend\.env.worker` present with `WORKER_TOKEN`, `DATABASE_URL`, `PROFILE_ENCRYPTION_KEY`, `MAILSAC_API_KEY` |
| 4 | `MAILSAC_API_KEY` non-empty — activation email polling depends on it |
| 5 | `passports\p1.png` present on the UZ machine (1.4 MB, included in repo) |
| 6 | `NOTIFY_BOOKING_FAILURES=true` in `.env.worker` to receive failure Telegrams |
| 7 | **Chrome extension running** and connected to the backend — required for activation (the backend calls the extension to visit the Mailsac activation link) |
| 8 | **No pre-existing accounts needed** — the worker mints them |

> **Extension check:** go to the dashboard → Extension Setup page. If the status shows "Online", the extension is live.

### Zero-state launch command

```powershell
# Register exactly 1 fresh account and drive it to book.
$env:POOL_MIN      = '1'     # register exactly 1 account (default is 2)
$env:RUN_LIMIT     = '1'     # drive max 1 account per run (prevents driving old accounts)
$env:SUBCAT        = 'ocma'  # sub-category with available slots
$env:WORKER_BOOK   = '1'     # arm real booking submit
$env:NOTIFY_BOOKING_FAILURES = 'true'
.\launch-worker.ps1
```

Then trigger a run from the dashboard: **Start Scenario** button. The worker polls every 10s for a "requested" run.

> **Why POOL_MIN=1?** The worker automatically registers accounts when spare ACTIVE pool count is below `POOL_MIN`. With `POOL_MIN=1` and an empty pool, it registers exactly 1 new Mailsac account before driving.

> **Why RUN_LIMIT=1?** Prevents the worker from accidentally driving multiple accounts in the same cycle if any ACTIVE accounts already exist.

### Expected Telegram sequence from zero

Messages arrive roughly in this order. Gaps mean a step silently failed — see the abort criteria below.

| # | Message | What it means |
|---|---|---|
| 1 | `🔄 Registering new Mailsac account...` | Worker is about to spawn register_spike.py (**REAL-TIME**) |
| 2 | `🔄 Registering new Mailsac account: vfs-xxxxxx@mailsac.com` | form_rendered milestone relayed (arrives in batch after registration) |
| 3 | `☑️ Consents ticked — waiting for Turnstile: vfs-...` | Turnstile pending |
| 4 | `📤 Register submitted — waiting for activation email: vfs-...` | POST fired |
| 5 | `✅ Registered: vfs-...@mailsac.com` | Account created in DB |
| 6 | `✅ Activated: vfs-...@mailsac.com` | Activation link visited, account ACTIVE |
| 7 | `🔐 Logged in: vfs-...@mailsac.com` | nodriver login succeeded |
| 8 | `🔍 No slots · check #1 ...` | First slot check (repeats every `MONITOR_INTERVAL` seconds) |
| 9 | SLOT_DETECTED Telegram | Slot found — booking begins |
| 10 | `📨 OTP requested...` | OTP Generate clicked |
| 11 | `✅ OTP filled: ...` | OTP received and entered |
| 12a | `🎉 Booked — Conf: <REF>` | **SUCCESS** |
| 12b | `⚠️ Reached payment wall...` | Manual payment needed |

> **Messages 2–6 arrive as a batch** after registration completes (~2 minutes after message 1). That's expected — `register_spike.py` runs synchronously.

### Registration throttle warning

VFS limits new registrations per IP to approximately **5 attempts** before throttling (returns page-not-found / no form). If you see `❌ Registration failed: no RESULT line — throttled or failed`, **stop immediately**. Wait 30–60 minutes before retrying. Do NOT spam the Register endpoint — each failed attempt increases the cooldown window.

Signs of throttle: form never renders, or `"ABORT: register form never rendered"` in logs.

### Zero-state abort criteria

| Situation | Action |
|---|---|
| `❌ Registration failed: no RESULT line` | Throttled or VFS page-not-found. Wait 30–60 min. |
| `✅ Registered` but NO `✅ Activated` | Extension is offline. Check extension status on dashboard. |
| `✅ Activated` but NO `🔐 Logged in` | Account activated but login failed. Check logs for Turnstile / IP issues. |
| `register_spike CRASHED` | Python crash — check `nodriver` version / dependencies. |
| Telegram stops after `🔄 Registering...` (no more messages for 5+ min) | Registration hung — check PowerShell window. Press Ctrl+C if stuck. |

### Post-run cleanup (zero state)

Same as Section 5 — cancel the test appointment after a successful booking on any test/demo account.
