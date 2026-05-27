"""
100% hands-off VFS pipeline in ONE nodriver stealth browser:
  login (auto-pass Turnstile) -> enter booking wizard -> select Work D-visa
  -> monitor slot availability on a loop -> book on slot -> Telegram alert.

No extension, no chrome.debugger (those break the captcha). All lift-api calls
run in this real browser (Cloudflare-happy).

Run (PowerShell):
  $env:VFS_EMAIL="..."; $env:VFS_PASSWORD="..."; python nodriver-spike/auto_pipeline.py
Env:
  MONITOR_INTERVAL  seconds between slot re-checks (default 120)
  BOOK_ENABLED      "1" to actually book on a slot (default off = monitor only, safe)
  BOOK_DRY_RUN      "1" to run the full booking flow up to the Review screen, take a
                    screenshot, and exit WITHOUT clicking Submit/Confirm. Useful for
                    validating the booking flow end-to-end. If both BOOK_DRY_RUN and
                    BOOK_ENABLED are set, DRY_RUN takes precedence (no actual submit).
  SUBCAT            regex to pick sub-category (default: Work D-visa)
  TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID  optional alerts
  PROFILE_*         applicant data for booking (firstName,lastName,nationality,passport,contact)
"""
import asyncio
import os
import re
import sys
import json
import pathlib
import urllib.request

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

EMAIL = os.environ.get("VFS_EMAIL", "")
PASSWORD = os.environ.get("VFS_PASSWORD", "")
LOGIN_URL = os.environ.get("VFS_LOGIN_URL", "https://visa.vfsglobal.com/uzb/en/lva/login")
MONITOR_INTERVAL = int(os.environ.get("MONITOR_INTERVAL", "120"))
BOOK_ENABLED = os.environ.get("BOOK_ENABLED") == "1"
BOOK_DRY_RUN = os.environ.get("BOOK_DRY_RUN") == "1"
SUBCAT = re.compile(os.environ.get("SUBCAT", r"work\s*\(?\s*(?:visa\s*d|d\s*visa)"), re.I)
SHOTS = pathlib.Path(__file__).parent / "shots"
SHOTS.mkdir(exist_ok=True)

WORKER_BRIDGED = os.environ.get("WORKER_BRIDGED") == "1"


def milestone(step, **kw):
    """Print a machine-readable MILESTONE line for the orchestrator worker to parse."""
    data = {"step": step, **kw}
    print(f"MILESTONE {json.dumps(data)}", flush=True)


def log(*a):
    print("[PIPE]", *a, flush=True)


def telegram(msg):
    if WORKER_BRIDGED:
        log("(bridged, skipping telegram):", msg); return
    tok = os.environ.get("TELEGRAM_BOT_TOKEN"); chat = os.environ.get("TELEGRAM_CHAT_ID")
    if not tok or not chat:
        log("(telegram not configured)", msg); return
    try:
        data = json.dumps({"chat_id": chat, "text": msg}).encode()
        req = urllib.request.Request(f"https://api.telegram.org/bot{tok}/sendMessage", data=data,
                                     headers={"Content-Type": "application/json"})
        urllib.request.urlopen(req, timeout=15)
        log("telegram sent:", msg)
    except Exception as e:
        log("telegram failed:", e)


def _unwrap(v):
    # nodriver sometimes returns JS arrays as [{'type':'string','value':...}, ...]
    if isinstance(v, dict) and "value" in v and set(v.keys()) <= {"type", "value", "className", "subtype"}:
        return v["value"]
    if isinstance(v, list):
        return [_unwrap(x) for x in v]
    return v


async def jeval(page, expr):
    try:
        return _unwrap(await page.evaluate(expr))
    except Exception as e:
        log("jeval err:", str(e)[:80]); return None


async def shot(page, name):
    try:
        await page.save_screenshot(str(SHOTS / f"{name}.png"))
    except Exception:
        pass


async def dismiss_consent(page):
    await jeval(page, """(()=>{const e=document.getElementById('onetrust-accept-btn-handler'); if(e){e.click(); return 1;}
        const b=[...document.querySelectorAll('button,a')].find(x=>/accept all|accept cookies|i agree/i.test(x.innerText||'')); if(b){b.click(); return 1;} return 0;})()""")


async def sign_in_disabled(page):
    return await jeval(page, "(()=>{const b=[...document.querySelectorAll('button')].find(x=>/sign\\s*in/i.test(x.innerText||'')); return b?!!b.disabled:true;})()")


