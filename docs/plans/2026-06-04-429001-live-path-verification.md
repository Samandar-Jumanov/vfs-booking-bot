# 429001 Account-Swap — Verify the LIVE Path (and reconcile the TS fix)

**Date:** 2026-06-04
**Owner:** backend / worker
**Status:** Investigation + decision plan (not yet executed)

## Why this exists

User reported: a flagged account (`LOGIN FAILED — rate_limit_429001`, URL `…/page-not-found`)
should "just swap the account." A fix was made and pushed — BUT it was made in the
**wrong code path**. This plan corrects that and verifies the real behavior.

## What we learned (grounded in the code)

The live hands-off engine is **nodriver Python**, NOT the TypeScript extension path:

- `backend/scripts/orchestrator-worker.ts:126,359` spawns `nodriver-spike/auto_pipeline.py`
  (`driveAccountReal`). It does **not** call `loginAccount` or `extension-dispatch`.
- `auto_pipeline.py:322` classifies failures and emits `MILESTONE … rate_limit_429001`
  — this is the exact string in the user's log.
- `orchestrator-worker.ts` already has the swap machinery:
  - `MAX_SWAPS_PER_RUN = 2` (line 74-76) — "Auto-rotate: max 429001 swaps per driveRun()".
  - `cooldown429001Ms: 6h` (line 117).
  - Circuit breaker: kills the Python child on first `rate_limit`/`datadome_block`/`login_failed`
    milestone (line 298-299); tracks last milestone error to "quarantine the account" (line 209-210).
- `CLAUDE.md:245` documents this as working: *"auto-rotate on 429001: moves the client's
  profile to a ready spare + quarantines the blocked account (cap 2 swaps/run); only on
  account-blocks, not IP-blocks."*

**Implication:** the 429001 swap is supposed to already work in the live path. The pushed
TS change (commit `899f1c0`: `accountLoginService.resolveLoginFailed` + `extension-dispatch`)
sits in a **secondary/legacy extension path the live worker never invokes**.

## Open question this plan answers

Does the live `orchestrator-worker.ts` → `auto_pipeline.py` 429001 swap **actually fire and
succeed** end-to-end, or is there a gap (e.g. cools down but never re-drives a spare; swap cap
exhausted immediately; quarantine not persisted; page-not-found masks the 429001 classification)?

---

## Tasks

### Task 1 — Trace the live 429001 swap end-to-end (read-only)
- [ ] In `orchestrator-worker.ts`, read `driveRun()` / the swap loop that consumes
      `MAX_SWAPS_PER_RUN`. Confirm: on a `rate_limit_429001` milestone it (a) sets the account
      `COOLDOWN` + `cooldownUntil = now+6h` in `vfsAccount`, (b) selects a different spare with a
      client `profileIds` link, (c) re-spawns `auto_pipeline.py` for the new account.
- [ ] In `auto_pipeline.py:~322-340`, confirm `rate_limit_429001` is emitted for the
      account-level ban AND is **not** shadowed when the URL is `/page-not-found`
      (cross-check `throttleGuard.classifyThrottle` precedence — URL `page-not-found` is matched
      before `429`). Note if a page-not-found bounce mislabels a real 429001.
- [ ] Write findings inline here under "## Findings" with exact line refs.

### Task 2 — Decide the real defect (pick ONE based on Task 1)
- [ ] **A. Swap works** → no live-code change needed; the user's incident was the documented
      behavior (account cooled 6h, swapped to spare). Action: explain + optionally make the 6h
      cooldown / 2-swap cap configurable. Done.
- [ ] **B. Swap cools down but never re-drives** → fix the re-drive loop in `orchestrator-worker.ts`.
- [ ] **C. 429001 misclassified as page_not_found** → fix precedence so an explicit `429001`
      signal wins over the `/page-not-found` redirect in the classifier the live path uses.
- [ ] **D. No healthy spare exists** → it's a pool-capacity problem, not a swap bug; surface a
      clear log + alert and document `POOL_MIN`/registration needs.

### Task 3 — Reconcile the pushed TS change (commit 899f1c0)
- [ ] Decide: **keep** the TS `accountLoginService`/`extension-dispatch` cooldown as a harmless
      safety-net for the extension path, OR **revert** it to avoid two divergent 429001 mechanisms.
- [ ] Recommendation: keep ONLY if the extension login path is still reachable in any live mode;
      otherwise revert to keep one source of truth (the worker + Python pipeline).
- [ ] If keeping, align its cooldown semantics with the live path (the worker uses 6h for 429001;
      the TS edit uses 60m via `account.cooldownMs`). Pick one policy.

### Task 4 — Implement the chosen fix (only if Task 2 ≠ A)
- [ ] Make the change in the LIVE path (`orchestrator-worker.ts` and/or `auto_pipeline.py`).
- [ ] No DB migration expected (uses existing `vfsAccount.status` / `cooldownUntil`).
- [ ] `cd backend && npx tsc --noEmit` clean; run any worker/lifecycle tests.

### Task 5 — Verify on the VPS (the only real proof)
- [ ] Per `ops/ALWAYS_ON.md`: `git pull` on the Tashkent VPS, then
      `Stop-ScheduledTask -TaskName VFS-Booking-Worker; Start-ScheduledTask -TaskName VFS-Booking-Worker`.
      (Worker runs `npx tsx` — no build step.)
- [ ] On the next live `rate_limit_429001`, confirm in the worker log / Telegram: account flips to
      `COOLDOWN`, a different spare is driven, and the run continues. Capture the log lines here.

## Notes / risks
- The TS commit `899f1c0` is already on `origin/main` but does NOT affect the live worker
  (Railway ≠ VPS worker, per `CLAUDE.md:235`). It is inert in production until the extension
  path is used.
- Do NOT introduce a second `Account` model again — the live pool is `VfsAccount`.
