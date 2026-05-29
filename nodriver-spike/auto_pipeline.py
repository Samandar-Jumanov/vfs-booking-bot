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
import urllib.parse

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
MAILSAC_KEY = os.environ.get("MAILSAC_API_KEY", "")


# ── Mailsac (booking OTP) ────────────────────────────────────────────────────
# VFS's booking flow gates step 3 behind an email/SMS OTP. The OTP is sent to the
# account's registered email — a Mailsac address for pool accounts — so we poll
# Mailsac for the code (same provider used for activation).
_MAILSAC_HDR = {
    "Mailsac-Key": MAILSAC_KEY,
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "application/json",
}


def mailsac_list(email):
    """Return Mailsac messages for an address (newest first), or [] on error."""
    if not MAILSAC_KEY:
        return []
    enc = urllib.parse.quote(email, safe="")
    try:
        req = urllib.request.Request(f"https://mailsac.com/api/addresses/{enc}/messages", headers=_MAILSAC_HDR)
        return json.loads(urllib.request.urlopen(req, timeout=20).read()) or []
    except Exception as e:
        log("mailsac list err:", e); return []


def mailsac_body(email, mid):
    enc = urllib.parse.quote(email, safe="")
    try:
        req = urllib.request.Request(f"https://mailsac.com/api/text/{enc}/{urllib.parse.quote(str(mid), safe='')}", headers=_MAILSAC_HDR)
        return urllib.request.urlopen(req, timeout=20).read().decode("utf-8", "replace")
    except Exception as e:
        log("mailsac body err:", e); return ""


async def mailsac_otp_code(email, exclude_ids, timeout=120):
    """Poll Mailsac for a NEW message and extract its OTP code (4-8 digits)."""
    import time as _t
    deadline = _t.time() + timeout
    while _t.time() < deadline:
        for m in mailsac_list(email):
            mid = m.get("_id")
            if mid in exclude_ids:
                continue
            text = (m.get("subject", "") or "") + " " + (mailsac_body(email, mid) or "")
            mm = (re.search(r"(?:otp|one[\s-]?time|verification|verify|code|password)\D{0,30}(\d{4,8})", text, re.I)
                  or re.search(r"\b(\d{6})\b", text))
            if mm:
                return mm.group(1)
        await asyncio.sleep(4)
    return None


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
    # The first load is flaky (transient page-not-found / slow hydration). Wait for
    # the email field, reloading up to 2× before giving up.
    email_el = None
    for attempt in range(3):
        email_el = await page.select("#email", timeout=20)
        if email_el:
            break
        url = await jeval(page, "location.href") or ""
        log(f"LOGIN: email field absent (attempt {attempt+1}), url={url.split('/')[-1]} — reloading")
        try:
            await page.get(LOGIN_URL)
        except Exception:
            pass
        await asyncio.sleep(8)
        await dismiss_consent(page)
    if not email_el:
        log("LOGIN: email field never rendered — aborting")
        return False
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

# VFS "Your Details" extracts applicant identity by OCR from an uploaded passport
# BIO-page image (PNG/JPG/PDF ≤2MB) — there are NO name/passport text fields. The
# operator/customer must supply a passport scan per applicant; default to a repo
# test passport for dry-run validation.
PASSPORT_IMAGE = os.environ.get(
    "PASSPORT_IMAGE",
    str((pathlib.Path(__file__).resolve().parent.parent / "passports" / "p1.png")),
)