# ── LOGIN ──────────────────────────────────────────────────────────────────
async def do_login(browser, page):
    log("LOGIN: navigating")
    await asyncio.sleep(10)
    await dismiss_consent(page)
    email_el = await page.select("#email", timeout=25)
    await email_el.send_keys(EMAIL)
    pwd_el = await page.select('#password, input[type="password"]', timeout=15)
    await pwd_el.send_keys(PASSWORD)
    log("LOGIN: filled; waiting for Turnstile auto-pass…")
    for _ in range(30):
        if await sign_in_disabled(page) is False:
            break
        await asyncio.sleep(1)
    await dismiss_consent(page)
    # click the Sign In button
    for b in await page.select_all("button"):
        if "sign in" in ((b.text or "").lower()):
            await b.mouse_click(); break
    for _ in range(25):
        url = await jeval(page, "location.href") or ""
        if "/login" not in url:
            break
        await asyncio.sleep(1)
    diag = await jeval(page, """(()=>{const f=document.querySelector('[name="cf-turnstile-response"]');
        const b=[...document.querySelectorAll('button')].find(x=>/sign\\s*in/i.test(x.innerText||''));
        return JSON.stringify({cfRespLen:f&&f.value?f.value.length:0, signInDisabled:b?!!b.disabled:'no-btn',
          inactive:/inactive|resend the activation/i.test(document.body.innerText||''),
          err:[...document.querySelectorAll('mat-error,.mat-error,[class*="error" i]')].filter(e=>e.offsetParent&&(e.innerText||'').trim()).map(e=>(e.innerText||'').trim().slice(0,60)).slice(0,4)});})()""")
    log("LOGIN: post-submit url:", url, "diag:", diag)
    return bool(url) and "/login" not in url and "/page-not-found" not in url


# ── WIZARD: enter + select centre/category/subcat ──────────────────────────
async def enter_wizard(page):
    # If not already showing dropdowns, click "Start New Booking" from dashboard.
    has_select = await jeval(page, "!!document.querySelector('mat-select')")
    if not has_select:
        log("WIZARD: entering from dashboard")
        await jeval(page, """(()=>{const phrases=['start new booking','book appointment','book an appointment','new booking','start booking'];
            const els=[...document.querySelectorAll('button,a,[role=button],mat-card,.mat-card')];
            const t=els.find(e=>phrases.some(p=>((e.innerText||'').toLowerCase()).includes(p))); if(t){t.click(); return 1;} return 0;})()""")
        for _ in range(20):
            if await jeval(page, "!!document.querySelector('mat-select')"):
                break
            await asyncio.sleep(1)


async def open_select(page, index, label, polls=6):
    """Open mat-select #index, return its option elements (nodriver elements).
    polls*0.4s is the max wait for options to render (keep small when scanning)."""
    triggers = await page.select_all("mat-select")
    if index >= len(triggers):
        return []
    try:
        await triggers[index].mouse_click()
    except Exception:
        return []
    for _ in range(polls):
        opts = await page.select_all("mat-option, .mat-mdc-option")
        opts = [o for o in opts if ((o.text or "").strip())]
        if opts:
            return opts
        await asyncio.sleep(0.4)
    return []


async def pick_option(opts, matcher, label):
    """Trusted-click the first option whose text matches `matcher(text)`."""
    for o in opts:
        t = (o.text or "").strip()
        if t and matcher(t):
            try:
                await o.mouse_click()
            except Exception as e:
                log(f"{label}: option click failed:", str(e)[:60]); return None
            await asyncio.sleep(1.3)
            log(f"{label}: chose", t[:40])
            return t
    log(f"{label}: no match; options=", [((o.text or '').strip()[:30]) for o in opts][:12])
    return None


async def continue_enabled(page):
    return await jeval(page, "(()=>{const b=[...document.querySelectorAll('button')].find(x=>/continue/i.test(x.innerText||'')&&x.offsetParent); return b?!b.disabled:false;})()")


async def close_overlay(page):
    await jeval(page, "(()=>{const b=document.querySelector('.cdk-overlay-backdrop'); if(b)b.click();})()")
    await asyncio.sleep(0.4)


SUBCAT_LIST_RE = re.compile(r"work|cargo|ocma|seasonal|students", re.I)


