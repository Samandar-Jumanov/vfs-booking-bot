# Stop Control Report (2026-05-30)

## TL;DR

- **Stop Scenario now works**: `POST /api/scenario/stop` sets the run to `stopping`; the worker's new stop-poller (inside `spawnAndWatch`) detects this within ~9s and kills the Python child process; the run ends as `stopped` (terminal, never reclaimed). A **Stop Scenario** button in the dashboard calls it and reflects the state.
- **Login Batch removed**: the 3 backend routes, the `loginBatch.service.ts` file, and the full account-pool UI block (button + modal + types + mutations + queries) are gone. `LOGIN_CRON_ENABLED` defaults to `false` and remains OFF.
- **Tests: 166/166**. Backend build clean. Frontend Next.js build clean. `login-batch` grep across `backend/src` + `frontend/src` returns empty.

---

## Task 1 — Stop endpoint

Added `POST /api/scenario/stop` in `backend/src/modules/scenario/scenario.router.ts`.

**Status flow:**

```
requested ──► running ──► stopping ──► stopped  (terminal — not reclaimed)
                    ╰──► completed / failed       (normal paths)
```

**Logic:**
- Reads the current `scenario_run` setting
- If status is `requested` or `running` → updates to `stopping`, stamps `stoppingAt`
- If no active run (status is `stopping`, `stopped`, `completed`, `failed`, or null) → returns 200 with `note: 'no active run to stop'`
- `ScenarioRunMeta` interface extended with `stoppingAt?: string` and a status-flow comment

---

## Task 2 — Worker honors stop

Three changes to `backend/scripts/orchestrator-worker.ts`:

### 2a — Stop-poller in `spawnAndWatch`

```typescript
const stopPoller = setInterval(() => {
  prisma.settings.findUnique({ where: { key: 'scenario_run' } }).then((row) => {
    const r = row?.value as ScenarioRun | null;
    if (r && (r.status === 'stopping' || r.status === 'stopped')) {
      log(`[stop] signal for run ${ctx.runId} — sending SIGTERM to Python child`);
      clearInterval(stopPoller);
      child.kill('SIGTERM');
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already dead */ } }, 3_000);
    }
  }).catch(() => {});
}, 9_000);

child.on('close', (code) => {
  clearInterval(stopPoller);           // always clear on child exit
  resolve(code === 0 ? 'ok' : 'failed');
});
```

- Polls the DB every 9s while the Python child is running
- On `stopping`/`stopped`: sends SIGTERM; after 3s grace, SIGKILL; clears the interval
- The child's `close` event always clears the interval (no leak)
- **Kill latency: ≤ 9s** (worst case: stop signal arrives just after a poll)

### 2b — Stop check between accounts (in `driveRun` loop)

Before every `driveAccountReal` call, reads the run status:
```typescript
const stopRow = await prisma.settings.findUnique({ where: { key: 'scenario_run' } });
const stopRun = stopRow?.value as ScenarioRun | null;
if (stopRun && (stopRun.status === 'stopping' || stopRun.status === 'stopped')) {
  log(`stop requested — aborting run before driving ${acct.email}`);
  return;  // exits driveRun
}
```

### 2c — Terminal `stopped` status in main loop

After `driveRun()` returns, re-reads the run status:
```typescript
const finalRun = finalRow?.value as ScenarioRun | null;
if (finalRun && (finalRun.status === 'stopping' || finalRun.status === 'stopped')) {
  // mark stopped (terminal)
  await prisma.settings.update({ ...status: 'stopped'... });
  log(`Run ${run.runId} stopped by operator`);
} else {
  // mark completed (normal)
  await prisma.settings.update({ ...status: 'completed'... });
}
```

### 2d — `stopped` is never reclaimed

The existing stale-reclaim logic only fires for:
```typescript
run.status === 'running' && claimedAt > STALE_RUN_MS
```
`stopped` and `stopping` are neither `running` nor `requested`, so they fall through to the quiet-poll branch and are never reclaimed. Confirmed by code inspection.

---

## Task 2b — One-click continuity: wait for PENDING → ACTIVE before driving

*(Added 2026-05-30 — this was missing from the original report.)*

### Problem

