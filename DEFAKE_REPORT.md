# De-Fake Report (2026-05-29)

## Summary

The worker now has exactly **one run path: real VFS.** All fake/demo/simulate code has been removed. The test suite stayed at **166/166**. The only remaining `simulat` occurrences in the codebase are two English-language comments inside `humanBehavior.ts` ("simulate human movement", "simulate reading") — not code paths.

---

## Task 1 — SIMULATE stripped from orchestrator-worker.ts

**Removed:**
- Header comment block advertising `SIMULATE=1` test invocation (lines 4–6)
- JSDoc paragraph explaining SIMULATE=1 / SIMULATE_FAIL=1 (lines 16–18)
- `const SIMULATE = process.env.SIMULATE === '1';` (line 42)
- `const SIMULATE_FAIL = process.env.SIMULATE_FAIL === '1';` (line 43)
- Entire `simulateAccount()` function (49 lines, ~238–287)
- `if (!SIMULATE && poolMin > 0)` guard → pool top-up now always runs when `poolMin > 0`
- `SIMULATE_LIMIT` alias from RUN_LIMIT line → `const simulateLimit = Number(process.env.RUN_LIMIT ?? process.env.SIMULATE_LIMIT ?? 0)` → **`const runLimit = Number(process.env.RUN_LIMIT ?? 0)`** (RUN_LIMIT kept)
- `if (SIMULATE) { simulateAccount } else { driveAccountReal }` → just `driveAccountReal`
- `SIMULATE=${SIMULATE}` from startup log
- Two `if (SIMULATE) log(...)` lines in `main()`

**Kept (as instructed):**
- `RUN_LIMIT` — still caps how many accounts a run drives
- `BOOK_DRY_RUN` — still gates real submit vs screenshot-only
- `TARGET_EMAIL` — still pins a run to one specific account
- `POOL_MIN` — still controls pool top-up threshold

---

## Task 2 — WORKER_SIMULATE removed from launch-worker.ps1

**Removed:**
- Line 16: `$env:WORKER_SIMULATE='1'; .\launch-worker.ps1    SIMULATE (no VFS hits) - demo`
- Line 47: `if ($env:WORKER_SIMULATE -eq '1') { $env:SIMULATE = '1' } else { $env:SIMULATE = '' }`
- Line 64: `if ($env:SIMULATE -eq '1') { $mode = 'SIMULATE (no VFS)' }` (and its `elseif` → now simple `if`)

The mode display now correctly shows only two states: `REAL + BOOK (live submit!)` or `REAL + booking DRY-RUN`.

---

## Task 3 — Fake demo scripts deleted

| File | Why deleted |
|---|---|
| `backend/scripts/full-loop-demo.ts` | "100% autonomous full-loop demo", simulates extension over WS, seeds fake slot data |
| `backend/scripts/simulate-extension.ts` | "simulate the Chrome extension by connecting to /extension WS as a Node client" |
| `backend/scripts/test-pipeline-e2e.ts` | "SIMULATE end-to-end test", writes fake `scenario_run` signals, emits `simulated_critical_failure` |
| `backend/scripts/list-sim-bookings.ts` | Queries bookings with `confirmationNo LIKE 'VFS-SIM-%'` — lists fake simulated bookings |

No `package.json` scripts section referenced any of these (confirmed by grep before deletion).

**Remaining script count:** 29 `.ts` files in `backend/scripts/` (down from 33).

---

## Task 4 — Dead PROFILE dict removed from auto_pipeline.py

**Removed:**
- Docstring line: `PROFILE_*  applicant data for booking (firstName,...)`
- The entire 7-line `PROFILE = { ... }` dict with all its hardcoded fabricated defaults including `"passport": os.environ.get("PROFILE_PASSPORT", "AB1234567")`
- The 3-line comment above `PASSPORT_IMAGE` that incorrectly described the removed dict

**Replaced with** a single accurate comment:
```python
# Applicant identity is extracted by VFS OCR from the passport image — no text
# fields to fill. Supply a real passport BIO-page scan (PNG/JPG/PDF ≤2MB).
```

`PASSPORT_IMAGE` (the actual operative variable) is unchanged.

---

## Task 5 — mock-browser-driver.ts verdict: KEEP

`backend/src/modules/lifecycle/mock-browser-driver.ts` is imported exclusively by two test files:
- `src/modules/lifecycle/__tests__/booking.pipeline.test.ts`
- `src/modules/lifecycle/__tests__/lifecycle.service.test.ts`

No production source imports it. It is test infrastructure, not a fake runtime path. **Not deleted.**

---

## Task 6 — Proof nothing broke

```
npm run build  →
  > backend@1.0.0 build
  > tsc --project tsconfig.json && tsc-alias -p tsconfig.json
  (exit 0 — no errors)

npm test  →
  Test Suites: 22 passed, 22 total
  Tests:       166 passed, 166 total
  Time: 4.349 s

python -m py_compile nodriver-spike/auto_pipeline.py nodriver-spike/register_spike.py
  → py_compile PASS (exit 0)
```

**Simulate-grep result** (files: orchestrator-worker.ts, launch-worker.ps1, auto_pipeline.py, backend/src/**):
```
(empty — zero matches)
```

**Only remaining `simulat` occurrences in the whole codebase:**
```
backend/src/modules/engine/humanBehavior.ts:7   /** Moves mouse along a Bezier curve path to simulate human movement */
backend/src/modules/engine/humanBehavior.ts:61  /** Scrolls the page slightly to simulate reading */
```
These are English-language JSDoc comments, not code branches.

---

## The only run path is now: real

The worker (`orchestrator-worker.ts`) follows exactly one path:
1. `registerOne()` → `register_spike.py` → real VFS register form
2. Activation via `/api/pipeline/reconcile` → real extension Chrome visit
3. `driveAccountReal()` → `auto_pipeline.py` → real nodriver browser → real VFS login
4. Monitor OCMA → real slot polling
5. `book()` → real passport upload, real OTP, real Submit

There is no code branch that walks fake state, posts fake milestones, or fabricates confirmation numbers. `BOOK_DRY_RUN=1` (the safe default) runs the full flow including real login and real slot detection but stops before the final Submit click — that is the correct safe-default behaviour, not a fake path.

---

## What's staged (not committed)

| File | Change |
|---|---|
| `backend/scripts/orchestrator-worker.ts` | SIMULATE constants + function + guards removed; RUN_LIMIT preserved |
| `launch-worker.ps1` | WORKER_SIMULATE line + toggle + mode display removed |
| `nodriver-spike/auto_pipeline.py` | Dead PROFILE dict + fabricated defaults removed |
| `backend/scripts/full-loop-demo.ts` | **Deleted** |
| `backend/scripts/simulate-extension.ts` | **Deleted** |
| `backend/scripts/test-pipeline-e2e.ts` | **Deleted** |
| `backend/scripts/list-sim-bookings.ts` | **Deleted** |

Nothing committed, nothing pushed.
