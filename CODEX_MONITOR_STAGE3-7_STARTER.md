# Monitor redesign — Stages 3-7 (continuation)

You are continuing a multi-stage task. Stages 0-2 are already committed (`git log -1` → `feat(setup): rewrite /setup as 4-step wizard + monitor telemetry`). This file covers the remaining 5 stages.

Repo: `C:/Users/saman/OneDrive/Documents/vfs-booking-bot-main`.
Branch: stay on whatever branch your worktree is on. Do NOT switch.
Package manager: **npm only**. Never use `pnpm`. If `npm` is not on PATH, use `npm.cmd`.
**Do NOT commit. Do NOT push.** The orchestrator handles git.
**Hard rule:** every shell command that runs tests or starts a dev server MUST be wrapped in a timeout. Format: `timeout 90 npm test -- ...` on bash, or `Start-Process ... -Wait -TimeoutSec 90` on PowerShell. If a command exceeds the timeout, kill it, write a BLOCKER block, and STOP.

---

## Context — what already exists (do not duplicate)

- `frontend/src/app/(protected)/setup/page.tsx` — 4-step wizard. Posts to existing `POST /api/monitor/start`. You may extend it in Stage 6 but do not rewrite it.
- `backend/src/modules/monitor/monitor.service.ts` — has `recordMonitorPollOutcome`, `lastPollAt`, `lastPollStatus`, `pollerAccountEmail`, `recentPolls` ring buffer.
- `backend/src/modules/extension/extension.state.ts` — has `recordExtensionPollResult` wired.
- `backend/prisma/schema.prisma` — model `VfsAccount` exists, enum `AccountStatus` exists (with `PENDING`). No `PollingRole` yet.
- `backend/src/modules/accounts/accountAutoLogin.service.ts` — single-account login (reuse, do not inline).
- `frontend/src/app/(protected)/account-pool/page.tsx` — existing account table, has per-row "Auto-login" button at ~line 532.

Read these files before editing. Do not invent parallel shapes.

---

## After EVERY stage you MUST:

1. Run the stage's verification commands (with timeouts).
2. Append a checkpoint block to `CODEX_MONITOR_REPORT.md` at repo root using the template at the bottom of this file.
3. If verification fails or times out, write a `## Stage N — BLOCKER` block and STOP.

---

## Stage 3 — Backend: PollingRole on VfsAccount

### Schema change
In `backend/prisma/schema.prisma`, on model `VfsAccount` add:
```prisma
pollingRole PollingRole @default(BOTH)
```
Add enum at bottom of the file:
```prisma
enum PollingRole {
  WATCHER
  BOOKER
  BOTH
}
```

### Migration + client
```bash
cd backend && npx prisma migrate dev --name add_polling_role && npx prisma generate && cd ..
```

### Endpoint: `PATCH /api/accounts/:id/polling-role`
- Body: `{ role: 'WATCHER' | 'BOOKER' | 'BOTH' }`
- Validate with the same Zod/Joi pattern used elsewhere in `accounts.controller.ts`.
- Auth: same middleware as other `/accounts/*` routes.
- Response: full updated account row.

### Behavior in `monitor.service.ts`
- The account selector for polling MUST filter `pollingRole IN ('WATCHER', 'BOTH')`. If multiple, round-robin.
- The booking dispatch (in the slot-detected → `BOOK_FOR_CUSTOMER` path) MUST select an account with `pollingRole IN ('BOOKER', 'BOTH')` AND `email !== pollerAccountEmail`. If none available, fall back to the same account and log a WARN event `BOOKING_ON_POLLER_ACCOUNT` via the existing logger.

### Verification (timeout 120s each)
```bash
cd backend && timeout 120 npm run build && cd ..
cd backend && timeout 60 npx prisma migrate status && cd ..
```

Skip running jest tests in this stage — the existing monitor test hangs on DB connect (this is the Stage 2 hang we already diagnosed). Instead, write a smoke script `backend/scripts/smoke-polling-role.ts` that:
1. Connects to Prisma
2. Creates 3 dummy accounts with roles WATCHER/BOOKER/BOTH
3. Calls your account selector function once for "pick poller" and once for "pick booker"
4. Asserts the right account types are returned
5. Cleans up