`registerOne` was `Promise<void>` and `driveRun` discarded its outcome. After pool top-up, the drive query immediately ran `findMany({ status: 'ACTIVE' })`. A just-registered account that was still `PENDING` (activation in progress via the extension) was silently skipped — the operator had to click **Start Scenario** a second time after activation completed to actually drive the new account.

### What changed

**`registerOne` → `Promise<{ email: string; status: string } | null>`**

All early `return;` statements become `return null;`. After a successful `prisma.vfsAccount.create`, the function sets:
```typescript
outcome = { email: result.email, status }; // 'ACTIVE' or 'PENDING'
```
and returns it. On DB-persist failure, returns `null`.

**`driveRun` — collect registrations + wait-for-ACTIVE block**

```typescript
const registered: Array<{ email: string; status: string }> = [];
// ... pool top-up loop now: const reg = await registerOne(runId); if (reg) registered.push(reg);

// After top-up, before the drive query:
const pendingRegistered = registered.filter((r) => r.status === 'PENDING');
if (pendingRegistered.length > 0) {
  // Poll every 12s, cap 3 min, abort on stop signal
  const WAIT_CAP_MS = 3 * 60 * 1000;
  const POLL_MS = 12_000;
  ...while (stillPending.size > 0 && Date.now() < deadline) {
    // Check stop signal
    if (run.status === 'stopping' || 'stopped') { return; }
    await sleep(POLL_MS);
    // poll each still-pending account from DB
  }
  // For any account still PENDING after cap:
  //   postMilestone(failed, activation_timeout) + Telegram "⏱ Activation timed out"
}
// Then: normal drive query finds the now-ACTIVE accounts
```

### How one Start now drives create → activate → login → book (code-reasoned)

1. **Start Scenario** clicked → `driveRun` called → pool top-up detects `spare < poolMin`
2. `registerOne` spawns `register_spike.py` → account created as `PENDING` in DB → activation requested via `/api/pipeline/reconcile` (extension visits the Mailsac link) → `registerOne` returns `{ email, status: 'PENDING' }`
3. Wait-for-ACTIVE block polls DB every 12s; once extension activates the account, `status` flips to `ACTIVE` in DB → `stillPending.delete(email)` → loop exits
4. Drive query `findMany({ status: 'ACTIVE' })` now finds the freshly-activated account
5. `driveAccountReal` spawns `auto_pipeline.py` → login → monitor → book

If activation takes longer than 3 min: Telegram warns the operator, run proceeds with whatever is already ACTIVE.

**Stop signal respected:** at each 12s poll iteration the wait loop checks `scenario_run.status`; if `stopping`/`stopped`, `driveRun` returns early and the main loop marks the run `stopped`.

### Build + test after Task 2b

```
npm run build (backend) → exit 0 (no errors)
npm test (backend)      → Tests: 166 passed, 166 total
```

---

## Task 3 — Login Batch removed

### Backend

Removed from `backend/src/modules/accounts/accounts.router.ts`:
- `import { cancelLoginBatch, getLoginBatch, startLoginBatch } from './loginBatch.service'`
- `const loginBatchSchema = z.object({ accountIds, spacingMs })`
- `POST /accounts/login-batch`
- `GET /accounts/login-batch/:jobId`
- `POST /accounts/login-batch/:jobId/cancel`

**Service file decision:** `loginBatch.service.ts` had **zero external references** outside the three removed routes (confirmed by grep). No test files existed for it. **Deleted.**

### LOGIN_CRON stays OFF

`backend/src/config/env.ts:40`: `LOGIN_CRON_ENABLED: z.coerce.boolean().default(false)`

`backend/src/modules/accounts/accountLoginService.ts:207-208`:
```typescript
if (!env.LOGIN_CRON_ENABLED) {
  console.info('[LOGIN-CRON] disabled (set LOGIN_CRON_ENABLED=true to enable)');
```

Default is `false`. Not touched; not enabled.

### Frontend

