# VFS Booking Bot — One-Shot Build Plan (Claude Code, Sonnet 4.6)

You are working in an existing repo: **VFS Global visa-appointment booking bot**.
Build the multi-phase automation described below **in one session**, using **parallel
subagents (Task tool)** for independent work, then **test everything and report**.

---

## 0. Mission

Turn the existing, partially-wired bot into a resilient, observable, hands-off
pipeline driven by one dashboard button:

> **Start → (create accounts if pool short) → activate → login → monitor slots → auto-book**, with Telegram alerts on every meaningful event and structured before/after error logging.

Scope is fixed: **uzb→lva (Uzbekistan→Latvia) D-visa, work sub-categories (Uzbek/Turkmen + Tajik).** Model-A = **one VFS account per customer profile (1:1)**.

---

## 1. Ground yourself FIRST (do this before writing any code)

Read these to understand current reality (do NOT assume — read them):
- `CLAUDE.md` (project instructions + current state)
- `nodriver-spike/register_spike.py` — nodriver register + activate
- `nodriver-spike/auto_pipeline.py` — login → wizard → monitor → book
- `backend/scripts/local-runner.ts` — spawns auto_pipeline per ACTIVE+linked account
- `backend/scripts/register-runner.ts` — drains the registration queue
- `backend/src/modules/accounts/accounts.router.ts` — account endpoints
- `backend/src/modules/booking/autoBooking.orchestrator.ts` — booking orchestration
- `backend/src/modules/accounts/accountPool.service.ts` — profile↔account linking
- `backend/src/modules/email/mailsac.service.ts` — Mailsac client
- `backend/prisma/schema.prisma` — `VfsAccount`, `Settings`, enums, `lifecycleState`
- `backend/src/utils/crypto.ts` — `encrypt()/decrypt()` (AES-256-GCM)
- `backend/scripts/trigger-register.ts` — how to sign an admin JWT (`signAccessToken`)

---

## 2. Architecture you are building within (do not fight it)

- **Backend**: Node/TypeScript, Express, Prisma + Postgres. Deployed on **Railway**
  (`https://backend-production-24c3.up.railway.app`, auto-deploys on push to `main`).
- **Frontend**: Next.js on Railway (`https://frontend-production-840c.up.railway.app`).
- **Two "doers" run on the operator's clean Uzbekistan-IP machine:**
  - **(A) Chrome MV3 extension** — drives VFS via `chrome.debugger` trusted clicks.
    **PROVEN** at **register + activate** (backend polls Mailsac for the activation
    email; the extension opens the link in the operator's real, Cloudflare-cleared
    Chrome). The extension **cannot log in** (Cloudflare withholds Turnstile for
    `chrome.debugger` sessions).
  - **(B) nodriver** (Python stealth Chrome, `nodriver-spike/`) — **PROVEN** at
    **login** (passes Turnstile), **register** (`registered:true` confirmed),
    **slot monitoring**, and the **booking wizard**. nodriver's **activation does NOT
    land** (a fresh tab lacks Cloudflare clearance) — **activation must go through the
    extension.**

