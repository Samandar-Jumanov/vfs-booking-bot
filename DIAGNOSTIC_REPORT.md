# VFS Booking Bot — Diagnostic Report (2026-05-29)

## TL;DR

- **Green:** Backend type-check (tsc) passes clean. Frontend Next.js build passes clean. Python files compile clean. 165/166 unit tests pass.
- **Yellow:** Lint has 42 errors (all unused-var / no-var-requires / empty-block; non-fatal at runtime). Frontend has 4 build warnings (non-fatal).
- **Red:** 1 unit test failing — `monitor.service.test.ts` "logs in the stored VFS account and retries once after a 403 poll response" (line 205 assertion). `prisma.vfsAccount.update` is being called when the test expects it NOT to be, with `{data:{lastUsedAt:...}}`. Likely caused by recent `orchestrator-worker.ts` changes.
- **Memory correction:** Old session memory said OTP is NOT wired into the booking loop. **OTP IS wired** — `mailsac_otp_code()` is called at `auto_pipeline.py:486`.
- **Biggest blocker:** Worker SIMULATE run is BLOCKED — it requires live `DATABASE_URL` (prod Railway DB), `WORKER_TOKEN`, and `PROFILE_ENCRYPTION_KEY` even in SIMULATE mode (PrismaClient instantiates unconditionally and polls DB on every loop tick).

---

## Status Matrix

| Component | Check | Result | Evidence (cmd + key output) |
|---|---|---|---|
| Toolchain | node version | PASS | `node --version` → `v22.14.0` |
| Toolchain | npm version | PASS | `npm --version` → `11.3.0` |
| Toolchain | python version | PASS | `python --version` → `Python 3.13.13` |
| Toolchain | nodriver importable | PASS | `python -c "import nodriver; print(nodriver.__version__)"` → `0.50.3` |
| Toolchain | backend/.env | PRESENT | `find backend -maxdepth 1 -name ".env*"` → listed |
| Toolchain | backend/.env.example | PRESENT | same command |
| Toolchain | backend/.env.worker | PRESENT | same command |
| Toolchain | nodriver-spike/.env | ABSENT | `find nodriver-spike -maxdepth 1 -name ".env*"` → nothing |
| Toolchain | frontend dir + package.json | PRESENT | `frontend/package.json` exists, name=frontend |
| Backend | type-check (`npm run build`) | **PASS** | `npm run build` → exit 0, no TS errors |
| Backend | lint (`npm run lint`) | **FAIL** | 42 errors, 154 warnings — see Detailed Findings |
| Backend | unit tests (`npm test`) | **FAIL (1)** | 1 failed / 165 passed / 166 total — `monitor.service.test.ts:205` |
| Backend | e2e dry (`npm run test:e2e:dry`) | **BLOCKED** | Dry mode still requires live DATABASE_URL — see Blocked Checks |
| Worker | SIMULATE run | **BLOCKED** | SIMULATE still needs live DATABASE_URL + WORKER_TOKEN + PROFILE_ENCRYPTION_KEY |
| Python pipeline | `py_compile` auto_pipeline.py + register_spike.py | **PASS** | exit 0, no output |
| Python pipeline | OTP wired into booking loop? | **YES** | `auto_pipeline.py:486` — `code = await mailsac_otp_code(EMAIL, pre_ids, timeout=120)` |
| Python pipeline | Step 5 Submit reachable / dry-run-guarded? | **YES / YES** | `auto_pipeline.py:540` BOOK_DRY_RUN guard, `auto_pipeline.py:545` real submit |
| Frontend | build/type-check (`npm run build`) | **PASS** | `next build` → "Compiled successfully", 16 static pages generated |

---

## Detailed Findings

### Task 1 — Toolchain & Environment

```
node --version  → v22.14.0
npm --version   → 11.3.0
python --version → Python 3.13.13
python -c "import nodriver; print(nodriver.__version__)" → 0.50.3
```

Env files:
| File | Present |
|---|---|
| `backend/.env` | YES |
| `backend/.env.example` | YES |
| `backend/.env.worker` | YES |
| `nodriver-spike/.env` | NO |

Frontend directory: `frontend/` — `package.json` present, `name: "frontend"`, Next.js 14.2.35.

---

### Task 2 — Backend Static Health

**Build (`npm run build`):** PASS — exit 0, no TypeScript errors.
```
> backend@1.0.0 build
> tsc --project tsconfig.json && tsc-alias -p tsconfig.json
(no output = clean)
```

**Lint (`npm run lint`):** FAIL — 42 errors, 154 warnings. Exit code 1.

