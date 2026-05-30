# Operating the VFS Booking System

A short, plain-language guide. **You only need the dashboard — no commands, no black terminal windows.**

---

## What you do day-to-day

Everything happens on one web page: the **Dashboard**.

1. **Open the dashboard** in your browser (use the link you were given, then log in).
2. Look at the **Engine light** at the top of the "Scenario" box:
   - **🟢 Engine: Online** — the booking system is running and ready.
   - **🔴 Engine: Offline** — the booking system is **not** running. See *"If the light is red"* below.
3. To begin, click **Start Scenario**. The system then registers/activates accounts, logs in, watches for appointment slots, and books automatically. You'll get Telegram messages as it works.
4. To stop, click **Stop Scenario**. The button shows a short countdown (**"Stopping… 12s…"**) and then everything returns to normal. You can start again whenever you like.

That's it. You never need to open any program other than your browser.

---

## The Engine light explained

- The engine is the background program that does the actual work. It runs **by itself** on an always-on computer — you don't start it.
- The light turns **🟢 green** when that computer's engine has "checked in" within the last 30 seconds.
- If it turns **🔴 red**, the engine isn't checking in — usually because the always-on computer is off, asleep, lost internet, or the engine was stopped for maintenance.

## The Stop button

- After you click **Stop Scenario**, the button counts down (about 12 seconds) while it shuts the current run down cleanly.
- When it's done, the buttons return to normal and **Start Scenario** is available again.
- If it ever says **"Stopping… (finalizing)"** for more than half a minute, the system will clear it for you automatically — you don't have to do anything. Just wait, and the page will return to normal.

---

## If the light is red

1. First, refresh the page once and wait ~30 seconds — a brief network blip can show red.
2. If it stays **🔴 red**, the always-on computer or the engine needs attention. **Contact your technical operator** (the person who set this up) and tell them: *"The dashboard Engine light is red."*

> You should **not** try to fix a red light yourself — it always means a technical person needs to check the host computer.

---

## Honest limits (so there are no surprises)

- **The engine needs an always-on computer.** The booking work runs on a dedicated machine in Uzbekistan (a clean local internet connection, no VPN). If that machine is turned off or loses internet, the Engine light goes red and nothing books until it's back. Keeping that machine on and online is part of the hosting setup.
- **Software updates need a restart by a technician.** When the system is improved, a technical person has to briefly restart the engine on the host computer so it picks up the new version. This is a quick, scheduled, behind-the-scenes step — not something you do from the dashboard. During that short restart the Engine light may flick red and then back to green.
- **One run at a time.** Start one scenario, let it work; use Stop if you need to halt it. Starting is disabled while a run is already active.

---

## Quick reference

| You want to… | Do this |
|---|---|
| See if it's running | Look at the **Engine** light (🟢/🔴) |
| Begin booking | Click **Start Scenario** |
| Halt booking | Click **Stop Scenario** (watch the countdown) |
| Understand a red light | Refresh once; if still red, contact your operator |

*(For the technical operator: auto-start is installed via `ops/install-autostart.ps1` and removed via `ops/uninstall-autostart.ps1`. After `git pull`, restart the `VFS-Booking-Worker` scheduled task.)*
