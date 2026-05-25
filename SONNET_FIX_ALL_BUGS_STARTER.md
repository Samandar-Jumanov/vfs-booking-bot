# VFS Booking Bot — Fix All Open Bugs (Executor Brief)

You are Sonnet 4.6 working in the `vfs-booking-bot-main` repo. Fix the four bugs below. Each task is **not done** until it is **fixed, tested, and reported**. Work the tasks in the order given (Task 0 first — it unblocks clean diffs). Make surgical changes only; match existing code style.

---

## Ground rules (read before touching anything)

- **Package manager is `npm`**, not pnpm. Ignore any stray `pnpm-lock.yaml` / `pnpm-workspace.yaml` — do not use them.
- **Architecture is the Chrome MV3 extension + Node/TS backend.** The extension drives VFS via `chrome.debugger` (trusted clicks). The Playwright `browser.factory.ts` path described in the "Demo Preparation" section of `CLAUDE.md` is **superseded** — do not work there.
- **Never use `page.goto()` against VFS.** It triggers Datadome `403201` + a ~1h ban. All VFS navigation must be SPA UI clicks after the operator/bot is already on the dashboard.
- **Proxy is OPTIONAL.** Operator is on a clean UZ residential IP. Do not re-enable proxy. If you ever see "Session Expired", suspect VPN/proxy IP poisoning, not VFS.
- **Leave these env flags OFF**: `LOGIN_CRON_ENABLED` (causes VFS 429001) and `NOTIFY_BOOKING_FAILURES` (spams operator). Do not flip them.
- **Known-good facts** (do not re-derive):
  - Login email field = `#email` / `fc=username` (NOT `emailid`).
  - Turnstile sitekey = `0x4AAAAAABhlz7Ei4byodYjs`.
  - Turnstile success callback lives in the page **MAIN world**; the extension's **isolated** content script cannot fire it.
  - Diagnostic/trigger scripts live in `backend/scripts/` and run via:
    `railway run --service backend npx tsx scripts/<name>.ts`
- **OneDrive locks `.git`** intermittently. Write **code only** — do **not** run `git commit`/`git push`. The orchestrator commits.
- For every task: locate the real files with grep first (paths below are starting points, confirm before editing).

---

## Task 0 — Clean up stray junk files (do this first)

**Problem:** Many untracked files were created by accidental shell-redirect mistakes (filenames like `'')`, `({tag`, `backend/{`, `0`, `0)`, `400)`, `e.offsetParent`, `clicked`, `console.log('`, etc.). They bury real changes and pollute diffs.

**Fix:**
1. Run `git status --porcelain` and identify untracked entries that are **clearly not real source** — filenames that are code fragments / punctuation / shell artifacts rather than valid module names.
2. **Do NOT delete** legitimate new files: `*.md` docs, `backend/scripts/*.js|*.ts`, `deployments/*.png`, `passports/`, real config (`.eslintrc.json`, `pnpm-*` can be deleted since we use npm — confirm npm is the lockfile in use).
3. Delete only the garbage fragment-files. List each deletion.

**Test:** `git status` shows a clean, readable untracked list — only real artifacts remain. No real source or docs were removed (verify by re-listing what you kept).

**Report:** Table of every file deleted vs. every questionable file kept (with the reason).

---

## Task 1 — Auto-login Turnstile wall (highest impact)

**Problem:** VFS Sign-In / Register button stays **disabled until Cloudflare Turnstile passes**. The extension fills the form and obtains a Turnstile token, but the success callback is registered in the page **MAIN world**, and the isolated content script can't invoke it — so the button never enables (`tokenOk:false`).

**Where to look:** `extension/` content scripts handling login fill/submit. Grep for: `Sign In`, `#email`, `fc=username`, `Turnstile`, `cf-turnstile`, `data-sitekey`, `tokenOk`, `world`, `MAIN`, `executeScript`, `lift-auth-sniffer`, `2captcha`, `0x4AAAAAABhlz7Ei4byodYjs`. Also `extension/manifest.json` `content_scripts` / `world` declarations.

**Fix direction (MAIN-world token inject):**
1. After obtaining the Turnstile token (2Captcha or rendered widget), inject it into the page MAIN world so the page's own Turnstile callback fires and the button enables. Options, in order of preference:
   - A MAIN-world content script (`"world": "MAIN"` in manifest, or `chrome.scripting.executeScript({world:'MAIN'})`) that sets the token into the `cf-turnstile-response` input/textarea **and** invokes the page's registered success callback.
   - If the callback handle isn't reachable, dispatch the input + the events the page listens for (`input`, `change`) on the Turnstile response field, then let the existing form-validation re-evaluate.
