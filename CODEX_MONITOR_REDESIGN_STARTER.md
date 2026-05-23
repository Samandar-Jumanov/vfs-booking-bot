# Monitor UX redesign + Batch operations + Watcher/Booker routing

You are working on the VFS booking bot repo at `C:/Users/saman/OneDrive/Documents/vfs-booking-bot-main` (or your assigned worktree).
Branch: **whatever branch you are currently on** — do NOT switch branches, do NOT commit, do NOT push. The orchestrator handles git.

**Package manager: npm (not pnpm).** The repo has a `package-lock.json`; ignore any `pnpm-lock.yaml` you see — it's stale. Every command in this starter that says `pnpm -C <dir>` must be rewritten as `npm --prefix <dir> run <script>` (or `cd <dir> && npm <cmd>` if the prefix form misbehaves on Windows). For Prisma: `cd backend && npx prisma <cmd>`.

This task has **7 stages**. After **every** stage you MUST:
1. Run the stage's verification commands.
2. Append a checkpoint block to `CODEX_MONITOR_REPORT.md` at repo root (see template at the bottom of this file).
3. If verification fails, STOP, write a `## BLOCKER` block in the report, and end. Do not "best-effort" past a broken build.

Use parallel sub-agents only inside Stage 1 (frontend) and Stage 2 (backend) because they touch disjoint files. Stages 3+ are sequential.

---

## Repo context you must read before touching code

Read these files first. They define existing shapes you MUST conform to — do not invent parallel types:

| File | Why |
|---|---|
| `backend/prisma/schema.prisma` | `VfsAccount`, `AccountStatus`, `Monitor` models |
| `backend/src/modules/monitor/monitor.service.ts` | Existing monitor lifecycle, slot dispatch |
| `backend/src/modules/monitor/monitor.controller.ts` | Existing `/monitor/*` endpoints |
| `backend/src/modules/accounts/accounts.controller.ts` (and `.router.ts`) | Existing `/accounts/*` endpoints, where to add `login-batch` |
| `backend/src/modules/accounts/accountAutoLogin.service.ts` | Single-account login dispatch — reuse, do not duplicate |
| `extension/shared/types.ts` | `BackendMessage`, `ExtensionEvent`, `MonitorConfig` — do NOT add new fields without also updating extension consumers |
| `frontend/src/app/(protected)/setup/page.tsx` | Page you are replacing |
| `frontend/src/app/(protected)/account-pool/page.tsx` | Where the "Login all stale" button goes |
| `frontend/src/lib/api.ts` | Axios client + auth headers |
| `frontend/src/store/monitorStore.ts` | Zustand store you must keep in sync |

Run `cd backend && npx prisma generate && cd ..` once after any schema change.

---

## Stage 0 — Baseline build verification

Before touching anything:

```bash
cd backend && npm run build && cd ..
cd frontend && npm run build && cd ..
cd extension && npm run build && cd ..
```

If any of these fail on the current tree, STOP and write `## BLOCKER Stage 0` in the report with the error. Do not start work on a broken baseline. (If a dependency-install error appears, run `npm install` in that workspace first, then retry the build. Do NOT run `pnpm` for anything.)

Report at end of Stage 0:
```
## Stage 0 — Baseline OK
- backend build: PASS
- frontend build: PASS
- extension build: PASS
- commit at start: <git rev-parse HEAD>
```

---

## Stage 1 — Frontend: rewrite `/setup` as a 4-step wizard

**Goal:** the page must be understandable to a non-developer in 10 seconds. Eliminate fake options. Surface the one decision that actually matters (route + which accounts poll).

### What to delete
- The 14-option "Visa Category" dropdown — only D-visa is real for this product.
- The 4-option "Target Destination" dropdown — only `lva` and `tjk` are tested.
- The 3-option "Applying From" dropdown — only `uzb` works.
- The manual "Secure Tunneling (Proxy)" card — backend uses BrightData from `.env`, the form was misleading.
- The "Target Profiles" multi-select (the `profiles` table is a legacy table for the old per-applicant flow; bookings are now keyed by Customer, not Profile).

### What to build

Replace `frontend/src/app/(protected)/setup/page.tsx` with a wizard. Keep the existing `DashboardShell` layout wrapper. Use only existing UI primitives (`CustomSelect`, `card`, `btn-primary`). No new dependencies.

**Step 1 — Pick a route**

Render a 2-card grid. Each card has: country flag emoji, route label, current status badge.

