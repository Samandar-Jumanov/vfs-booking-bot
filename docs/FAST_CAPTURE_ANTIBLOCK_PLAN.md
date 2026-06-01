# Plan — Fast Slot Capture + Beat the Blocking (multi-agent)

**Owner:** orchestrator plans/verifies/commits · subagents execute in parallel.
**Goal:** detect a Work-D slot the instant it appears, book it immediately, and
stop the VFS/Datadome IP throttling — for 10+ clients on one clean UZ VPS.

---

## Acceptance criteria (definition of done)
1. **Fast detection:** a slot is detected within ≤ a few seconds of appearing
   (not the current ~minutes of UI re-navigation per check).
2. **Instant book:** on detection the bot goes straight to booking (cached route,
   no full wizard re-walk) and submits with the right client's passport.
3. **No self-inflicted blocks:** the bot detects `page-not-found` /
   `session-invalid` / `429` and backs off automatically instead of hammering.
4. **Light footprint:** monitoring is by authed API (no full page reloads / no
   repeated Turnstile) so volume stays under Datadome's threshold.
5. **All clients covered:** every active client account is watched (round-robin or
   concurrent API), not just one.
6. **Reliable onboarding:** register-once + gentle pacing + daily caps so account
   creation never bursts into a throttle.

---

## The 6 pillars (what we're building)
- **P1 — API monitoring:** poll VFS `lift-api` availability with captured
  `authorize`/`clientsource`/`route` headers instead of driving the UI. Near-instant,
  no reload, no captcha. UI only when a slot is found (to book).
- **P2 — Fast booking path:** cache centre/category/subcat selection; on a slot, jump
  straight to Step 1→5; trim fixed sleeps. (auto_pipeline.py)
- **P3 — Block detection + auto-backoff:** classify page-not-found / session-invalid /
  429 → exponential per-IP/per-account cooldown; never retry into a hot wall.
- **P4 — Gentle pacing + daily caps:** `REGISTER_STAGGER_SEC` (≥900s), max registrations/day,
  jitter; register each account ONCE then reuse (no churn).
- **P5 — Multi-account monitoring:** watch all active clients. API polling is light enough
  for round-robin (default) or limited concurrency; tune cadence vs IP volume.
- **P6 — Session reuse:** persist logged-in cookies per account so we don't re-login /
  re-Turnstile every cycle (fewer challenges = less Datadome scrutiny).

---

## Workstreams, file ownership, parallelism

> Conflict rule: no two parallel agents edit the same file. Integration into
> `orchestrator-worker.ts` is done sequentially by the orchestrator.

### PHASE 1 — parallel NOW (code-only, no live VFS / IP needed)
- **WS-A — Booking-path speed** · file: `nodriver-spike/auto_pipeline.py`
  - Cache the subcat dropdown index after first find (skip the per-check full scan).
  - On a monitor check, avoid full `location.reload()` + centre/category re-pick when
    state can be reused; trim the 2–2.5s fixed sleeps to event-waits.
  - Fast-path: when a slot is found, go straight into `book()` with minimal delay.
  - MUST keep working when run standalone; no behavior change to the actual book steps.
- **WS-B — Block detection + backoff + pacing** · NEW file
  `backend/src/modules/lifecycle/throttleGuard.ts` + minimal hook in
  `backend/scripts/orchestrator-worker.ts` (orchestrator will merge the hook).
  - `classifyResponse(urlOrText)` → `ok | page_not_found | session_invalid | rate_limited`.
  - Exponential backoff state per IP/account (in-memory + persisted to a Settings row).
  - Daily registration cap + `REGISTER_STAGGER_SEC` honor + jitter helpers.
  - Pure functions + unit tests; the worker hook is a small documented diff.
- **WS-C — lift-api availability recon + spec** · read-only across
  `extension/` (service-worker.ts auth-sniffer) + `nodriver-spike/` + `backend/`
  - Document the exact availability endpoint(s), method, required headers
    (`authorize`,`clientsource`,`route`), payload, and the "slot available" response shape.
  - Output: `docs/LIFT_API_AVAILABILITY_SPEC.md` — enough to build P1 without guessing.
  - Note any gaps that require a LIVE capture (cool IP) to confirm.

### PHASE 2 — after Phase 1 + a cooled IP (live data needed)
- **WS-D — API monitoring module** (from WS-C spec): poll availability via API;
  emit `slot_found` → hand off to the fast booking path (WS-A). Validate against a
  live authed session.
- **WS-E — Multi-account round-robin**: refactor `driveRun` so monitoring cycles
  through all active accounts via the light API poll (not one blocking UI loop).
- **WS-F — Session reuse**: persist/restore per-account cookies to cut re-logins.

### PHASE 3 — integration + live validation
- Orchestrator merges WS-B hook + WS-D/E/F into `orchestrator-worker.ts`.
- Build clean (backend `npm run build`, `py_compile`), unit tests green.
- Live test on cooled IP: onboard 2 fresh accounts gently → API-monitor → force a
  detection → confirm instant book path (DRY-RUN first, then armed).

---

## Testing / validation
- Phase 1: unit tests (WS-B), `py_compile` (WS-A), spec review (WS-C). No IP needed.
- Phase 2/3: needs the VPS + a cooled IP + a live authed session; validate detection
  latency and that no page-not-found is triggered by the API poll.
- Always start DRY-RUN; arm `WORKER_BOOK=1` only after the fast path is proven.

## Risks / notes
- API endpoint shape may need a live capture to finalize (WS-C flags this).
- True concurrency (N browsers) would re-trip Datadome → prefer API round-robin.
- No proxies (BrightData/IPRoyal are Datadome-blocked for VFS); scale = more clean UZ IPs.
- Everything that touches the live IP waits for cooldown (`check_cooldown.py`).