async def select_route(page):
    """Pick centre + category + a Work-D-visa subcat that has slots. Robust to
    VFS's dependent (API-loaded) dropdowns. Returns the chosen subcat if a slot
    is available (Continue enabled), else None."""
    # wait for the form to render at least one dropdown
    for _ in range(20):
        if await page.select_all("mat-select"):
            break
        await asyncio.sleep(1)

    # centre (index 0): retry until it opens with options, pick first
    for _ in range(4):
        opts = await open_select(page, 0, "centre")
        if opts:
            await pick_option(opts, lambda t: True, "centre")
            break
        await asyncio.sleep(2)
    await asyncio.sleep(2)

    # category (index 1): pick "Long Stay/Visa D"
    opts = await open_select(page, 1, "category")
    if opts:
        await pick_option(opts, lambda t: re.search("long stay", t, re.I), "category")

    # sub-category: the index isn't stable AND VFS loads it via API after the
    # category pick, so SCAN every dropdown for the one whose options contain
    # work/cargo/ocma (the real sub-cat list), polling until it appears.
    sub_idx = None
    texts = []
    for it in range(10):
        selects = await page.select_all("mat-select")
        log(f"scan iter {it}: {len(selects)} dropdowns")
        for i in range(len(selects)):
            opts = await open_select(page, i, f"scan[{i}]", polls=5)
            ot = [(o.text or "").strip() for o in opts]
            await close_overlay(page)
            log(f"  scan[{i}] sample:", ot[:3])
            if any(SUBCAT_LIST_RE.search(t) for t in ot):
                sub_idx, texts = i, ot
                break
        if sub_idx is not None:
            break
        await asyncio.sleep(2.5)
    if sub_idx is None:
        log("subcat dropdown not found (still loading?)"); return None
    log(f"subcat at index {sub_idx}; options:", texts)

    work = [t for t in texts if SUBCAT.search(t)]
    if not work:
        log("no Work-D-visa sub-category in list"); return None
    for wt in work:
        opts = await open_select(page, sub_idx, "subcat")
        picked = await pick_option(opts, lambda t, wt=wt: t == wt, "sub:" + wt[:18])
        if not picked:
            continue
        await asyncio.sleep(2.5)  # VFS evaluates availability → enables Continue
        if await continue_enabled(page):
            log("SLOT AVAILABLE in:", wt); return wt
        log("no slot in:", wt)
    return None


# ── BOOKING (Phase D) — ported from extension runBookingSteps ───────────────
PROFILE = {
    "firstName": os.environ.get("PROFILE_FIRSTNAME", "Test"),
    "lastName": os.environ.get("PROFILE_LASTNAME", "User"),
    "nationality": os.environ.get("PROFILE_NATIONALITY", "Uzbekistan"),
    "passport": os.environ.get("PROFILE_PASSPORT", "AB1234567"),
    "email": os.environ.get("PROFILE_EMAIL", EMAIL),
    "contact": os.environ.get("PROFILE_CONTACT", "901234567"),
}


async def click_button_text(page, words, timeout=45):
    """Trusted-click the first enabled visible button whose text matches any word."""
    import time as _t
    deadline = _t.time() + timeout
    words = [w.lower() for w in words]
    while _t.time() < deadline:
        for b in await page.select_all("button"):
            txt = (b.text or "").strip().lower()
            if txt and any(w in txt for w in words):
                disabled = await jeval(page, f"(()=>{{const b=[...document.querySelectorAll('button')].find(x=>((x.innerText||'').trim().toLowerCase())===%s); return b?!!b.disabled:true;}})()" % json.dumps(txt))
                if disabled is False:
                    try:
                        await b.mouse_click(); return True
                    except Exception:
                        pass
        await asyncio.sleep(1)
    log("button never enabled:", words)
    return False


async def fill_input(page, selectors, value):
    for sel in selectors:
        try:
            el = await page.select(sel, timeout=2)
        except Exception:
            el = None
        if el:
            try:
                await el.send_keys(value); return True
            except Exception:
                pass
    return False


async def handle_captcha_modal(page):
    """After Continue, VFS pops a Verify-Captcha modal whose Turnstile auto-passes;
    click its Submit when enabled."""
    await click_button_text(page, ["submit"], timeout=25)


