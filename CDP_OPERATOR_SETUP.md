# Operator Chrome setup for CDP-attach mode

## One-time setup

1. Close ALL Chrome windows (use Task Manager -> kill all chrome.exe to be sure).
2. Open PowerShell and run:
   ```
   & "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="C:\vfs-bot-chrome-profile"
   ```
3. In that Chrome window:
   - Open one tab per customer VFS account
   - Log into each
   - Rename each tab to include the customer's email (right-click tab -> no, browser doesn't allow rename; instead include the email in the page title - VFS may set this automatically after login, or use a Chrome extension like "Tab Rename")
4. Leave Chrome running.

## Backend setup

In `backend/.env`:
```
CDP_ENDPOINT=http://localhost:9222
```

Restart the backend. It will log:
```
[browser.factory] Attaching to operator Chrome at http://localhost:9222
```

## Per-customer monitor

When you start a monitor for `profileId=X destination=lva`, the bot enumerates tabs and finds the one with that customer's email in the page title. If not found, the monitor fails with a clear error and you open the missing tab.

## Daily ops

- Cookies expire every 8h. When you see Telegram `Cookies expiring` alert, refresh the corresponding tab in Chrome and re-login.
- Do NOT close Chrome. If you do, all monitors fail and you must re-login to every tab.
- If Chrome crashes, restart it with the same command above. Tabs persist via `--user-data-dir`.

## OTP relay for registration dry-runs

Until the dashboard textbox is built, paste an SMS OTP into Redis through the API:

```
curl -X POST http://localhost:3001/api/profiles/<profileId>/submit-otp ^
  -H "Authorization: Bearer <accessToken>" ^
  -H "Content-Type: application/json" ^
  -d "{\"otp\":\"123456\"}"
```

TODO: add a small OTP textbox on `/profiles` that calls `POST /api/profiles/:id/submit-otp`.