async def click_button_text(page, words, timeout=45):
    """Trusted-click the VISIBLE, enabled button whose text matches any word.

    VFS renders multiple buttons with the same label (hidden templates + the real
    footer action). We must click the visible enabled one, scrolled into view, with
    no CDK overlay backdrop intercepting the click — otherwise the click silently
    lands on a hidden element / the backdrop and the page never advances."""
    import time as _t
    deadline = _t.time() + timeout
    sel = json.dumps([w.lower() for w in words])
    while _t.time() < deadline:
        # Dismiss any lingering dropdown overlay backdrop that would eat the click.
        await jeval(page, "(()=>{const b=document.querySelector('.cdk-overlay-backdrop'); if(b)b.click();})()")
        # Tag the LAST visible+enabled matching button (footer action button).
        tagged = await jeval(page, """((words)=>{document.querySelectorAll('[data-uc-click]').forEach(e=>e.removeAttribute('data-uc-click'));
            const bs=[...document.querySelectorAll('button')].filter(b=>b.offsetParent!==null && !b.disabled && words.some(w=>((b.innerText||'').trim().toLowerCase()).includes(w)));
            if(!bs.length)return false; bs[bs.length-1].setAttribute('data-uc-click','1'); return true;})(%s)""" % sel)
        if tagged is True:
            try:
                el = await page.select('button[data-uc-click="1"]', timeout=3)
                try:
                    await el.scroll_into_view()
                except Exception:
                    pass
                await el.mouse_click()
                await jeval(page, "(()=>{const b=document.querySelector('[data-uc-click]'); if(b)b.removeAttribute('data-uc-click');})()")
                return True
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
    """After Continue, VFS *sometimes* pops a Verify-Captcha modal whose Turnstile
    auto-passes; click its action button when enabled. If no modal appears, don't
    waste the full timeout — only wait when an overlay/dialog is actually present."""
    has_modal = await jeval(page, "!!document.querySelector('.cdk-overlay-pane, mat-dialog-container, [role=dialog]')")
    if not has_modal:
        return
    await click_button_text(page, ["submit", "verify", "confirm", "proceed"], timeout=25)


async def dump_state(page, label):
    """Diagnostic: log url + visible buttons (text/disabled) + dropdown count + key inputs."""
    info = await jeval(page, """(()=>{const vis=e=>e&&e.offsetParent!==null;
        const btns=[...document.querySelectorAll('button')].filter(vis).map(b=>({t:(b.innerText||'').trim().slice(0,24),d:!!b.disabled})).slice(0,12);
        const sels=[...document.querySelectorAll('mat-select')].filter(vis).length;
        const inputs=[...document.querySelectorAll('input')].filter(vis).map(i=>i.getAttribute('formcontrolname')||i.getAttribute('id')||i.type).slice(0,12);
        const h=(document.querySelector('h1,h2,mat-card-title,.mat-card-title')||{}).innerText||'';
        return JSON.stringify({url:location.href.split('/').slice(-1)[0].split('?')[0], heading:h.slice(0,50), selects:sels, inputs, btns});})()""")
    log(f"STATE[{label}]:", info)
    try:
        await shot(page, f"book_{label}")
    except Exception:
        pass


