# Claude Code Plan — Go-Live Prep: Fully Hands-Off Booking on a Live Slot

> **Executor:** Claude Code (Sonnet 4.6)
> **Operator decisions (locked):** booking account = **Mailsac pool account** (hands-off OTP). Run goal = **real submit / fully book** on a sub-category that has slots.
> **Source of truth:** `DIAGNOSTIC_REPORT.md`, `CLAUDE.md` "Current State", and the code itself.
> **Goal:** Make the autonomous chain — register → activate → login → monitor → **book a real available slot** — provably ready and fully instrumented (Telegram on every step), then hand the operator an exact runbook for the one supervised armed run.

---

## 0. Read this first — what you (Claude Code) can and cannot do

**You CANNOT run the live booking.** The live chain only works from the operator's **UZ machine** (clean Tashkent residential IP + real Chrome/nodriver). You have no UZ IP and no browser here; any `page.goto`/login from this environment will be Datadome-blocked and could flag the account. So:

- **You DO:** verify prerequisites, harden the code so every step notifies via Telegram and the armed-submit path is correct and well-instrumented, keep the test suite green, and write a precise operator **runbook**.
- **The OPERATOR DOES:** the actual armed run via `launch-worker.ps1` with `WORKER_BOOK=1`, supervised, following your runbook.

**HARD RULES:**
1. **Do NOT run `auto_pipeline.py`, `register_spike.py`, the worker, or any script that logs into / hits VFS.** Not even once. That's the operator's job on the UZ machine.
2. **Do NOT run `npm run test:e2e*`** (writes to prod DB).
3. Read-only prod-DB inspection scripts (`backend/scripts/check-test-account.ts`, `find-clean-account.ts`) are **allowed** to identify the Mailsac account — but **read only**, never mutate, and **never print full secrets** (mask passwords/keys).
4. Code edits are allowed where tasks call for them (Telegram instrumentation, slot-gating, submit-outcome capture). Keep changes surgical; match existing style.
5. **Do NOT `git commit` / `push` / open a PR.** Leave changes staged; the operator + orchestrator decide commits.
6. OneDrive path: if git throws a `.lock` error, note and skip.
7. **Never fabricate applicant/passport data.** If the booking account lacks a profile/passport, FLAG it for the operator — do not invent passport numbers.

**Environment:** Windows 11, PowerShell, npm. Backend `backend/`, Python spike `nodriver-spike/`, worker `backend/scripts/orchestrator-worker.ts`, launcher `launch-worker.ps1`.

---

## 1. What "done" looks like

- A written confirmation that the **Mailsac account path makes OTP hands-off**: `MAILSAC_API_KEY` is set in `backend/.env.worker` AND provably propagates into the Python subprocess env; the chosen account uses a Mailsac email; it has an applicant profile + passport image (or this is FLAGGED as a precondition the operator must satisfy).
- Every step of the chain (register, activate, login, monitoring-started, slot-found / no-slot, each booking step, OTP, **submit result**) emits a milestone that reaches **Telegram** — verified in code, gaps filled.
- The booking path **only attempts a sub-category that actually has slots**, and on submit it **captures the outcome** (confirmation number / payment-wall / error) with a screenshot and a clear Telegram SUCCESS/PARTIAL/FAIL message.
- `npm test` still **166/166**, `npm run build` clean, Python files still `py_compile`-clean.
- `ARMED_RUN_RUNBOOK.md` written — the operator's exact step-by-step.
- `GO_LIVE_PREP_REPORT.md` written with evidence.
- Nothing committed/pushed.

---

## 2. Tasks (in order)

