# Design — Booking Pipeline (park · poll · book)

**Date:** 2026-05-26
**Status:** Approved (design); pending spec review → implementation plan
**Depends on:** `2026-05-26-account-lifecycle-pipeline-design.md` (reuses its brain: state machine, pacer, 429-handling, 2Captcha, `BrowserDriver`).
**Goal:** A logged-in (WARM) account **stays parked on the VFS dashboard, continuously checks for slots, and auto-books the moment one appears** — no human in the loop, end-to-end to a confirmation number (no payment step on this route).

---

## 1. Scope & honest bounds

- **In:** keep WARM accounts parked → poll lift-api for availability → on a slot, drive Steps 1–5 → confirmation number.
- **"100% automated" means:** the bot autonomously detects and *attempts* a booking with no human. It **cannot guarantee** a booking — a slot must actually exist and be won (finite, contested; no automation creates slots).
- **Two real dependencies:** Step-3 of booking has its **own Turnstile** (handled by 2Captcha, same as login); and Steps 2–5 are coded but **not yet validated live** (never had slot + session simultaneously).
- **Out of scope:** payment (this route has none), customer-queue/date-matching (book any slot for the configured profile), `StealthDriver`/proxy scale.

## 2. Flow

```
[account pipeline] ──▶ account WARM (logged in, parked on dashboard; NOT logged out)
        │
        ▼
   SlotWatcher: paced lift-api poll using webRequest-captured auth (already built)
        │  diff vs last-seen → SLOT_DETECTED
        ▼
   BookingService: driver.book(account, profile)  ──▶ Steps 1–5 (Step-3 Turnstile via 2Captcha)
        │
        ▼
   BOOKED (confirmationNumber)  |  FAILED(code → feeds the shared 429/state logic)
```

## 3. Components (thin layer over the account brain)

- **`SlotWatcher`** — for each WARM account, polls the VFS slot endpoint (`lift-api…/appointment/slots`) on the **shared paced tick** (global rate limiter + per-account interval + jitter — same limiter as the account pipeline, so polling cannot burn accounts). Keeps `lastSeenSlots` per (centre, category) and fires `SLOT_DETECTED` only on a positive diff (so a slot that opens and closes between polls still triggers).
- **`BrowserDriver.book(input)`** — new method on the existing interface:
  ```ts
  book(input: BookInput): Promise<DriverResult>;  // drives Steps 1–5, returns confirmationNumber in data
  ```
  `ExtensionDriver.book()` → existing `BG_BOOK_VFS` → `runBookingSteps`. `StealthDriver.book()` later, unchanged caller.
- **`BookingService`** — on `SLOT_DETECTED`: pick the WARM account that saw it, take the configured applicant **profile** (existing dashboard profile data — no new queue table), call `driver.book()`. One booking at a time (extension = 1 Chrome; config-gated for later concurrency). Booking is the **priority action**, preempting routine polling.
- **Stay-warm:** a WARM account is **not logged out** after login; it remains parked. If its session ages past the freshness threshold, the account pipeline re-logs it in (`WARM → ACTIVE → LOGGING_IN → WARM`).

## 4. Speed (slot → submit)

The win condition is booking before the slot vanishes. The account is **already logged in and parked**, so on `SLOT_DETECTED` the driver goes straight into Steps 1–5 — no cold login. Target: submit within seconds of detection. Step-3 Turnstile is the main latency risk; 2Captcha solve (~1–20s) is the variable — acceptable, and the only alternative (auto-pass) is a bonus.

## 5. Booking-step states & error handling

- Per-attempt booking states: `WATCHING → BOOKING → BOOKED → (or) BOOK_FAILED`.
- `driver.book()` returns typed `DriverResult.code`; `BookingService` maps it:
  - `OK` + confirmation → `BOOKED`.
  - `429001/429202` (during poll or book) → feed the **shared** account state machine (RESTRICTED/cooldown) — booking and account logic share one restriction authority.
  - `TURNSTILE_FAILED` → retry once via 2Captcha, then back to `WATCHING`.
  - `NO_SLOTS_IN_ANY_SUBCATEGORY` / slot vanished → back to `WATCHING` (lost the race; keep polling).
- Booking never re-drives a RESTRICTED account (shared invariant).

## 6. Testing

- **Unit (no VFS):** slot-diff detection, `SLOT_DETECTED` firing, BookingService selection + state mapping — against a mock `BrowserDriver`.
- **Integration:** `ExtensionDriver.book()` ↔ `BG_BOOK_VFS` message mapping (stubbed WS).
- **Live (manual, gated):** with a WARM account parked, validate Steps 1–5 the next time a real slot is available (the only way to prove 2–5 + Step-3 Turnstile). Operator-watched; first live runs may surface step bugs — iterate.

## 7. Success criteria

- A WARM account stays parked and polls for slots on the paced tick without burning accounts.
- On a real slot, the bot drives Steps 1–5 hands-off to a confirmation number (Step-3 Turnstile solved via 2Captcha).
- Polling/booking 429s flow into the shared restriction state machine — the pool is never wiped.
- `book()` is exercised by unit tests with a mock driver and reused unchanged when `StealthDriver` lands.
