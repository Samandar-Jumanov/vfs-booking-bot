# 🚀 VFS Booking Bot: Running & Testing Guide

This guide walks you through the exact steps to launch, configure, and test the VFS Booking Bot for the first time.

---

## 🛠️ Step 1: Initial Launch (The Easy Way)
If you are on Windows, we have created a **One-Click** launcher for you.

1.  **Open the project folder.**
2.  **Double-click `start_project.bat`.**
    - This will automatically create your `.env` file and start all required services (Database, Redis, Backend, Frontend) via Docker.
    - *Wait until you see "Compiled successfully" in the terminal.*

---

## ⚙️ Step 2: Essential Configuration
Before the bot can find appointments, you **must** configure your Telegram credentials.

1.  Open the newly created `.env` file in Notepad.
2.  Add your **TELEGRAM_BOT_TOKEN** (from @BotFather).
3.  Add your **TELEGRAM_CHAT_ID** (from @userinfobot).
4.  **Save the file.**
5.  Restart the bot by closing and re-opening `start_project.bat`.

---

## 👤 Step 3: Create Your First Applicant (Test Profile)
1.  Open your browser and go to: `http://localhost:3000`
2.  Login with development credentials (if prompted).
3.  Click on **"Profiles"** in the sidebar.
4.  Click **"Initialize Identity"** (Add Profile).
5.  **Enter Test Data**:
    - **Name**: Oneeb Arif
    - **Passport**: AA1234567
    - **VFS Password**: (Your VFS Global account password)
6.  **Click Save.** Your applicant is now in the database.

---

## 📡 Step 4: Testing the Engine
Now, let's see if the bot can actually "see" the VFS website.

1.  Go to the **Dashboard**.
2.  **Select Countries**: 
    - e.g., *Source: Pakistan* 
    - *Destination: Portugal*
3.  **Set Monitoring Mode**: Select **"Manual"** (for testing, so it doesn't try to book immediately).
4.  **Click "Activate Monitor"**.
5.  Check the **Diagnostics Panel** (bottom of dashboard):
    - You should see `[INFO] Initializing browser session...`
    - You should see `[INFO] Reached VFS login page.`
    - If you see `[SUCCESS] No slots available`, **the bot is working!**

---

## 🤖 Step 5: Testing Telegram Notifications
To make sure you receive alerts on your phone:

1.  Open your Telegram App.
2.  Search for your bot and click **Start**.
3.  Type `/status` in the chat.
4.  If the bot replies with your active monitor's details, **Telegram is 100% connected.**

---

## 🛑 How to Stop Everything
- **Normal Stop**: Click "Deactivate" on the Dashboard.
- **Emergency Stop**: Type `/stop_all` in Telegram.
- **Full Shutdown**: Close the command prompt/terminal window on your PC.

---

## 💡 Troubleshooting Tips
- **Keep seeing 403 Forbidden?** Open the **Settings** and add a **Proxy**. The bot will automatically rotate through it.
- **Bot is slow?** Check your internet connection or lower the "Polling Intensity" slider on the dashboard.

---

**Now you are ready to secure your appointment!**  
For more technical details, refer to the [README.md](./README.md).
