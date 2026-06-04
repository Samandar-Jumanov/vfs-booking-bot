# ALWAYS_ON — Keep the VFS Bot Running Through RDP Disconnect

## The problem

The VFS bot drives a **visible (headed) Chrome** window. When the bot was started
inside an RDP session and you disconnect that RDP window, Windows **suspends the
RDP session** — Chrome freezes, slot-checks stop, Telegram goes silent.

## The fix in one sentence

Make Windows auto-log the Administrator into the **console session** on every
boot, configure that session to never lock or sleep, and register the worker as an
**AtLogon** scheduled task. The bot then runs in the console session, which is
**completely separate from RDP**. RDP connect/disconnect creates/destroys its own
secondary session and never touches the console session.

```
Boot
 └─► Console session (auto-logon) ─► VFS-Booking-Worker task ─► Chrome + bot
       ↑ always alive, never suspends

RDP connect  ─► creates session 2
RDP disconnect ─► destroys session 2   (console session unaffected)
```

---

## How to run `always-on.ps1`

Run **once** from an elevated PowerShell on the VPS:

```powershell
# DRY-RUN booking (safe default)
.\ops\always-on.ps1

# Arm real booking submit
.\ops\always-on.ps1 -WorkerBook

# Also launch the extension Chrome at logon (needed for activation)
.\ops\always-on.ps1 -WithChrome
```

The script will prompt once for the Windows account password (needed for
auto-logon). It is idempotent — safe to re-run.

### What it sets

| Category | Setting |
|---|---|
| Power (AC) | `powercfg /change standby-timeout-ac 0` |
| Power (AC) | `powercfg /change hibernate-timeout-ac 0` |
| Power (AC) | `powercfg /change monitor-timeout-ac 0` |
| Power (AC) | `powercfg /change disk-timeout-ac 0` |
| Power plan | `powercfg -setactive SCHEME_MIN` (High Performance, best-effort) |
| Screensaver | `HKCU\Control Panel\Desktop` → ScreenSaveActive=0, ScreenSaverIsSecure=0, ScreenSaveTimeOut=0 |
| Lock workstation | `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System` → DisableLockWorkstation=1 |
| Lock screen | `HKLM\SOFTWARE\Policies\Microsoft\Windows\Personalization` → NoLockScreen=1 |
| Auto-logon | `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon` → AutoAdminLogon=1, DefaultUserName, DefaultDomainName, DefaultPassword |
| Scheduled task | `VFS-Booking-Worker` registered (AtLogon + keep-alive, restarts on failure) |

---

## Security note on the auto-logon password

`always-on.ps1` writes the Windows password to
`HKLM\...\Winlogon\DefaultPassword` in plain text. This is identical to what
**netplwiz** ("Automatically sign in") does internally. It is acceptable on a
single-purpose dedicated bot VPS where no other users have access.

**More secure alternative — Sysinternals Autologon.exe** (stores the password
encrypted via LSA secrets, not plain text):

```
autologon.exe <username> <computername> <password>
```

Download: https://learn.microsoft.com/en-us/sysinternals/downloads/autologon

If you use Autologon.exe, skip the password prompt in `always-on.ps1` (press
Enter for empty) and run Autologon separately before rebooting.

---

## How to verify (the only correct test — no RDP after reboot)

1. Run `always-on.ps1` and confirm it prints "DONE" with no red errors.
2. Confirm `backend\.env.worker` has `WORKER_TOKEN`, `DATABASE_URL`,
   `PROFILE_ENCRYPTION_KEY`, `MAILSAC_API_KEY`, `TELEGRAM_BOT_TOKEN`,
   `TELEGRAM_CHAT_ID`.
3. **Reboot** the VPS (Start → Restart, or via VMmanager Control Panel).
4. **Do NOT connect via RDP.** Wait 60–90 seconds.
5. Watch your **Telegram** — you should see the bot's heartbeat or
   `no slots / monitoring` messages continuously for 15+ minutes.
6. Confirm messages keep arriving. If they stop, the bot froze — see
   Troubleshooting below.

The 15-minute uninterrupted Telegram stream is the pass/fail criterion.

---

## How to watch the console session (without RDP)

Use **VMmanager VNC console** (your hosting provider's web panel → your VPS →
Console / VNC):

- The VNC console shows the **physical console session** — exactly where the bot
  and Chrome are running.
- RDP gives you a **separate session** (Session 2+). If you connect via RDP you
  will NOT see Chrome/the bot there — that is expected and correct.
- The VNC console may show a black screen if the monitor is off. Press a key or
  move the mouse to wake it. (Monitor timeout is set to 0, but some providers
  blank the VNC view anyway — the session is still running.)

---

## Maintenance

### After `git pull` — restart the worker

```powershell
Stop-ScheduledTask  -TaskName VFS-Booking-Worker
Start-ScheduledTask -TaskName VFS-Booking-Worker
```

The worker runs **locally** on the VPS. Pushing to Railway does NOT update it.
You must restart the task to load new code.

### Re-arm booking submit

```powershell
# Re-run always-on.ps1 with -WorkerBook to re-register the task with WORKER_BOOK=1
.\ops\always-on.ps1 -WorkerBook
```

Or set `WORKER_BOOK=1` in `backend\.env.worker` and restart the task — the
`launch-worker.ps1` script reads that file on every launch.

### Remove auto-start tasks

```powershell
.\ops\uninstall-autostart.ps1
```

### Remove auto-logon

```powershell
Set-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon' -Name 'AutoAdminLogon' -Value '0'
Remove-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon' -Name 'DefaultPassword' -ErrorAction SilentlyContinue
```

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Telegram silent after reboot | Auto-logon failed — check password in Winlogon keys; or task did not fire — check Task Scheduler (taskschd.msc) History tab. |
| Bot visible in VNC but not in RDP | Correct — bot runs in console session; RDP is a separate session. |
| VNC shows login screen after reboot | Auto-logon not working — wrong password, or account has a PIN set (PIN overrides registry auto-logon on Windows 10/Server 2019+; remove the PIN via Settings → Accounts). |
| Chrome freezes / no Telegram for >5 min | Zombie worker or crashed Chrome. RDP in → kill all `node` + `python` processes → `Start-ScheduledTask VFS-Booking-Worker`. |
| Task runs but bot says "missing secrets" | `backend\.env.worker` not found or missing keys. Check the file exists and has the required KEY=VALUE lines (no BOM). |
| `DisableLockWorkstation` has no effect | Some providers enforce Group Policy over registry. Check `gpedit.msc` → Computer Configuration → Windows Settings → Security Settings → Local Policies → Security Options → "Interactive logon: Do not require CTRL+ALT+DEL". |