Removed from `frontend/src/app/(protected)/account-pool/page.tsx`:
- `interface LoginBatchJob` (13 lines)
- `const STALE_LOGIN_MS = 6 * 60 * 60 * 1000`
- `const [loginBatchOpen, setLoginBatchOpen] = useState(false)`
- `const [loginBatchJobId, setLoginBatchJobId] = useState<string | null>(null)`
- `const loginBatchQuery = useQuery<LoginBatchJob>(...)`
- `const startLoginBatchMutation = useMutation(...)`
- `const cancelLoginBatchMutation = useMutation(...)`
- `staleLoginAccounts` useMemo
- `loginBatchJob`, `loginBatchDone`, `loginBatchSuccess`, `loginBatchFailed`, `loginBatchNeedsWarmTab` derived values
- `useEffect` for `loginBatchJob?.state`
- The **"Login All Stale"** trigger button in the account pool toolbar
- The entire `{loginBatchOpen && (...)}` modal block (~130 lines)
- `function LoginBatchStatePill(...)` component

---

## Task 4 — Stop button

Added to `frontend/src/app/(protected)/dashboard/page.tsx`:

```typescript
const stopScenarioMutation = useMutation<{ ok: boolean; note?: string }, Error, void>({
  mutationFn: async () => {
    const response = await api.post<{ ok: boolean; note?: string }>('/scenario/stop');
    return response.data;
  },
  onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: ['scenario-status'] });
  },
});
```

**UI:** Stop button appears next to Start when run status is `requested`, `running`, or `stopping`. Shows "Stopping…" and is disabled once the stop signal has been sent. Start button is disabled while a run is in-flight.

```tsx
{['requested', 'running', 'stopping'].includes(scenarioStatus?.run?.status ?? '') && (
  <button
    onClick={() => stopScenarioMutation.mutate()}
    disabled={stopScenarioMutation.isPending || scenarioStatus?.run?.status === 'stopping'}
    className="btn-secondary h-11 gap-2 border-red-500/40 text-red-400 hover:bg-red-500/10"
  >
    <StopCircle className="h-4 w-4" />
    {scenarioStatus?.run?.status === 'stopping' ? 'Stopping…' : 'Stop Scenario'}
  </button>
)}
```

Uses the already-imported `StopCircle` icon (was in the import list at line 17).

---

## Task 5 — Green

```
npm run build (backend)  →
  > backend@1.0.0 build
  > tsc --project tsconfig.json && tsc-alias -p tsconfig.json
  (exit 0 — no errors)

npm test (backend)  →
  Test Suites: 22 passed, 22 total
  Tests:       166 passed, 166 total
  Time: 5.09 s

npm run build (frontend)  →
  ✓ Compiled successfully
  ✓ Generating static pages (16/16)
  /account-pool: 11.3 kB  (down from 12.4 kB — login-batch code gone)
  /dashboard:    11.1 kB  (up 0.2 kB — Stop button added)

grep -rni "login-batch|loginBatch" backend/src frontend/src  →
  (empty — zero matches)
```

---

## Operator must verify in browser before push

1. **Stop Scenario button halts a real run**: with the worker running and a scenario in progress (Python child monitoring), click "Stop Scenario" in the dashboard. Observe the worker log: the Python child should receive SIGTERM within ~9s, the run status should flip to `stopped` in the dashboard, and `launch-worker.ps1` should NOT restart a new run (only the outer keep-alive loop restarts the worker process, not a new scenario run).

2. **Login Batch button is gone**: open the Account Pool page and confirm no "Login All Stale" button is present.

---

## What's staged (not committed)

| File | Change |
|---|---|
| `backend/src/modules/scenario/scenario.router.ts` | `POST /api/scenario/stop` added; `stoppingAt?` field in interface |
| `backend/scripts/orchestrator-worker.ts` | `ScenarioRun.stoppingAt?` field; stop-poller in `spawnAndWatch`; stop check in `driveRun` loop; `stopped` terminal status in main loop |
| `backend/src/modules/accounts/accounts.router.ts` | 3 login-batch routes + import + schema removed |
| `backend/src/modules/accounts/loginBatch.service.ts` | **Deleted** |
| `frontend/src/app/(protected)/account-pool/page.tsx` | All login-batch code removed (~180 lines net) |
| `frontend/src/app/(protected)/dashboard/page.tsx` | `stopScenarioMutation` + Stop Scenario button added |

Nothing committed, nothing pushed.