Run with: `cd backend && timeout 30 npx tsx scripts/smoke-polling-role.ts`. Exit 0 = pass.

---

## Stage 4 — Backend: batch auto-login endpoints

Create `backend/src/modules/accounts/loginBatch.service.ts`:

```ts
// Pseudocode — implement in TS
type ItemState = 'pending' | 'running' | 'success' | 'failed';
interface BatchJob {
  jobId: string;
  startedAt: string;
  finishedAt: string | null;
  state: 'running' | 'done' | 'cancelled';
  cancelRequested: boolean;
  items: Array<{
    accountId: string;
    email: string;
    state: ItemState;
    startedAt: string | null;
    finishedAt: string | null;
    error: string | null;
  }>;
}
const jobs = new Map<string, BatchJob>();

export function startLoginBatch(accountIds: string[], spacingMs = 60000): string;
export function getLoginBatch(jobId: string): BatchJob | undefined;
export function cancelLoginBatch(jobId: string): boolean;
```

Implementation:
- `startLoginBatch` resolves account emails up front (one Prisma query), creates the job, kicks off an async sequencer that iterates items, calls the existing `runAutoLogin(accountId)` from `accountAutoLogin.service.ts` (DO NOT duplicate that flow), waits `spacingMs` between items, marks state transitions, respects `cancelRequested`.
- On per-item failure, write the short error to `items[i].error` and continue with the next item.

### Endpoints — wire in `accounts.controller.ts` + `accounts.router.ts`
- `POST /api/accounts/login-batch` — body `{ accountIds: string[], spacingMs?: number }` → `{ jobId: string }`.
- `GET  /api/accounts/login-batch/:jobId` → BatchJob shape above.
- `POST /api/accounts/login-batch/:jobId/cancel` → `{ ok: true }` or 404.

Same auth as existing accounts routes.

### Verification (timeout 90s)
```bash
cd backend && timeout 90 npm run build && cd ..
```

Smoke script `backend/scripts/smoke-login-batch.ts`:
- Mock `runAutoLogin` (replace the imported function with a stub that resolves after 200 ms with random success/failure)
- Call `startLoginBatch(['a','b','c'], 50)`
- Poll `getLoginBatch(jobId)` every 100 ms until `state === 'done'`
- Assert all 3 items transitioned through pending → running → success/failed
- Assert total elapsed ≥ 2 × spacingMs (proves sequencing)

Run with: `cd backend && timeout 30 npx tsx scripts/smoke-login-batch.ts`.

---

## Stage 5 — Frontend: "Login All Stale" button on Account Pool

File: `frontend/src/app/(protected)/account-pool/page.tsx`.

### Header button (next to existing top buttons)
Label: `Login All Stale (N)` where N = count of accounts with `status === 'ACTIVE'` AND (`cookiesUpdatedAt` is null OR older than 6 h).

Click → open modal.

### Modal — two modes

**Mode A: pre-flight**
- Lists the N accounts (email + last-login-age).
- "Estimated time: N × 60s".
- Buttons: `Cancel` | `Start batch`.
- Start → `POST /api/accounts/login-batch` with `{ accountIds, spacingMs: 60000 }`, stash returned `jobId` in component state, switch to Mode B.

**Mode B: progress**
- Polls `GET /api/accounts/login-batch/:jobId` every 2 seconds via React Query (`refetchInterval: 2000`).
- Renders a table: email | state pill | error (if any).
- State pills: pending (gray), running (yellow, animated), success (green), failed (red).
- Header: `X of N done`.
- Button: `Cancel job` → `POST /api/accounts/login-batch/:jobId/cancel`.
- When `data.state === 'done'`: stop polling, show summary `S succeeded, F failed`, invalidate the `['accounts']` query, button changes to `Close`.

### Existing per-row "Auto-login" button stays untouched.

