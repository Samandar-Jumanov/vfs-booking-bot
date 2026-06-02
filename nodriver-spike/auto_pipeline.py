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
  -- Lift-API availability monitor (cheap authed slot check, see
     docs/LIFT_API_AVAILABILITY_SPEC.md) --
  VFS_COUNTRY       source country code for CheckIsSlotAvailable (default "uzb")
  VFS_MISSION       destination/mission code                     (default "lva")
  VFS_VAC           centre / VAC code                            (default "TAS")
  VFS_VISACAT       visa category code (Work D-visa UZ→LVA)      (default "WDVUZ")
"""
import asyncio
import os
import re
import sys
import json
import pathlib
import urllib.error
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

# ── Lift-API availability monitoring (cheap, authed slot check) ───────────────
# Instead of driving the booking-wizard UI every monitor cycle (slow, heavy on the
# IP → Datadome throttle, fragile), poll VFS's own authed availability endpoint:
#   POST https://lift-api.vfsglobal.com/appointment/CheckIsSlotAvailable
# We capture the custom auth headers (authorize/clientsource/route) the browser
# sends on its OWN lift-api requests after login (see _install_auth_capture), then
# replay the slot check from INSIDE the browser via fetch() so it reuses the live
# session/cookies/origin (most Cloudflare-happy). Spec: docs/LIFT_API_AVAILABILITY_SPEC.md.
LIFT_API_URL = "https://lift-api.vfsglobal.com/appointment/CheckIsSlotAvailable"
VFS_COUNTRY = os.environ.get("VFS_COUNTRY", "uzb")     # source country code
VFS_MISSION = os.environ.get("VFS_MISSION", "lva")     # destination/mission code
VFS_VAC = os.environ.get("VFS_VAC", "TAS")             # centre/VAC code (Tashkent)
VFS_VISACAT = os.environ.get("VFS_VISACAT", "WDVUZ")   # visa category (Work D-visa UZ→LVA)
# Captured at login from the browser's own authed lift-api requests. Empty until
# capture succeeds → monitor falls back to the UI select_route() path (current
# behaviour), so nothing breaks if capture never fires.
_LIFT_AUTH = {"authorize": None, "clientsource": None, "route": None}


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
    """Return Mailsac messages for an address (newest first), or [] on non-429 error.
    Raises urllib.error.HTTPError on HTTP 429 so the caller can apply backoff."""
    if not MAILSAC_KEY:
        return []
    enc = urllib.parse.quote(email, safe="")
    try:
        req = urllib.request.Request(f"https://mailsac.com/api/addresses/{enc}/messages", headers=_MAILSAC_HDR)
        return json.loads(urllib.request.urlopen(req, timeout=20).read()) or []
    except urllib.error.HTTPError:
        raise  # propagate 429 (and other HTTP errors) to the caller
    except Exception as e:
        log("mailsac list err:", e); return []


def mailsac_body(email, mid):
    """Fetch message text. Raises urllib.error.HTTPError on HTTP 429."""
    enc = urllib.parse.quote(email, safe="")
    try:
        req = urllib.request.Request(f"https://mailsac.com/api/text/{enc}/{urllib.parse.quote(str(mid), safe='')}", headers=_MAILSAC_HDR)
        return urllib.request.urlopen(req, timeout=20).read().decode("utf-8", "replace")
    except urllib.error.HTTPError:
        raise
    except Exception as e:
        log("mailsac body err:", e); return ""


async def mailsac_otp_code(email, exclude_ids, timeout=120):
    """Poll Mailsac for a NEW message and extract its OTP code (4-8 digits).
    Backs off on HTTP 429 (Retry-After header or exponential, capped at 30s)."""
    import time as _t
    deadline = _t.time() + timeout
    _backoff = 2  # 429 exponential backoff state (seconds)
    while _t.time() < deadline:
        try:
            msgs = mailsac_list(email)
        except urllib.error.HTTPError as exc:
            if exc.code == 429:
                ra = exc.headers.get("Retry-After", "")
                wait = min(int(ra) if ra.isdigit() else _backoff, 30)
                log(f"OTP Mailsac 429 — backing off {wait}s")
                await asyncio.sleep(min(wait, max(deadline - _t.time(), 0)))
                _backoff = min(_backoff * 2, 30)
                continue
            msgs = []
        for m in msgs:
            mid = m.get("_id")
            if mid in exclude_ids:
                continue
            try:
                body = mailsac_body(email, mid) or ""
            except urllib.error.HTTPError:
                body = ""
            text = (m.get("subject", "") or "") + " " + body
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


def _telegram_text_raw(tok, chat, msg):
    """Send a plain Telegram message directly (NOT gated by WORKER_BRIDGED).
    Used as a fallback when a screenshot file is missing for telegram_photo()."""
    try:
        data = json.dumps({"chat_id": chat, "text": msg}).encode()
        req = urllib.request.Request(f"https://api.telegram.org/bot{tok}/sendMessage", data=data,
                                     headers={"Content-Type": "application/json"})
        urllib.request.urlopen(req, timeout=15)
    except Exception as e:
        log("telegram text fallback failed:", e)


def telegram_photo(path, caption):
    """Send a screenshot to Telegram as a captioned PHOTO (Telegram sendPhoto).

    Works even in WORKER_BRIDGED mode — block alerts must reach the operator
    instantly, and photos bypass the milestone bridge (the Python on the VPS has
    the screenshot file locally). Guarded: missing TELEGRAM_* env or a missing
    file degrades to a text alert / log and NEVER crashes the booking run.
    """
    tok = os.environ.get("TELEGRAM_BOT_TOKEN"); chat = os.environ.get("TELEGRAM_CHAT_ID")
    if not tok or not chat:
        log("(telegram photo not configured)", caption); return
    try:
        p = pathlib.Path(path)
        if not p.exists():
            log("telegram photo: file missing, sending text instead:", str(p))
            _telegram_text_raw(tok, chat, caption + " (screenshot unavailable)")
            return
        img = p.read_bytes()
        boundary = "----vfsbot" + str(os.getpid())

        def _field(name, value):
            return (("--" + boundary + "\r\n"
                     "Content-Disposition: form-data; name=\"" + name + "\"\r\n\r\n"
                     + str(value) + "\r\n").encode("utf-8"))

        body = b""
        body += _field("chat_id", chat)
        body += _field("caption", caption)
        body += (("--" + boundary + "\r\n"
                  "Content-Disposition: form-data; name=\"photo\"; filename=\"" + p.name + "\"\r\n"
                  "Content-Type: image/png\r\n\r\n").encode("utf-8"))
        body += img + b"\r\n"
        body += ("--" + boundary + "--\r\n").encode("utf-8")
        req = urllib.request.Request(
            f"https://api.telegram.org/bot{tok}/sendPhoto",
            data=body,
            headers={"Content-Type": "multipart/form-data; boundary=" + boundary},
        )
        urllib.request.urlopen(req, timeout=30)
        log("telegram photo sent:", caption)
    except Exception as e:
        log("telegram photo failed:", e)
        # last-resort text so the alert still goes out
        _telegram_text_raw(tok, chat, caption + " (photo send failed)")


def shot_path(name):
    """Absolute path to a screenshot taken by shot(name)."""
    return str(SHOTS / f"{name}.png")


def classify_block(url, body):
    """Map a terminal/block page to a SPECIFIC reason code so the operator's
    alert names the cause instead of a generic 'failed'. Checked most-specific
    first. Returns one of:
      rate_limit_429202 | rate_limit_429001 | session_expired | datadome_block
      | turnstile_wall | payment_wall | submit_uncertain
    """
    u = (url or "").lower()
    b = (body or "").lower()
    # 429 sub-codes are the most actionable — branch on the exact code first.
    if "429202" in b:
        return "rate_limit_429202"
    if "429001" in b:
        return "rate_limit_429001"
    if "session expired" in b or "session-expired" in u or "your session has expired" in b:
        return "session_expired"
    if "page-not-found" in u or "page not found" in b or "access denied" in b or "datadome" in b:
        return "datadome_block"
    # generic 429 with no readable sub-code → assume IP/session (429202 class)
    if "429" in b or "too many requests" in b or "rate limit" in b:
        return "rate_limit_429202"
    if "access restricted" in b:
        return "rate_limit_429001"
    if "verify you are human" in b or "turnstile" in b or "are you a robot" in b or "captcha" in b:
        return "turnstile_wall"
    if any(k in b for k in ["payment", "pay now", "total amount", "amount due", "fee payable"]):
        return "payment_wall"
    return "submit_uncertain"


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


async def wait_until(page, js_predicate, timeout, interval=0.4):
    """Poll js_predicate every interval seconds until truthy or timeout.
    Returns True when ready, False on timeout. Max-timeout cap prevents hanging."""
    import time as _t
    deadline = _t.time() + timeout
    while _t.time() < deadline:
        try:
            if await jeval(page, js_predicate):
                return True
        except Exception:
            pass
        remaining = deadline - _t.time()
        if remaining <= 0:
            break
        await asyncio.sleep(min(interval, remaining))
    return False


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


# ── Lift-API auth capture + availability check ───────────────────────────────
async def _install_auth_capture(page):
    """Attach a CDP RequestWillBeSent handler that records the custom auth headers
    (authorize / clientsource / route) the browser sends on its OWN lift-api
    requests. Same proven approach as login_spike.py:101-123. Best-effort: if CDP
    setup fails, capture stays empty and the monitor falls back to the UI path.

    NOTE: these custom headers are only sent on AUTHENTICATED lift-api calls, which
    fire AFTER login (e.g. when the dashboard/wizard loads). So this must be
    installed BEFORE login and the wizard navigation so we catch the first one."""
    try:
        from nodriver import cdp

        async def on_req(evt):
            try:
                u = evt.request.url
                if "lift-api" not in u:
                    return
                hdrs = dict(evt.request.headers or {})
                for k, v in hdrs.items():
                    lk = k.lower()
                    if lk in ("authorize", "clientsource", "route") and v:
                        if _LIFT_AUTH.get(lk) != v:
                            _LIFT_AUTH[lk] = v
                            log(f"AUTH-CAPTURE: {lk}={str(v)[:24]}…")
            except Exception:
                pass

        page.add_handler(cdp.network.RequestWillBeSent, on_req)
        await page.send(cdp.network.enable())
        log("AUTH-CAPTURE: CDP network capture enabled")
        return True
    except Exception as e:
        log("AUTH-CAPTURE: setup failed (UI fallback will be used):", str(e)[:80])
        return False


def auth_captured():
    """True once both required custom auth headers were sniffed off a lift-api req."""
    return bool(_LIFT_AUTH.get("authorize") and _LIFT_AUTH.get("clientsource"))


async def api_check_availability(page):
    """Poll VFS's authed CheckIsSlotAvailable endpoint via an IN-BROWSER fetch()
    (reuses the live session/cookies/origin — most Cloudflare-happy). Returns a
    dict {earliestDate, earliestSlotLists, error, _status} on a parsed HTTP
    response, or None on a transport/JS failure (caller then falls back to UI).

    Body params come from env (defaults from docs/LIFT_API_AVAILABILITY_SPEC.md):
    countryCode=VFS_COUNTRY, missionCode=VFS_MISSION, vacCode=VFS_VAC,
    visaCategoryCode=VFS_VISACAT, roleName='Individual', loginUser=<email>, payCode=''.
    """
    if not auth_captured():
        return None
    body = {
        "countryCode": VFS_COUNTRY,
        "missionCode": VFS_MISSION,
        "vacCode": VFS_VAC,
        "visaCategoryCode": VFS_VISACAT,
        "roleName": "Individual",
        "loginUser": EMAIL,
        "payCode": "",
    }
    headers = {
        "authorize": _LIFT_AUTH.get("authorize") or "",
        "clientsource": _LIFT_AUTH.get("clientsource") or "",
        "content-type": "application/json;charset=UTF-8",
        "accept": "application/json, text/plain, */*",
    }
    if _LIFT_AUTH.get("route"):
        headers["route"] = _LIFT_AUTH["route"]
    # The fetch runs in the page's own origin, so cookies (cf_clearance etc.) ride
    # along with credentials:'include'. We JSON-serialize url/headers/body into the
    # snippet so there's no string-escaping ambiguity, and return a JSON string the
    # Python side parses (jeval already _unwraps nodriver's value wrapper).
    payload = json.dumps({"url": LIFT_API_URL, "headers": headers, "body": body})
    expr = (
        "(async()=>{const cfg=%s;try{"
        "const r=await fetch(cfg.url,{method:'POST',headers:cfg.headers,"
        "body:JSON.stringify(cfg.body),credentials:'include'});"
        "let j=null;try{j=await r.json();}catch(e){j=null;}"
        "return JSON.stringify({status:r.status,data:j});"
        "}catch(e){return JSON.stringify({status:0,error:String(e)});}})()"
    ) % payload
    raw = await jeval(page, expr)
    if not raw:
        log("API: in-browser fetch returned nothing")
        return None
    try:
        env = json.loads(raw) if isinstance(raw, str) else raw
    except Exception as e:
        log("API: could not parse fetch result:", str(e)[:60])
        return None
    status = env.get("status", 0)
    data = env.get("data") or {}
    if status == 0:
        log("API: fetch transport error:", str(env.get("error"))[:80])
        return None
    if status != 200:
        log(f"API: HTTP {status} from CheckIsSlotAvailable", str(data)[:120])
    out = {
        "earliestDate": (data or {}).get("earliestDate"),
        "earliestSlotLists": (data or {}).get("earliestSlotLists") or [],
        "error": (data or {}).get("error"),
        "_status": status,
    }
    return out


# ── LOGIN ──────────────────────────────────────────────────────────────────
async def do_login(browser, page):
    log("LOGIN: navigating")
    # Wait until any login-form element appears (cap 10s; faster on good connections).
    await wait_until(page,
        "(()=>{return !!document.querySelector('#email,input[type=email],[formcontrolname=emailid]');})()",
        timeout=10, interval=0.5)
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

# ── Route-walk cache ─────────────────────────────────────────────────────────
# After the first successful select_route, remember the dropdown geometry so
# subsequent monitor checks skip the (slow) full SCAN of every mat-select. The
# subcat dropdown index isn't guaranteed stable across reloads, so we verify the
# cached index still exposes a subcat-shaped option list before trusting it and
# fall back to a full re-scan (once) if it doesn't.
_ROUTE_CACHE = {"sub_idx": None, "subcat_texts": None}


async def _option_texts(page, index, label, polls=5):
    """Open dropdown #index, return stripped option texts, and close the overlay."""
    opts = await open_select(page, index, label, polls=polls)
    ot = [(o.text or "").strip() for o in opts]
    await close_overlay(page)
    return ot