Key errors (all unused-var or no-var-requires class; do not affect runtime):
```
src/diagnose-vfs.ts:2:10          error  'prisma' is defined but never used
src/index.ts:65:35                error  Require statement not part of import statement
src/modules/account-farm/email-catchall.ts:44:35   error  'opts' assigned but never used
src/modules/accounts/accountBatch.service.ts:162   error  '_operatorUserId' assigned but never used
src/modules/accounts/accounts.router.ts:13:8       error  'axios' is defined but never used
src/modules/notifications/orchestrator-worker.ts:109,145,149  error  Empty block statement
src/modules/profiles/passportOcr.service.ts:118/119  error  Unnecessary escape character
src/modules/scenario/scenario.router.ts:19:10      error  'reconcilePending' defined but never used
src/modules/scenario/scenario.router.ts:121:27     error  'totalActive' assigned but never used
src/modules/vfs-mobile/client.ts:12:32             error  'AxiosError' defined but never used
```

(Full list: 42 errors total. Majority are `@typescript-eslint/no-unused-vars` or `no-console` — no logic bugs.)

---

### Task 3 — Backend Unit Tests

```
npm test  → jest --runInBand
Test Suites: 1 failed, 21 passed, 22 total
Tests:       1 failed, 165 passed, 166 total
Snapshots:   0 total
Time:        5.147 s
```

**Failing test:**
```
FAIL src/modules/monitor/monitor.service.test.ts
  ● monitor.service stored-account poll retry
    › logs in the stored VFS account and retries once after a 403 poll response

    expect(jest.fn()).not.toHaveBeenCalled()

    Expected number of calls: 0
    Received number of calls: 1

    1: {"data": {"lastUsedAt": 2026-05-29T11:23:36.916Z}, "where": {"id": "acc-1"}}

    at Object.<anonymous> (src/modules/monitor/monitor.service.test.ts:205:42)
```

**Root cause hypothesis:** The test asserts `prisma.vfsAccount.update` should NOT be called after a 403 retry succeeds (line 205). But the service is now calling it once with `{data:{lastUsedAt:...}}`. This looks like a recent change to `orchestrator-worker.ts` (shown as modified in git status) may have added a `lastUsedAt` touch that the test doesn't expect, or the monitor service logic was changed independently.

---

### Task 4 — Backend E2E Dry-Run

**Result: BLOCKED**

The `test:e2e:dry` script exists in `backend/package.json` and `backend/scripts/e2e-tests/run-all.ts` exists, but dry mode does NOT avoid database writes:

- `common.ts:1` imports `prisma` unconditionally.
- `common.ts:61` — `createTestAccount()` calls `prisma.vfsAccount.create()` directly.
- `common.ts:103` — `withTestServer()` calls `prisma.user.upsert()` to create an admin user.
- `01-cookie-sync-from-chrome.ts` calls `createTestAccount()` without any `isDryRun()` guard.
- Only the `liveOnly()` helper skips on dry-run; tests that don't call `liveOnly()` still hit the DB.

Running would write to the production Railway PostgreSQL database. **NOT executed.**

---

### Task 5 — Worker in SIMULATE Mode

**Result: BLOCKED**

Reading `backend/scripts/orchestrator-worker.ts` (full file read):

**What SIMULATE=1 disables:**
- All `spawnAndWatch('python', [PIPELINE_SPIKE], ...)` calls — no browser launched, no VFS hits.
- Pool top-up registration (`registerOne`) is skipped.

**What SIMULATE=1 still requires:**
1. `DATABASE_URL` (live Railway DB) — `PrismaClient` is instantiated unconditionally at line 76. The main loop immediately queries `prisma.settings.findUnique` (line 679) and updates it (line 691). `loadAccountTimings()` also reads from DB.
2. `BACKEND_URL` — required at startup, exits with error if missing (line 36-38).
3. `PROFILE_ENCRYPTION_KEY` — required at startup, exits with error if missing (line 48-52).
4. `WORKER_TOKEN` — optional (defaults to `''`), so a dummy value works.

`launch-worker.ps1` lines 55-62 validate all three required secrets before starting. The `backend/.env.worker` file is present and contains the prod Railway credentials.

**Conclusion:** SIMULATE=1 is safe from VFS hits but still reads/writes the production DB. Not run locally.

---

### Task 6 — Python Pipeline Static Check

**Compile check:**
```
python -m py_compile nodriver-spike/auto_pipeline.py nodriver-spike/register_spike.py
→ exit 0 (COMPILE_OK)
```

**Booking flow map (`auto_pipeline.py`):**

