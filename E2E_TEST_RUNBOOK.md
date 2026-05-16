# End-to-End Test Runbook — Account Pool Architecture

D5 deliverable: prove the chain green from cookie-sync → booking dispatch → screenshot → Telegram alert.

## One-time setup (~5 min, operator)

1. **Build is green**
   ```powershell
   cd backend && npm run build      # → exit 0
   cd extension && npm run build    # → "Extension bundle ready at ...\extension\dist"
   ```

2. **Load extension into Chrome**
   - Open `chrome://extensions`
   - Toggle "Developer mode" (top-right)
   - Click "Load unpacked"
   - Select `C:\Users\saman\OneDrive\Documents\vfs-booking-bot-main\extension\dist`
   - Extension "VFS Booking Bot" appears

3. **Configure extension**
   - Click the extension icon → Options
   - Backend URL: `http://localhost:4001`
   - Customer email: `<your operator email>`
   - Click "Generate setup code" on the dashboard's `/extension-setup` page, paste code into options
   - Status should flip to "Connected"

4. **Set EXTENSION_BOOKING=true in backend/.env**
   ```
   EXTENSION_BOOKING=true
   ```
   Restart backend.

5. **Set OPERATOR_USER_ID in backend/.env**
   ```
   OPERATOR_USER_ID=<your admin user id from prisma>
   ```
   If unset, backend falls back to first ADMIN user.

## Per-shift warmup (~2 min, operator)

1. Visit `http://localhost:3000/account-pool`
2. If pool is empty, add accounts:
   - POST `/api/accounts` with `{email, password}` per pool account
   - OR use the existing accounts dashboard
3. Click **"Open N stale login tabs"** — opens VFS login in N tabs (one per account)
4. Manually log into each tab (Datadome treats this as human; the extension content script syncs cookies + email + URL via `EXT_SESSION_SYNC` every 60s)
5. Refresh `/account-pool` page — each account flips to "fresh" green pill
6. Pool is ready

## E2E test (~30 sec)

1. Create 1 customer profile (passport-only, no VFS login):
   ```
   POST /api/profiles
   {
     "fullName": "Test Customer",
     "passportNumber": "AA1234567",
     "dob": "1990-01-15",
     "passportExpiry": "2030-12-31",
     "nationality": "UZ",
     "email": "test.customer@example.com",
     "phone": "+998901234567",
     "gender": "MALE"
   }
   ```

2. Trigger a booking:
   ```
   npx tsx backend/scripts/enqueue-test-booking.ts <profileId> lva LNGWORK
   ```

3. Watch backend logs. Expected sequence:
   ```
   [Booking] Job enqueued for <profileId>
   [Booking] EXTENSION_BOOKING=true → bookViaExtension
   [accountPool] Picked account <email> (LRU active)
   [WS] Sent BOOK_FOR_CUSTOMER to operator
   [Extension] Found tab for <email> → drove FILL_FORM → SUBMIT_BOOKING
   [Extension] EXT_BOOKING_COMPLETED correlationId=<uuid> confirmationNumber=<XX>
   [Booking] Status: SUCCESS confirmationNo=<XX>
   [Telegram] Alert sent
   ```

4. Verify:
   - Prisma `Booking` row has `status=SUCCESS` and `confirmationNo`
   - Telegram chat receives `🟢 Booking SUCCESS — <confirmationNo>`
   - Screenshot saved in `backend/recordings/booking_<id>_review_*.png`

## Failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| `NO_ACTIVE_ACCOUNTS_IN_POOL` | Pool is empty | Add accounts via POST /api/accounts |
| `ACCOUNT_STALE` | lastWarmedAt > 12h | Re-warm via /account-pool page |
| `OPERATOR_NOT_CONNECTED` | Extension not running / disconnected | Reload extension, regenerate setup code |
| `EXTENSION_TIMEOUT` | Tab missing for account / Datadome blocked the click | Verify tab exists in operator Chrome with that email |
| 403 on submit | Account flagged by Datadome | Account marked COOLDOWN 24h automatically |

## Architectural notes

- **Datadome bypass = none required.** Bookings execute inside the operator's real Chrome that has a real datadome cookie. No proxy, no stealth, no fingerprint patches.
- **Customer never logs in.** Customer's `Profile` row holds passport details only. Bot picks a pool account at booking time.
- **Cookie freshness = 12h.** Operator re-warms once per shift; extension auto-syncs cookies every 60s while tabs are open.
- **Account rotation = LRU.** `accountPoolService.getAvailableAccount()` returns least-recently-used ACTIVE account atomically (FOR UPDATE SKIP LOCKED).
- **Account cooldown = 24h on 403.** Account flagged automatically by `bookViaExtension` if Datadome returns 403; reset to ACTIVE after cooldown.
