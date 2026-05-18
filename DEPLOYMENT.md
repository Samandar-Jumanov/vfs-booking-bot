# Production Deployment Playbook

Total time: ~3 hours of focused operator work. Monthly cost: ~$15-25 + ~$15 one-time domain.

## Architecture (recap)

```
                           ┌──────────────────────┐
   Customer (passive)      │  yourbookingbot.com  │
   - Telegram alerts only  │   (Vercel dashboard) │
                           └──────────┬───────────┘
                                      │ HTTPS
                                      ▼
        ┌──────────────────────────────────────────────┐
        │  api.yourbookingbot.com (Railway / VPS)      │
        │  Express + BullMQ + Prisma + WS server       │
        └─────┬─────────────┬─────────────┬────────────┘
              │             │             │
        ┌─────▼─────┐ ┌─────▼─────┐ ┌─────▼──────────┐
        │  Postgres │ │   Redis   │ │  Telegram bot  │
        │   (Neon)  │ │ (Upstash) │ │  + 2Captcha    │
        └───────────┘ └───────────┘ │  + Vak-SMS     │
                                    └────────────────┘
                                      ▲
                                      │ WS (BG_REGISTER_*, BOOK_FOR_CUSTOMER)
                                      │
                  ┌───────────────────┴─────────────────┐
                  │  Windows VPS (Hetzner / Contabo)    │
                  │  Chrome + bot extension             │
                  │  - 50 VFS pool accounts logged in   │
                  │  - Operator RDPs once/day to warm   │
                  └─────────────────────────────────────┘
```

## Pre-flight: things you need before starting

