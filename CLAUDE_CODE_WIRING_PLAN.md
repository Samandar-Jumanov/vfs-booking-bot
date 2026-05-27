# VFS Booking Bot — "One-Button End-to-End" Wiring Plan (Claude Code, Sonnet 4.6)

Build the integration that makes the dashboard **"Start Scenario"** button run the
whole pipeline **end-to-end, live, and observable** — in one session, using **parallel
subagents**, then **test everything (including a no-VFS simulation) and report**.

This builds on the existing backbone (commit `a4897ac`). The backbone modules exist and
pass unit tests but are **NOT wired to the real doers**. Your job is to wire them.

---

## 0. The problem you are solving

Today there are **two disconnected worlds:**
- **World A (proven doers):** `nodriver-spike/register_spike.py` (register) and
  `auto_pipeline.py` (login→monitor→book), spawned by `backend/scripts/local-runner.ts`
  / `register-runner.ts`. They run standalone, emit their **own crude Telegram**, and do
  **NOT** update `lifecycleState`, fire the polished notifications, or write
  `PipelineEvent` rows.
- **World B (new backbone):** TS state machine (`src/modules/lifecycle/`), polished
  Telegram events (`notification.service`), `pipeline-event.service`, heartbeat,
  `scenario.router`. Built + tested + deployed but **run by nothing** and connected to
  World A only loosely via the DB.

**Result:** clicking "Start Scenario" only queues registrations + runs activation
reconcile. It does NOT drive login/monitor, and failures in the doers are invisible
(not logged, not alerted). You will connect A↔B so one click runs the chain and every
step is reported back live.

### The one hard constraint (do not try to remove it)
The backend runs on Railway (datacenter, not Uzbekistan) and **cannot run browsers** —
VFS needs a real Chrome on a **clean UZ IP**. So the muscle **must** run on the
operator's UZ machine. The button can only *signal* a UZ-side worker; that worker does
the work and **reports back**. Architecture:

```
[Dashboard "Start"] → Railway backend (sets a run signal)
                          ▲ report-back (HTTP)        │ signal (poll/WS)
                          │                            ▼
                  UZ Orchestrator Worker (always running on the UZ machine)
                    register (ext) → activate (ext) → login (nodriver) → monitor → book
                    emits a MILESTONE after every step → backend → lifecycleState +
                    Telegram event + PipelineEvent → dashboard shows it live
```

---

## 1. Ground yourself first (read before writing)
- `CLAUDE.md`, `CLAUDE_CODE_BUILD_PLAN.md` (the backbone spec)
- `backend/scripts/local-runner.ts`, `backend/scripts/register-runner.ts`
- `nodriver-spike/auto_pipeline.py`, `nodriver-spike/register_spike.py`
- `backend/src/modules/scenario/scenario.router.ts`
- `backend/src/modules/lifecycle/` (state-machine, lifecycle.service, pacer, slot-watcher, booking.pipeline, account-repo, types)
- `backend/src/modules/notifications/` (notification.service, heartbeat)
- `backend/src/modules/pipeline-events/pipeline-event.service.ts`
- `backend/src/modules/accounts/reconciliation.service.ts`
- `backend/src/modules/websocket/ws.server.ts` (extension WS, `isExtensionLive`)
- `backend/src/modules/booking/extension-dispatch.service.ts` (triggerActivationVisit etc.)
- `backend/prisma/schema.prisma` (VfsAccount, lifecycleState, PipelineEvent, Settings)

---

## 2. What to build

### Component 1 — Backend report-back + control channel (the A↔B seam)
- **`POST /api/pipeline/event`** (worker → backend; auth via a shared `WORKER_TOKEN`
  bearer). Body: `{ runId, accountId, email, step, fromState, toState, status: 'ok'|'fail', detail?, slotId?, confirmation?, error?, url?, screenshotPath? }`.
  Handler MUST:
  - update the account's `lifecycleState`/`status` per `toState`,
  - write a **`PipelineEvent`** row (Phase 4),
  - fire the **polished Telegram event** (Phase 3) for the relevant steps:
    `SLOT_FOUND → "Book for slot: {slotId}"`, `BOOKING_SUCCESS {confirmation}`,
    `BOOKING_FAILED {error}`; `status:'fail'` with severity critical → critical alert.
- **`POST /api/scenario/start`** (extend existing): when `SCENARIO_ENABLED=true`, create
  a **run signal** the worker watches — a `Settings` key `scenario_run` =
  `{ runId, requestedAt, poolMinSpare, status:'requested' }` — and still do the
  queue + reconcile it does today. Return `{ triggered:true, runId }`.
- **`GET /api/scenario/status?runId=`** — returns the run + a live snapshot of each
  account's `lifecycleState`/`status`/last `PipelineEvent`. The dashboard polls this.
- Keep everything **flag-gated** on `SCENARIO_ENABLED`.

### Component 2 — The UZ Orchestrator Worker (the muscle conductor)
New `backend/scripts/orchestrator-worker.ts` (Node, runs on the UZ machine; persistent).
- Connects to the backend; **polls `GET /api/scenario/run` (or the Settings key)** for a
  `requested` run; claims it.
- Drives the **per-account state machine** through the chain, **paced for one IP**
  (reuse the existing `pacer`; stagger logins ~1/30–60s, jitter, 429 backoff):
  1. **Pool top-up**: if spare ACTIVE < target, drive **register** (spawn
     `register_spike.py`) → persist PENDING (as register-runner does today).
  2. **Activate**: call the backend reconcile path so the **extension** visits the
     Mailsac link → ACTIVE. **Fail loudly** if the extension is not live (do NOT use the
     broken HTTP/BrightData fallback to fake-activate — emit a `fail` milestone +
     critical alert instead).
  3. **Login + Monitor**: spawn `auto_pipeline.py` per ACTIVE+linked account.
  4. After **every** step, POST a **MILESTONE** to `/api/pipeline/event`.