```
┌─────────────────────────┐   ┌─────────────────────────┐
│ 🇺🇿 → 🇱🇻               │   │ 🇺🇿 → 🇹🇯               │
│ UZ → Latvia             │   │ UZ → Tajikistan         │
│ D-visa (Work)           │   │ Test route              │
│ ● Production            │   │ ● Test only             │
└─────────────────────────┘   └─────────────────────────┘
```

Clicking a card sets `sourceCountry='uzb'`, `destination='lva'|'tjk'`, `visaCategoryCode='LTV'|'TST'` (use the exact codes from the current `MonitorConfig.visaCategoryCode` in `extension/shared/types.ts` — do not invent new ones; if unsure, log what the existing `/monitor/start` currently accepts and reuse).

Disable destinations that have no ACTIVE VfsAccount available (see Step 2).

**Step 2 — Pick which accounts will poll**

Fetch `GET /api/accounts?status=ACTIVE`. Render a table:

| Email | Last login age | Polling role | Select |
|---|---|---|---|
| user@x.com | 4h ago | WATCHER | ☑ |
| ... | ... | BOTH | ☐ |

- Show ONLY accounts where `cookiesUpdatedAt` is < 12h old (stale cookies = useless for polling). If none qualify, show a callout: *"No fresh-cookie accounts. Go to Account Pool → 'Login all stale' first."* with a link to `/account-pool`.
- Each row has a polling-role pill (WATCHER / BOOKER / BOTH) read from the field added in Stage 3. If the field doesn't exist yet (because Stage 3 hasn't merged), default to displaying "BOTH" for every account.
- Allow multi-select. Require at least 1.

**Step 3 — Settings**

Three controls only:
- Polling interval: slider 30s–300s, default 60s (matches the rate-limit cooldown in `[[project_vfs_rate_limit_2026_05_19]]` memory).
- Mode toggle: `Auto-book` vs `Alert only` (rename "Manual" — operator never books manually anyway).
- Telegram alerts: read-only badge showing whether `TELEGRAM_BOT_TOKEN` is configured (`GET /api/health/full` exposes this). If false, show: *"Configure Telegram in Settings to receive slot alerts."*

**Step 4 — Confirm + start**

A summary card:
```
You're about to:
  • Poll UZ → Latvia every 60s
  • Using 3 watcher accounts (user1@…, user2@…, user3@…)
  • Auto-book when slot found, dispatching to <booker count> booker account(s)
  • Send Telegram alert on detection

[ Start Monitor ]
```

Submit posts to `POST /api/monitor/start` with the exact existing payload shape — do NOT change the endpoint contract in Stage 1. Field name additions go in Stage 4.

**Right column — Live status panel** (always visible across all steps)