- A credit card.
- ~3 hours of focused time.
- A domain (you'll buy in Step 2).
- Existing services already set up (you have these):
  - Telegram bot token + chat ID
  - 2Captcha API key with $5+ balance
  - VFS test account (`jumanovsamandar84@gmail.com`)

## Step 1 — GitHub repo (5 min)

1. Create a private GitHub repo `vfs-booking-bot`.
2. `cd C:\Users\saman\OneDrive\Documents\vfs-booking-bot-main`
3. `git remote add origin git@github.com:<you>/vfs-booking-bot.git`
4. `git push -u origin track-7-extension`
5. On GitHub, set `track-7-extension` as the default branch.

## Step 2 — Domain (10 min)

1. Buy `yourbookingbot.com` (or your chosen name) on **Namecheap** or **Porkbun**. ~$10-15/yr.
2. Sign up **Cloudflare** (free tier).
3. Add your domain to Cloudflare → grab the 2 nameservers it gives you.
4. Back on Namecheap → Domain → Nameservers → change to Cloudflare's. (Propagation: ~10 min)

## Step 3 — Postgres + Redis (10 min)

### Postgres (Neon, free tier)
1. neon.tech → sign up → create project `vfs-bot` (region: closest to Railway region you'll pick in step 4).
2. Copy the **Pooled connection string** (looks like `postgresql://...neon.tech/neondb?sslmode=require`).
3. Save it. You'll paste into Railway in step 4.

### Redis (Upstash, free tier)
1. upstash.com → sign up → create database `vfs-bot` (region: same as above).
2. Copy the **Redis URL with password** (`redis://default:PASS@HOST:6379`).

## Step 4 — Backend on Railway (20 min)

1. railway.app → sign up → "Deploy from GitHub" → connect → select your repo.
2. After Railway detects monorepo: settings → **Root Directory: `backend`**.
3. Add environment variables (Settings → Variables). Use `.env.production.example` as the source of truth — fill in:
   - `NODE_ENV=production`
   - `PORT=3001`
   - `DATABASE_URL=<Neon>` 
   - `REDIS_URL=<Upstash>`
   - `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `PROFILE_ENCRYPTION_KEY` — generate fresh: `openssl rand -hex 64` / 32
   - `TWOCAPTCHA_API_KEY` (existing)
   - `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` (existing)
   - `EXTENSION_BOOKING=true`
   - `FRONTEND_URL=https://app.yourbookingbot.com` (we'll set up next)
4. Deploy. Wait ~3 min. Railway gives you a `*.up.railway.app` URL.
5. Settings → Networking → **Custom Domain** → `api.yourbookingbot.com`. Railway shows you a `CNAME` to add in Cloudflare.
6. Cloudflare → DNS → add `CNAME api → <railway>.up.railway.app` (Proxy DNS only — orange cloud OFF — Railway terminates TLS itself).
7. Verify: `curl https://api.yourbookingbot.com/api/health` → `{"status":"ok"...}`

## Step 5 — Bootstrap admin user (5 min)

1. Open Railway → backend service → "Open shell".
2. `ADMIN_EMAIL=you@yourdomain.com ADMIN_PASSWORD='your-strong-pw' node dist/scripts/bootstrap-admin.js`
3. Copy the printed `Operator user.id` → set as `OPERATOR_USER_ID` in Railway env.
4. Railway redeploys (auto).

## Step 6 — Frontend on Vercel (15 min)

1. vercel.com → sign up → import GitHub repo.
2. Root Directory: `frontend`.
3. Env vars (Settings → Environment Variables):
   - `NEXT_PUBLIC_API_URL=https://api.yourbookingbot.com`
   - `NEXT_PUBLIC_WS_URL=https://api.yourbookingbot.com`
4. Deploy. Get `vercel.app` URL.
5. Settings → Domains → `app.yourbookingbot.com`. Vercel shows you the CNAME.
6. Cloudflare → DNS → add `CNAME app → cname.vercel-dns.com`.
7. Verify: visit `https://app.yourbookingbot.com` → login screen.
8. Log in with the admin you bootstrapped in step 5.

## Step 7 — Email forwarding (10 min)

Goal: emails to `*@yourbookingbot.com` get POSTed to `https://api.yourbookingbot.com/api/email/webhook`.

### Option A — Cloudflare Email Workers (free, recommended)
1. Cloudflare → Email Routing → enable.
2. Routes → "Catch-all" → action: **Send to Worker** → create worker.
3. Paste this worker code:
   ```js
   export default {
     async email(message, env, ctx) {
       const raw = await new Response(message.raw).text();
       await fetch('https://api.yourbookingbot.com/api/email/webhook', {
         method: 'POST',
         headers: {
           'Content-Type': 'application/json',
           'X-Webhook-Secret': env.WEBHOOK_SECRET,
         },
         body: JSON.stringify({
           to: message.to,
           from: message.from,
           subject: message.headers.get('subject'),
           body: raw,
         }),
       });
     }
   };
   ```
4. Worker → Settings → Variables → add `WEBHOOK_SECRET=<same as your backend EMAIL_WEBHOOK_SECRET>`.
5. Test: send any email to `test@yourbookingbot.com` → check Railway logs / `prisma.receivedEmail`.

### Option B — ImprovMX (free, simpler)
1. improvmx.com → add domain → follow 2-record DNS.
2. Forward `*@yourbookingbot.com` → your Gmail.
3. Then EITHER: poll Gmail via IMAP (more work) OR upgrade to ImprovMX paid ($9/mo) for webhook delivery.

### Set env on Railway
```
EMAIL_PROVIDER=custom
CUSTOM_EMAIL_DOMAIN=yourbookingbot.com
EMAIL_WEBHOOK_SECRET=<the random string from worker>
```

## Step 8 — Vak-SMS account (5 min)

1. vak-sms.com → sign up → deposit $10 USD (covers ~50 numbers).
2. Profile → API → copy key.
3. Railway env:
   ```
   SMS_PROVIDER=vaksms
   VAKSMS_API_KEY=<your key>
   VAKSMS_COUNTRY=uz
   ```

## Step 9 — Windows VPS for Chrome (45 min)

1. **Hetzner Cloud** → Project → "Add Server".
2. Image: **Microsoft Windows Server 2022 Standard** (€5/mo on CX22).
3. Location: closest to Tashkent (Helsinki / Falkenstein).
4. SSH key: skip (Windows uses password). Save the autogenerated admin password.
5. Wait ~2 min for provisioning.
6. RDP to the VPS IP using `Administrator` + the password from Hetzner.
7. Inside the VPS:
   - Install Chrome (download from google.com).
   - Install Git for Windows (so you can `git clone` for extension updates).
   - Clone repo: `git clone https://github.com/<you>/vfs-booking-bot.git`
   - Open `chrome://extensions` → developer mode → Load unpacked → select `vfs-booking-bot/extension/dist`.
   - Click extension icon → Options → Backend URL `https://api.yourbookingbot.com`.
   - On your laptop's browser: log into the dashboard → `/extension-setup` → "Generate setup code" → paste into VPS Chrome extension Options.
   - Extension shows "Connected".
8. Configure VPS to **auto-login** on boot (Settings → Accounts → "This user automatically signs in" — Windows Registry trick or use [Sysinternals AutoLogon](https://learn.microsoft.com/en-us/sysinternals/downloads/autologon)) so Chrome restarts after VPS reboots.
9. Set Chrome to auto-launch on startup: paste a `chrome.exe` shortcut into `shell:startup` folder.

## Step 10 — Seed the pool (15 min)

Two paths:

### Manual (first 5 accounts, faster than waiting for auto-register to work)
Inside the VPS Chrome:
1. Visit `https://visa.vfsglobal.com/uzb/en/lva/register`.
2. Create 5 accounts using gmail+aliases (`yourname+vfs01@gmail.com`, etc.) + your phone (you receive each OTP).
3. After each: `POST /api/accounts` with `{email, password}` via the dashboard or curl.
4. On VPS Chrome: open `/uzb/en/lva/login` in 5 tabs, log into each.
5. Visit dashboard `/account-pool` → all 5 should be "fresh".

### Automated (once you trust the auto-register flow)
```powershell
# From any machine that can reach the API:
$h = @{ Authorization = "Bearer $TOKEN"; "Content-Type" = "application/json" }
for ($i=0; $i -lt 50; $i++) {
  Invoke-RestMethod -Uri https://api.yourbookingbot.com/api/accounts/auto-create -Method POST -Headers $h -Body '{"source":"uzb","destination":"lva"}'
  Start-Sleep -Seconds 60   # space them out to avoid VFS rate limit
}
```
~50 min to seed 50 accounts, ~$10 in Vak-SMS credit.

## Step 11 — First customer + monitor (5 min)

1. Dashboard → Profiles → New Profile → fill passport, name, DOB, email, phone, **Telegram chat ID** (the customer's, not yours).
2. Dashboard → Monitors → Start → source: Uzbekistan, destination: Latvia, visaType: LNGWORK, intervalMs: 30000.
3. Wait. Bot polls every 30s. When VFS opens a slot → automatic booking → Telegram alerts both you and the customer.

## Step 12 — Monitoring (10 min)

1. **BetterStack** or **UptimeRobot** → free → add check:
   - URL: `https://api.yourbookingbot.com/api/health/full`
   - Interval: 5 min
   - Expected: status 200
2. Alerts → Telegram (use a separate bot or the same bot, different chat).
3. If any check ever fails: get pinged.

## Rollback / Disaster recovery

- **Railway:** Deployments → click an old deploy → "Rollback".
- **Vercel:** Deployments → click an old build → "Promote to production".
- **Postgres:** Neon → "Branches" → restore from a point-in-time.
- **Redis:** stateful, but BullMQ jobs are idempotent — losing Redis costs you ~30s of in-flight bookings.
- **Chrome extension:** keep the `dist/` directory backed up in git. Re-load on VPS if it crashes.

## Total monthly cost summary

| Item | $/mo |
|---|---|
| Railway Hobby (backend) | $5 |
| Vercel (frontend) | $0 |
| Neon (Postgres) | $0 |
| Upstash (Redis) | $0 |
| Cloudflare (DNS + email routing) | $0 |
| Hetzner Windows VPS (CX22) | €5 (~$6) |
| BetterStack monitoring | $0 |
| Vak-SMS credit (50 accounts/month replacement) | ~$10 |
| 2Captcha credit | ~$2 |
| Domain (annualized) | ~$1 |
| **Total** | **~$25/mo** |

For 100 customers paying $20-30 each → ~$2-3k/mo revenue. ~99% margin.

## Going further

- **Stripe** when you want self-serve customer signup ($0/mo + 2.9% per payment).
- **Sentry** for error tracking (free tier 5k events/mo).
- **PostHog** for product analytics (free tier 1M events).
- **Cloudflare WAF** in front of the API for DDoS / abuse protection.