| Step | Function/Lines | Description |
|---|---|---|
| Login | `do_login()` lines 159–205 | nodriver navigates to VFS login, fills email/password, waits for Turnstile auto-pass, clicks Sign In |
| Wizard enter | `enter_wizard()` lines 209–221 | Clicks "Start New Booking" from dashboard if not already in wizard |
| Step 1 — Appointment Details | `select_route()` lines 270–329, `book()` line 434 | Selects centre → Long Stay → Work D-visa subcat; checks Continue enabled (slot exists); then clicks Continue |
| Step 2 — Your Details | `book()` lines 444–463 | Uploads passport image (file input), clicks Continue (OCR process), clicks Save |
| Step 3 — OTP Gate | `book()` lines 466–525 | Snapshots pre_ids; polls for OTP page; clicks Generate OTP; calls `mailsac_otp_code()` **at line 486**; fills code; clicks Verify; clicks Continue to advance |
| Step 3b — Book Appointment | `book()` lines 527–534 | Selects appointment type radio, date, time slot, clicks Continue |
| Step 4 — Services | `book()` line 537 | Clicks Continue/Next |
| Step 5 — Review → Submit | `book()` lines 539–548 | **BOOK_DRY_RUN guard at line 540**: if set, takes screenshot and returns without submitting. If not, clicks Submit/Confirm/Pay at line 545 |

**OTP wiring — definitive YES:**
```python
# auto_pipeline.py line 486
code = await mailsac_otp_code(EMAIL, pre_ids, timeout=120)
```
`mailsac_otp_code()` is defined at lines 82–97 and is actively called inside `book()`. **The old memory entry "OTP NOT wired" is incorrect and should be updated.**

**Caveat on OTP:** If `MAILSAC_KEY` env var is empty, `mailsac_list()` returns `[]` (line 63 guard), so `mailsac_otp_code()` will always timeout (120s) and return None. The code handles this gracefully at line 523–524 ("no code from Mailsac within timeout — cannot pass the OTP gate") but the booking will stall at Step 3.

**Step 5 Submit — reachable and dry-run-guarded:**
```python
# auto_pipeline.py:540–548
if BOOK_DRY_RUN:
    ts = int(asyncio.get_event_loop().time())
    await shot(page, f"dry_review_{ts}")
    log(f"DRY-RUN: reached review screen ...")
    return True
ok = await click_button_text(page, ["submit", "confirm", "pay"], timeout=20)
```
Submit is reachable when `BOOK_ENABLED=True` AND `BOOK_DRY_RUN=False`. Dry-run guard is in place.

---

### Task 7 — Frontend Static Health

```
cd frontend && npm run build
→ next build
✓ Compiled successfully
✓ Generating static pages (16/16)
```

**Result: PASS** — 16 static routes, 1 dynamic route. Build time ~normal.

Warnings (non-fatal):
1. `setup/page.tsx:108` — `useMemo` dependency on `accounts` expression (react-hooks/exhaustive-deps)
2. `layout.tsx:16` — Custom font not in `_document.js`
3. `status/[token]/page.tsx:100` — `useEffect` missing `loadStatus` dependency
4. `components/ui/CaptchaModal.tsx:69` — `<img>` instead of Next `<Image />`

---

### Task 8 — Repo Hygiene Inventory

**Modified but uncommitted (` M`):**
- `.claude/worktrees/sharp-wescoff-bb0f0f` — Claude worktree state
- `backend/scripts/orchestrator-worker.ts` — actively modified
- `backend/scripts/verify-vfs-reachable.js` — modified
- `launch-bot-chrome.ps1` — modified
- `nodriver-spike/auto_pipeline.py` — modified

**Deleted nothing — inventory only as instructed.**

---

#### (a) Obvious junk / shell-redirect artifacts

These are zero-byte files created by accidental shell redirects (e.g. `node -e "..." > ({` in PowerShell). They are safe to delete in bulk.

Root-level junk:
`'')`, `((x.innerText`, `(o.textContent`, `(t.id`, `({`, `({,`, `0)`, `15-30s`, `200`, `400)`, `403,`, `Oxylabs`, `Telegram`, `c.checked).length})`, `console.log('[VFS-SW]'`, `d.file`, `i.offsetParent!`, `i.status`, `id`, `len(triggers)`, `re.test((o.textContent`, `t.id`, `undefined)`, `void)`, `{`, `{,+`, `{await`, `{console.error('ERR'`, `{console.error(e.message)`, `{console.log('ERR'`, `{console.log('accounts`, `{console.log('queue`, `{const`

