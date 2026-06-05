# Codex Handoff — VFS Booking Automation

Repo: `C:\Users\saman\OneDrive\Documents\vfs-booking-bot-main` · npm · Python 3.12 (Windows VPS) · main branch.

This is an engineering handoff: the system, how to run/validate it, what changed recently, and the concrete known issues + suggested tasks. Make surgical, backward-compatible changes. Validate locally (no VFS contact needed for any task below). Commit with clear messages; do NOT push.

---

## 1. System overview

A visa-appointment automation for **VFS Global, Uzbekistan → Latvia (Work D-visa)**.

- **Python engine** — `nodriver-spike/auto_pipeline.py`. Uses **nodriver** (real Chrome, headed) to: log in, enter the booking wizard, capture lift-api auth headers, then poll `CheckIsSlotAvailable` directly. Detects slots, books (passport upload → OCR → form fill → OTP → submit). Also contains the account-pool rotation, burst-window, and watcher/booker logic.
- **Node/TS worker** — `backend/scripts/orchestrator-worker.ts`. Polls the DB for a queued `scenario_run`, selects accounts to drive, decrypts creds, spawns the Python engine per account, parses its `MILESTONE` stdout lines, posts them to the backend, and manages account lifecycle (auto-rotate, per-box lock, spare-credentials file).
- **Backend + dashboard** — Node/TS API + Next.js dashboard on **Railway**. Dashboard shows the account pool (Total/Active/Stale/Cooldown/Blocked) and operator controls. The **worker runs on the VPS, not Railway** — pushing to Railway does NOT update the worker; the VPS must `git pull` + restart.
- **DB** — Postgres (Railway), Prisma. Key models: `VfsAccount` (status, lifecycleState, cooldownUntil, profileIds[], pollingRole enum WATCHER|BOOKER|BOTH, encryptedPassword), `Profile` (the client; passportImageEnc, encrypted fields), `Settings` (worker_lock, scenario_run).
- **Runtime files** (gitignored) — `nodriver-spike/.account-pool.json` (pre-authed tokens per account), `nodriver-spike/.spare-credentials.json` (ACTIVE+unlinked creds for inline login, written by the worker).

### Key env (engine, read in auto_pipeline.py module scope)
`VFS_EMAIL/PASSWORD`, `BOOK_ENABLED` (real submit), `BOOK_DRY_RUN`, `SUBCAT`, `PROVE_OCMA`, `NATIONALITY_FILTER` (default `uzbek|turkmen`), `RATELIMIT_BACKOFF_MIN`, `MAILSAC_API_KEY`, `PASSPORT_IMAGE`, `PROFILE_*`, `MONITOR_INTERVAL`/`API_MONITOR_INTERVAL`, plus the newer: `BURST_WINDOWS`/`BURST_INTERVAL`/`IDLE_INTERVAL`/`BURST_TZ`, `BOOKER_EMAIL/PASSWORD/PASSPORT_IMAGE/PROFILE_*`, `TEST_BOOKER_ON_OCMA`. **All newer env unset = legacy behavior.**

### How to run / validate (no VFS contact)
```
python -m py_compile nodriver-spike/auto_pipeline.py
cd backend && npm run build          # tsc + tsc-alias, must be clean
python nodriver-spike/test_burst.py  # burst-window unit test
```
Do NOT launch the worker or open a browser against vfsglobal.com for any task here.

---

