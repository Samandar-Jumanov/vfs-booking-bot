# Claude Code Plan — System Diagnostic & Ground-Truth Assessment

> **Executor:** Claude Code (Sonnet 4.6)
> **Type:** Read / test / identify ONLY. **Do NOT fix, refactor, or build anything.**
> **Goal:** Produce an evidence-based map of what works and what's broken *right now*, so the operator can decide next actions from facts. Every claim in your report must be backed by a command you actually ran and its real output.

---

## 0. Mission & Hard Rules

We are NOT building features in this pass. We are finding out the true current state of the system by running everything that is **safe to run** and recording exactly what passes and what fails.

**HARD RULES — read these twice:**

1. **DO NOT WRITE OR EDIT ANY SOURCE CODE.** Not even "small fixes". If you find a bug, you *write it down in the report*; you do not fix it. The operator will decide fixes with the orchestrator afterward.
2. **DO NOT make any live VFS request, login, register, book, or submit.** No real `auto_pipeline.py` run against VFS. No real worker run. Use **SIMULATE mode** and static checks only (details below).
3. **DO NOT touch OTP / Mailsac live flows.** The operator has explicitly deferred OTP. Do not call any Mailsac endpoint.
4. **DO NOT delete files** — including the junk artifact files in the repo. Just inventory them.
5. **DO NOT `git commit`, `git push`, or `gh pr create`.** This is a read-only assessment.
6. If a command needs a secret you don't have (e.g. `backend/.env.worker`, `DATABASE_URL`), **do not invent one** — record it as "BLOCKED: missing <X>" and move on.
7. Run every command from the documented working directory. This repo lives on a **OneDrive path** — if a `git` operation hits a `.lock` permission error, note it and skip; do not retry destructively.

**Environment:** Windows 11, PowerShell. Package manager is **npm** (not pnpm). Node + Python both installed. Backend at `backend/`, frontend at `frontend/` (confirm name), extension at `extension/`, Python spike at `nodriver-spike/`.

---

## 1. What "done" looks like for this task

- You ran each task below, captured **real terminal output** (not assumptions).
- You wrote **`DIAGNOSTIC_REPORT.md`** at the repo root with a status matrix and verbatim evidence.
- You did not change a single line of source code.
- You finished with a short "Recommended next actions" list ranked by impact, for the operator + orchestrator to QA together.

---

## 2. Tasks

Do these **in order**. For each: run the command, capture the output, record PASS / FAIL / BLOCKED with the actual evidence. If something fails, capture the full error text — that error is the most valuable thing in the report.

### Task 1 — Toolchain & environment inventory
**What:** Confirm the tools and config the system needs are present.
**Why:** Half of "it's broken" turns out to be a missing tool or env file. Establish the baseline first.
**How (run each, record version/result):**
- `node --version`, `npm --version`
- `python --version` (and `py --version` if that fails)
- In `nodriver-spike/`: check whether `nodriver` is importable — `python -c "import nodriver; print(nodriver.__version__)"`
- List which env files exist (presence only, **do NOT print their contents/secrets**): check for `backend/.env`, `backend/.env.example`, `backend/.env.worker`, `nodriver-spike/.env` (use a file-existence check, e.g. `Test-Path`).
- Record the resolved frontend directory name and confirm it has a `package.json`.
**Done when:** You have a table of tool → version → present? and env-file → present?

