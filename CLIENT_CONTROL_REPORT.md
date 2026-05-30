# Client Control Report (2026-05-30)

## TL;DR

The dashboard is now the only thing a client needs to operate the system. Four pieces landed:
1. **Engine 🟢/🔴 light** — a worker heartbeat drives an "is the engine running" indicator (the thing that was invisibly off before).
2. **Self-clearing stop** — a run stuck in `stopping` resolves to `stopped` automatically (backend timeout when no worker is online, plus worker cleanup on startup/poll), so the UI never hangs.
3. **Stop button live countdown** — "Stopping… 12s…" counting down, returning to idle on `stopped`, and showing "(finalizing)" rather than a frozen number.
4. **Auto-start** — one-time `ops/install-autostart.ps1` + uninstall + a non-technical `ops/CLIENT_OPERATION.md` so the engine runs on boot without a terminal.

**Build clean. `npm test` 166/166. Frontend builds. Pacing/anti-flag code untouched.**

---

## Task 1 — Heartbeat + Online indicator

**Worker (`backend/scripts/orchestrator-worker.ts`):**
- Added a heartbeat upsert of Settings key `worker_heartbeat = { at: <ISO now> }`.
- **Important design choice:** the heartbeat runs on its **own `setInterval`** (every `POLL_INTERVAL_SEC`, ~10s), *not* inside the poll loop. The poll loop blocks inside `driveRun` for long stretches during slot monitoring; a loop-driven heartbeat would go stale and the engine would wrongly show **offline during an active run**. The independent timer keeps it green while driving. Cleared on process exit.

**Backend (`backend/src/modules/scenario/scenario.router.ts`):**
- Added `readEngineOnline()` — reads `worker_heartbeat` and returns `(now - at) < 30s` (`ENGINE_ONLINE_WINDOW_MS`).
- `GET /api/scenario/status` now returns `engineOnline: boolean` alongside `run` + `accounts`.

**Frontend (`dashboard/page.tsx`):**
- A pill next to the "Scenario" header: green dot + **"Engine: 🟢 Online"** when `engineOnline`, red dot + **"🔴 Offline"** otherwise, with a tooltip ("The booking engine is running / not running").
- Driven by the existing 4s `scenario-status` poll — no new interval.

**Behavior:** stopping the worker → heartbeat goes stale → dashboard flips 🔴 within ~30s. Restarting → 🟢 on the next poll.

---

## Task 2 — Self-clearing stop

Three layers ensure a `stopping` run never hangs:

1. **`stoppingAt` stamp** — already set by `POST /api/scenario/stop` (confirmed present; the run is written as `{ ...run, status: 'stopping', stoppingAt: <ISO now> }`).

2. **Backend self-clear (no live worker):** in `GET /status`, if the run is `stopping` **AND** `engineOnline` is false **AND** `stoppingAt` is older than `STOPPING_SELF_CLEAR_MS` (25s), the endpoint finalizes it to `stopped` and returns that. So even with the worker dead, the UI self-resolves on the next status read.

3. **Worker cleanup:**
   - **On startup** (`clearOrphanedRunOnStartup`): a `stopping` run left by a dead/old worker is finalized to `stopped` before the loop begins.
   - **On each poll**: a `stopping` run that reaches the poll loop (meaning no `driveRun` is actively finalizing it in this worker) is finalized to `stopped`. An actively-driving worker never hits this branch — it's blocked inside `driveRun`, whose existing post-run code already flips `stopping → stopped`.

**Result:** a run left in `stopping` becomes `stopped` within ~25–30s via the backend even with no worker, and immediately when a worker (re)starts or next polls.

---

## Task 3 — Stop button live countdown