`backend/` junk:
`({`, `({})))`, `.([profileId])n.swp` *(vim swap file)*, `200`, `400)`, `Oxylabs`, `[]`, `c.checked).length})`, `console.error('[scenario]`, `console.log('ERR'`, `console.log(k+'`, `k+'`, `prisma.$disconnect())`, `prisma/$disconnect())`, `slot-API`, `t.id`, `{await`, `{console.error('ERR'`, `{console.log('ERR'`, `{console.log('FAIL`, `{console.log('PENDING`, `{console.log('accounts`, `{console.log('count`, `{console.log('pipeline_events`, `{console.log('queue`, `{console.log(JSON.stringify(a))`, `{const`, `{{const`, `{})`

`nodriver-spike/` junk:
`'`, `((x.innerText`, `b.offsetParent!`, `e`, `i.getAttribute('formcontrolname')`, `{const`, `{{const`

`extension/` junk:
`Oxylabs`

**Total junk files: ~70 zero-byte artifacts**

---

#### (b) Legit new files (not yet committed)

| File | Note |
|---|---|
| `CLAUDE_CODE_DIAGNOSTIC_PLAN.md` | Current diagnostic plan |
| `CODEX_FINISH_LINE_STARTER.md`, `CODEX_PRODUCTION_READY_STARTER.md`, `CODEX_VERIFY_AND_FIX_STARTER.md` | Codex starter prompts |
| `INFRA_SHOPPING_LIST.md`, `PASTE_TO_SONNET_PIPELINE.md`, `PHASE1_CLAUDE_PLAN.md`, `PHASE1_STAGE_A_REPORT.md`, `VPS_SETUP_CONTABO.md` | Planning/ops docs |
| `backend/scripts/check-test-account.ts`, `find-clean-account.ts`, `reveal-cred.ts`, `set-cred.ts` | Diagnostic/utility scripts |
| `backend/src/spike-rebrowser-login.ts` | rebrowser spike (experimental) |
| `deployments/*.png` (35 images) + `state-and-scenarios.html` | Deployment screenshots / reference |
| `docs/superpowers/plans/2026-05-26-plan2/3/4.md` | Architecture plans |
| `frontend/.eslintrc.json` | Frontend ESLint config |
| `n5.png` | Root screenshot (orphaned?) |
| `scripts/bootstrap-test-flow.js`, `db-inspect.js`, `full-reset.js`, `full-ws-heartbeat-test.js`, `latest-accounts.js`, `push-vendor-env.js`, `reset-prod.js`, `test-extension-ws.js` | Utility/test scripts at root `scripts/` |
| `.claude/scheduled_tasks.lock` | Claude system lock file (auto-managed) |

---

#### (c) Uncertain

| File | Why uncertain |
|---|---|
| `nodriver-spike/e` | Zero-byte file in nodriver-spike — probably junk redirect |
| `backend/backend/slot-API` | Looks like a misplaced zero-byte redirect |

---

## Bugs / Breakage Found (NOT fixed)

1. **[High] Failing unit test — `monitor.service.test.ts:205`**
   - Symptom: `expect(prisma.vfsAccount.update).not.toHaveBeenCalled()` fails; update called with `{data:{lastUsedAt: now}}`.
   - File: `src/modules/monitor/monitor.service.test.ts:205` / likely source: `src/modules/monitor/monitor.service.ts`
   - Severity: **High** — blocks CI green. The monitor service is the core slot-polling loop; a regression here could mean accounts get their `lastUsedAt` touched on a 403-retry success path when they shouldn't, breaking cooldown logic.
   - Blocks: clean CI, deployment confidence.

2. **[Medium] OTP memory entry is wrong**
   - Symptom: Memory says "OTP NOT wired into booking loop" — `auto_pipeline.py:486` proves OTP IS wired.
   - File: `.claude/projects/.../memory/project_vfs_captcha_mandatory_field_wall.md` (memory index entry)
   - Severity: **Medium** — stale memory will mislead future sessions into thinking OTP is missing, potentially causing unnecessary re-work.
   - Blocks: correct planning decisions.

3. **[Medium] OTP will stall if `MAILSAC_API_KEY` is unset**
   - Symptom: `mailsac_otp_code()` calls `mailsac_list()` which returns `[]` when `MAILSAC_KEY` is empty (line 63). Function times out after 120s returning None. Booking stalls at Step 3 with "no code from Mailsac within timeout".
   - File: `nodriver-spike/auto_pipeline.py:63,486`
   - Severity: **Medium** — booking will always fail at OTP gate in any env where `MAILSAC_API_KEY` is not set. Operator must set this env var for real bookings.
   - Blocks: end-to-end booking unless `MAILSAC_API_KEY` is configured.