### Task 1 — Verify the hands-off OTP path (Mailsac account)
**Why:** The whole "hands-off" claim dies at the OTP gate if the account isn't Mailsac or the key doesn't reach Python.
**What to do:**
1. Confirm `MAILSAC_API_KEY` is present in `backend/.env.worker` (presence only — mask the value).
2. **Trace propagation:** read `backend/scripts/orchestrator-worker.ts` and find where it spawns the Python pipeline (`spawnAndWatch('python', [PIPELINE_SPIKE], ...)`). Confirm the child process env **includes `MAILSAC_API_KEY`** (and `VFS_EMAIL`/`VFS_PASSWORD` for the account). If it's NOT passed through, that's a bug — fix the spawn env so the key reaches `auto_pipeline.py`. Show the before/after.
3. **Identify the account:** using the read-only inspection scripts, list pool accounts and determine which are **Mailsac** addresses vs personal. Pick/confirm a Mailsac pool account suitable for the run. Record its email (Mailsac addresses aren't secret) but mask its password.
4. **Confirm applicant data:** verify the chosen account has an associated applicant **profile + passport image** that the booking form needs (`PROFILE_*` env or DB profile + the passport file path used at `auto_pipeline.py` Step 2 upload). If missing, **FLAG as a precondition** — do not fabricate.
**Test / done when:** Report states: key present (Y/N), key propagates to Python (Y/N, with the spawn-env evidence), chosen Mailsac account email, profile+passport present (Y/N). Any gap is listed as an operator precondition.

### Task 2 — Telegram-on-every-step audit + fill gaps
**Why:** The operator wants a Telegram message at each step. Confirm the milestone→backend→Telegram path fires for ALL of: register, activate, login, monitoring-started, slot-found AND no-slot, each booking step (1–5), OTP requested/filled, and the final submit result.
**What to do:**
1. Map the notification path: Python `milestone(step, ...)` lines → `orchestrator-worker.ts` MILESTONE parsing → backend `/api/pipeline/event` → Telegram send. Confirm it end-to-end in code.
2. List which steps currently emit a milestone and which **don't**. For any missing step, add a `milestone(...)` (Python) / forward (worker) so it reaches Telegram. Keep messages short and human ("✅ Logged in", "🔎 No slots (Work D-visa) — still watching", "📅 Slot found! booking…", "📨 OTP received", "🎉 Booked — confirmation <X>" / "⚠️ Stopped at payment" / "❌ Failed: <reason>").
3. Make sure failures Telegram a **clear reason** (429, Turnstile, OTP timeout, no profile, etc.), not silence.
**Test / done when:** Report has a table: step → milestone emitted? → reaches Telegram? — all YES (or the new code that makes it YES, with diffs). No live send performed; verification is by code trace + unit/logic reasoning.

### Task 3 — Slot-gated booking + submit-outcome capture
**Why:** Don't blindly try a sub-category with no slots (Work-D has none — OCMA may). And when we DO submit for real, we must know exactly where it landed.
**What to do:**
1. In `auto_pipeline.py`, confirm the monitor→book branch only proceeds to booking when the selected sub-category **actually shows availability** (Continue enabled / slots present), and otherwise keeps monitoring + Telegrams "no slots". Confirm `SUBCAT` selects the right sub-category (operator will pass `SUBCAT=ocma`).
2. Harden the **submit outcome** (Step 5): after the real Submit/Confirm click, detect and report which of these happened — (a) **booking confirmed** (capture confirmation/reference number + screenshot), (b) **payment wall** (the route requires manual payment → capture screenshot, Telegram "reached payment, manual payment needed"), (c) **error** (capture message + screenshot). Each must produce a screenshot in `nodriver-spike/shots/` and a distinct Telegram outcome. Treat "reached payment" as a **PARTIAL success** (the bot did its job; payment is out of scope per CLAUDE.md), not a failure.
3. Ensure ret/timeout handling around submit doesn't silently no-op (recall the earlier "Continue click no-op" class of bug — apply the same visible-button/overlay-safe click for Submit).
**Test / done when:** Report documents the three outcome branches with the `auto_pipeline.py` line refs and any hardening diff. Confirm screenshots are written for every branch.

### Task 4 — Keep the suite green + static checks
**What to do (no live runs):**
- `cd backend; npm test` → still **166/166**.
- `cd backend; npm run build` → exit 0.
- `python -m py_compile nodriver-spike/auto_pipeline.py nodriver-spike/register_spike.py` → clean.
**Test / done when:** All three pasted as evidence. If your edits broke a test, fix it before finishing.

### Task 5 — Write the operator runbook: `ARMED_RUN_RUNBOOK.md`
**Why:** The operator runs the real booking; give them an unambiguous procedure.
**What to include:**
1. **Preconditions checklist** (from Task 1): on the UZ machine, clean Tashkent IP (no VPN — recall the VPN→BrightData `ip_blacklisted` trap), `backend/.env.worker` has `WORKER_TOKEN`/`DATABASE_URL`/`PROFILE_ENCRYPTION_KEY`/`MAILSAC_API_KEY`, chosen Mailsac account has profile+passport, Telegram configured.
2. **Exact launch** for the armed run, e.g.:
   ```powershell
   $env:WORKER_BOOK='1'      # arms REAL submit
   $env:SUBCAT='ocma'        # sub-category that has slots
   # (single target account — note how to scope to it)
   .\launch-worker.ps1
   ```
   Explain each flag and that `WORKER_BOOK=1` means a **real booking**.
3. **Expected Telegram sequence** — the exact messages they should see, in order, so they can tell at a glance if a step silently failed.
4. **Watch / abort criteria** — when to let it run vs Ctrl+C (e.g. repeated 429 → stop and cool down 30–60 min; Turnstile fail → fresh profile; OTP timeout → check Mailsac key).
5. **Post-run cleanup** — after a successful real booking on the test account, **cancel the appointment** (per the test-account policy) and how.
6. **Troubleshooting table** — OTP stall, 429202 vs 429001, Turnstile withheld, payment wall, no slots.
**Test / done when:** `ARMED_RUN_RUNBOOK.md` exists, is self-contained, and a non-technical operator could follow it.

---

## 3. Required output: `GO_LIVE_PREP_REPORT.md`

```markdown
# Go-Live Prep Report (<date>)

## TL;DR
Is the chain ready for the operator's armed run? Yes/No + the single most important caveat.

## Task 1 — Hands-off OTP readiness
Key present / propagates / chosen Mailsac account / profile+passport — with evidence. Preconditions for operator.

## Task 2 — Telegram per step
The step→milestone→Telegram table. Diffs for any gaps filled.

## Task 3 — Slot-gating + submit outcome
The three outcome branches, line refs, hardening diffs, screenshot behavior.

## Task 4 — Green suite
npm test (166/166), build (exit 0), py_compile — pasted.

## Task 5 — Runbook
Confirm ARMED_RUN_RUNBOOK.md written; 1-line summary.

## Open risks / unknowns
Honest list — esp. payment wall (we won't know until the operator runs), 429 risk, account-flagging risk.

## What's staged (not committed)
File list.
```

**Evidence rule:** every readiness claim cites the code location or command output. No live VFS hit is evidence here — readiness is proven by code + static checks + the runbook; the *truth* is proven by the operator's run.

---

## 4. Final step

Write `GO_LIVE_PREP_REPORT.md` and `ARMED_RUN_RUNBOOK.md`, post in chat: the TL;DR readiness verdict + the operator preconditions + the top open risk (payment wall). Then **stop** — do not attempt the live run. The operator executes the runbook on the UZ machine; we QA the result together afterward.