### Hard environment facts
- Windows + PowerShell (Bash also available). Package manager = **npm**.
- `ts-node-dev` ignores an inline `DATABASE_URL` override (re-reads `.env` on respawn)
  — use **`tsx`** or set `.env`. Frontend local dev needs `frontend/.env.local` with
  `NEXT_PUBLIC_API_URL` (inline env doesn't propagate on Windows).
- Railway public DB URL: `railway service Postgres; railway variables --kv | grep DATABASE_PUBLIC_URL` (then `railway service backend` to relink).
- **Cloudflare flags the VFS IP after ~10 hits/session** (cooldown 30–60 min). **Do
  NOT hammer VFS.** Prefer dry-runs; gate any real VFS call behind an env flag.
- Mailsac requires a **browser `User-Agent`** header (Cloudflare error 1010 otherwise);
  auth header is `Mailsac-Key`.

---

## 3. Locked product decisions (from the client — non-negotiable)

1. **"No slot found" → a Telegram HEARTBEAT every ~20 minutes**, NOT one message per
   poll. (Per-check messages would spam the chat into uselessness.)
2. **Activation → via the EXTENSION.** nodriver login only ever touches
   `status = ACTIVE` accounts. Activation is a **hard gate** before login.
3. A dashboard **"Start scenario"** button triggers the whole pipeline: create accounts
   if the spare pool is short, otherwise use the existing pool.
4. **Telegram messages reference a booking/slot id**, format like `Book for slot: {id}`.
5. **Booking is FULLY auto-submit** — no human pause/confirm window.
6. **Slot scope:** uzb→lva, work-D **Uzbek/Turkmen + Tajik** sub-categories only.

---

## 4. The phases (build these)

Each phase has concrete tasks + acceptance criteria. **Flag-gate all new runtime
behavior OFF by default** (env flags) so nothing changes in prod until enabled.

### Phase 1 — State machine + pacing scheduler (the backbone) — *no live slot needed*
- Drive each account through `lifecycleState`:
  `NEW → REGISTERED → ACTIVATED → LOGGED_IN → MONITORING ⇄ BOOKING → BOOKED | FAILED`.
- **DB is the source of truth** → the pipeline must **resume from DB state** after a
  crash (idempotent; never double-register or double-book).
- A **pacing scheduler** for the single IP: stagger logins (~1 per 30–60s, jittered),
  rate-limit slot-checks, exponential backoff on VFS `429`. Encode this centrally so
  every VFS-touching action goes through it.
- **Slot-watching efficiency:** do NOT have every account poll. Designate **1–2
  "watcher" accounts** that poll `CheckIsSlotAvailable`; when a slot appears, **book
  with the customer's matched account**.
- **Acceptance:** unit tests for the state transitions + scheduler pacing math; a
  dry-run that prints the planned schedule for N accounts without touching VFS.

### Phase 2 — Activation gate + reconciliation — *no live slot needed*
- Enforce `status = ACTIVE` as the **only** gate into the login phase.
- Build a **reconciliation job**: find `PENDING` accounts and complete activation **via
  the extension** path (`/accounts/recover-from-mailsac` already does the
  extension activation visit) → flip to `ACTIVE`. Handle the "registered but not
  activated" accounts (e.g. nodriver-registered ones).
- **Acceptance:** a dry-run listing which PENDING accounts would be reconciled; the
  login phase provably refuses non-ACTIVE accounts (unit test).

### Phase 3 — Telegram events + heartbeat — *testable now*
- Events (fire immediately): `SLOT_FOUND` → `"Book for slot: {id}"`,
  `BOOKING_SUCCESS {id, confirmation#}`, `BOOKING_FAILED {id, reason}`. Include enough
  IDs (account + profile + route/sub-category) to differentiate.
- **Heartbeat** every ~20 min: `"Watching · N accounts active · no slots · last check HH:MM"`.
- Wire into the existing notification service. Respect existing flags
  (`NOTIFY_BOOKING_FAILURES` etc.). Add a **manual test-fire** endpoint/script.
- **Acceptance:** fire each event type to a real Telegram chat (test mode) and show
  the messages; heartbeat scheduler unit-tested.

### Phase 4 — Structured error logging (before/after) — *no live slot needed*
- New `PipelineEvent` table (Prisma migration, do NOT auto-apply to prod):
  `{ id, action, accountId?, profileId?, beforeState, afterState?, error?, url?, screenshotPath?, lastNetwork?, severity, createdAt }`.
- Wrap each pipeline action so failures capture: action name, before/after state,
  URL, screenshot, last network calls. Surface to the `/logs` viewer + Telegram-alert
  on `critical`.
- **Acceptance:** a forced failure produces a complete `PipelineEvent` row + a Telegram
  critical alert; `/logs` shows it.

### Phase 5 — "Start scenario" dashboard button — *depends on Phase 1+2*
- A dashboard control that kicks the state machine end-to-end (create-if-short →
  activate → login → monitor → book), showing per-account state live.
- **Acceptance:** clicking it (against a test/dry pipeline) advances accounts through
  states visibly; browser-verified.

### Phase 0 — Booking-submit validation, ARMED — *final fire gated on a live slot*
- `auto_pipeline.py` `SUBCAT` is already configurable. Add a **dry "drive to review
  screen + screenshot, no final submit"** mode so the full booking flow can be
  validated the instant any sub-category has a slot, then switched back to work-D.
- **Acceptance:** dry-mode reaches and screenshots the review screen on demand (when a
  slot exists). Do NOT force a real submit in this build.

### Phase 6 — (OUT OF SCOPE for code) 24/7 UZ hosting + clean-IP fleet for scale.
Note it in the report; do not build.

---

## 5. Parallel subagent dispatch plan (REQUIRED — maximize parallelism)

Use the **Task tool** to run independent phases concurrently. Dependency graph:

```
Phase 1 (backbone) ─┬─► Phase 2 (activation gate)   ─► Phase 5 (Start button)
                    └─► (Phase 5 also needs Phase 2)
Phase 3 (Telegram)  ── independent ── run in parallel
Phase 4 (logging)   ── independent ── run in parallel
Phase 0 (booking dry-mode) ── independent ── run in parallel
```

**Dispatch in waves:**
- **Wave A (parallel, in one message — 4 subagents):** Phase 1, Phase 3, Phase 4, Phase 0.
- **Wave B (after Phase 1 lands):** Phase 2.
- **Wave C (after Phase 1 + 2):** Phase 5.

Give each subagent: the relevant files to read, its phase's tasks + acceptance
criteria, and the hard rules below. Have them return a concise report (files changed,
tests run, pass/fail). You (the lead) integrate, resolve conflicts, run the full test
pass, and write the final report.

---

## 6. Hard rules (every subagent must obey)

1. **Read before writing.** Match existing conventions, TypeScript strict, surgical
   changes, no speculative abstractions.
2. **Flag-gate new behavior OFF by default.** Nothing changes in prod until an env flag
   is set.
3. **Never commit secrets.** Use `.env` / env vars.
4. **Single-IP pacing is a hard constraint** — all VFS-touching actions go through the
   scheduler.
5. **Do NOT hammer VFS** (Cloudflare flags after ~10 hits). Prefer dry-runs; gate real
   VFS calls behind a flag and keep them to a minimum.
6. **Do NOT `git push` or open PRs without explicit user confirmation.** Commit locally
   with clear messages. Do NOT apply Prisma migrations to the prod DB — generate the
   migration file only.
7. **Idempotent / crash-safe**: DB state is the source of truth.

---

## 7. Test everything (do this before reporting)

- `tsc --noEmit` on backend (and frontend if touched) — must be clean.
- Run existing unit tests; add tests for the state machine, scheduler pacing, and the
  reconciliation selector.
- **Dry-run the runners**: `REGISTER_DRY_RUN=1`, `RUNNER_DRY_RUN=1` — confirm pacing,
  account selection, and state transitions without touching VFS.
- **Fire each Telegram event type** + a heartbeat to a real chat (test mode); paste the
  messages seen.
- **Verify backend endpoints live** against the deployed backend with a signed admin
  JWT (pattern in `backend/scripts/trigger-register.ts`). DB checks may use the Railway
  public URL via `railway run` or `DATABASE_PUBLIC_URL`.
- **Force a failure** to prove the `PipelineEvent` + critical-alert path.
- Booking final-submit stays **unvalidated** here (needs a live slot) — say so.

---

## 8. Final report (end with this)

Produce a report containing:
1. **Per-phase summary** — what was built, files changed.
2. **Test results** — each test with pass/fail and evidence (command output, Telegram
   screenshots, JWT endpoint responses, dry-run logs).
3. **Verified vs unverified** — explicitly call out what could NOT be verified and why
   (e.g. booking submit needs a live slot; full VFS run needs a cooled IP).
4. **Migrations created but NOT applied** — list them + the apply command.
5. **Exact next manual steps** for the operator (how to run it on the UZ machine, what
   env flags to flip on, what to watch).
6. **Anything you changed from this plan** and why.

Do not push. Stop after the report and wait for the user to review.