async def _scan_for_subcat(page):
    """SCAN every dropdown for the one whose options look like the subcat list
    (work/cargo/ocma…). Returns (sub_idx, texts) or (None, []). Slow path."""
    for it in range(10):
        selects = await page.select_all("mat-select")
        log(f"scan iter {it}: {len(selects)} dropdowns")
        for i in range(len(selects)):
            ot = await _option_texts(page, i, f"scan[{i}]")
            log(f"  scan[{i}] sample:", ot[:3])
            if any(SUBCAT_LIST_RE.search(t) for t in ot):
                return i, ot
        await asyncio.sleep(2.5)
    return None, []


async def _try_subcat(page, sub_idx, texts):
    """Given the subcat dropdown index + its option texts, pick each Work-D-visa
    option and check whether a slot is available (Continue enabled). Returns the
    chosen subcat text on a hit, else None."""
    work = [t for t in texts if SUBCAT.search(t)]
    if not work:
        log("no Work-D-visa sub-category in list"); return None
    for wt in work:
        opts = await open_select(page, sub_idx, "subcat")
        picked = await pick_option(opts, lambda t, wt=wt: t == wt, "sub:" + wt[:18])
        if not picked:
            continue
        # VFS evaluates availability → enables Continue. Poll (≤3s) instead of a
        # blind sleep so the happy path is fast but slow evaluations still pass.
        if await wait_until(page,
                "(()=>{const b=[...document.querySelectorAll('button')].find(x=>/continue/i.test(x.innerText||'')&&x.offsetParent); return b?!b.disabled:false;})()",
                timeout=3, interval=0.3):
            log("SLOT AVAILABLE in:", wt); return wt
        log("no slot in:", wt)
    return None


