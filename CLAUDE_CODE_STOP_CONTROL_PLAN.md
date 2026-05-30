# Claude Code Plan — Stop Scenario control + Remove Login Batch

> **Executor:** Claude Code (Sonnet 4.6)
> **Goal:** Give the operator a working **Stop Scenario** button that actually halts a running scenario (including the never-ending monitor loop), and **remove the risky Login Batch** feature (the `429001` mass-login hazard that self-runs and can't be stopped).
> **Type:** Backend + worker + frontend edits. No live VFS. No commit/push.

---

## 0. Why this exists (the bug)

- **Start Scenario can't be stopped:** there is a start + status path but **no stop endpoint**. The worker (`orchestrator-worker.ts`) claims the run and blocks inside the Python child (`spawnAndWatch` awaits `child.on('close')`), and `auto_pipeline.py` monitors in a `while True` loop that only exits on a booking. So nothing can interrupt it; `launch-worker.ps1` even auto-restarts the worker on exit.
- **Login Batch self-runs and can't be cleanly stopped:** `POST /login-batch` starts a job that logs in many accounts (the `429001` ban hazard, see [[project_vfs_429_codes_distinct]]); cancel only stops *pending* items. The operator wants it **removed**.

## Control-flow facts (verified)
- The worker reads the run straight from the DB each loop: `prisma.settings.findUnique({ where: { key: 'scenario_run' } })` (`orchestrator-worker.ts:627`). Statuses used: `requested → running → completed/failed`. Stale `running` runs (>90s, `STALE_RUN_MS`) get reclaimed.
- So a **new terminal-ish status `stopping`/`stopped`** that the worker checks **during** the child run is the clean mechanism — no new HTTP call needed from the worker; it already has `prisma`.

**HARD RULES:**
1. No live VFS/login/register/booking. No `git commit`/`push`.
2. Surgical edits; match existing style. Don't create shell-redirect junk files.
3. Keep `npm test` green (adjust only tests tied to removed Login-Batch code, and justify).
4. **Frontend UI changes need a real browser check before they're trusted** — you can't run that here, so your job is to make them type-check/build cleanly and the **operator verifies in the browser before push** (state this in the report).

---

## 1. What "done" looks like

- A `POST /api/scenario/stop` endpoint sets the run to `stopping`.
- The worker, **while a Python child is running**, polls the run status and **kills the child + aborts the run** when it sees `stopping`; the run ends as `stopped` (terminal — NOT reclaimed).
- A **Stop Scenario** button in the dashboard calls it and reflects state.
- The **Login Batch** button is gone from the UI and its backend routes are removed/disabled.
- **One-click continuity:** a single Start drives a freshly-registered account create→activate→login→book without a second click (bounded, stop-aware activation wait).
- `npm run build` clean, `npm test` green, frontend builds/type-checks.
- `STOP_CONTROL_REPORT.md` written. Nothing committed.

---

## 2. Tasks (in order)

### Task 1 — Backend: Stop endpoint
In `backend/src/modules/scenario/scenario.router.ts` (uses `SCENARIO_RUN_KEY = 'scenario_run'`):
- Add `POST /stop`: read the current `scenario_run`; if its status is `requested` or `running`, update it to `status: 'stopping'` (keep the rest of the meta). If there's no active run, return ok with a "nothing running" note. Return the updated run.
- Make sure the status enum/types include `stopping` and `stopped` wherever the run shape is typed (here and in the worker's `ScenarioRun` interface).
**Done when:** hitting the endpoint flips the run to `stopping`; build clean.

### Task 2 — Worker: honor the stop signal (the core fix)
In `backend/scripts/orchestrator-worker.ts`:
1. **Abort the child on stop.** In `spawnAndWatch` (line ~156) add a periodic check (e.g. every 8–10s via `setInterval`) that reads `prisma.settings.findUnique({ where: { key: 'scenario_run' } })`; if the run's status is `stopping` or `stopped`, call `child.kill('SIGTERM')` (and after a short grace, `SIGKILL` if still alive), clear the interval, and let the `close` handler resolve. This is what finally interrupts the `while True` monitor.
2. **Abort between accounts.** In `driveRun`'s account loop (line ~509), check the run status before each `driveAccountReal`; if `stopping`/`stopped`, `log('stop requested — aborting run')` and break.
3. **Mark terminal.** In the main loop (line ~635–673), after `driveRun` returns, if the run status is `stopping`/`stopped`, set it to `stopped` (terminal) instead of `completed`. Ensure the **reclaim logic does NOT reclaim `stopped`** runs (it currently only reclaims `requested` or stale `running` — confirm `stopped` is excluded so a stopped run stays stopped).
4. Also have the main loop, while idle-polling a `running` run, notice a `stopping` status and treat it as terminal.
**Done when:** with a run in `stopping`, the worker kills the Python child within ~10s and ends the run as `stopped`, and does not re-claim it. (Validate by code reasoning + unit-level where possible; full live validation is the operator's.)

### Task 2b — One-click continuity (create→activate→login→book in ONE Start)
**Context (the "stops after one account" bug):** `driveRun` does pool top-up (`registerOne`) → then queries `where:{status:'ACTIVE'}` to drive. A freshly-registered account is `PENDING`; `registerOne` already awaits a synchronous `/api/pipeline/reconcile` (activation) — but if that activation doesn't finish in time (e.g. it previously timed out on the now-fixed Mailsac 429 storm), the account is still `PENDING` when the ACTIVE query runs, so it isn't driven and the run ends — the operator has to click Start a second time. We want **one Start to chain all the way through**, reliably.
**What to do (belt-and-suspenders, surgical):**
1. Have `registerOne` **return the registered account's email + final status** (currently returns void) instead of just logging it; collect these in `driveRun`'s pool-top-up loop.
2. After top-up, **before** the ACTIVE drive query: if any just-registered account is still `PENDING`, **poll the DB** (e.g. every ~10–15s, up to a ~3–5 min cap) until it flips to `ACTIVE`, then continue. Log progress (`waiting for <email> to activate…`).
3. If it's still `PENDING` after the cap → **don't hang**: proceed to drive whatever IS active, and emit a clear milestone/Telegram (`activation did not complete in time for <email>`). Never loop forever.
4. **Respect the stop signal** (Task 2): the activation-wait loop must also check the run status and abort if `stopping`/`stopped`.
5. Do NOT change the pacing/registration throttle; this only adds a bounded wait so the same run picks up the freshly-activated account.
**Done when:** in a single run, a freshly-registered account that activates within the cap is driven (login→monitor→book) without a second Start; the wait is bounded and stop-aware. (Code-reasoned here; operator confirms live.)

### Task 3 — Remove Login Batch
1. **Backend** (`backend/src/modules/accounts/accounts.router.ts`): remove the three routes `POST /login-batch`, `GET /login-batch/:jobId`, `POST /login-batch/:jobId/cancel` and the `loginBatch.service` import.
2. **Service file** `loginBatch.service.ts`: check who references it. If only the removed routes + its own tests use it, delete the file and its test(s). If something else depends on it, leave the file but ensure it's no longer reachable from the API. Report what you found.
3. **Confirm no auto-trigger:** verify the 6-hourly mass-login cron stays OFF (`LOGIN_CRON_ENABLED` default false in `env.ts`) — do not enable it; just confirm. (This + removing the button is what stops it "running itself".)
4. **Frontend:** remove the **Login Batch** button and any handlers/state/api calls for it (search the dashboard / account-pool pages — `frontend/src/app/(protected)/...`). Remove now-unused imports.
**Done when:** no `login-batch` route or button remains; build + tests green; report lists exactly what was removed and the service-file decision.

### Task 4 — Frontend: Start/Stop as a coherent pair
**Keep the existing Start Scenario button** — do NOT remove it. The goal is a clean Start/Stop toggle so the operator is never stuck. In the dashboard where **Start Scenario** lives (`frontend/src/app/(protected)/dashboard/page.tsx` and/or `setup/page.tsx`):
- Add a **Stop Scenario** button that calls `POST /api/scenario/stop`, styled consistently with Start.
- **Drive both buttons off the run status** (poll/read `GET /api/scenario/status`):
  - **Idle / `completed` / `failed` / `stopped`** → **Start enabled**, Stop hidden/disabled.
  - **`requested` / `running`** → **Start disabled** (prevents double-start / stacking runs), **Stop enabled**.
  - **`stopping`** → both disabled, show "Stopping…" until it resolves to `stopped`, then back to idle.
- So at any moment exactly one action is available: you can always either Start (when idle) or Stop (when running). No state where you're stuck.
**Done when:** Start and Stop reflect run status as above and the frontend type-checks/builds. (Operator does the live browser check.)

### Task 5 — Prove nothing broke
- `cd backend; npm run build` → exit 0.
- `cd backend; npm test` → green (state count; if you removed Login-Batch tests, say which + why).
- Frontend: run its build/type-check script (inspect `package.json`); record result.
- `grep -rni "login-batch\|loginBatch" backend/src frontend/src` → only expected leftovers (none in routes/UI).
**Done when:** all pasted as evidence.

---

## 3. Required output: `STOP_CONTROL_REPORT.md`

```markdown
# Stop Control Report (<date>)

## TL;DR
Stop Scenario now works (how) + Login Batch removed (what). Test status.

## Task 1 — Stop endpoint
The route + the status flow (requested/running → stopping → stopped).

## Task 2 — Worker honors stop
How the child gets killed mid-monitor; how the run ends 'stopped' and isn't reclaimed. Key diffs.

## Task 2b — One-click continuity
How a freshly-registered account is now driven in the same run (bounded, stop-aware activation wait); what happens if activation exceeds the cap.

## Task 3 — Login Batch removed
Routes removed; service-file decision (deleted? kept? why); confirmation LOGIN_CRON stays OFF.

## Task 4 — Stop button
Where added; how it reflects state.

## Task 5 — Green
build / test (count) / frontend build / the login-batch grep.

## Operator must verify in browser before push
- Stop Scenario button actually halts a run (watch the worker kill the Python child within ~10s)
- Login Batch button is gone

## What's staged (not committed)
```

---

## 4. Final step

Write `STOP_CONTROL_REPORT.md`, post the TL;DR + the explicit note that the **operator must browser-verify the Stop button halts a real run before we push**, then stop. Orchestrator verifies build/tests; operator validates the live Stop; then we commit.