async def book(page, subcat):
    log("BOOK: slot found, starting booking flow")
    # Step 1 → Continue + captcha modal
    await click_button_text(page, ["continue"])
    await handle_captcha_modal(page)
    await asyncio.sleep(2)
    # Step 2 — Your Details
    await fill_input(page, ['input[formcontrolname="firstName"]', 'input[id*="first" i]'], PROFILE["firstName"])
    await fill_input(page, ['input[formcontrolname="lastName"]', 'input[id*="last" i]'], PROFILE["lastName"])
    await fill_input(page, ['input[formcontrolname="passportNumber"]', 'input[id*="passport" i]'], PROFILE["passport"])
    await fill_input(page, ['input[formcontrolname="emailid"]', 'input[type="email"]'], PROFILE["email"])
    await fill_input(page, ['input[formcontrolname="contactNumber"]', 'input[type="tel"]'], PROFILE["contact"])
    # nationality mat-select (find the one near "nationality")
    nopts = await open_select(page, 0, "nationality")
    if nopts:
        await pick_option(nopts, lambda t: PROFILE["nationality"].lower() in t.lower(), "nationality")
    await asyncio.sleep(1)
    await click_button_text(page, ["save", "continue"], timeout=45)
    # Step 3 — Book Appointment (type → date → slot → continue)
    await asyncio.sleep(2)
    await jeval(page, "(()=>{const r=document.querySelector('#mat-radio-0-input, mat-radio-button input[type=radio]'); if(r)r.click();})()")
    await handle_captcha_modal(page)
    await jeval(page, "(()=>{const c=[...document.querySelectorAll('.mat-calendar-body-cell')].find(x=>x.getAttribute('aria-disabled')!=='true'); if(c)c.click();})()")
    await asyncio.sleep(1)
    await jeval(page, "(()=>{const s=document.querySelector('input[name=SlotRadio], mat-radio-button input[type=radio]'); if(s)s.click();})()")
    await click_button_text(page, ["continue"])
    # Step 4 — Services
    await asyncio.sleep(1.5)
    await click_button_text(page, ["continue", "next"], timeout=15)
    # Step 5 — Review → Submit
    await asyncio.sleep(1.5)
    if BOOK_DRY_RUN:
        ts = int(asyncio.get_event_loop().time())
        await shot(page, f"dry_review_{ts}")
        log(f"DRY-RUN: reached review screen — screenshot saved to shots/dry_review_{ts}.png — not submitting")
        return True
    ok = await click_button_text(page, ["submit", "confirm", "pay"], timeout=20)
    await shot(page, "pipe_after_submit")
    log("BOOK: submit clicked:", ok, "url:", await jeval(page, "location.href"))
    return ok


# ── MAIN ───────────────────────────────────────────────────────────────────
async def main():
    global BOOK_ENABLED
    if not EMAIL or not PASSWORD:
        log("ERROR: set VFS_EMAIL/VFS_PASSWORD"); sys.exit(2)
    if BOOK_DRY_RUN and BOOK_ENABLED:
        log("WARN: both BOOK_DRY_RUN and BOOK_ENABLED are set — DRY_RUN takes precedence (no actual submit)")
        BOOK_ENABLED = False
    import nodriver as uc
    browser = await uc.start(headless=False, browser_args=["--lang=en-US"])
    page = await browser.get(LOGIN_URL)

    if not await do_login(browser, page):
        log("RESULT: LOGIN FAILED")
        milestone("failed", email=EMAIL, error="login_failed")
        await asyncio.sleep(5); browser.stop(); return
    log("LOGIN OK")
    milestone("logged_in", email=EMAIL)
    telegram(f"[bot] logged in {EMAIL}, monitoring Work D-visa slots…")

    await enter_wizard(page)
    await shot(page, "pipe_wizard")
    milestone("monitoring", email=EMAIL)

    # Monitor loop
    attempt = 0
    while True:
        attempt += 1
        log(f"--- check #{attempt} ---")
        slot = await select_route(page)
        if slot:
            milestone("slot_found", email=EMAIL, slotId=slot)
            telegram(f"[bot] SLOT FOUND for {EMAIL}: {slot}")
            if BOOK_DRY_RUN:
                booked = await book(page, slot)
                telegram(f"[bot] DRY-RUN: reached review screen for {EMAIL} ({slot}) — not submitted")
                break
            elif BOOK_ENABLED:
                booked = await book(page, slot)
                if booked:
                    milestone("booked", email=EMAIL, slotId=slot)
                else:
                    milestone("failed", email=EMAIL, error="booking_failed", slotId=slot)
                telegram(f"[bot] booking {'submitted' if booked else 'attempted'} for {EMAIL} ({slot})")
                break
            else:
                log("slot found but BOOK_ENABLED off — stopping for operator")
                break
        log(f"no slot — re-checking in {MONITOR_INTERVAL}s")
        # emit a per-check milestone so the backend sends a "no slots" Telegram
        # on EVERY check (operator wants a message each time, not a summary).
        milestone("monitoring", email=EMAIL, detail=f"check #{attempt} — Work D-visa, no slots")
        # go back to a clean Appointment Details state for the next check
        await asyncio.sleep(MONITOR_INTERVAL)
        await jeval(page, "location.reload()")
        await asyncio.sleep(8)
        await enter_wizard(page)

    log("done — keeping browser open 15s")
    await asyncio.sleep(15)
    browser.stop()


if __name__ == "__main__":
    import nodriver as uc
    try:
        uc.loop().run_until_complete(main())
    except Exception as _e:
        milestone("failed", error=str(_e))
        raise
