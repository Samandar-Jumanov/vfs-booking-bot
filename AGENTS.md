# AGENTS.md

This repo is an operational VFS Global automation system. Read this file first, then `CLAUDE.md` for deeper historical context.

## Current State

- Actual target is UZ -> Latvia D-visa, using a Node/TypeScript backend, Next.js dashboard, Prisma/Postgres, Redis, Railway deploys, and a visible Chrome/nodriver worker on Windows VPSs.
- Railway backend/frontend are production surfaces. VPS workers do not auto-update from Railway deploys; each VPS needs `git pull`, install/build if needed, and worker restart.
- The account pool CSV export is already pushed to `origin/main` in commit `470587b` (`Add account pool CSV export`). It adds `GET /api/accounts/export-csv` and a dashboard **Download CSV** button on `/account-pool`.
- CSV export includes decrypted account passwords. Keep it protected behind auth/admin access and do not paste exported data into repo files.

## Current Bugs / Issues

- VFS/Datadome throttles account creation per IP/session. Symptoms include `form_not_rendered`, `/page-not-found`, "Register never enabled", no register form fields, or no `register/user` POST. This usually means the VPS IP/session needs cooldown, not that installs are broken.
- Large creation batches are unsafe. Use a one-account gate test on each VPS, then `REGISTER_COUNT=10` with `REGISTER_STAGGER_SEC=120`; do not exceed 15 per run unless the operator explicitly accepts the throttle risk.
- PENDING accounts are mixed quality. Some can be activated by opening Mailsac activation links or triggering resend. Some are not registered on VFS at all and must not be marked ACTIVE.
- Do not mark a DB account ACTIVE unless activation/login was confirmed on VFS.
- Local `reconcile-pending.ts` can query DB/Mailsac but cannot reliably use the production Chrome extension socket. For extension-backed recovery, use the deployed backend while the extension is connected, or activate manually.
- Generated activation reports under `ops/pending-activation-accounts.*` contain passwords and inbox links. Treat them as sensitive local artifacts; do not commit or push them.
- Multi-box coordination is still mostly manual via `BOX_ID`, `TARGET_EMAIL`, and `TARGET_EMAILS`. Avoid double-driving the same account from multiple VPSs.
- Visible Chrome automation is fragile across RDP disconnects. Prefer VMmanager VNC or the always-on console setup for long worker runs.

## Session Changes To Preserve

- Added pending activation tooling:
  - `backend/scripts/export-pending-activation-report.ts`
  - `backend/scripts/mark-activation-report-active.ts`
  - `backend/scripts/bulk-trigger-recover.ts`
- Updated pending reconciliation logic to support configured domains instead of only `mailsac.com`.
- Manually confirmed and marked several activation-report rows ACTIVE during the session. Last observed pool snapshot was `ACTIVE=108`, `PENDING=7`, `BLOCKED=1`; query production DB before relying on this.
- Some files from this session are intentionally local/uncommitted. Do not clean or revert unrelated dirty files unless the user explicitly asks.

## Operational Rules

- On Windows PowerShell, prefer `npm.cmd` and `npx.cmd` when script execution policy blocks shims.
- Before mass account creation on a VPS, verify env is loaded: `DATABASE_URL`, `REDIS_URL`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `PROFILE_ENCRYPTION_KEY`, `MAILSAC_API_KEY`, `BOX_ID`, and `BOX_COUNT`.
- Do not write VPS passwords, DB URLs, JWT secrets, Mailsac keys, Telegram tokens, or account passwords into committed docs. Credentials belong in `.env.worker`, the user's provider emails, or the operator's password manager.
- If a VPS hits VFS throttling, stop that run and cool down for 1-2 hours. Repeated immediate retries make the box worse.
- If updating docs only, no build/test is required. If changing backend/frontend code, run the relevant build before reporting done.

## Useful Commands

```powershell
npm.cmd run build --workspace=backend
Set-Location .\frontend
npm.cmd run build
```

```powershell
Set-Location .\backend
npx.cmd tsx scripts/export-pending-activation-report.ts
npx.cmd tsx scripts/mark-activation-report-active.ts
```