## 2. Recent changes (already on main)
- `6dedaa8` — **burst-at-release-window** (BURST_* env) + **watcher/booker split** (BOOKER_* env, 2nd browser books on the watcher's slot signal via an asyncio queue).
- `6c1978a` — `TEST_BOOKER_ON_OCMA` hook: routes an OCMA hit to the booker in DRY-RUN so the handoff can be exercised without a Work-D slot.
- `482e40f` — **429 death-spiral fix**: IP-level 429 (`429201`/`429202`/generic) now **rests silently** (`_ip_rest_skip`, sleep ≥20min, no account rotation, no UI walk). Account rotation is reserved for `429001` only. **Do not regress this.**

---

## 3. Known issues (concrete, code-level)

1. **UI fallback (`select_route`) flakiness.** Logs show repeated `category NOT registered (shows '')` (3 retries) and `wizard re-entry EMPTY (centre='')` (3 hard-reload retries) that often all fail, wasting the cycle. The wizard/category dropdowns frequently don't populate on re-entry. The API path is primary, but the UI fallback is fragile and noisy.

2. **Subcategory dropdown index drift.** `_try_subcat` logs `displayed value '' != intended '...' — skipping (index drift?)` and returns `SUBCAT_NOT_READY` / `no dropdown has subcat options`. Subcat selection by index is unreliable when the option list shifts; it already tries to match by content but still drifts.

3. **`datetime.datetime.utcnow()` DeprecationWarning** in the pool cooldown code (auto_pipeline.py, the `_pool_mark_ratelimited` / pool-write helpers — search `utcnow`). Replace with timezone-aware `datetime.now(datetime.UTC)`.

4. **Backend `/api/pipeline/event` step enum is missing values.** Milestones `ocma_available` and `activated` (or `activation_visited`) return cosmetic **HTTP 400** ("step enum") — the account still persists and Telegram still fires, but the 400s are noise. Add the missing enum value(s) to the backend validation.

5. **pool_builder over-registers (counting quirk).** It registers more spare accounts than `POOL_MIN` (the dashboard shows a runaway "Register (nodriver) · 60 queued"). The spare-count calculation over-counts needed registrations. Cap/queue it correctly and respect `MAX_REG_PER_DAY`.

6. **Watcher/booker handoff not yet validated end-to-end.** Code is in place (6dedaa8) and structurally sound (2nd browser logs in + parks + graceful fallback seen), but the full watcher→booker→book handoff has not been run through to a (dry-run) review screen in one clean pass. The booker's idle-session keep-alive (re-login on `/login` redirect, ~9-min dashboard re-nav) is best-effort and unproven for long idles.

7. **Burst-window needs `tzdata` on Windows.** `zoneinfo.ZoneInfo("Asia/Tashkent")` requires `pip install tzdata` on the VPS. Code degrades gracefully if absent (try/except) but logs a warning; confirm the fallback path is correct and document the dep in `ops/ADD_BOX.md`.

8. **Stale cookies / session warming.** The dashboard regularly shows accounts going `STALE` with `COOKIES FRESH 0`. The session-warming path (keeping logged-in cookies fresh so the booking flow can start without a full re-login) may need attention/hardening.

9. **No structured slot-appearance log.** When a Work-D slot is detected there's a `slot_found` milestone, but there is no dedicated, easily-queryable record of *every* Work-D availability event with a precise timestamp to reconstruct the release-time pattern over days.

---

## 4. Suggested tasks (prioritized)

**A. Slot-appearance timing log (highest value).** Every time the engine sees Work-D availability (`earliestDate`/slot lists non-empty for a Work-D subcat), write a structured, timestamped record (a distinct milestone like `workd_seen` with ISO timestamp + earliestDate, and/or append to a local `slot_sightings.jsonl`). Goal: reconstruct *when* slots release. Must not change detection/booking behavior.

**B. Fix the pipeline-event enum (quick win).** Add `ocma_available` + `activated`/`activation_visited` to the backend step enum so milestones stop returning HTTP 400.

**C. Cap pool_builder registration.** Fix the over-count so it never queues dozens of registrations; honor `POOL_MIN` and `MAX_REG_PER_DAY` strictly.

**D. Harden `select_route` / subcat selection.** Make wizard re-entry + category/subcat selection more robust (wait-for-populated, retry-by-content, clearer SUBCAT_NOT_READY handling) to cut the wasted UI-walk cycles.

**E. Clean up `datetime.utcnow()` deprecations.**

**F. Validate + harden watcher/booker + burst** using `TEST_BOOKER_ON_OCMA=1 BOOK_DRY_RUN=1` locally where possible (py_compile/build; full run needs a live env, so document the manual steps).

---

## 5. Guardrails (do not regress)
- **IP-level 429 (`429201`/`429202`/generic) must REST silently** — never rotate accounts / inline-login / register / UI-walk on these. Rotation is for `429001` only. (See `482e40f` + the `_ip_rest_skip` flag.)
- **Backward compatibility:** any new env unset → behavior identical to today.
- Preserve: `1035`=no-slots handling, OCMA-report-only / Work-D-book split, `NATIONALITY_FILTER` lean polling, the per-box lock (`BOX_ID`), the 429001 auto-rotate (orchestrator-worker.ts), captcha-modal dismissal.
- **Do NOT** contact VFS, launch the worker against it, or open a browser to vfsglobal.com.
- Validate with `py_compile` + `npm run build` (+ `test_burst.py`). Commit; **do not push**.

---

## 6. Report back
For each task: files changed + commit hashes (not pushed), where the change went (function + line refs), validation output, and anything you couldn't verify locally with the exact manual steps to verify it in a live env.
