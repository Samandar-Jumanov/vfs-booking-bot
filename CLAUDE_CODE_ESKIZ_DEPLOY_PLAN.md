# Claude Code Plan — Eskiz Windows VPS Deployment Kit

> **Executor:** Claude Code (Sonnet 4.6)
> **Goal:** Produce a **deployment kit** (setup script + runbook + a Datadome go/no-go test) so the operator can stand the engine up on a **Windows VPS in Tashkent** (provider = Serverspace or any UZ/Tashkent host — the steps are provider-neutral) and validate it, with the **VFS-reachability/Datadome test gating everything** (don't invest in full setup if the box is blocked). The output runbook should be named `ops/DEPLOY_VPS.md` (not provider-specific).
> **Type:** Author scripts + runbook; verify locally as far as possible. No live VFS from here. No commit/push.

---

## 0. Context & honest constraints

The chosen host is **Eskiz VPS 4 (Windows Server, 8 GB / 4-core, Tashkent, native UZ IP)**. The whole Windows stack (PowerShell launchers, extension Chrome, `install-autostart.ps1`) runs there over RDP — no Linux port, no proxy.

**You (Claude Code) cannot run anything on the VPS** — it doesn't exist yet and you have no RDP. Your job is to **author the deployment kit and verify it locally** (PowerShell parses, referenced files/paths exist, dependency lists are correct). The **operator executes it on the box.** Be explicit in the runbook about every manual step.

**The #1 gate: Datadome reachability.** The single biggest unknown is whether VFS loads on Eskiz's IP (datacenter ASN risk). The runbook MUST make the operator run the **reachability test FIRST**, before full setup — so a blocked box is discovered in 5 minutes, not after an hour of install.

**HARD RULES:**
1. No live VFS from here. No `git commit`/`push`. No secrets hardcoded in any script — `.env.worker` is filled by the operator from existing values.
2. Keep `npm test` green (this is mostly new ops files; no app-logic change expected).
3. Don't create shell-redirect junk files.

---

## 1. What "done" looks like

- `ops/DEPLOY_ESKIZ.md` — a complete, non-expert-followable runbook from "just provisioned the VPS" → "engine running + validated", with the **reachability test as an explicit go/no-go gate**.
- `ops/setup-vps.ps1` — a one-shot installer the operator runs on the VPS (Node, Python, Chrome, git, repo clone, npm + python deps), idempotent, with clear echoes.
- The **reachability test** is documented and uses an existing script (`backend/scripts/verify-vfs-reachable.js`) and/or a manual Chrome check.
- **Block-alert hardening:** booking blocks emit a specific reason code AND send the screenshot to Telegram as a captioned photo.
- Scripts parse cleanly; referenced paths/deps are correct. `npm run build` + `npm test` still green; `py_compile` clean.
- `ESKIZ_DEPLOY_REPORT.md` written. Nothing committed.

---

## 2. Tasks (in order)

### Task 1 — The Datadome go/no-go test (gate everything on this)
**What to do:**
1. Review `backend/scripts/verify-vfs-reachable.js` (and `verify-proxy-exit.js`) — confirm what they check and how to run them. If `verify-vfs-reachable.js` already loads a VFS URL and reports blocked/ok, document its exact usage. If it needs the proxy off (direct), note that (on the UZ VPS we go DIRECT, no proxy — `VFS_USE_PROXY` unset).
2. In the runbook, make Step 1 (right after RDP) a **5-minute reachability check**:
   - Open **real Chrome** on the VPS → visit `https://visa.vfsglobal.com/uzb/en/lva/login` → does the **login form render** (good) or does it redirect to **/page-not-found** or show a Datadome/Cloudflare block (bad)?
   - AND/OR run `node backend/scripts/verify-vfs-reachable.js` and record the result.
   - **GO** (form renders) → continue to full setup. **NO-GO** (blocked) → STOP, the UZ-VPS path failed for Datadome; fall back to Contabo + Oxylabs/SOAX UZ proxy (note this branch, don't build it here).
**Done when:** the runbook's Step 1 is an unambiguous go/no-go with both the manual and scripted check, and the no-go fallback is named.

### Task 2 — One-shot VPS setup script `ops/setup-vps.ps1`
**What to do:** author an idempotent PowerShell script the operator runs on the Windows VPS that:
1. Installs prerequisites via `winget` (or documents choco fallback): **Node LTS, Python 3.12+, Google Chrome, Git**. Check-before-install so re-runs are safe.
2. Clones the repo (parameter for repo URL) to a known path, or `git pull` if present.
3. Installs deps: `cd backend; npm install` and the Python pipeline deps (`pip install nodriver` + whatever `nodriver-spike` needs — verify the import list in `auto_pipeline.py`/`register_spike.py`).
4. Verifies tool versions at the end (node/python/chrome/git) and prints next steps.
5. Does NOT write secrets — prints a reminder to create `backend\.env.worker` (Task 3 documents the keys).
**Done when:** the script parses, the winget IDs are correct (Node = `OpenJS.NodeJS.LTS`, Python = `Python.Python.3.12`, Chrome = `Google.Chrome`, Git = `Git.Git`), and the python dep list matches what the spikes import.

### Task 3 — The runbook `ops/DEPLOY_ESKIZ.md`
**What to do:** write the full operator runbook:
1. **Provision:** Eskiz VPS 4, **Windows Server**, Tashkent; get RDP host/user/password + the public IP. (Note: confirm Windows-license cost + use Payme/Click.)
2. **RDP in.**
3. **Step 1 = reachability go/no-go** (Task 1) — front and center.
4. **Run `ops/setup-vps.ps1`.**
5. **Create `backend\.env.worker`** with the required keys (list them: `WORKER_TOKEN`, `DATABASE_URL` (Railway public), `PROFILE_ENCRYPTION_KEY`, `MAILSAC_API_KEY`, `BACKEND_URL`) — copied from the operator's current machine / Railway. Mask/placeholder only; never real values in the doc.
6. **Load the extension + connect:** launch `launch-bot-chrome.ps1`, load the MV3 extension, confirm the dashboard Extension page shows **Online** (needed for activation).
7. **Install auto-start:** run `ops/install-autostart.ps1` so the engine runs on boot.
8. **Validate:** open the dashboard → **Engine 🟢** → click **Start** → watch the one-click chain (`Registered → Activated → Logged in → monitoring`) → leave it monitoring OCMA. First real slot validates the booking finish-line.
9. **Troubleshooting** table: blocked at reachability (→ proxy fallback), extension offline, 429 pacing, RDP session/keep-alive (so the box keeps running when you disconnect — note RDP disconnect vs logoff).
**Done when:** a non-expert could follow it start to finish; the go/no-go gate is unmissable.

### Task 3b — Block-alert hardening (never blind during a live booking)
**Why:** the first live booking is also our first real block-test. The operator must get a **clear, coded alert + the screenshot** the instant anything blocks — not silence.
**What to do (app code — `nodriver-spike/auto_pipeline.py` + `pipeline.router.ts`):**
1. **Classify every booking-terminal outcome with a clear reason code.** In `book()` / the booking loop, make sure each failure path emits a milestone whose `error`/`detail` names the cause: `rate_limit_429202`, `rate_limit_429001`, `session_expired`, `datadome_block` (page-not-found / access-denied), `turnstile_wall`, `otp_timeout`, `payment_wall`, or `submit_uncertain`. Detect these from the page (URL contains page-not-found/session-expired/error; body text for 429/access-denied/turnstile/payment keywords) right after the submit/continue steps. Reuse the existing outcome detection; just ensure the reason is specific, not generic "failed".
2. **Send the screenshot to Telegram as a PHOTO** on every booking-terminal outcome (confirmed / payment_wall / failed-with-reason). Add a `telegram_photo(path, caption)` helper in `auto_pipeline.py` that POSTs to Telegram `sendPhoto` using `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` (the worker already has these — ensure they're in the Python env via the spawn). Caption = the outcome + reason code (e.g. `❌ Booking blocked: datadome_block — shots/pipe_submit_uncertain.png`). The Python on the VPS has the screenshot file locally, so it can send it directly — this works even in bridged mode (photos bypass the milestone bridge).
3. **Keep the text milestone too** (so the dashboard/pipeline log still records it) — the photo is an addition, not a replacement.
4. Guard it: if `TELEGRAM_*` env is missing, log and continue (never crash the booking on a notify failure).
**Done when:** a booking block emits a specific reason code AND (when Telegram is configured) sends the matching screenshot as a photo with a captioned reason; `py_compile` clean; `npm run build`/`npm test` green.

### Task 4 — Verify locally
- `cd backend; npm run build` → exit 0; `npm test` → green (count).
- PowerShell parse-check the new scripts (e.g. `powershell -NoProfile -Command "$null = [ScriptBlock]::Create((Get-Content -Raw ops/setup-vps.ps1))"`), or at minimum a careful read for syntax.
- Confirm every path/file the runbook references exists (`launch-bot-chrome.ps1`, `launch-worker.ps1`, `ops/install-autostart.ps1`, `verify-vfs-reachable.js`).
**Done when:** all pasted as evidence.

---

## 3. Required output: `ESKIZ_DEPLOY_REPORT.md`

```markdown
# Eskiz Deploy Kit Report (<date>)

## TL;DR
The deployment kit is ready; operator provisions the VPS and follows ops/DEPLOY_ESKIZ.md. The reachability test gates everything.

## What I produced
ops/DEPLOY_ESKIZ.md, ops/setup-vps.ps1 — summary of each.

## The go/no-go test
Exactly what the operator runs first and how to read it; the no-go fallback.

## Block-alert hardening
The reason codes classified; how the screenshot photo gets to Telegram; the diffs.

## Verification
build / test / script parse / referenced-paths-exist.

## Honest unknowns
Datadome on Eskiz (only the live test settles it); Windows license cost; RDP keep-alive.

## What's staged (not committed)
```

---

## 4. Final step

Write `ESKIZ_DEPLOY_REPORT.md`, post the TL;DR + the one-line reminder that **the reachability test is the go/no-go and must be run first on the VPS**, then stop. Orchestrator verifies build/tests; operator provisions + runs the kit; we QA the reachability result together.
