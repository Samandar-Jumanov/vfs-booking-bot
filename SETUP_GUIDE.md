# VFS Booking Bot — Complete Setup Guide
### From GitHub to Running System (Zero to Hero)

> Follow every step in order. Do NOT skip any step.

---

## ✅ Prerequisites — Pehle Yeh Install Karo

### 1. Git
Download & install: https://git-scm.com/download/win
```
Verify: git --version
```

### 2. Docker Desktop
Download & install: https://www.docker.com/products/docker-desktop/
- Install karo aur computer restart karo
- Docker Desktop open karo aur wait karo whale icon stable ho jaye
```
Verify: docker --version
```

### 3. Node.js (Optional — sirf keys generate karne ke liye)
Download & install: https://nodejs.org (LTS version)
```
Verify: node --version
```

---

## STEP 1 — Code Download Karo (GitHub)

```bash
git clone https://github.com/MuhammmadMuneerZameer/vfs-booking-bot.git
cd vfs-booking-bot
git checkout oneeb-coder
```

---

## STEP 2 — WSL Memory Configure Karo (VERY IMPORTANT)

Docker ko 6GB RAM deni hogi. Notepad open karo aur yeh file banao:

**File location**: `C:\Users\YOUR_USERNAME\.wslconfig`

*(YOUR_USERNAME ki jagah apna Windows username likhna)*

**File content:**
```ini
[wsl2]
memory=6GB
processors=4
swap=2GB
```

**File save karne ke baad WSL restart karo:**
```powershell
wsl --shutdown
```
Phir Docker Desktop band karo aur dobara kholo. Wait karo jab tak whale icon stable ho jaye.

---

## STEP 3 — Secret Keys Generate Karo

Yeh keys **ZAROOR** generate karni hain. PowerShell open karo aur ek ek command chalao:

### JWT Access Secret (64-byte)
```powershell
-join ((1..64) | ForEach-Object { "{0:x2}" -f (Get-Random -Max 256) })
```
> Output copy kar lo — yeh `JWT_ACCESS_SECRET` hai

### JWT Refresh Secret (64-byte)
```powershell
-join ((1..64) | ForEach-Object { "{0:x2}" -f (Get-Random -Max 256) })
```
> Output copy kar lo — yeh `JWT_REFRESH_SECRET` hai

### Profile Encryption Key (32-byte)
```powershell
-join ((1..32) | ForEach-Object { "{0:x2}" -f (Get-Random -Max 256) })
```
> Output copy kar lo — yeh `PROFILE_ENCRYPTION_KEY` hai

---

## STEP 4 — External Services Setup Karo

### 4A. Proxyrack Account (Residential Proxy)
> **Zaroor hai** — VFS bot detection bypass ke liye

1. https://proxyrack.com par account banao
2. **Residential Proxies** plan subscribe karo
3. Dashboard se apna **username** aur **password** note karo
4. Host: `premium.residential.proxyrack.net`
5. Port: `10000`

### 4B. Telegram Bot (Notifications)
> **Zaroor hai** — real-time alerts ke liye

1. Telegram open karo
2. `@BotFather` ko search karo
3. `/newbot` command bhejo
4. Bot ka naam do (e.g., `VFS Monitor Bot`)
5. **Bot Token** copy kar lo (format: `1234567890:ABCdefGHI...`)

**Chat ID lene ke liye:**
1. Apne bot ko Telegram mein open karo
2. `/start` bhejo
3. Browser mein yeh URL kholo:
   ```
   https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates
   ```
4. Response mein `"chat":{"id":XXXXXXXX}` — yeh number copy kar lo

### 4C. 2Captcha (Optional — Auto CAPTCHA solving)
> **Optional** — agar manual mode use karna hai to skip karo

1. https://2captcha.com par account banao
2. Balance add karo ($5-10)
3. API Key copy kar lo

---

## STEP 5 — .env File Banao

Project folder mein `.env` file banao (`.env.example` se copy karo):

```bash
# Windows mein:
copy .env.example .env
```

Ab `.env` file open karo (Notepad ya VS Code se) aur yeh values fill karo:

```env
# ─── Server ───────────────────────────────────────────────────────────────────
NODE_ENV=development
PORT=3001
FRONTEND_URL=http://localhost:3000

# ─── Database ─────────────────────────────────────────────────────────────────
DATABASE_URL=postgresql://vfsuser:vfspass@localhost:5432/vfsdb

# ─── Redis ────────────────────────────────────────────────────────────────────
REDIS_URL=redis://:redispass@localhost:6379

# ─── Auth (STEP 3 mein generate ki hui keys yahan paste karo) ─────────────────
JWT_ACCESS_SECRET=<STEP-3-SE-COPY-KIYA-HUA-64-BYTE-KEY>
JWT_REFRESH_SECRET=<STEP-3-SE-COPY-KIYA-HUA-DOOSRA-64-BYTE-KEY>
JWT_ACCESS_EXPIRY=15m
JWT_REFRESH_EXPIRY=7d

# ─── Encryption (STEP 3 se 32-byte key) ──────────────────────────────────────
PROFILE_ENCRYPTION_KEY=<STEP-3-SE-COPY-KIYA-HUA-32-BYTE-KEY>

# ─── Captcha ──────────────────────────────────────────────────────────────────
TWOCAPTCHA_API_KEY=<2CAPTCHA-API-KEY>   # ← Agar nahi hai to khali chhod do
CAPTCHA_SOLVER=manual                    # ← manual rakho agar 2captcha nahi

# ─── Proxy (STEP 4A se) ───────────────────────────────────────────────────────
PROXY_DEFAULT_PROVIDER=proxyrack
PROXY_HOST=premium.residential.proxyrack.net
PROXY_PORT=10000
PROXY_USERNAME=<PROXYRACK-USERNAME>
PROXY_PASSWORD=<PROXYRACK-PASSWORD>

# ─── Telegram (STEP 4B se) ────────────────────────────────────────────────────
TELEGRAM_BOT_TOKEN=<BOT-TOKEN-FROM-BOTFATHER>
TELEGRAM_CHAT_ID=<YOUR-CHAT-ID>
TELEGRAM_PROXY=                          # ← Pakistan mein VPN use karo yahan

# ─── Automation ───────────────────────────────────────────────────────────────
BOOKING_CONCURRENCY=3
MONITOR_DEFAULT_INTERVAL_MS=30000
SESSION_DIR=/app/sessions
BOOKING_MAX_RETRIES=3
```

