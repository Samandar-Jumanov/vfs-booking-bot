# Claude Code Plan — Mailsac De-Throttle + Smart-Waits (faster, same stealth)

> **Executor:** Claude Code (Sonnet 4.6)
> **Goal:** Make the pipeline faster and more reliable WITHOUT increasing detection risk: (1) kill the self-inflicted Mailsac 429 storm, (2) replace **dead process-waits** (`sleep(8)` upload, `sleep(7)` OCR, etc.) with **wait-until-ready** that has a max-timeout fallback. **Do NOT touch protective pacing** (per-account poll interval, human jitter between VFS clicks).
> **Type:** Surgical edits + verification. No live VFS. No commit/push.

---

## 0. The principle (read first)

Faster = more detectable, UNLESS you only remove **wasted** time. There are two kinds of delay in this code:

- **Dead waits** = waiting on a machine process to finish (file upload, OCR, page render/redirect, Mailsac polling). Converting these to "poll until the result is actually ready, with a max-timeout cap" is **faster on good runs, identical worst-case, and NOT more detectable.** ✅ Convert these.
- **Protective pacing** = deliberate human-like spacing between VFS interactions + the slot re-check interval. This is what avoids 429/Datadome flags. ❌ DO NOT shorten these.

This plan only touches the first kind.

**HARD RULES:**
1. No live VFS/login/register/booking from here. No `git commit`/`push`.
2. **DO NOT reduce** `MONITOR_INTERVAL` (slot re-check pacing) or remove the small per-click jitter sleeps (~0.15–1.3s) — those are anti-flag protection. You may keep a small jittered floor; you may NOT make VFS-facing actions machine-fast.
3. Every wait-until-ready MUST have a **max-timeout fallback** so worst-case ≤ the current fixed sleep and it can never hang forever.
4. Keep edits surgical; don't refactor unrelated code. Don't create shell-redirect junk files.
5. Keep `npm test` green and both Python files `py_compile`-clean.

---

## 1. What "done" looks like

- `register_spike.py` no longer polls Mailsac (the 429 storm is gone); registration is confirmed from the network POST signal it already captures.
- Remaining Mailsac calls (Python OTP polling + backend activation fetch) have **429 backoff** (respect `Retry-After`, exponential, capped).
- The dead process-waits (`upload`, `OCR`, `outcome`, `login`) are wait-until-ready with max-timeout caps.
- Protective pacing untouched (`MONITOR_INTERVAL`, per-click jitter intact).
- `npm run build` clean, `npm test` green, `py_compile` clean.
- `SPEED_MAILSAC_REPORT.md` written. Nothing committed.

---

## 2. Tasks (in order)

### Task 1 — Remove the Mailsac 429 storm in `register_spike.py`
**Context:** lines ~384–425 run `for _ in range(20): link = mailsac_link(email); … sleep(6)` to "confirm registration via the activation email." This is **pointless** — the spike doesn't activate (it sets `activated=false`); the worker/backend does activation. This loop made ~20 Mailsac calls in seconds → the `HTTP 429` storm you saw, and it delayed RESULT by up to ~2 min.
**What to do:**
1. Delete the Mailsac activation-poll block (~384–425). Determine `registered` from the **network POST signal already captured** (`POST /user/registration` seen / `submittedSignal`) — that's how `registered:true` is set today regardless of the email. Keep emitting the `registered` milestone + the `RESULT: {...}` line with `registered` set from the POST signal and `activated:false`.
2. Reduce the trailing `await asyncio.sleep(10)` ("browser open 10s", line ~437) to ~2s (just enough to flush) — the worker reads RESULT from stdout, it doesn't need the browser to linger.
3. Leave `mailsac_link()`/`mailsac_list()` definitions in place if still referenced elsewhere; if now unused, remove them too (check first).
**Done when:** `register_spike.py` makes **zero** Mailsac calls during a normal register; `py_compile` clean; the `RESULT` line still reports `registered` correctly from the POST signal.