- **Merge/replace** `local-runner.ts` + `register-runner.ts` logic here (or have the
  worker call them) — one conductor, not three scripts. Keep the proven spawn logic.
- Env: `WORKER_TOKEN`, `BACKEND_URL`, `DATABASE_URL`, pacing knobs, `SIMULATE=1`.
- **`SIMULATE=1` mode (REQUIRED for testing):** instead of spawning browsers, walk a
  test account through the full state sequence with fake milestones + delays, POSTing
  real `/api/pipeline/event` calls. This proves the **entire one-button flow + live
  dashboard + Telegram** with **zero VFS hits**.

### Component 3 — Doers emit structured milestones
- `register_spike.py` and `auto_pipeline.py`: in addition to existing logs, print
  machine-readable lines: `MILESTONE {json}` at each step (registered, activation_visited,
  logged_in, monitoring, slot_found{slotId}, booking_submitted, booked{confirmation},
  failed{error}). The worker parses these from stdout and bridges them to the backend.
  Keep the doers otherwise unchanged (they're the proven muscle). Disable the doers'
  own crude Telegram when `WORKER_BRIDGED=1` (the backend now owns notifications).

### Component 4 — Dashboard live view
- "Start Scenario" → POST start → store `runId` → **poll `GET /api/scenario/status`**
  (every ~3–5s) → render a **live per-account progression** (email, current
  `lifecycleState`, last step, timestamp, status badge). Show the run as it advances
  NEW→REGISTERED→ACTIVATED→LOGGED_IN→MONITORING→(BOOKED/FAILED).
- Disabled-state banner when `SCENARIO_ENABLED` is off.

---

## 3. Parallel subagent dispatch (REQUIRED)

```
Wave A (parallel, one message — 3 subagents):
  • Subagent 1: Component 1 (backend report-back + control + status endpoints, wire
                Phase-3 Telegram + Phase-4 PipelineEvent into /api/pipeline/event)
  • Subagent 3: Component 3 (python MILESTONE emission in both doers)
  • Subagent 4: Component 4 (dashboard live status view, against the new status endpoint)
Wave B (after Component 1 lands):
  • Subagent 2: Component 2 (orchestrator-worker.ts + SIMULATE mode)
Lead: integrate, run the full test pass (incl. SIMULATE end-to-end), write the report.
```

Give each subagent the files to read, its component's spec, and the hard rules below.

---

## 4. Hard rules
1. Read before writing; match conventions; TS strict; surgical changes.
2. **Flag-gate everything** on `SCENARIO_ENABLED` (and `WORKER_BRIDGED` for the doers).
   Nothing changes default behavior until flags are set.
3. **Never commit secrets.** `WORKER_TOKEN` via env.
4. **Single-IP pacing** is mandatory in the worker (reuse `pacer`).
5. **Do NOT hammer VFS** — all real-VFS testing is gated; prefer `SIMULATE=1`. The IP
   flags after ~10 hits/session (30–60 min cooldown).
6. **Activation must FAIL LOUDLY if the extension is offline** — never fake-activate via
   the HTTP/BrightData fallback (it returns status=0 / can't reach vfsglobal). Emit a
   `fail` milestone + critical alert.
7. **Do NOT push / open PRs / apply prod migrations** without explicit user confirmation.
   Generate migration files only; commit locally.
8. Idempotent / crash-resume: DB + `runId` are the source of truth.

---

## 5. Test everything (before reporting)
- `tsc --noEmit` (backend + frontend) clean; run unit tests; add tests for the
  `/api/pipeline/event` handler (state update + notification + PipelineEvent) and the
  worker's state sequencing + pacing.
- **THE KEY TEST — SIMULATE end-to-end (no VFS):** run the worker with `SIMULATE=1`
  against the deployed (or local-against-Railway-DB) backend with `SCENARIO_ENABLED=true`
  and `WORKER_TOKEN` set. Click/POST `Start Scenario`. Confirm:
  - the worker claims the run,
  - milestones POST back,
  - `lifecycleState` advances in the DB,
  - the **polished Telegram events fire** (incl. `"Book for slot: {id}"`),
  - **`GET /api/scenario/status` shows the live progression**,
  - PipelineEvent rows are written, and a forced `fail` produces a critical alert.
  Paste evidence (Telegram screenshots, status JSON over time, DB rows).
- Verify endpoints live with a signed admin JWT (pattern in `trigger-register.ts`).
- Booking final-submit stays UNVALIDATED (needs a live slot) — the SIMULATE path proves
  the wiring; real VFS validation is a later cooled-IP run.

## 6. Final report (Section-8 style)
Per-component summary + files; test results with evidence (esp. the SIMULATE end-to-end
proof); verified vs unverified (real VFS run + booking need a cooled IP/live slot);
migrations created-not-applied; exact operator run steps (how to start the worker on the
UZ machine, which env flags to set: `SCENARIO_ENABLED`, `WORKER_TOKEN`, `WORKER_BRIDGED`);
and anything changed from this plan. Do not push. Stop and wait for review.

---

## Acceptance: after this build, with the worker running + `SCENARIO_ENABLED=true`, clicking **"Start Scenario"** advances accounts through the full chain **live on the dashboard with Telegram narration** — proven end-to-end in SIMULATE mode with zero VFS risk, and ready for a real cooled-IP run (booking still armed for a live slot).