async def select_route(page):
    """Pick centre + category + a Work-D-visa subcat that has slots. Robust to
    VFS's dependent (API-loaded) dropdowns. Returns the chosen subcat if a slot
    is available (Continue enabled), else None.

    Fast path: once the subcat dropdown index is cached, skip the full SCAN and
    go straight to it; re-scan only if the cached index no longer matches."""
    # wait for the form to render at least one dropdown
    for _ in range(20):
        if await page.select_all("mat-select"):
            break
        await asyncio.sleep(1)

    # centre (index 0): retry until it opens with options, pick first. Poll for
    # the selection to register instead of a fixed 2s tail-sleep.
    for _ in range(4):
        opts = await open_select(page, 0, "centre")
        if opts:
            await pick_option(opts, lambda t: True, "centre")
            break
        await asyncio.sleep(2)
    # category dropdown (index 1) becomes populated after centre is chosen; wait
    # for it to expose options (≤4s) rather than sleeping a flat 2s.
    await wait_until(page,
        "(()=>{const s=document.querySelectorAll('mat-select'); return s.length>1;})()",
        timeout=4, interval=0.3)

    # category (index 1): pick "Long Stay/Visa D"
    opts = await open_select(page, 1, "category")
    if opts:
        await pick_option(opts, lambda t: re.search("long stay", t, re.I), "category")

    # ── FAST PATH: trust the cached subcat dropdown index ─────────────────────
    cached_idx = _ROUTE_CACHE["sub_idx"]
    if cached_idx is not None:
        selects = await page.select_all("mat-select")
        if cached_idx < len(selects):
            # Wait briefly for the (API-loaded) subcat dropdown to populate at the
            # cached index, then verify its options still look like the subcat list.
            texts = []
            for _ in range(6):  # ≤~3s
                texts = await _option_texts(page, cached_idx, "subcat(cached)")
                if any(SUBCAT_LIST_RE.search(t) for t in texts):
                    break
                await asyncio.sleep(0.5)
            if any(SUBCAT_LIST_RE.search(t) for t in texts):
                log(f"subcat fast-path: cached index {cached_idx}; options:", texts)
                _ROUTE_CACHE["subcat_texts"] = texts
                return await _try_subcat(page, cached_idx, texts)
        log("subcat fast-path: cached index no longer matches — re-scanning")

    # ── SLOW PATH: scan every dropdown for the subcat list, then cache it ──────
    sub_idx, texts = await _scan_for_subcat(page)
    if sub_idx is None:
        log("subcat dropdown not found (still loading?)"); return None
    log(f"subcat at index {sub_idx}; options:", texts)
    _ROUTE_CACHE["sub_idx"] = sub_idx
    _ROUTE_CACHE["subcat_texts"] = texts
    return await _try_subcat(page, sub_idx, texts)