### Task 2 — Add 429 backoff to the Mailsac calls that REMAIN
These are legitimate and must stay, but need backoff so they never storm:
- **Python** `auto_pipeline.py`: `mailsac_list()` / `mailsac_body()` (used by `mailsac_otp_code()` during booking). On HTTP 429: read `Retry-After` if present, else exponential backoff (e.g. 2s→4s→8s, cap ~30s), with a small jitter; keep the overall OTP deadline.
- **Backend** Mailsac email provider (used by `reconciliation.service.fetchEmailVerificationLink` for activation): same 429 backoff so activation polling doesn't burst.
Add a tiny shared helper rather than copy-pasting, if it fits the existing structure.
**Done when:** both Mailsac consumers back off on 429 instead of hammering; report shows the diffs.

### Task 3 — Convert DEAD waits to wait-until-ready (`auto_pipeline.py`)
Add a helper, e.g. `async def wait_until(page, js_predicate, timeout, interval=0.4)` that polls `jeval(page, js_predicate)` until truthy or `timeout`, returning whether it became ready. Then convert these **dead process-waits** (keep each one's current value as the max-timeout cap):
- **Line ~439 `sleep(8)` (file upload):** wait until the upload is reflected (e.g. the "Continue"/process control appears or a filename/preview shows), cap 8–10s.
- **Line ~444 `sleep(7)` (OCR extraction):** wait until extracted fields / the Save button become enabled, cap 8s.
- **Line ~537 `sleep(5)` (submit outcome render):** wait until the URL changes OR confirmation/payment keywords appear, cap 6s.
- **Line ~160 `sleep(10)` (post-login settle):** wait until dashboard/wizard element present, cap 10s.
- Other `sleep(2)/sleep(3)` that purely gate a page transition (e.g. ~423/426/450/465/471/518) MAY be converted to short wait-until with a cap; if unsure whether a given one is a transition-wait vs human-pacing, **leave it**.
**DO NOT convert / DO NOT shorten:** `MONITOR_INTERVAL` (line 622), the per-click jitter sleeps (~0.15–1.3s in `select_route`/`fill`/dropdown handling). These are protective.
**Done when:** the four big dead waits are wait-until-ready with caps; protective pacing untouched; `py_compile` clean.

### Task 4 — Prove nothing broke
- `cd backend; npm run build` → exit 0.
- `cd backend; npm test` → green (state count).
- `python -m py_compile nodriver-spike/auto_pipeline.py nodriver-spike/register_spike.py` → clean.
- Re-read the changed booking/region code once to confirm control flow still reaches every step (no accidentally-dropped step from removing a sleep).
**Done when:** all pasted as evidence.

---

## 3. Required output: `SPEED_MAILSAC_REPORT.md`

```markdown
# Speed + Mailsac Report (<date>)

## TL;DR
What got faster, what got de-throttled, confirmation protective pacing is untouched.

## Task 1 — register_spike Mailsac storm removed
What was deleted; how `registered` is now determined (POST signal); browser-linger reduced.

## Task 2 — 429 backoff
The two Mailsac consumers + the backoff strategy (Retry-After/exponential/cap), with diffs.

## Task 3 — dead waits → wait-until-ready
Table: site (line) | old fixed sleep | new wait condition | max-timeout cap.
Explicit list of what you LEFT ALONE (MONITOR_INTERVAL + jitter) and why.

## Task 4 — green suite
build / test (count) / py_compile.

## Est. time saved (rough)
e.g. register −~2min (no Mailsac storm), booking −~10-15s (upload/OCR/outcome waits).

## What's staged (not committed)
```

---

## 4. Final step

Write `SPEED_MAILSAC_REPORT.md`, post the TL;DR + a one-line confirmation that `MONITOR_INTERVAL` and per-click jitter were NOT touched (so detection risk is unchanged), then stop. Operator + orchestrator review and commit; the real timing win is confirmed on the operator's next live run.