async def book(page, subcat):
    log("BOOK: slot found, starting booking flow")
    # The sub-category dropdown we just picked may leave a CDK overlay backdrop up;
    # close it so the Continue click lands on the button, not the backdrop.
    await close_overlay(page)
    await asyncio.sleep(0.5)
    await dump_state(page, "0_appointment_details")
    # Step 1 → Continue. Capture the page IMMEDIATELY after the click to see if a
    # captcha/Verify modal appears (and what its button is).
    await click_button_text(page, ["continue"])
    await asyncio.sleep(2)
    await dump_state(page, "1a_post_continue_click")
    await handle_captcha_modal(page)
    await asyncio.sleep(2)
    await dump_state(page, "1_after_continue")
    # Step 2 — Your Details: this is a PASSPORT-IMAGE UPLOAD step (not a form). VFS
    # OCR-extracts the applicant's identity from an uploaded BIO-page scan; there are
    # no name/passport text fields to fill. Set the file input directly (works even
    # when the input is hidden behind a "Browse Files" link), wait for OCR, then Save.
    file_inputs = await page.select_all('input[type=file]')
    if file_inputs and os.path.exists(PASSPORT_IMAGE):
        try:
            await file_inputs[0].send_file(PASSPORT_IMAGE)
            log("BOOK: uploaded passport image:", PASSPORT_IMAGE)
        except Exception as e:
            log("BOOK: passport upload failed:", e)
        await asyncio.sleep(8)  # VFS uploads the file
        await dump_state(page, "2a_after_upload")
        # The upload card shows a "Continue" link that PROCESSES/OCR-extracts the
        # doc — must be clicked BEFORE Save (Save alone is a no-op until processed).
        await click_button_text(page, ["continue"], timeout=15)
        await asyncio.sleep(7)  # OCR extraction
        await dump_state(page, "2b_after_process")
    else:
        log("BOOK: no file input or passport image missing", "(inputs=%d, img=%s)" % (len(file_inputs), PASSPORT_IMAGE))
    # Save the applicant (footer Save) → applicant Summary page.
    await click_button_text(page, ["save"], timeout=30)
    await asyncio.sleep(3)
    await dump_state(page, "2c_after_save")
    # Summary page → Continue advances to the OTP gate. Snapshot existing Mailsac
    # message ids first so we can distinguish the new OTP email from old mail.
    pre_ids = set(m.get("_id") for m in mailsac_list(EMAIL))
    # The Summary "Continue" is flaky (sometimes needs a second click) and the OTP
    # gate loads slowly — re-click Continue each iteration until the gate appears
    # (≤40s). Re-clicking is safe: the OTP page's Continue is disabled until a code
    # is entered, so an extra click there is a no-op.
    body_txt = ""
    for _ in range(20):
        body_txt = (await jeval(page, "(document.body.innerText||'').toLowerCase()")) or ""
        if "one-time password" in body_txt or "generate otp" in body_txt:
            break
        await click_button_text(page, ["continue", "proceed"], timeout=4)
        await asyncio.sleep(2)
    await dump_state(page, "3a_otp_gate")
    # OTP step: VFS gates step 3 behind an email/SMS OTP sent to the (Mailsac)
    # account email. Generate → poll Mailsac for the code → fill → Continue.
    if "one-time password" in body_txt or "generate otp" in body_txt:
        await click_button_text(page, ["generate otp", "generate"], timeout=15)
        await asyncio.sleep(3)
        await dump_state(page, "3a2_otp_input")  # reveal the OTP-entry field DOM
        log("OTP: Generate clicked — polling Mailsac for the code…")
        milestone("otp_requested", email=EMAIL)
        code = await mailsac_otp_code(EMAIL, pre_ids, timeout=120)
        if code:
            log("OTP: received code", code)
            # Tag the VISIBLE OTP input (generic selectors matched a hidden input
            # last time → field stayed empty, Verify never enabled). Prefer one whose
            # placeholder/formcontrolname mentions OTP, else the first visible input.
            await jeval(page, """(()=>{const ins=[...document.querySelectorAll('input')].filter(i=>i.offsetParent!==null && i.type!=='hidden');
                const t=ins.find(i=>/otp/i.test((i.getAttribute('placeholder')||'')+(i.getAttribute('formcontrolname')||'')+(i.getAttribute('aria-label')||'')+(i.id||''))) || ins[0];
                document.querySelectorAll('[data-uc-otp]').forEach(e=>e.removeAttribute('data-uc-otp'));
                if(t)t.setAttribute('data-uc-otp','1');})()""")
            otp_el = await page.select('input[data-uc-otp="1"]', timeout=4)
            if otp_el:
                try:
                    await otp_el.click()
                    await otp_el.send_keys(code)
                except Exception as e:
                    log("OTP: send_keys err:", e)
                await asyncio.sleep(0.6)
                val = await jeval(page, "(()=>{const e=document.querySelector('input[data-uc-otp]'); return e?e.value:'';})()")
                if not val:  # Angular didn't pick up the keystrokes — set value + fire input
                    await jeval(page, "(()=>{const e=document.querySelector('input[data-uc-otp]'); e.value=%s; e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('blur',{bubbles:true}));})()" % json.dumps(code))
                    val = await jeval(page, "(()=>{const e=document.querySelector('input[data-uc-otp]'); return e?e.value:'';})()")
                log("OTP: field value now:", val)
            else:
                log("OTP: visible input not found")
            milestone("otp_filled", email=EMAIL)
            await asyncio.sleep(1)
            await click_button_text(page, ["verify"], timeout=20)  # verify the OTP
            await asyncio.sleep(3)
            await dump_state(page, "3b_after_otp")
            # Then footer Continue leaves the OTP page → Book Appointment. Re-click
            # until the heading is no longer the OTP page (≤30s).
            for _ in range(15):
                hd = (await jeval(page, "(document.querySelector('h1,h2,mat-card-title')||{}).innerText||''")) or ""
                if "one-time password" not in hd.lower():
                    break
                await click_button_text(page, ["continue", "proceed"], timeout=4)
                await asyncio.sleep(2)
        else:
            log("OTP: no code from Mailsac within timeout — cannot pass the OTP gate")
            milestone("otp_timeout", email=EMAIL, error="otp_timeout")
            await dump_state(page, "3b_after_otp")
    # Step 3 — Book Appointment (type → date → slot → continue)
    await asyncio.sleep(2)
    await dump_state(page, "3_book_appointment")
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
        return "dry_run", None
    ok = await click_button_text(page, ["submit", "confirm", "pay"], timeout=20)
    await asyncio.sleep(5)  # let VFS redirect/render the outcome page
    await shot(page, "pipe_after_submit")
    url = (await jeval(page, "location.href")) or ""
    body_raw = (await jeval(page, "(document.body.innerText||'')")) or ""
    body_lower = body_raw.lower()
    log("BOOK: submit clicked:", ok, "url:", url)
    # ── Outcome detection ──────────────────────────────────────────────────────
    # 1. Booking confirmed — look for a confirmation/reference code on the page
    conf_m = (re.search(r'(?:confirmation|reference|booking)\s*(?:no\.?|number|ref|#)?\s*[:\-]?\s*([A-Z0-9\-]{6,20})', body_raw, re.I)
              or re.search(r'\b([A-Z]{2,4}[0-9]{4,10})\b', body_raw))
    confirmation = conf_m.group(1).upper() if conf_m else None
    # 2. Payment wall — VFS requires manual payment before finalising the slot
    is_payment = any(kw in body_lower for kw in [
        "payment", "pay now", "proceed to payment", "total amount", "amount due", "fee payable"])
    if confirmation:
        log("BOOK: CONFIRMED! Reference:", confirmation)
        await shot(page, "pipe_confirmed")
        return "confirmed", confirmation
    elif is_payment:
        log("BOOK: PAYMENT WALL reached — appointment reserved, manual payment needed")
        await shot(page, "pipe_payment_wall")
        return "payment_wall", None
    else:
        err_text = await jeval(page, """(()=>{return [...document.querySelectorAll('mat-error,.mat-error,[class*="error" i],[class*="alert" i]')].filter(e=>e.offsetParent).map(e=>(e.innerText||'').trim().slice(0,80)).filter(Boolean).slice(0,3).join('; ');})()""") or ""
        reason = (err_text or body_raw[:120]).strip()
        log("BOOK: submit outcome uncertain, ok=%s, reason=%s" % (ok, reason[:80]))
        await shot(page, "pipe_submit_uncertain")
        return "failed", reason[:120]


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
                outcome, _ = await book(page, slot)
                milestone("booking_submitted", email=EMAIL, slotId=slot, detail="dry_run")
                break
            elif BOOK_ENABLED:
                outcome, confirmation = await book(page, slot)
                if outcome == "confirmed":
                    milestone("booked", email=EMAIL, slotId=slot, confirmation=confirmation)
                elif outcome == "payment_wall":
                    # Slot reserved; payment is manual — emit booking_submitted not booked
                    milestone("booking_submitted", email=EMAIL, slotId=slot, detail="payment_wall")
                else:
                    milestone("failed", email=EMAIL, error=f"booking_{outcome}: {confirmation or ''}", slotId=slot)
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