In `dashboard/page.tsx`:
- New constant `STOP_COUNTDOWN_SECONDS = 12` (a bit above the worker's ~9s kill window).
- `stopSecondsLeft` is derived from the server's `run.stoppingAt` and the existing 1s `useTicker` (`now`): `max(0, 12 - floor((now - stoppingAt)/1000))`.
- Button label logic:
  - active run, not stopping → **"Stop Scenario"** (StopCircle icon)
  - `stopping`, countdown > 0 → **"Stopping… {n}s"** (spinner icon, `tabular-nums` so the digit doesn't jitter)
  - `stopping`, countdown == 0 → **"Stopping… (finalizing)"** — never a frozen number; Task 2's self-clear resolves it.
- When status becomes `stopped`/`completed`/`failed`, `isRunActive` is false → the whole Stop button unmounts and **Start Scenario** re-enables. The UI always returns to idle.

`isRunActive` / `isStopping` are derived from `scenarioStatus.run.status` so they survive page reloads (server holds the run state).

---

## Task 4 — Auto-start (no terminal for the client)

New `ops/` folder:

- **`ops/install-autostart.ps1`** (run once by a technician, elevated): registers a Windows **Scheduled Task** `VFS-Booking-Worker` that runs the existing `launch-worker.ps1` **at logon** with keep-alive (RestartCount 999, 1-min interval, no execution time limit). `-WithChrome` also registers `VFS-Booking-Chrome` for `launch-bot-chrome.ps1` (needed when activation goes through the operator's real Chrome extension). `-WorkerBook` arms real booking submit. Runs as the logged-on **interactive** user (headed Chrome/nodriver needs a desktop session). Reuses the existing launchers — does not reimplement them.
- **`ops/uninstall-autostart.ps1`**: stops + removes both tasks; touches nothing else.
- **`ops/CLIENT_OPERATION.md`**: a terminal-free, plain-language guide — open dashboard, read the Engine light, Start / Stop, what a red light means (refresh once, else contact the operator).

**Honest limits stated in the doc:**
- The engine needs an **always-on host on a clean UZ IP (no VPN)**; if it's off/offline, the light goes red and nothing books.
- **Code updates require a technician to restart the engine** (`Stop-ScheduledTask` / `Start-ScheduledTask VFS-Booking-Worker` after `git pull`) — not a client action; the light may flick red→green during the restart.
- One run at a time.

*(These helpers can't be executed here — the technician installs/validates them on the actual host.)*

---

## Task 5 — Green

```
backend: npm run build   → exit 0 (tsc + tsc-alias, no errors)
backend: npm test        → Test Suites: 22 passed, 22 total
                           Tests:       166 passed, 166 total
frontend: npm run build  → compiled successfully; /dashboard 11.3 kB (was 11.1)
```

**Pacing/anti-flag untouched:** `git diff` of the worker contains no changes to `STAGGER_SEC`, `JITTER_SEC`, `MONITOR_INTERVAL`, `PACER_CFG`, or any human-jitter sleeps (grep over the diff returns nothing). The heartbeat/stop logic is orthogonal to pacing.

---

## Operator must verify in the browser before push

These are UI/runtime behaviors that can only be trusted after a real check:
- **Stop shows a live countdown and never hangs** — click Stop on a real run, watch "Stopping… 12s…11s…", confirm it returns to idle (and that a worker-dead run self-clears within ~30s).
- **Engine light flips online/offline** — stop the worker and confirm the dashboard goes 🔴 within ~30s; start it and confirm 🟢. Confirm it stays 🟢 *during* an active monitoring run (the independent-heartbeat fix).
- **(separately, on the host)** — `ops/install-autostart.ps1` registers the task and the engine launches on logon; `uninstall` removes it.

---

## What's staged (not committed)

Modified:
- `backend/scripts/orchestrator-worker.ts` — independent heartbeat timer; startup + poll-loop orphan-`stopping` cleanup.
- `backend/src/modules/scenario/scenario.router.ts` — `readEngineOnline()`, `engineOnline` in `/status`, backend self-clear of stuck `stopping`.
- `frontend/src/app/(protected)/dashboard/page.tsx` — Engine 🟢/🔴 pill, Stop countdown + idle reset.

New:
- `ops/install-autostart.ps1`, `ops/uninstall-autostart.ps1`, `ops/CLIENT_OPERATION.md`
- `CLIENT_CONTROL_REPORT.md` (this file)

Nothing committed or pushed.
