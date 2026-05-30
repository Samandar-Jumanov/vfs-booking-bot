# Claude Code Plan — Client-Ready Control (dashboard-only, no terminal)

> **Executor:** Claude Code (Sonnet 4.6)
> **Goal:** Make the system operable **entirely from the dashboard** by a non-technical client — no PowerShell. Four pieces: (1) Stop button with a **live countdown**, (2) dashboard **self-clears a stuck "stopping"**, (3) an **Engine Online/Offline** indicator, (4) a one-time **auto-start** setup so the engine runs without anyone launching a terminal.
> **Type:** Frontend + backend + worker + one setup helper. No live VFS. No commit/push.

---

## 0. Context (why this exists)

The booking engine works, but today it only runs if someone launches `launch-worker.ps1` / `launch-bot-chrome.ps1` from a terminal, and the Stop button can get stuck on "Stopping…" with no feedback (it just happened: the operator's worker was running old code / was closed, so nothing finalized the stop). A client will never use PowerShell. After this plan: **the client uses only the dashboard** — Start, Stop (with a visible timer), and a clear "is the engine running" light — and the engine itself auto-runs in the background.

**Known mechanics (already in place):**
- `POST /api/scenario/stop` sets the run to `stopping`; the worker's stop-poller kills the Python child and the main loop flips `stopping → stopped`. (Works only when the worker runs the current code.)
- The worker (`orchestrator-worker.ts`) polls `scenario_run` from the DB each loop.

**HARD RULES:**
1. No live VFS/login/booking. No `git commit`/`push`. Surgical edits. No shell-redirect junk files.
2. Keep `npm test` green; keep pacing/anti-flag logic untouched.
3. UI changes need a real browser check before push — make them build/type-check cleanly; the operator browser-verifies before we push (state this in the report).

---

## 1. What "done" looks like

- Clicking **Stop** shows a **countdown inside the button** ("Stopping… 8s…") and returns to idle when the run is `stopped`.
- A run stuck in `stopping` with no live worker **auto-resolves to `stopped`** (so the UI never hangs).
- The dashboard shows **Engine: 🟢 Online / 🔴 Offline** based on a worker heartbeat.
- A one-time **auto-start helper** + short doc lets the engine run on boot with **no manual terminal** thereafter.
- `npm run build` clean, `npm test` green, frontend builds. `CLIENT_CONTROL_REPORT.md` written. Nothing committed.

---

## 2. Tasks (in order)

### Task 1 — Worker heartbeat + Engine Online indicator
**Why:** the client needs to see at a glance whether the engine is actually running (the thing that was invisibly "off" today).
**What to do:**
1. **Worker:** each main-loop iteration, upsert a `Settings` key `worker_heartbeat` = `{ at: <ISO now> }` (cheap, once per poll ~10s).
2. **Backend:** in the scenario status endpoint (or a small `GET /api/scenario/health`), return `engineOnline = (now - worker_heartbeat.at) < 30s` alongside the run status.
3. **Frontend (dashboard):** show **Engine: 🟢 Online** when `engineOnline`, **🔴 Offline** otherwise, with a tooltip ("the booking engine is running / not running"). Poll it on the existing status interval.
**Done when:** stopping the worker flips the dashboard to 🔴 within ~30s; starting it flips to 🟢. (Operator confirms live.)

### Task 2 — Self-clearing stop (no more stuck "Stopping…")
**Why:** if the worker dies/changes mid-stop, the run can hang in `stopping` forever (today's bug).
**What to do:**
1. **Backend:** when the scenario status is read and the run is `stopping` with `stoppingAt` older than ~25–30s **AND** `engineOnline` is false (no worker to finalize it), finalize it to `stopped` (terminal) and return that. So the UI self-clears even with no worker.
2. **Worker:** on startup AND each poll, if it sees an orphaned `stopping` run (or a stale `running` run it isn't actively driving), finalize it to `stopped`/reclaim per existing logic — so a freshly (re)started worker cleans up a stuck stop instead of ignoring it.
3. Ensure `stoppingAt` is stamped when `POST /stop` sets `stopping` (add if missing).
**Done when:** a run left in `stopping` with no worker becomes `stopped` within ~30s on the next status read; a restarted worker also clears it. (Code-reasoned + operator confirms.)

### Task 3 — Stop button live countdown
**Why:** feedback — the operator/client must see it's working, not a dead "Stopping…".
**What to do (frontend, dashboard):**
- When Stop is clicked and the run goes `stopping`, render a **countdown inside the button** (e.g. start at ~12s — a bit above the worker's ~9s kill window — counting down): `Stopping… 12s → 11s …`.
- When the status becomes `stopped` (or engine offline + self-cleared), reset the buttons to idle (Start enabled).
- If the countdown reaches 0 and it's still `stopping`, show "Stopping… (finalizing)" and keep polling — Task 2's self-clear will resolve it; don't leave a frozen number.
- Keep the Start/Stop toggle states from before (Start disabled while running/stopping).
**Done when:** Stop shows a live countdown and the UI always returns to idle. (Operator browser-verifies.)

### Task 4 — Auto-start the engine (one-time, then no terminal)
**Why:** remove the PowerShell dependency for ongoing operation. After a **one-time** technical setup, the engine runs on boot and the client only uses the dashboard.
**What to do:**
1. Add a helper `ops/install-autostart.ps1` (run **once** by a technical person) that registers a **Windows Scheduled Task** which runs `launch-worker.ps1` at logon and keeps it alive (and, if the extension is required for activation, also launches `launch-bot-chrome.ps1`). Use the existing launchers; don't reimplement them.
2. Add `ops/uninstall-autostart.ps1` to remove the task.
3. Write `ops/CLIENT_OPERATION.md` — a short, **non-technical** guide: "the engine runs automatically; to operate, open the dashboard → Start / Stop; the green/red light shows if it's running; if it's red, [who to contact]." No CLI steps for the client.
4. **Be honest in the doc** about current limits: the engine must run on an always-on machine on a clean UZ IP (the hosting decision), and **code updates still require restarting the service** (a technical step, not the client's).
**Done when:** the helper installs/removes an auto-start task; the client doc is terminal-free. (Operator validates the install on their box separately — you can't run it here.)

### Task 5 — Prove nothing broke
- `cd backend; npm run build` → exit 0; `npm test` → green (count).
- Frontend build/type-check → clean.
- Confirm pacing/anti-flag code untouched.
**Done when:** all pasted as evidence.

---

## 3. Required output: `CLIENT_CONTROL_REPORT.md`

```markdown
# Client Control Report (<date>)

## TL;DR
The dashboard is now the only thing needed to operate: Stop countdown, self-clearing stop, engine online light, auto-start. Test status.

## Task 1 — Heartbeat + Online indicator
How heartbeat is written/read; how the dashboard shows online/offline.

## Task 2 — Self-clearing stop
How a stuck 'stopping' resolves (backend timeout + worker startup cleanup). stoppingAt handling.

## Task 3 — Stop countdown
The countdown UX + idle reset behavior.

## Task 4 — Auto-start
The install/uninstall helpers + the client doc; honest limits noted.

## Task 5 — Green
build / test (count) / frontend build.

## Operator must verify before push
- Stop shows countdown and never hangs
- Engine light flips online/offline
- (separately) auto-start install works on the box

## What's staged (not committed)
```

---

## 4. Final step

Write `CLIENT_CONTROL_REPORT.md`, post the TL;DR + the explicit note that the operator must browser-verify (Stop countdown + engine light) before push, then stop. Orchestrator verifies build/tests; operator validates live; then commit + push.