Replace the current right column with:
- "Active monitors: N" (count of `monitorStatus.filter(m => m.isRunning)`)
- "Last poll: <relative time>" (poll the `GET /api/monitor/status` you already have; if it doesn't expose `lastPollAt`, add it in Stage 2)
- "Next poll in: <countdown>"
- Last 5 poll outcomes, color-coded (green = 200, yellow = empty result, red = 4xx/5xx)
- "Recent slot detections" — last 3 entries from `GET /api/logs?eventType=SLOT_DETECTED&limit=3`

Re-render countdown every 1s via `setInterval` in a `useEffect`. Do not use `framer-motion` for the countdown — too expensive.

### Stage 1 acceptance criteria
- The page renders without console errors on `cd frontend && npm run dev`.
- A non-developer can launch a monitor in ≤4 clicks (Route → Accounts → Start defaults → confirm).
- `cd frontend && npm run build && cd ..` passes.
- `cd frontend && npm run lint && cd ..` passes.
- No new dependencies added.

### Stage 1 verification commands

```bash
cd frontend && npm run build && cd ..
cd frontend && npm run lint && cd ..
```

### Stage 1 report block

```
## Stage 1 — Setup wizard
- files changed: <list>
- LOC added/removed: +X / -Y
- frontend build: PASS|FAIL
- frontend lint: PASS|FAIL
- screenshot of /setup at each step: docs/screenshots/setup-step-{1,2,3,4}.png (use puppeteer/playwright headed against `cd frontend && npm run dev` if available; if screenshots cannot be produced, skip and note why — DO NOT block on this)
- notes: <anything surprising>
```

---

## Stage 2 — Backend: expose missing monitor telemetry

The frontend status panel needs fields that `/api/monitor/status` doesn't return today.

### Endpoint: `GET /api/monitor/status` (extend existing)

Each monitor entry must additionally include:

```ts
{
  // existing fields kept as-is
  lastPollAt: string | null,            // ISO8601
  lastPollStatus: number | null,        // HTTP status from last lift-api call
  lastPollError: string | null,         // short message if !ok
  nextPollAt: string | null,            // ISO8601 = lastPollAt + intervalMs
  pollerAccountEmail: string | null,    // which VfsAccount made the last poll
  recentPolls: Array<{                  // last 5, newest first
    at: string,
    status: number,
    ok: boolean,
    accountEmail: string,
  }>
}
```

Wire `monitor.service.ts` to record each poll outcome into an in-memory ring buffer keyed by monitor ID (no DB writes for this — it's ephemeral telemetry). Cap at 5 entries per monitor.

### Endpoint: `GET /api/logs?eventType=...&limit=...`

If this endpoint doesn't already accept `eventType` + `limit`, extend it. Don't widen the schema — just filter.

### Stage 2 verification commands

```bash
cd backend && npm run build && cd ..
cd backend && npm test -- --testPathPattern=monitor && cd ..
# manual smoke:
cd backend && npm run dev &   # in background
curl http://localhost:3001/api/monitor/status | jq .
```

### Stage 2 report block — same template as Stage 1.

---

## Stage 3 — Backend: Watcher/Booker polling roles

### Schema change

In `backend/prisma/schema.prisma`, on model `VfsAccount`, add:

```prisma
pollingRole PollingRole @default(BOTH)
```

And the enum:

```prisma
enum PollingRole {
  WATCHER   // only polls, never receives BOOK_FOR_CUSTOMER dispatches
  BOOKER    // only receives bookings, never polls
  BOTH      // legacy default, eligible for both
}
```

Generate migration:
```bash
cd backend && npx prisma migrate dev --name add_polling_role && npx prisma generate && cd ..
```

### Endpoint: `PATCH /api/accounts/:id/polling-role`

Body: `{ role: 'WATCHER' | 'BOOKER' | 'BOTH' }`. Returns the updated account. Same auth as existing accounts endpoints.

### Service behavior

In `monitor.service.ts`:
- When picking which account to use for the next poll, filter `pollingRole IN ('WATCHER', 'BOTH')`. Round-robin across them.
- When a slot is detected and auto-mode is on, the booking dispatch must select an account with `pollingRole IN ('BOOKER', 'BOTH')` AND `email !== pollerAccountEmail` (different account books than polled). If no such account exists, fall back to the same account but log a `WARN` event `BOOKING_ON_POLLER_ACCOUNT`.

### Stage 3 verification commands

```bash
cd backend && npm run build && cd ..
cd backend && npx prisma migrate status && cd ..
cd backend && npm test -- --testPathPattern=monitor && cd ..
# unit test you must add:
# backend/src/modules/monitor/monitor.service.test.ts — case "picks BOOKER account different from poller"
```

### Stage 3 report block — same template.

---

## Stage 4 — Backend: Batch auto-login

### Endpoint: `POST /api/accounts/login-batch`

Body: `{ accountIds: string[], spacingMs?: number }` (default `spacingMs = 60000`).
Response: `{ jobId: string }`.

Behavior: enqueues a background job that iterates `accountIds` sequentially, calls the existing single-account login flow (`accountAutoLogin.service.ts` — reuse, do NOT inline), waits `spacingMs` between accounts. Tracks per-account state.

### Endpoint: `GET /api/accounts/login-batch/:jobId`

Response:
```ts
{
  jobId: string,
  startedAt: string,
  finishedAt: string | null,
  state: 'running' | 'done' | 'cancelled',
  items: Array<{
    accountId: string,
    email: string,
    state: 'pending' | 'running' | 'success' | 'failed',
    startedAt: string | null,
    finishedAt: string | null,
    error: string | null,
  }>
}
```

### Endpoint: `POST /api/accounts/login-batch/:jobId/cancel`

Marks job cancelled. Currently-running login completes; pending items are skipped.

### Storage

Use an in-memory `Map<jobId, BatchJob>` in a new file `backend/src/modules/accounts/loginBatch.service.ts`. Do NOT persist to DB — these jobs are operator tools, not auditable records.

### Stage 4 verification commands

```bash
cd backend && npm run build && cd ..
cd backend && npm test -- --testPathPattern=loginBatch && cd ..
# integration smoke (in two terminals):
cd backend && npm run dev
curl -X POST http://localhost:3001/api/accounts/login-batch -H 'content-type: application/json' -d '{"accountIds":["<one-real-id>"],"spacingMs":1000}'
# then poll the GET endpoint and verify state transitions
```

A unit test that mocks `runAutoLogin` and verifies sequencing + spacing is required.

### Stage 4 report block — same template.

---

## Stage 5 — Frontend: "Login all stale" button on Account Pool

In `frontend/src/app/(protected)/account-pool/page.tsx`:

1. Top-of-page header gets a button: `Login all stale (N)` where N = accounts with `status='ACTIVE'` AND `cookiesUpdatedAt` older than 6h (or `null`).
2. Clicking opens a modal:
   - Shows the list of N accounts that will be logged in.
   - Shows estimated time = `N × 60s`.
   - Buttons: `Cancel` / `Start`.
3. Start calls `POST /api/accounts/login-batch` with those IDs.
4. Modal then switches to "progress mode": polls `GET /api/accounts/login-batch/:jobId` every 2s. Renders a table with each account's per-item state (pending / running / success / failed). Failed rows show the short error inline.
5. A `Cancel job` button calls the cancel endpoint.
6. When `state === 'done'`, invalidate `['accounts']` react-query so the table refreshes.

The existing per-row "Auto-login" button stays as-is.

### Stage 5 verification

```bash
cd frontend && npm run build && cd ..
cd frontend && npm run lint && cd ..
# manual smoke against running backend with 2 stale accounts
```

### Stage 5 report block — same template, plus a screenshot of the modal in progress.

---

## Stage 6 — Frontend: polling-role chips on Account Pool table

Small visual addition:
- Add a column "Role" to the account-pool table showing the `pollingRole` value as a pill.
- Clicking the pill opens a 3-option popover (WATCHER / BOOKER / BOTH). Selecting one calls `PATCH /api/accounts/:id/polling-role` and invalidates `['accounts']`.

No other UI changes to that page.

### Stage 6 verification — `cd frontend && npm run build && cd ..`, `cd frontend && npm run lint && cd ..`.

---

## Stage 7 — Final integration sweep + report

Run the full verification matrix:

```bash
cd backend && npm run build && cd ..
cd backend && npm test && cd ..
cd frontend && npm run build && cd ..
cd frontend && npm run lint && cd ..
cd extension && npm run build && cd ..
```

If anything fails, dump the failing output verbatim under `## Stage 7 — Final BLOCKER`.

Then check the diff size:
```bash
git diff --stat main...HEAD
```

Acceptable target: ≤ 1500 LOC net added across all stages. If you blew past 2000 LOC, write a `## Stage 7 — Scope warning` block explaining what ballooned.

---

## Report file format

All checkpoints go in `CODEX_MONITOR_REPORT.md` at repo root, created in Stage 0, appended in each later stage. Use this template per stage:

```markdown
## Stage <N> — <name>

- **Status:** PASS | FAIL | BLOCKED
- **Files changed:**
  - path/to/file.ts (+L1 / -L2)
  - ...
- **Endpoints added/changed:**
  - METHOD /path — short description
- **Tests added:**
  - path/to/test.ts — what it asserts
- **Verification:**
  - command 1 → PASS|FAIL (paste last 5 lines if FAIL)
  - command 2 → PASS|FAIL
- **Manual smoke (if applicable):** what you clicked / curled and what came back
- **Surprises / deviations:** any time you had to depart from this spec, explain why
- **Time spent:** rough estimate
```

If a stage is BLOCKED, write:

```markdown
## Stage <N> — BLOCKER

- What failed:
- Last command output:
- Hypothesis:
- What the orchestrator needs to decide:
```

…and STOP. Do not start the next stage.

---

## Hard rules — re-read before starting

1. **No commits, no pushes.** Working tree only. The orchestrator commits.
2. **No branch switch.** Stay on `track-7-extension`.
3. **No new npm packages.** Use only what's in the existing `package.json` files.
4. **No changes to `vfs-bridge.ts`, captcha, proxy rotation, or BrightData wiring.** Those are out of scope.
5. **Do not "improve" unrelated files** you happen to read. Surgical changes only — RFC discipline.
6. **Reuse existing services.** Especially `accountAutoLogin.service.ts` in Stage 4 and `monitor.service.ts` in Stage 2/3.
7. **Use npm, never pnpm.** The repo has mixed lockfiles; `package-lock.json` is canonical. Do not install pnpm globally.
8. **Windows path note:** OneDrive can lock `.git/*.lock` files (memory: `[[project_onedrive_git_lock]]`). If git commands fail with `permission denied`, write a `## BLOCKER` note — do NOT `rm` lock files.

---

## What "done" looks like

- Operator can open `/setup`, pick UZ→LVA in two clicks, pick 3 fresh accounts, click Start. Within 60s they see "last poll: 5s ago, status 200".
- Operator can open `/account-pool`, click "Login all stale (7)", see 7 accounts go green over ~7 minutes.
- Operator can change an account's role from WATCHER to BOOKER with one click.
- All builds green. `CODEX_MONITOR_REPORT.md` has 7 stage blocks all marked PASS.
