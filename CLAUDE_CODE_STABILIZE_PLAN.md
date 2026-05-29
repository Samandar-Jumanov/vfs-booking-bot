# Claude Code Plan — Stabilize (fix monitor test · repo cleanup · refresh CLAUDE.md)

> **Executor:** Claude Code (Sonnet 4.6)
> **Source of truth for current state:** `DIAGNOSTIC_REPORT.md` (repo root, dated 2026-05-29). Read it first.
> **Type:** Targeted fix + housekeeping + doc refresh. All low-risk. **No live VFS, no booking, no login, no OTP/Mailsac calls.**
> **Goal:** Get the backend test suite to 166/166 green, clean the ~70 junk artifact files out of the working tree, and update `CLAUDE.md` to match verified reality — then report for joint QA.

---

## 0. Mission & Hard Rules

This pass makes the codebase clean and honest: one real test bug fixed, the junk swept up, and the project doc telling the truth about the current state. We are NOT building features, NOT touching the booking/login/OTP runtime, NOT hitting VFS.

**HARD RULES:**

1. **No live VFS / login / register / booking / submit. No Mailsac/OTP calls.** This plan never runs `auto_pipeline.py`, `register_spike.py`, the worker, or any e2e script that hits VFS or the prod DB.
2. **Do NOT run `npm run test:e2e` / `test:e2e:dry`** — the diagnostic proved they write to the **production** Railway DB even in `--dry`. Off-limits.
3. **Do NOT run the orchestrator worker** (even SIMULATE) — it reads/writes the prod DB.
4. **Code edits are allowed ONLY in Task 1** (the monitor test fix), and only the files named there. Tasks 2 and 3 must not edit application source.
5. **Do NOT `git commit`, `git push`, or `gh pr create`.** Leave changes staged in the working tree for the operator to commit. (Deleting untracked junk files in Task 2 is fine — that's not a commit.)
6. This repo is on a **OneDrive path**. If any `git` op throws a `.lock` permission error, note it in the report and skip — do NOT retry destructively or force-remove `.git` locks.
7. **Never delete a file that isn't on the explicit junk list in Task 2, and never delete a file that is not zero bytes.** Double-guard every deletion.

**Environment:** Windows 11, PowerShell, npm. Backend `backend/`, frontend `frontend/`, Python spike `nodriver-spike/`.

---

## 1. What "done" looks like

- `cd backend; npm test` → **166 passed, 0 failed**, proven by pasted output.
- `cd backend; npm run build` → still exit 0 (no type regression from the fix).
- The ~70 zero-byte junk artifact files are gone; `git status` is readable; **zero** legit files deleted.
- `CLAUDE.md` "Current State" section reflects the 2026-05-29 verified facts.
- `STABILIZE_REPORT.md` written at repo root with evidence for all three tasks.
- No commit/push performed.

---

## 2. Tasks (do in order)

### Task 1 — Root-cause and fix the failing monitor test

**Context (from diagnostics):** `npm test` fails 1/166 at
`src/modules/monitor/monitor.service.test.ts:205` — the test
`"logs in the stored VFS account and retries once after a 403 poll response"` asserts
`expect(prisma.vfsAccount.update).not.toHaveBeenCalled()`, but the service now calls
`prisma.vfsAccount.update({ where:{id:"acc-1"}, data:{ lastUsedAt: <now> } })` once. This correlates with the uncommitted changes to `backend/scripts/orchestrator-worker.ts`.

**Why this matters (read carefully):** the monitor is the **core slot-polling loop**. `lastUsedAt` drives **cooldown / request pacing**, which is what prevents VFS **429** bans (429202 IP/session, 429001 account-level). A wrong `lastUsedAt` touch on the 403-retry path could corrupt pacing and get accounts rate-limited or quarantined. So the fix must be **correct**, not just "make the test pass."

**What to do:**
1. **Investigate first — do not edit yet.** Read:
   - `src/modules/monitor/monitor.service.ts` (the 403 → login → retry-once path)
   - `src/modules/monitor/monitor.service.test.ts` around lines 180–230
   - the relevant diff in `backend/scripts/orchestrator-worker.ts` (git shows it modified) — `git diff backend/scripts/orchestrator-worker.ts` and `git log -p -1 -- src/modules/monitor/monitor.service.ts` to see what changed.
2. **Decide which is wrong, and write the decision into the report:**
   - **If touching `lastUsedAt` on a successful 403-retry is INTENTIONAL and correct** (e.g. it reflects a real VFS request that should reset the pacing clock) → the **test expectation is stale**. Update the test to assert the update IS called once with the expected shape. Justify why the touch is correct for pacing.
   - **If touching `lastUsedAt` there is a REGRESSION** (e.g. it double-counts, or touches on a path that shouldn't reset cooldown) → fix the **service** so it doesn't, leaving the test assertion as-is. Justify why the touch was wrong.
   - When unsure, prefer the interpretation that **preserves correct 429-avoidance pacing** and explain your reasoning.
3. **Make the minimal edit** in the chosen file only (`monitor.service.ts` OR `monitor.service.test.ts`). Do not refactor surrounding code.
4. **Do not** "fix" anything else you notice — record other issues in the report instead.

**Test / done when:**
- `cd backend; npm test` → `Tests: 166 passed, 166 total` (paste the summary line + the formerly-failing test now passing).
- `cd backend; npm run build` → exit 0 (paste confirmation; proves no type break).
- Report states clearly: which file you changed, why, and the test-vs-code verdict with reasoning.

---

### Task 2 — Delete the ~70 junk shell-redirect artifact files

**Context:** `git status` is polluted by ~70 **zero-byte** files created by accidental PowerShell redirects (names like `({`, `t.id`, files literally named `console.log('ERR'`, root `200`, `400)`, `15-30s`, a vim swap `backend/.([profileId])n.swp`). The diagnostic catalogued them. These are safe to remove.

**Why:** a readable `git status` is required to see real changes before any future commit. Right now real edits hide among 70 junk entries.

**What to do — with a hard double-guard:**
1. Build the **explicit junk list** from the categorized "(a) Obvious junk" section of `DIAGNOSTIC_REPORT.md` (Task 8). Use those exact paths. Include the vim swap `backend/.([profileId])n.swp`.
2. For the **two "uncertain" files** (`nodriver-spike/e`, `backend/backend/slot-API`): only delete them if they are confirmed **zero bytes**; otherwise leave them and note in the report.
3. **Before deleting each file, verify it is zero bytes.** Skip (and log) any file on the list that is NOT zero bytes — that would mean it's unexpectedly real. Delete with `Remove-Item -LiteralPath '<path>'` (use `-LiteralPath` + single quotes so the weird characters/parens are treated literally, not as globs).
4. **PROTECT LIST — never delete these** (the legit uncommitted files from category (b)): all `*.md` plan/report/starter docs (`CLAUDE_CODE_*`, `CODEX_*`, `PHASE1_*`, `INFRA_*`, `PASTE_TO_*`, `VPS_*`, `DIAGNOSTIC_REPORT.md`, `STABILIZE_REPORT.md`), `backend/scripts/*.ts` utility scripts, `backend/src/spike-rebrowser-login.ts`, everything under `deployments/`, everything under `docs/`, `frontend/.eslintrc.json`, root `scripts/*.js`, `.claude/**`, and any non-zero-byte file. When in doubt, DON'T delete — list it as "kept, uncertain" instead.
5. **Do NOT use** a blanket `git clean -fd` — it would also wipe the legit untracked docs/scripts. Delete **only** by explicit per-file path.

**Test / done when:**
- Run `git status --porcelain` after, and paste it. Confirm: the junk `??` entries are gone, all PROTECT-LIST files still present, and the only remaining changes are the legit ones (modified source + legit new files + this task's edits).
- Report states the count deleted and explicitly confirms zero legit files were removed. If OneDrive locked any deletion, note which and that you skipped it.

---

### Task 3 — Refresh `CLAUDE.md` "Current State & Known Issues" section

**Context:** `CLAUDE.md`'s "Current State" block is stamped **"updated 2026-05-25"** and is stale. The top half of the file is the project's **original broad vision** (Playwright, Angola→Brazil/Portugal, full dashboard) that no longer reflects the actual scope (UZ→Latvia D-visa, Chrome extension + nodriver). We only edit the **Current State** section (and add one short pointer near the top) — do not rewrite the whole file.

**Why:** A stale project doc makes future executors act on wrong assumptions (exactly the OTP confusion we just hit). The doc should tell the truth verified by `DIAGNOSTIC_REPORT.md`.

**What to do — edit `CLAUDE.md` only:**
1. Add a short note at the very top of the file (1–2 lines) directing readers: *"⚠️ Sections above 'Current State & Known Issues' describe the ORIGINAL Phase-1 vision and are partly superseded. For what's actually built and working, read 'Current State & Known Issues' below."*
2. In the **"Current State & Known Issues"** section, update the date to **2026-05-29** and reconcile it with these **verified facts** from `DIAGNOSTIC_REPORT.md` and Task 1:
   - Backend **type-checks clean**; frontend (Next.js 14) **builds clean**; Python spikes **compile clean**.
   - Unit tests: **166/166 green** (after Task 1's fix — state the fix briefly).
   - **OTP IS wired** into the nodriver booking loop (`auto_pipeline.py:486`); the real OTP blocker is the **`MAILSAC_API_KEY`** env, not missing code (if unset, booking stalls 120s at Step 3).
   - Booking **Step 5 Submit** is reachable and **`BOOK_DRY_RUN`-guarded**; still **unvalidated on a live slot**.
   - Full chain **create→activate→login→monitor** proven live (2026-05-28); **booking submit gated on a real slot appearing**.
   - **Known footgun:** `test:e2e:dry` and worker **SIMULATE both hit the PROD Railway DB** — there is no safe local test path yet; treat them as live.
   - Lint has cosmetic errors only (unused vars / empty blocks) — no logic impact.
3. Keep the still-valid gotchas already in the section (VPN→BrightData `ip_blacklisted`, proxy optional on UZ residential, `LOGIN_CRON_ENABLED`/`NOTIFY_BOOKING_FAILURES` default OFF, fresh-profile Turnstile finding). Do not delete hard-won knowledge — only correct what's now wrong and add what's new.
4. Keep it concise and factual; no marketing language.

**Test / done when:**
- `git diff CLAUDE.md` shows only the top pointer + the Current State section changed (paste the diff).
- Report includes a 5–8 line summary of exactly what facts you changed and why.

---

## 3. Required output: `STABILIZE_REPORT.md`

Create `STABILIZE_REPORT.md` at the repo root:

```markdown
# Stabilize Report (<date>)

## TL;DR
What changed across the 3 tasks; current test status; anything that needs the operator's eyes.

## Task 1 — Monitor test fix
- Verdict: test-was-wrong / code-was-wrong (+ reasoning, tied to 429 pacing)
- File changed + the minimal diff
- Evidence: `npm test` summary (166/166) + `npm run build` exit 0

## Task 2 — Junk cleanup
- Count deleted, with the list
- `git status --porcelain` before vs after (paste after)
- Explicit confirmation: zero legit/PROTECT-LIST files removed; any OneDrive-locked skips

## Task 3 — CLAUDE.md refresh
- Summary of facts corrected/added
- `git diff CLAUDE.md`

## Anything I noticed but did NOT touch
Bugs/smells found while working — recorded, not fixed (out of scope).

## State left for the operator
What's staged in the working tree (nothing committed/pushed, per rules).
```

**Evidence rule:** every "done" claim cites the real command + output. No claim without evidence.

---

## 4. Final step

Write `STABILIZE_REPORT.md`, then post in chat: the TL;DR + the Task 1 verdict (test-wrong vs code-wrong) + confirmation that tests are 166/166 and no commit/push was done. Then **stop** — the operator + orchestrator will QA the report and decide whether to commit and what's next.