4. **[Medium] E2E scripts don't respect `isDryRun()` — all write to prod DB**
   - Symptom: `--dry` flag passes `E2E_DRY_RUN=1` to child processes, but most e2e scripts (01, 10, etc.) call `createTestAccount()` / `withTestServer()` directly without checking `isDryRun()`. These write to the Railway production database.
   - File: `backend/scripts/e2e-tests/01-cookie-sync-from-chrome.ts:7`, `10-profile-crud.ts:8`, `common.ts:61,103`
   - Severity: **Medium** — no safe local dry-run path. Can't validate e2e without pointing at prod DB.
   - Blocks: safe local integration testing.

5. **[Low] Lint: 42 ESLint errors across backend src**
   - Symptom: `npm run lint` exits 1. Errors are: unused vars/imports, `no-var-requires`, empty catch blocks, unnecessary escape chars.
   - Files: 15+ src files (see Task 2 for full list)
   - Severity: **Low** — does not affect runtime or build. Does block any CI gate that runs lint.
   - Blocks: clean CI if lint is gated.

6. **[Low] `nodriver-spike/.env` missing**
   - Symptom: No `.env` in `nodriver-spike/`. The Python pipeline reads env vars directly (os.environ) and falls back gracefully, but credentials (`VFS_EMAIL`, `VFS_PASSWORD`, `MAILSAC_API_KEY`) must be passed via shell env or the worker's env injection.
   - File: `nodriver-spike/` directory
   - Severity: **Low** — operational inconvenience, not a bug. Credentials work via parent process env.

---

## Repo Hygiene

See Task 8 section above for full categorized lists.

**Summary:** ~70 zero-byte junk artifacts from accidental shell redirects. 35+ deployment PNGs. ~8 uncommitted utility scripts in root `scripts/`. A vim swap file at `backend/.([profileId])n.swp`.

**Confirmed: nothing was deleted during this diagnostic run.**

---

## Blocked Checks

| Check | Reason |
|---|---|
| `npm run test:e2e:dry` | Most e2e scripts write to DB unconditionally regardless of `--dry`. Running would mutate the production Railway PostgreSQL. Blocked to protect prod data. |
| Worker SIMULATE run | `SIMULATE=1` still instantiates `PrismaClient` and queries/updates `Settings.scenario_run` + reads `vfsAccount` on every poll tick. Requires live `DATABASE_URL`, `WORKER_TOKEN`, `PROFILE_ENCRYPTION_KEY`. Not safe to run without prod creds. |
| Env file contents | Plan explicitly forbids printing secrets. `backend/.env` and `backend/.env.worker` contents not read. |

---

## Recommended Next Actions (ranked)

1. **Fix the failing unit test (`monitor.service.test.ts:205`)** — HIGH IMPACT, LOW EFFORT.
   The test regression in the monitor service likely tracks a real logic change in `orchestrator-worker.ts` (which is modified). Root-cause: the service now touches `lastUsedAt` on a 403-retry path when the retry succeeds, which the test doesn't expect. Either the test expectation is wrong (if the touch is intentional) or the service is touching `lastUsedAt` too eagerly. Fix this before any deployment. The monitor is core; a broken cooldown leaves accounts spamming VFS and triggering 429s.

2. **Set `MAILSAC_API_KEY` on the UZ machine / worker env** — HIGH IMPACT, ZERO CODE EFFORT.
   Without this, every real booking attempt will stall for 120s at the OTP step and fail. Check `backend/.env.worker` and the Railway backend env to confirm the key is set end-to-end. The key should propagate from the worker's spawn env into `auto_pipeline.py` (`MAILSAC_API_KEY` env var). If it's already there, no action needed — but verify.

3. **Bulk-delete the ~70 junk artifact files** — MEDIUM IMPACT, LOW EFFORT.
   The zero-byte shell-redirect files pollute `git status`, making it hard to see real changes. A single `git clean -n` preview followed by targeted deletes (just the junk, not the legit new files) would restore a clean working tree. Recommend doing this in a single housekeeping commit so the porcelain is readable again.

4. **Update the stale OTP memory entry** — LOW EFFORT, PREVENTS FUTURE CONFUSION.
   The memory entry claiming "OTP NOT wired" will mislead any future session. Update it to reflect that OTP IS wired at `auto_pipeline.py:486` and the only blocker is having `MAILSAC_API_KEY` set.

5. **Add `isDryRun()` guards to e2e scripts OR add a local test database** — MEDIUM EFFORT, HIGH VALUE.
   The e2e suite is useful but currently unsafe to run locally. Either: (a) add `if (isDryRun()) { skip('requires live DB'); }` at the top of scripts that write to DB, or (b) provision a local test database (docker-compose with Postgres) so the suite can run without touching prod.