### Verification
```bash
cd frontend && timeout 180 npm run build && cd ..
cd frontend && timeout 120 npm run lint && cd ..
```

Manual smoke OPTIONAL (skip if no browser tool available — note in report). Build + lint MUST pass.

---

## Stage 6 — Frontend: PollingRole chip on Account Pool table

Same file: `frontend/src/app/(protected)/account-pool/page.tsx`.

- Add one column "Role" between existing columns.
- Render the role value as a pill (reuse styling pattern from other pills in this file — do NOT add new CSS classes).
- Click pill → popover with 3 options (WATCHER / BOOKER / BOTH).
- Select option → `PATCH /api/accounts/:id/polling-role` → invalidate `['accounts']`.
- Use `useMutation` from `@tanstack/react-query`.

### Verification
```bash
cd frontend && timeout 180 npm run build && cd ..
cd frontend && timeout 120 npm run lint && cd ..
```

---

## Stage 7 — Final sweep + report

```bash
cd backend && timeout 120 npm run build && cd ..
cd frontend && timeout 180 npm run build && cd ..
cd extension && timeout 60 npm run build && cd ..
```

All three must pass. If any fail, write a `## Stage 7 — BLOCKER`.

Then run:
```bash
git diff --stat HEAD
```
…paste the output verbatim in your Stage 7 checkpoint block.

Acceptable diff size for Stages 3-7 combined: ≤ 1000 LOC net added. If you blew past 1500 LOC, write a `## Stage 7 — Scope warning` block explaining what ballooned.

---

## Hard rules — re-read before starting

1. **No commits, no pushes, no branch switch.** Orchestrator handles git.
2. **No new npm packages.** Use what's already in `package.json` files.
3. **Do NOT run `npm test` or any jest command** anywhere in this task. The existing monitor test hangs on DB connect. Use the smoke scripts described in Stages 3 and 4 instead.
4. **Every external command must have a timeout.** Wrap with `timeout N` (bash) or `Start-Process -TimeoutSec N -Wait` (PowerShell). If a command times out, kill it and write a BLOCKER block.
5. **Surgical changes only.** Do not "improve" unrelated files you happen to read.
6. **Do NOT touch:** `vfs-bridge.ts`, captcha modules, proxy rotation, BrightData wiring, `launch-bot-chrome.ps1`, `.env` files, any `.ps1` script.
7. **Reuse existing services.** Especially `runAutoLogin` in Stage 4. Do not inline a second copy.
8. **OneDrive lock note:** if a file edit fails with `EBUSY` / `permission denied`, retry once after 5 seconds. If it still fails, write a BLOCKER. Do NOT `rm` lock files.

---

## Report file format

Append to `CODEX_MONITOR_REPORT.md` at repo root. Template per stage:

```markdown
## Stage <N> — <name>

- **Status:** PASS | FAIL | BLOCKED
- **Files changed:**
  - path/to/file.ts (+L1 / -L2)
- **Endpoints added/changed:**
  - METHOD /path — short description
- **Smoke script result:**
  - path/to/script.ts → exit 0 | exit 1 (paste last 5 lines if non-zero)
- **Verification:**
  - command 1 → PASS|FAIL (paste last 5 lines if FAIL)
- **Surprises / deviations:** any time you departed from this spec, explain
- **Time spent:** rough estimate
```

If blocked:
```markdown
## Stage <N> — BLOCKER

- What failed:
- Last command output:
- Hypothesis:
- What the orchestrator needs to decide:
```

…and STOP.

---

## What "done" looks like for this continuation

- Operator can flip an account's role between WATCHER / BOOKER / BOTH with one click on `/account-pool`.
- Operator can click `Login All Stale (N)` and watch all N accounts log in over ~N minutes, with live progress.
- Backend monitor selects polling accounts only from watchers, dispatches bookings only to bookers (different account when possible).
- `CODEX_MONITOR_REPORT.md` has 5 new checkpoint blocks (Stages 3-7) all marked PASS.
- All 3 builds green, no jest commands were run.
