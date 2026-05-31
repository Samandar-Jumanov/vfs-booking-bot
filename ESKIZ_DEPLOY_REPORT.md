# Eskiz / UZ-VPS Deploy Kit Report (2026-05-31)

## TL;DR

The deployment kit for a **Windows VPS in Tashkent** is ready, plus **block-alert
hardening** so the first live booking is never silent. The operator provisions the
VPS and follows **`ops/DEPLOY_VPS.md`** — whose **Step 1 (VFS reachability /
Datadome go/no-go) gates everything**. I could not run anything on the VPS (it
doesn't exist yet); everything was authored and verified locally.

> **The reachability test is the go/no-go and must be run FIRST on the VPS** —
> a NO-GO means the box is Datadome-blocked and the operator stops before wasting
> an hour on setup (fallback: non-UZ VPS + UZ residential proxy).

---

## What I produced

| File | Summary |
|---|---|
| `ops/DEPLOY_VPS.md` | Full operator runbook: provision → RDP → **Step 1 reachability go/no-go** → `setup-vps.ps1` → `.env.worker` keys → load extension/confirm Online → `install-autostart` → validate the one-click chain → troubleshooting table → **RDP keep-alive** (disconnect vs sign-out). |
| `ops/setup-vps.ps1` | Idempotent installer: winget Node LTS / Python 3.12 / Chrome / Git (check-first), clone-or-`git pull`, `backend npm install`, extension build, `pip install nodriver`, version verify, next-steps. No secrets. |
| `ops/check-vfs-direct.js` | **Direct (no-proxy)** reachability checker for the UZ VPS — prints GO / UNCLEAR / NO-GO from status + body + Location header; exits non-zero on a clear NO-GO. (The existing `verify-vfs-reachable.js` is proxy-only; documented as such.) |
| `nodriver-spike/auto_pipeline.py` | Block-alert hardening: `telegram_photo()`, `classify_block()`, specific reason codes, captioned-photo sends on every booking-terminal outcome. |
| `backend/src/modules/pipeline/pipeline.router.ts` | Maps the specific reason codes to clear coded Telegram alerts on the `failed` step (keeps `dispatchNotification`). |

---

## The go/no-go test (run FIRST on the VPS)

**Authoritative — real Chrome:** on the VPS, open Chrome → visit
`https://visa.vfsglobal.com/uzb/en/lva/login`.
- **GO** = the login form renders.
- **NO-GO** = redirect to `/page-not-found` or an access-denied / Cloudflare /
  Datadome block page.

**Secondary — scripted signal:** `node ops\check-vfs-direct.js` → GO / UNCLEAR /
NO-GO. A plain GET can be fooled (Datadome usually only challenges a real
browser), so the runbook tells the operator to **trust the real-Chrome result**.

**NO-GO fallback (named, not built here):** non-UZ VPS (Contabo) **+** a UZ
residential/mobile proxy (Oxylabs UZ / SOAX UZ) routing only VFS traffic, using
the `launch-bot-chrome.ps1` proxy-bypass pattern. Escalate before taking that path.

> Note on the existing script: `backend/scripts/verify-vfs-reachable.js` builds an
> `HttpsProxyAgent` from `PROXY_*` env — it tests the **proxy** exit, not a direct
> IP. On a native-UZ VPS we go **direct** (`VFS_USE_PROXY` unset), so the kit adds
> `ops/check-vfs-direct.js` for the direct case and keeps the proxy script for the
> fallback path.

---

## Block-alert hardening

**Reason codes** (from `classify_block(url, body)`, most-specific first):
`rate_limit_429202` · `rate_limit_429001` · `session_expired` · `datadome_block`
(page-not-found / access-denied) · `turnstile_wall` · `otp_timeout` ·
`payment_wall` · `submit_uncertain`.

**Where they're emitted** (`auto_pipeline.py`):
- **Login failure** → captures `url`+`body`, classifies, screenshots
  `pipe_login_failed`, milestone `failed` with the code, **photo** to Telegram.
- **OTP timeout** → milestone `otp_timeout` + **photo** of `book_3b_after_otp`.
- **Submit blocked** → `book()` now returns `("failed", <reason_code>)` from
  `classify_block(...)` instead of generic text; main() sends the
  `pipe_submit_uncertain` **photo** captioned with the code.
- **Confirmed / payment_wall** → also send their screenshots
  (`pipe_confirmed` / `pipe_payment_wall`) as captioned photos.

**`telegram_photo(path, caption)`** — POSTs `sendPhoto` (manual multipart via
`urllib`) using `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`. It is **not** gated by
`WORKER_BRIDGED` (block alerts must reach the operator even in bridged mode;
photos bypass the milestone bridge since the file is local on the VPS). Guards:
missing env → log + skip; missing file → text fallback; any error → text
fallback; never crashes the run. **The text milestone is kept** — the photo is an
addition, so the dashboard/pipeline log still records every outcome.

**Backend (`pipeline.router.ts`)** — the `failed` step now looks up a
`REASON_LABELS` map and sends a clear coded message (e.g. *"⛔ Rate limited
(429202 — IP/session). Cool down ~2h…"*) in addition to the existing
`BOOKING_FAILED` dispatch. Unknown codes fall through to the raw reason.

---

## Verification

```
backend: npm run build          → exit 0 (tsc + tsc-alias, no errors)
backend: npm test               → Test Suites: 22 passed, 22 total
                                   Tests:       166 passed, 166 total
python:  py_compile auto_pipeline.py register_spike.py  → OK
node:    node --check ops/check-vfs-direct.js           → OK
powershell AST parse:
  ops\setup-vps.ps1            PARSE-OK
  ops\install-autostart.ps1    PARSE-OK
  ops\uninstall-autostart.ps1  PARSE-OK
  launch-worker.ps1            PARSE-OK
  launch-bot-chrome.ps1        PARSE-OK
referenced paths exist: launch-bot-chrome.ps1, launch-worker.ps1,
  ops/install-autostart.ps1, ops/uninstall-autostart.ps1, ops/CLIENT_OPERATION.md,
  ops/setup-vps.ps1, ops/check-vfs-direct.js, ops/DEPLOY_VPS.md,
  backend/scripts/verify-vfs-reachable.js, extension/dist/manifest.json  → all OK
```

Python deps confirmed: the spikes import only stdlib + third-party **`nodriver`**
(tested 0.50.3) — so `pip install nodriver` is the complete Python dep, matching
`setup-vps.ps1`. winget IDs used: `OpenJS.NodeJS.LTS`, `Python.Python.3.12`,
`Google.Chrome`, `Git.Git`.

---

## Honest unknowns

- **Datadome on the UZ VPS** — only the live Step-1 test on the actual box
  settles whether the datacenter IP is flagged. Everything downstream is gated on
  it.
- **Windows license cost** — provider-dependent; confirm at provisioning.
- **RDP keep-alive** — if the provider hard-logs-off idle sessions, the engine
  stops; the runbook's mitigations (auto-logon + AtLogon keep-alive + disconnect-
  not-sign-out) cover the common cases but the provider's idle policy is the
  variable.
- **`telegram_photo` multipart** — hand-rolled with `urllib`; verified by
  `py_compile` and code review, but the actual Telegram `sendPhoto` round-trip is
  proven only on the first live alert (guards ensure a failure degrades to text,
  never a crash).

---

## What's staged (not committed)

Modified:
- `nodriver-spike/auto_pipeline.py` — `telegram_photo` / `_telegram_text_raw` /
  `shot_path` / `classify_block`; reason-coded login + submit failures; captioned
  photos on every booking-terminal outcome + OTP timeout.
- `backend/src/modules/pipeline/pipeline.router.ts` — reason-code → coded Telegram
  label map on the `failed` step.

New:
- `ops/DEPLOY_VPS.md`, `ops/setup-vps.ps1`, `ops/check-vfs-direct.js`
- `ESKIZ_DEPLOY_REPORT.md` (this file)

Nothing committed or pushed. (Note: the runbook is named `ops/DEPLOY_VPS.md` per
the plan headline + the task instruction — the plan's Task-3 heading said
`DEPLOY_ESKIZ.md`; I used the provider-neutral `DEPLOY_VPS.md` the headline
specifies.)
