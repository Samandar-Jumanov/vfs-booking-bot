# Claude Code Plan — Remove Fake Simulations (keep real tests)

> **Executor:** Claude Code (Sonnet 4.6)
> **Goal:** Strip out the **fake demo/SIMULATE paths and fabricated data** so the worker can ONLY do a real run (no way to accidentally run a fake one). **Keep the real Jest unit tests and the real stealth/human-behavior code.**
> **Type:** Surgical deletion + verification. No live VFS. No commit/push.

---

## 0. Mission & the critical keep/remove distinction

The operator wants every run to be the REAL process — no fake simulations that look real (those produced the demo Telegram messages 237/238/239). Remove the fakery; do NOT remove legitimate engineering.

**❌ REMOVE (genuinely fake):**
1. `SIMULATE` mode in `backend/scripts/orchestrator-worker.ts` — the `simulateAccount()` function (~lines 238–285), the `SIMULATE` / `SIMULATE_FAIL` / `SIMULATE_CHECKS` env flags and every branch guarded by them (incl. the `if (SIMULATE)` dispatch ~line 601, the pool-top-up `if (!SIMULATE)` guard ~519, startup logs ~679–681, header comments ~4–18).
2. `WORKER_SIMULATE` handling in `launch-worker.ps1` (lines ~16, 47, 64) and the "SIMULATE (no VFS)" mode display — leave only REAL and REAL+BOOK modes.
3. The standalone fake/demo scripts: `backend/scripts/full-loop-demo.ts`, `backend/scripts/simulate-extension.ts`, and `backend/scripts/test-pipeline-e2e.ts` **if** they exist only to run the simulated pipeline (verify each is a SIMULATE/demo harness before deleting; if one does something real+useful, keep it and report).
4. The dead fabricated `PROFILE` dict in `nodriver-spike/auto_pipeline.py` (~lines 333–340, incl. `"AB1234567"`) — already proven unreferenced (`grep "PROFILE\["` is empty). Remove the dict and update the module docstring line that mentions `PROFILE_*`.