2. Confirm the existing `chrome.debugger` trusted-click path is used for the actual Sign-In click (button must be enabled first).
3. Keep `VFS_FRESH_PROFILE=true` support intact (flagged-profile mitigation) — do not regress profile rotation.

**Test:**
- Launch via `launch-bot-chrome.ps1` with `VFS_FRESH_PROFILE=true`.
- Run `backend/scripts/trigger-auto-login.ts` against the active test account (`jumanovsamnandar84@gmail.com`; password in `backend/.env`).
- Capture: does the Sign-In button **enable** (`tokenOk:true`), does the click submit, does it reach the dashboard? Screenshot the post-login state.
- If Turnstile still gates manually on the test profile, note that and verify the MAIN-world inject works on a **fresh** profile.

**Report:** Pass/fail of button-enable + login. Console log excerpt showing `tokenOk` flip to true. The exact MAIN-world injection mechanism used. Any residual manual-assist still required.

---

## Task 2 — Booking Steps 2–5 automation (`runBookingSteps`)

**Problem:** Step 1 (Appointment Details: centre → visa category → sub-category) is automated via `selectMatOptionByIndex` reading each select's `aria-owns` panel. Steps 2–5 were proven **manually** on 2026-05-25 and selectors captured, but the click automation is **not built**.

**Where to look:** Grep `extension/` for `runBookingSteps`, `selectMatOptionByIndex`, `aria-owns`, `mat-option`, `mat-select`, `Appointment Details`, `applicant`, `review`, `confirm`, `slot`, `calendar`, `time slot`. Check repo markdown/notes for captured Step 2–5 selectors (the booking was documented when proven).

**Fix direction:**
1. Extend the booking orchestration to cover Steps 2–5 using the **same trusted-click + `selectMatOptionByIndex` pattern** as Step 1. Re-use `aria-owns` panel reading for any mat-selects.
2. For each step, wait for async option/element load (Step 1 already retries sub-category — mirror that resilience).
3. Stop **before final irreversible submit** behind the existing manual-override pause window if one exists; if not, add a configurable pause before the final confirm so a real submit is operator-gated for now.
4. Wire it so `backend/scripts/trigger-booking.ts` drives the full Step 1→5 sequence.

**Test:**
- Use the test account + a VFS test passport profile.
- Run `trigger-booking` and walk all five steps. Screenshot each step's completed state.
- If no live slot exists, implement/confirm a **dry-run** that advances as far as the data allows and screenshots the furthest reachable screen — do not fabricate a success.

**Report:** Which steps now automate cleanly, which need a live slot to validate, the selector strategy per step, and where the final-submit pause sits. Attach the per-step screenshots' paths.

---

## Task 3 — Auto-logout

**Problem:** Activation/register submits OK and Mailsac email-link activation works, but **auto-logout is broken** — operator logs out manually. A likely cause is logout attempting a blocked navigation instead of an SPA click.

**Where to look:** Grep for `logout`, `logOut`, `sign out`, `Sign Out`, `signout`, `logoutUrl`; and the activation flow `Mailsac`, `activation`, `activate`. Check whether logout uses `page.goto`/navigation (Datadome-blocked) vs. clicking the in-page menu.

**Fix direction:**
1. Implement logout as a **SPA UI click** (open the account/avatar menu → click Sign Out) via the existing trusted-click mechanism. **No `page.goto`.**
2. Confirm session/cookie state is cleared appropriately after logout so the next account can log in on the same profile (or rotate profile per existing flow).

**Test:**
- After a successful login (Task 1) or a `trigger-recover` activation, invoke the logout path.
- Verify the UI returns to the logged-out/login state. Screenshot before/after.

**Report:** Root cause of the previous logout failure, the click sequence used, and confirmation the session ends cleanly.

---

## Final consolidated report (required)

Produce `FIX_ALL_BUGS_REPORT.md` at repo root containing:
- One section per task: **status** (✅ fixed & verified / ⚠️ partial / ❌ blocked), files changed, what the test showed, screenshot paths.
- A "Still blocked / needs operator" list (e.g. anything gated on a live slot or a flagged profile).
- Exact commands used to test each task, so they're reproducible.

Do **not** mark a task done on type-check/build success alone — every UI-facing change needs a real browser run against VFS (or a documented reason it couldn't be run).