### ⚠️ IMPORTANT — Docker ke andar DATABASE_URL alag hoti hai!

Docker Compose ki `docker-compose.dev.yml` file mein yeh pehle se set hai — aap ko kuch nahi karna:
```yaml
DATABASE_URL: postgresql://vfsuser:vfspass@postgres:5432/vfsdb
REDIS_URL: redis://:redispass@redis:6379
```

---

## STEP 6 — Docker Containers Start Karo

```bash
docker-compose -f docker-compose.dev.yml up -d --build
```

> ⏳ **Pehli baar 15-20 minute lagenge** — Chromium browser ke 192 packages install honge.
> Dobara start karne par sirf 1-2 minute lagenge.

**Status check karo:**
```bash
docker-compose -f docker-compose.dev.yml ps
```

Yeh output aana chahiye:
```
NAME                        STATUS
vfsbookingbot-postgres-1    Up (healthy)
vfsbookingbot-redis-1       Up
vfsbookingbot-backend-1     Up
vfsbookingbot-frontend-1    Up
```

---

## STEP 7 — Admin Account Banao (Database Seed)

```bash
docker-compose -f docker-compose.dev.yml exec -T backend npx ts-node -r tsconfig-paths/register prisma/seed.ts
```

**Expected Output:**
```
🌱 Seeding database (Users Only)…

  ✅ Admin user: admin@vfsbot.local
  ✅ Operator user: operator@vfsbot.local
  ✅ 3 default settings seeded

✅ Seed complete (No dummy data)!
```

---

## STEP 8 — Website Open Karo

Browser mein yeh URL kholo:
```
http://localhost:3000
```

**Login Credentials:**
| Field | Value |
|:---|:---|
| Email | `admin@vfsbot.local` |
| Password | `admin1234` |

---

## STEP 9 — Pehla Applicant Add Karo

1. Login ke baad **"Applicants"** section mein jao
2. **"Add Applicant"** button click karo
3. Client ka data fill karo:
   - Full Name
   - Email (client ka VFS-registered email)
   - VFS Portal Password
   - Nationality (source country — e.g., United Kingdom)
   - Passport Number, Issue Date, Expiry Date
   - Date of Birth
   - Destination (e.g., Portugal)
   - Visa Category (e.g., Tourist Visa)
4. **Save** karo

**Bot automatically monitoring shuru kar dega!**

---

## Daily Usage Commands

### Bot Start Karo
```bash
docker-compose -f docker-compose.dev.yml up -d
```

### Bot Band Karo
```bash
docker-compose -f docker-compose.dev.yml down
```

### Live Logs Dekho
```bash
docker-compose -f docker-compose.dev.yml logs -f backend
```

### Full Reset (Sab Data Delete)
```bash
docker-compose -f docker-compose.dev.yml down -v
docker-compose -f docker-compose.dev.yml up -d --build
# Phir dobara STEP 7 chalao
```

---

## Troubleshooting

### "Invalid Credentials" on Login
```bash
docker-compose -f docker-compose.dev.yml exec -T backend npx ts-node -r tsconfig-paths/register prisma/seed.ts
```

### "Network Error" on Login Page
```bash
docker-compose -f docker-compose.dev.yml ps        # Check sab containers UP hain
docker-compose -f docker-compose.dev.yml up -d     # Agar nahi to start karo
```

### Docker Desktop Nahi Khul Raha
```powershell
wsl --shutdown
# Phir Docker Desktop manually start karo
```

### Logs Mein "Page crashed"
- `.wslconfig` check karo — memory=6GB set honi chahiye
- Docker Desktop restart karo

---

## Keys Summary Table

| Key | Kahan Se Milegi | Zaroor Hai? |
|:---|:---|:---|
| `JWT_ACCESS_SECRET` | PowerShell se generate (64-byte) | ✅ Yes |
| `JWT_REFRESH_SECRET` | PowerShell se generate (64-byte) | ✅ Yes |
| `PROFILE_ENCRYPTION_KEY` | PowerShell se generate (32-byte) | ✅ Yes |
| `PROXY_USERNAME` | Proxyrack dashboard | ✅ Yes |
| `PROXY_PASSWORD` | Proxyrack dashboard | ✅ Yes |
| `TELEGRAM_BOT_TOKEN` | @BotFather on Telegram | ✅ Yes |
| `TELEGRAM_CHAT_ID` | Telegram API getUpdates | ✅ Yes |
| `TWOCAPTCHA_API_KEY` | 2captcha.com dashboard | ❌ Optional |

---

*VFS Booking Bot — Branch: oneeb-coder*
*GitHub: https://github.com/MuhammmadMuneerZameer/vfs-booking-bot*