**✅ KEEP — do NOT touch (these are real, not fake):**
1. `backend/src/modules/engine/humanBehavior.ts` — "simulate human behaviour" here means real anti-bot mouse/typing/scroll jitter. Essential. Leave it.
2. **All 166 Jest unit tests** (`*.test.ts` / `*.spec.ts`). They use mocks by design — that's how unit tests work, not "fake." They are the regression safety net.
3. `backend/src/modules/lifecycle/mock-browser-driver.ts` — **verify usage first.** If it is imported only by test files, KEEP it (test infrastructure). Only if it is selectable in a real runtime code path (a way to run the live pipeline against a fake browser) should it be gated off — and if so, report it rather than deleting outright.
4. `RUN_LIMIT` — the from-scratch run depends on it. Keep `RUN_LIMIT` fully working. You may drop the `SIMULATE_LIMIT` alias (line ~544) so `RUN_LIMIT` is the only name, but `RUN_LIMIT` itself must stay.
5. `BOOK_DRY_RUN` — NOT fake (it's a real run that stops before the final submit). Keep it.

**HARD RULES:**
1. No live VFS/login/register/booking. No `git commit`/`push`.
2. Removing fake code must NOT break the build or the real run. After edits, the worker must compile and run the REAL path with no SIMULATE references left.
3. If any unit test imports the removed SIMULATE code (e.g. tests `simulateAccount`), that specific test was testing the fake path — remove just that test and justify it in the report. Do NOT remove unrelated tests. Target: tests still green (count may drop slightly only if a test was specifically for SIMULATE).
4. Don't create stray shell-redirect junk files (no accidental `> ...`).

---

## 1. What "done" looks like

- `grep -rni "simulate" backend/scripts backend/src --include=*.ts` returns **only** `humanBehavior.ts` (real) — no SIMULATE run-mode references remain in the worker.
- `launch-worker.ps1` has no `WORKER_SIMULATE`; it offers only REAL and REAL+BOOK.
- The fake demo scripts are gone (or justified-kept).
- The dead `PROFILE` dict is gone from `auto_pipeline.py`.
- `RUN_LIMIT`, `BOOK_DRY_RUN`, `humanBehavior.ts`, and the unit tests all still work.
- `npm run build` clean, `npm test` green (166, or 166 minus any SIMULATE-specific test you removed — state the new number + why), `py_compile` clean.
- `DEFAKE_REPORT.md` written. Nothing committed.

---

## 2. Tasks (in order)

### Task 1 — Rip SIMULATE out of the worker
Edit `orchestrator-worker.ts`: delete `simulateAccount()`, the `SIMULATE`/`SIMULATE_FAIL`/`SIMULATE_CHECKS` consts and every branch using them, and the related header comments. The main drive loop should call the REAL drive path unconditionally. Preserve `RUN_LIMIT` (drop only the `SIMULATE_LIMIT` alias). Keep all real logic (pool top-up, reconcile, drive, milestones) intact.
**Done when:** no `SIMULATE*` identifiers remain in the file; `npm run build` clean.

### Task 2 — Simplify the launcher
Edit `launch-worker.ps1`: remove `WORKER_SIMULATE` → `SIMULATE` mapping and the SIMULATE mode line/text. Modes become: REAL + booking DRY-RUN (default) and REAL + BOOK (`WORKER_BOOK=1`). Update the header comment block accordingly.
**Done when:** no `SIMULATE` in the launcher; the two real modes display correctly.

### Task 3 — Remove the fake/demo scripts
For `full-loop-demo.ts`, `simulate-extension.ts`, `test-pipeline-e2e.ts`: open each, confirm it's a SIMULATE/demo harness, then delete it. If `package.json` references any of them in `scripts`, remove that script entry too. If one turns out to do something real and useful, keep it and explain in the report.
**Done when:** the fake scripts are gone; `package.json` has no dangling references.

### Task 4 — Remove dead fabricated data
In `auto_pipeline.py`, delete the unused `PROFILE` dict (~333–340) and fix the docstring line referencing `PROFILE_*`. Re-confirm with `grep "PROFILE\["` (empty) and that nothing else references `PROFILE`. Leave the legitimate generated values used by registration (e.g. generated email/phone in `register_spike.py`) alone — those are real, not fake.
**Done when:** `PROFILE` dict gone; `py_compile` clean; no broken references.

### Task 5 — Verify mock-browser-driver usage (decide, don't guess)
`grep -rn "mock-browser-driver\|MockBrowserDriver" backend/src`. If it's imported only by `*.test.ts`, KEEP it and note "test-only infra." If a non-test runtime path can select it, report exactly where and recommend gating it off (do not delete a test dependency).
**Done when:** report states the verdict with the grep evidence.

### Task 6 — Prove nothing real broke
- `cd backend; npm run build` → exit 0.
- `cd backend; npm test` → green (state the count; if you removed a SIMULATE-only test, say which and why the new count is correct).
- `python -m py_compile nodriver-spike/auto_pipeline.py nodriver-spike/register_spike.py` → clean.
- `grep -rni "simulate" backend/scripts backend/src --include=*.ts` → only `humanBehavior.ts`.
**Done when:** all four pasted as evidence.

---

## 3. Required output: `DEFAKE_REPORT.md`

```markdown
# De-Fake Report (<date>)

## TL;DR
What fake paths were removed; confirmation the real run path is now the only run path; test count.

## Removed
- SIMULATE in worker (what + lines)
- launcher WORKER_SIMULATE
- fake/demo scripts (which, + any package.json entries)
- dead PROFILE dict

## Kept (and why)
- humanBehavior.ts (real stealth)
- 166 unit tests (mocks ≠ fake)
- mock-browser-driver.ts verdict (test-only? evidence)
- RUN_LIMIT / BOOK_DRY_RUN

## Evidence
build / test (count + any removed SIMULATE-test justified) / py_compile / the final simulate-grep result

## What's staged (not committed)
File list.
```

---

## 4. Final step

Write `DEFAKE_REPORT.md`, post in chat: confirmation that the worker now has no fake path (the only way to run is real), the final test count, and anything you kept that the operator might have thought was fake (so they understand why). Then stop.
