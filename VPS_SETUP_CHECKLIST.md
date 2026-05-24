# Vultr Windows VPS — bot setup checklist

Follow top to bottom once you're RDP'd into the Windows desktop. Ping me at any step that misbehaves.

## 0. Connect
- Vultr → Compute → your instance → wait for **Running**
- Copy **IP** + **password** (user: `Administrator`)
- On your laptop: open **Remote Desktop Connection** → enter the IP → `Administrator` + password

## 1. Install Chrome (on the VPS)
- Open Edge → download Chrome from https://www.google.com/chrome → install
- (If Edge blocks downloads: lower IE Enhanced Security via Server Manager → Local Server → IE Enhanced Security Configuration → Off)

## 2. Get the bot files onto the VPS
Two options:
- **Easiest:** install Git for Windows (https://git-scm.com/download/win), then in PowerShell:
  `git clone https://github.com/Samandar-Jumanov/vfs-booking-bot.git`
- **Or:** copy the `extension/dist` folder + `launch-bot-chrome.ps1` via RDP clipboard/drive redirection

## 3. Load the extension
- Chrome → `chrome://extensions` → toggle **Developer mode** ON → **Load unpacked** → select `extension/dist`
- Note the extension ID

## 4. Pair the extension with the backend
- Dashboard (frontend-production URL) → generate a setup code → in the extension Options page, paste backend URL + setup code → Save
- Backend will push the BrightData proxy creds automatically (from .env) → proxy auto-auth kicks in

## 5. Verify proxy + IP
- In bot Chrome open `https://ipinfo.io` → should show **country: UZ** (BrightData UZ exit)
- If it shows another country → proxy creds/zone issue → ping me

## 6. Confirm VFS renders (not 403)
- Open `https://visa.vfsglobal.com/uzb/en/lva/login` → should show the login form
- Service-worker console (`chrome://extensions` → service worker) should show `WS status → connected` + `proxy auto-auth enabled`

## 7. Hand back to me
Tell me:
- ipinfo.io country = ?
- VFS login page renders? (yes/no)
- SW console shows connected? (yes/no)

Then I resume: log in an account → seed the auth sniffer → confirm clean 200 polling → build/test booking — all on the VPS, 24/7, no laptop.

## Keep-alive (so it survives reboots — do later)
- Set the launcher to run on login via Task Scheduler
- Enable auto-login for the Administrator account
- (I'll give exact steps once the basics work)