### Task 2 — Backend static health (type-check + lint)
**What:** Compile and lint the backend without running it.
**Why:** This is the fastest way to catch real breakage across the whole TS codebase. The git status shows `backend/scripts/orchestrator-worker.ts` and others were modified — confirm they still compile.
**How (from `backend/`):**
- `npm install` if `node_modules` is missing (check first with `Test-Path backend/node_modules`); otherwise skip.
- `npm run build` — this runs `tsc` + `tsc-alias`. Capture **every** TypeScript error with file:line.
- `npm run lint` — capture errors and the warning count (don't list every warning; summarize).
**Done when:** You can state "backend type-checks clean" OR you have the exact list of TS errors. Lint result recorded separately (lint failures are lower severity than type errors — label them).

### Task 3 — Backend unit tests
**What:** Run the Jest suite.
**Why:** Memory says ~57 unit tests existed for the lifecycle pipeline. Confirm they still pass and count them.
**How (from `backend/`):** `npm test` (it runs `jest --runInBand`).
**Done when:** You record total/passed/failed/skipped counts and the names of any failing tests with their failure messages.

### Task 4 — Backend E2E dry-run (no live VFS)
**What:** Run the **dry** e2e harness, which is designed not to hit the real site.
**Why:** Exercises the orchestration wiring end-to-end without risk.
**How (from `backend/`):** `npm run test:e2e:dry`.
- **Before running**, open `scripts/e2e-tests/run-all.ts` and confirm `--dry` truly avoids live VFS/DB writes. If `--dry` still requires a live `DATABASE_URL` or hits VFS, **do NOT run it** — record as "BLOCKED: dry mode still requires <X>" and explain what you found in the file.
**Done when:** Either the dry suite result is recorded, or it's documented as blocked with the reason from the source.

### Task 5 — Worker in SIMULATE mode (no VFS, no DB writes to prod ideally)
**What:** Understand the orchestrator worker's control flow and, if safely possible, run it in SIMULATE.
**Why:** `launch-worker.ps1` has `WORKER_SIMULATE='1'` → sets `SIMULATE=1`, which the worker uses to avoid real VFS hits. This is the safe way to see the worker's loop work.
**How:**
- First **read** `backend/scripts/orchestrator-worker.ts` fully and summarize its loop: how it polls the backend, what `SIMULATE` changes, what it needs to start (does SIMULATE still require `DATABASE_URL` / `WORKER_TOKEN`?).
- If SIMULATE needs only env you can safely set to dummy values **without touching prod**, attempt a short run: `$env:WORKER_SIMULATE='1'; .\launch-worker.ps1` — but **kill it after ~30–60s** (it's a daemon with a keep-alive loop; it will not exit on its own). Capture the startup log and the first cycle.
- If SIMULATE requires a real `DATABASE_URL` (the public Railway DB) or `WORKER_TOKEN` you don't have, **DO NOT run it** — record "BLOCKED: SIMULATE still needs live <X>" and explain. Do not point it at prod.
**Done when:** Either you have the worker's first simulated cycle logged, or a precise statement of what blocks a safe local run.

### Task 6 — Python pipeline static check (NO live run)
**What:** Validate `nodriver-spike/auto_pipeline.py` and `register_spike.py` parse and import cleanly, and map their flow — WITHOUT launching a browser or hitting VFS.
**Why:** These drive the real booking. We want to know they're syntactically sound and understand the current booking-step logic (especially the "Continue click no-op" fix area and the Submit/Step-5 path) without running them live.
**How:**
- Syntax/compile check only: `python -m py_compile nodriver-spike/auto_pipeline.py nodriver-spike/register_spike.py`. Record pass/fail.
- **Read** `auto_pipeline.py` and document, with line numbers: (a) the booking step functions (Step 1→5), (b) where/if `mailsac_otp_code()` is called in the booking loop (memory says it's defined but NOT wired — confirm true/false with line evidence), (c) the Submit/Confirm logic for Step 5 and whether it's guarded by `BOOK_DRY_RUN`.
- **Do NOT execute** the pipeline (no `python nodriver-spike/auto_pipeline.py`). It would open a browser and hit VFS.
**Done when:** Compile result recorded + a precise written map of the booking flow with line refs, including a definitive yes/no on "is OTP wired into the booking loop" and "is Step 5 Submit reachable / dry-run-guarded".

### Task 7 — Frontend static health
**What:** Type-check / build the Next.js dashboard.
**Why:** Confirm the operator-facing dashboard still compiles after recent changes.
**How (from the frontend dir):**
- `npm install` if `node_modules` missing.
- Run its type-check/build script (inspect its `package.json` scripts — likely `npm run build` or `npm run lint`/`tsc --noEmit`). Use whatever script exists; record which one you ran.
**Done when:** Frontend build/type-check result recorded with any errors.

### Task 8 — Repo hygiene inventory (inventory only, NO deletion)
**What:** Catalog the junk untracked files so the operator can plan a cleanup PR later.
**Why:** `git status` shows many accidental shell-redirect artifact files (e.g. `backend/({`, files literally named `console.log(...)`, root `200`, `400)`, `15-30s`). They pollute the tree.
**How:** `git status --porcelain` → group the untracked entries into: (a) obvious junk/artifacts, (b) legit new files (scripts, docs, deployment PNGs), (c) genuinely uncertain. **Do not delete or git-add anything.**
**Done when:** Report has 3 lists: junk candidates, legit-looking new files, uncertain — with a one-line note each. Explicitly state you deleted nothing.

---

## 3. Required output: `DIAGNOSTIC_REPORT.md`

Create `DIAGNOSTIC_REPORT.md` at the repo root. Structure:

```markdown
# VFS Booking Bot — Diagnostic Report (<date>)

## TL;DR
3–6 bullets: the headline state. What's green, what's red, the single biggest blocker.

## Status Matrix
| Component | Check | Result | Evidence (cmd + key output) |
|---|---|---|---|
| Toolchain | node/npm/python/nodriver | PASS/FAIL | ... |
| Backend | type-check (npm run build) | ... | ... |
| Backend | lint | ... | ... |
| Backend | unit tests (npm test) | ... | X/Y passed | ... |
| Backend | e2e dry | ... | ... |
| Worker | SIMULATE run | ... | ... |
| Python pipeline | py_compile | ... | ... |
| Python pipeline | OTP wired into booking loop? | YES/NO | file:line |
| Python pipeline | Step 5 Submit reachable / dry-guarded? | ... | file:line |
| Frontend | build/type-check | ... | ... |

## Detailed Findings
Per task: what you ran, what happened, verbatim errors for anything that failed.

## Bugs / Breakage Found (NOT fixed)
Numbered list. For each: symptom, file:line if known, severity (Critical/High/Med/Low), and what it blocks. (You did NOT fix these — that's intentional.)

## Repo Hygiene
The 3 lists from Task 8.

## Blocked Checks
Anything you couldn't run and exactly why (missing secret, needs live VFS, etc.).

## Recommended Next Actions (ranked)
Ordered by impact. These are *recommendations for the operator + orchestrator to QA together*, not things you did.
```

**Evidence rule:** every PASS/FAIL must cite the command and a snippet of its real output. No claim without evidence. If you didn't run it, it's BLOCKED, not PASS.

---

## 4. Final step

After writing `DIAGNOSTIC_REPORT.md`, post a short summary in chat: the status matrix TL;DR + the top 3 recommended actions. Then **stop** — do not start fixing anything. The operator and orchestrator will QA the report and decide the next plan together.