# ── BOOKING (Phase D) — ported from extension runBookingSteps ───────────────
# Applicant identity is extracted by VFS OCR from the passport image — no text
# fields to fill. Supply a real passport BIO-page scan (PNG/JPG/PDF ≤2MB).
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
        # Wait until upload is reflected (a "Continue" or processing button appears), cap 10s.
        await wait_until(page,
            "(()=>{const bs=[...document.querySelectorAll('button,a')].filter(b=>b.offsetParent&&/continue|process/i.test(b.innerText||'')); return bs.length>0;})()",
            timeout=10, interval=0.5)
        await dump_state(page, "2a_after_upload")
        # The upload card shows a "Continue" link that PROCESSES/OCR-extracts the
        # doc — must be clicked BEFORE Save (Save alone is a no-op until processed).
        await click_button_text(page, ["continue"], timeout=15)
        # Wait until OCR is done (Save button enabled), cap 8s.
        await wait_until(page,
            "(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.offsetParent&&!b.disabled&&/save/i.test(b.innerText||'')); return !!b;})()",
            timeout=8, interval=0.5)
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
            telegram_photo(shot_path("book_3b_after_otp"), f"⏱ OTP timeout (check MAILSAC_API_KEY) — {EMAIL}")
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
    # Wait until outcome content appears (confirmation/payment/error), cap 6s.
    await wait_until(page,
        "(()=>{const t=document.body.innerText||''; return /confirmation|reference|payment|pay now|total amount|amount due|fee payable|error occurred|booking failed/i.test(t);})()",
        timeout=6, interval=0.4)
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
        # Classify the block with a SPECIFIC reason code (429202/429001, session
        # expired, datadome, turnstile, …) so the alert is actionable, not "failed".
        reason_code = classify_block(url, body_lower)
        err_text = await jeval(page, """(()=>{return [...document.querySelectorAll('mat-error,.mat-error,[class*="error" i],[class*="alert" i]')].filter(e=>e.offsetParent).map(e=>(e.innerText||'').trim().slice(0,80)).filter(Boolean).slice(0,3).join('; ');})()""") or ""
        log("BOOK: submit blocked, ok=%s, reason=%s, detail=%s" % (ok, reason_code, (err_text or body_raw[:80])[:80]))
        await shot(page, "pipe_submit_uncertain")
        return "failed", reason_code


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
    # Install the lift-api auth-header capture BEFORE login so we sniff authorize/
    # clientsource off the browser's first authed lift-api request (fires once the
    # dashboard/wizard loads). Enables the cheap API monitor; if it never captures,
    # the monitor falls back to the UI select_route() path (current behaviour).
    await _install_auth_capture(page)

    if not await do_login(browser, page):
        # Classify WHY login failed (datadome page-not-found, session expired,
        # turnstile wall, 429…) so the operator's alert is specific, not "failed".
        lf_url = (await jeval(page, "location.href")) or ""
        lf_body = (await jeval(page, "(document.body.innerText||'')")) or ""
        reason_code = classify_block(lf_url, lf_body.lower())
        if reason_code == "submit_uncertain":
            reason_code = "login_failed"  # nothing block-specific matched
        log("RESULT: LOGIN FAILED —", reason_code, "url:", lf_url)
        await shot(page, "pipe_login_failed")
        milestone("failed", email=EMAIL, error=reason_code)
        telegram_photo(shot_path("pipe_login_failed"), f"❌ Login blocked: {reason_code} — {EMAIL}")
        await asyncio.sleep(5); browser.stop(); return
    log("LOGIN OK")
    milestone("logged_in", email=EMAIL)
    telegram(f"[bot] logged in {EMAIL}, monitoring Work D-visa slots…")

    await enter_wizard(page)
    await shot(page, "pipe_wizard")
    milestone("monitoring", email=EMAIL)

    # ── Monitor loop ─────────────────────────────────────────────────────────
    # PRIMARY path: poll VFS's authed CheckIsSlotAvailable endpoint (cheap, fast,
    # ~1 req/cycle — far gentler on the IP than driving the UI wizard every check).
    # Drive the UI (select_route) ONLY when the API says a slot exists OR when the
    # API is unavailable/erroring (fallback → preserves current capability).
    attempt = 0
    api_fail_streak = 0  # consecutive API failures → trigger header re-capture / re-login flag
    while True:
        attempt += 1
        log(f"--- check #{attempt} ---")

        slot = None          # truthy → a slot to book (UI subcat text OR API earliestDate)
        used_api = False     # did the cheap API path resolve this cycle?

        if auth_captured():
            api = await api_check_availability(page)
            if api is not None:
                status = api.get("_status", 0)
                err = api.get("error")
                if status == 200 and not err:
                    used_api = True
                    api_fail_streak = 0
                    earliest = api.get("earliestDate")
                    slot_lists = api.get("earliestSlotLists") or []
                    if earliest or slot_lists:
                        slot = earliest or "slot"  # marker; UI re-picks the real subcat to book
                        log("API: SLOT AVAILABLE — earliestDate=%s, lists=%d" % (earliest, len(slot_lists)))
                    else:
                        log("API: no slots (earliestDate null)")
                else:
                    # 401/403/429 or an error envelope → don't trust it; fall back to UI.
                    api_fail_streak += 1
                    code = (err or {}).get("code") if isinstance(err, dict) else None
                    log(f"API: unusable (status={status}, code={code}, streak={api_fail_streak}) — falling back to UI")
            else:
                api_fail_streak += 1
                log(f"API: call failed (streak={api_fail_streak}) — falling back to UI")
        else:
            log("API: auth headers not captured yet — using UI path")

        # FALLBACK / BACKWARD-COMPAT: if the API didn't resolve this cycle, run the
        # existing UI slot check (unchanged behaviour). Also used when API found a
        # slot but we still need the UI to navigate to bookable state — select_route
        # both confirms availability AND leaves the wizard ready for book().
        if not used_api or slot:
            ui_slot = await select_route(page)
            if slot:
                # API flagged a slot; prefer the concrete subcat select_route lands on
                # (book() needs the wizard in the picked state). If the UI couldn't
                # confirm it, keep the API marker so we still attempt to book.
                slot = ui_slot or slot
            else:
                slot = ui_slot

        if slot:
            milestone("slot_found", email=EMAIL, slotId=slot)
            telegram(f"[bot] SLOT FOUND for {EMAIL}: {slot}")
            if BOOK_DRY_RUN:
                outcome, _ = await book(page, slot)
                milestone("booking_submitted", email=EMAIL, slotId=slot, detail="dry_run")
                break
            elif BOOK_ENABLED:
                # book() returns (outcome, detail) where detail is the confirmation
                # number (confirmed) or a specific reason code (failed).
                outcome, detail = await book(page, slot)
                if outcome == "confirmed":
                    milestone("booked", email=EMAIL, slotId=slot, confirmation=detail)
                    telegram_photo(shot_path("pipe_confirmed"), f"🎉 Booked: {detail} — {EMAIL} ({slot})")
                elif outcome == "payment_wall":
                    # Slot reserved; payment is manual — emit booking_submitted not booked
                    milestone("booking_submitted", email=EMAIL, slotId=slot, detail="payment_wall")
                    telegram_photo(shot_path("pipe_payment_wall"), f"⚠️ Payment wall — manual payment needed — {EMAIL} ({slot})")
                else:
                    # detail is a specific reason code from classify_block().
                    milestone("failed", email=EMAIL, error=detail, slotId=slot)
                    telegram_photo(shot_path("pipe_submit_uncertain"), f"❌ Booking blocked: {detail} — {EMAIL} ({slot})")
                break
            else:
                log("slot found but BOOK_ENABLED off — stopping for operator")
                break

        log(f"no slot — re-checking in {MONITOR_INTERVAL}s")
        # emit a per-check milestone so the backend sends a "no slots" Telegram
        # on EVERY check (operator wants a message each time, not a summary).
        path_tag = "api" if used_api else "ui"
        milestone("monitoring", email=EMAIL, detail=f"check #{attempt} ({path_tag}) — Work D-visa, no slots")
        await asyncio.sleep(MONITOR_INTERVAL)

        if used_api:
            # Cheap path: no UI reload needed — the next fetch re-reads availability
            # live. But on repeated API failures (token expiry/403), drop back to the
            # UI reload so we re-capture fresh auth headers off the browser's requests.
            if api_fail_streak >= 3:
                log("API: repeated failures — reloading wizard to re-capture auth headers")
                await jeval(page, "location.reload()")
                await wait_until(page,
                    "(()=>{return !!document.querySelector('mat-select') || /start new booking|book appointment|new booking/i.test(document.body.innerText||'');})()",
                    timeout=8, interval=0.4)
                await enter_wizard(page)
                api_fail_streak = 0
        else:
            # UI fallback path: go back to a clean Appointment Details state. The
            # reload forces VFS to re-evaluate availability (required for a fresh
            # read); after it, wait for the wizard form to re-render (≤8s) instead of
            # a flat 8s sleep so a fast reload starts the next check sooner.
            await jeval(page, "location.reload()")
            await wait_until(page,
                "(()=>{return !!document.querySelector('mat-select') || /start new booking|book appointment|new booking/i.test(document.body.innerText||'');})()",
                timeout=8, interval=0.4)
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
