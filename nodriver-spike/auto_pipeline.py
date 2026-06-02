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
import random
import re
import ssl
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
DASHBOARD_URL = os.environ.get("VFS_DASHBOARD_URL", LOGIN_URL.replace("/login", "/dashboard"))
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
# The REAL availability-request body the browser POSTs when the wizard fires its
# OWN CheckIsSlotAvailable (captured off request.post_data). The env defaults
# (VFS_VAC/VFS_VISACAT etc.) are GUESSES — if wrong, the API returns
# earliestDate:null = a silent false "no slots". Capturing the wizard's real body
# gives us the authoritative codes. Empty until the UI walk triggers the request.
_LIFT_BODY = {
    "countryCode": None,
    "missionCode": None,
    "vacCode": None,
    "visaCategoryCode": None,
}
# True once _LIFT_BODY holds both the vacCode + visaCategoryCode the wizard used.
# Until then we MUST drive the UI walk (select_route) first so VFS fires its own
# CheckIsSlotAvailable and we sniff the correct codes — only then is the fast API
# poll path trustworthy.
_CODES_CONFIRMED = False
# Logged once so the operator can see which code source the first API call used.
_API_SOURCE_LOGGED = False
# DIAGNOSTIC: run the token-replay probe only once per run.
_REPLAY_PROBED = False
# A realistic desktop-Chrome UA for the direct (non-browser) replay probe.
BROWSER_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")


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


def _tg_ssl_ctx():
    """SSL context for api.telegram.org that tolerates the VPS's TLS-intercepting
    (self-signed) cert chain. The Eskiz Windows VPS MITMs outbound TLS, so the
    default verifying context raises `CERTIFICATE_VERIFY_FAILED — self-signed
    certificate in certificate chain` and the operator gets NO alerts. Telegram
    notifications are not security-sensitive, so unverified is the pragmatic call.
    """
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


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
        urllib.request.urlopen(req, timeout=15, context=_tg_ssl_ctx())
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
        urllib.request.urlopen(req, timeout=15, context=_tg_ssl_ctx())
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
        urllib.request.urlopen(req, timeout=30, context=_tg_ssl_ctx())
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
                # Also sniff the REAL request body of the wizard's OWN
                # CheckIsSlotAvailable POST → authoritative vac/visacat/country/
                # mission codes (the env defaults are guesses). CDP exposes the body
                # as request.post_data (nodriver attr) / "postData" (raw dict). Parse
                # the JSON and stash the four codes in _LIFT_BODY.
                if "checkisslotavailable" in u.lower():
                    pd = getattr(evt.request, "post_data", None)
                    if pd is None:
                        try:
                            pd = (evt.request.to_json() or {}).get("postData")
                        except Exception:
                            pd = None
                    if pd:
                        try:
                            j = json.loads(pd)
                        except Exception:
                            j = None
                        if isinstance(j, dict):
                            changed = False
                            for key in ("countryCode", "missionCode",
                                        "vacCode", "visaCategoryCode"):
                                val = j.get(key)
                                if val and _LIFT_BODY.get(key) != val:
                                    _LIFT_BODY[key] = val
                                    changed = True
                            if changed:
                                _maybe_confirm_codes()
                                log("API: captured real codes — vac=%s visacat=%s country=%s mission=%s" % (
                                    _LIFT_BODY.get("vacCode"),
                                    _LIFT_BODY.get("visaCategoryCode"),
                                    _LIFT_BODY.get("countryCode"),
                                    _LIFT_BODY.get("missionCode"),
                                ))
            except Exception:
                pass

        page.add_handler(cdp.network.RequestWillBeSent, on_req)
        # max_post_data_size > 0 is REQUIRED for CDP to include the request body
        # (postData) in RequestWillBeSent. Without it post_data is None → we never
        # capture the wizard's real vac/visacat codes → codes_confirmed() never
        # flips → the monitor is stuck re-walking the heavy UI (full dashboard
        # reload) every cycle → that request volume is what trips 429201. With the
        # body captured, codes confirm after ONE walk and we switch to cheap
        # API-only polling (1 in-browser fetch/cycle) for the rest of the run.
        try:
            await page.send(cdp.network.enable(max_post_data_size=262144))
        except TypeError:
            # Older nodriver without the kwarg — fall back (codes may still be
            # captured via to_json()'s postData on some builds).
            await page.send(cdp.network.enable())
        log("AUTH-CAPTURE: CDP network capture enabled (post-data ON)")
        return True
    except Exception as e:
        log("AUTH-CAPTURE: setup failed (UI fallback will be used):", str(e)[:80])
        return False


def auth_captured():
    """True once both required custom auth headers were sniffed off a lift-api req."""
    return bool(_LIFT_AUTH.get("authorize") and _LIFT_AUTH.get("clientsource"))


def _maybe_confirm_codes():
    """Flip _CODES_CONFIRMED once the wizard's real vac + visacat codes are in
    _LIFT_BODY. After this, api_check_availability() can be trusted with the
    correct body and the monitor can switch from the UI walk to fast API polling."""
    global _CODES_CONFIRMED
    if (not _CODES_CONFIRMED
            and _LIFT_BODY.get("vacCode")
            and _LIFT_BODY.get("visaCategoryCode")):
        _CODES_CONFIRMED = True
        log("API: codes CONFIRMED from wizard — switching to API polling")


def codes_confirmed():
    """True once the wizard's real vacCode + visaCategoryCode have been captured."""
    return _CODES_CONFIRMED


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
    # Prefer the codes the wizard actually used (captured off its CheckIsSlotAvailable
    # POST body) over the GUESSED env defaults. Falling back to env keeps the call
    # working before/if capture never fires.
    global _API_SOURCE_LOGGED
    country = _LIFT_BODY.get("countryCode") or VFS_COUNTRY
    mission = _LIFT_BODY.get("missionCode") or VFS_MISSION
    vac = _LIFT_BODY.get("vacCode") or VFS_VAC
    visacat = _LIFT_BODY.get("visaCategoryCode") or VFS_VISACAT
    if not _API_SOURCE_LOGGED:
        _API_SOURCE_LOGGED = True
        vac_src = "captured" if _LIFT_BODY.get("vacCode") else "env-default"
        cat_src = "captured" if _LIFT_BODY.get("visaCategoryCode") else "env-default"
        log("API: first call codes — vac=%s (%s) visacat=%s (%s) country=%s mission=%s" % (
            vac, vac_src, visacat, cat_src, country, mission))
    body = {
        "countryCode": country,
        "missionCode": mission,
        "vacCode": vac,
        "visaCategoryCode": visacat,
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
    # CRITICAL: the snippet is an async IIFE returning a Promise — nodriver only
    # resolves it when await_promise=True (plain evaluate returns the pending
    # promise → "returned nothing"). Unwrap nodriver's {type,value} wrapper.
    try:
        raw = await page.evaluate(expr, await_promise=True)
        if isinstance(raw, dict) and "value" in raw and set(raw.keys()) <= {"type", "value", "subtype", "className"}:
            raw = raw["value"]
    except Exception as e:
        log("API: evaluate(await_promise) failed:", str(e)[:90])
        return None
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


async def replay_probe(page):
    """DIAGNOSTIC (runs once/run). Fires the SAME CheckIsSlotAvailable as a DIRECT
    Python HTTP request — NO browser, NO cookies — using only the captured
    authorize/clientsource headers. The verdict tells us how to scale:

      • HTTP 200  → the lift-api token is NOT IP/cookie-bound. We can poll from a
                    POOL OF ROTATING IPS reusing one captured token (exactly how
                    the 28k-checks/day services dodge the per-IP 429201). Cheap path.
      • 401/403   → token is session/cookie/IP-bound → we'd need a full browser
                    session per IP (heavier, what proxy services sell).
      • 429       → even a single direct call is rate-limited at the IP.

    Set REPLAY_PROXY=http://user:pass@host:port to route the probe through a proxy
    and test IP-replay directly (a 200 through a *different* IP = rotation works)."""
    if not auth_captured():
        log("REPLAY-PROBE: no auth captured — skipping"); return
    body = {
        "countryCode": _LIFT_BODY.get("countryCode") or VFS_COUNTRY,
        "missionCode": _LIFT_BODY.get("missionCode") or VFS_MISSION,
        "vacCode": _LIFT_BODY.get("vacCode") or VFS_VAC,
        "visaCategoryCode": _LIFT_BODY.get("visaCategoryCode") or VFS_VISACAT,
        "roleName": "Individual",
        "loginUser": EMAIL,
        "payCode": "",
    }
    headers = {
        "authorize": _LIFT_AUTH.get("authorize") or "",
        "clientsource": _LIFT_AUTH.get("clientsource") or "",
        "content-type": "application/json;charset=UTF-8",
        "accept": "application/json, text/plain, */*",
        "user-agent": BROWSER_UA,
        "origin": "https://visa.vfsglobal.com",
        "referer": "https://visa.vfsglobal.com/",
    }
    if _LIFT_AUTH.get("route"):
        headers["route"] = _LIFT_AUTH["route"]
    proxy = os.environ.get("REPLAY_PROXY", "").strip()
    body_bytes = json.dumps(body).encode()

    def _do():
        if proxy:
            opener = urllib.request.build_opener(
                urllib.request.ProxyHandler({"http": proxy, "https": proxy}))
        else:
            opener = urllib.request.build_opener()
        req = urllib.request.Request(LIFT_API_URL, data=body_bytes, headers=headers, method="POST")
        try:
            r = opener.open(req, timeout=20)
            return r.status, r.read().decode("utf-8", "replace")[:300]
        except urllib.error.HTTPError as e:
            try:
                snip = e.read().decode("utf-8", "replace")[:300]
            except Exception:
                snip = ""
            return e.code, snip
        except Exception as e:
            return 0, str(e)[:200]

    try:
        status, snippet = await asyncio.to_thread(_do)
    except Exception as e:
        log("REPLAY-PROBE: failed:", str(e)[:120]); return
    where = "via PROXY" if proxy else "direct same-IP"
    if status == 200:
        verdict = "✅ TOKEN REPLAY WORKS (header-only, no cookies) — IP rotation is viable"
    elif status in (401, 403):
        verdict = f"❌ token bound (HTTP {status}) — needs browser/cookies per IP"
    elif status == 429:
        verdict = "⛔ rate-limited (429) even on a single direct call"
    elif status == 0:
        verdict = f"transport error: {snippet}"
    else:
        verdict = f"HTTP {status}"
    log(f"REPLAY-PROBE [{where}]: status={status} → {verdict}")
    log(f"REPLAY-PROBE body: {snippet}")
    telegram(f"🧪 Token-replay probe [{where}]: HTTP {status} — {verdict}")


# ── LOGIN ──────────────────────────────────────────────────────────────────
# JS that re-syncs a login field with Angular's reactive form. On the slow VPS,
# send_keys() occasionally lands the characters in the DOM input but Angular's
# FormControl never registers them (a fill TIMING RACE that only shows on slow
# hardware), so submit fails with "Email field cannot be left blank" even though
# Turnstile passed. Forcing value + bubbling input/change/blur events makes
# Angular's reactive form pick up the value the same way a real keystroke would.
_SYNC_FIELD_JS = r"""((sel,val)=>{
    const e=document.querySelector(sel);
    if(!e) return JSON.stringify({found:false});
    try{
        const proto=e.tagName==='TEXTAREA'?window.HTMLTextAreaElement.prototype:window.HTMLInputElement.prototype;
        const setter=Object.getOwnPropertyDescriptor(proto,'value').set;
        e.focus();
        setter.call(e,val);
        e.dispatchEvent(new InputEvent('input',{bubbles:true,data:val,inputType:'insertText'}));
        e.dispatchEvent(new Event('change',{bubbles:true}));
        e.dispatchEvent(new Event('blur',{bubbles:true}));
    }catch(_){
        e.value=val;
        e.dispatchEvent(new Event('input',{bubbles:true}));
        e.dispatchEvent(new Event('change',{bubbles:true}));
        e.dispatchEvent(new Event('blur',{bubbles:true}));
    }
    return JSON.stringify({found:true,len:(e.value||'').length});
})"""


async def _fill_login_field(page, el, selector, value):
    """Type into a login field AND force Angular's reactive form to register it.
    Real keystrokes first (send_keys), then a value+events re-sync, then verify the
    DOM input actually holds the value. Returns True only when the input is non-empty."""
    try:
        await el.send_keys(value)
    except Exception as e:
        log("LOGIN: send_keys err:", str(e)[:60])
    # Re-sync with Angular regardless of whether send_keys "worked" — cheap + idempotent.
    await jeval(page, "(%s)(%s,%s)" % (_SYNC_FIELD_JS, json.dumps(selector), json.dumps(value)))
    cur = await jeval(page, "(()=>{const e=document.querySelector(%s); return e?(e.value||'').length:0;})()" % json.dumps(selector))
    return bool(cur)


async def _fill_login_form(page):
    """Fill email + password, verifying each input holds its value (Angular synced)
    and polling until the Sign In button is enabled (Turnstile passed + form valid).
    Returns True when the button is enabled, False otherwise."""
    email_el = await page.select("#email", timeout=20)
    if not email_el:
        return False
    ok_email = await _fill_login_field(page, email_el, "#email", EMAIL)
    pwd_el = await page.select('#password, input[type="password"]', timeout=15)
    if not pwd_el:
        return False
    ok_pwd = await _fill_login_field(page, pwd_el, "#password", PASSWORD)
    log(f"LOGIN: filled (email_ok={ok_email} pwd_ok={ok_pwd}); waiting for Turnstile auto-pass + form-valid…")
    # Poll up to ~30s for the Sign In button to enable. If the fields never stuck,
    # re-sync them ONCE so a late-hydrating Angular form picks the values up.
    refilled = False
    for i in range(30):
        if await sign_in_disabled(page) is False:
            return True
        if i == 8 and not refilled:
            refilled = True
            log("LOGIN: Sign In still disabled @8s — re-syncing fields once")
            await jeval(page, "(%s)(%s,%s)" % (_SYNC_FIELD_JS, json.dumps("#email"), json.dumps(EMAIL)))
            await jeval(page, "(%s)(%s,%s)" % (_SYNC_FIELD_JS, json.dumps("#password"), json.dumps(PASSWORD)))
        await asyncio.sleep(1)
    return await sign_in_disabled(page) is False


async def _attempt_login(browser, page):
    """ONE login attempt: ensure the email field renders (reload up to 3×), fill +
    verify the form, click Sign In only when enabled, then confirm we left /login.
    Returns True on success, False on this attempt's failure (caller may retry)."""
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
        log("LOGIN: email field never rendered — aborting this attempt")
        return False
    btn_enabled = await _fill_login_form(page)
    await dismiss_consent(page)
    if not btn_enabled:
        # Sign In never enabled (Turnstile not passed yet OR form still invalid /
        # email-blank race). Don't blind-click a disabled button — let the caller retry.
        diag = await jeval(page, """(()=>{const f=document.querySelector('[name="cf-turnstile-response"]');
            const b=[...document.querySelectorAll('button')].find(x=>/sign\\s*in/i.test(x.innerText||''));
            return JSON.stringify({cfRespLen:f&&f.value?f.value.length:0, signInDisabled:b?!!b.disabled:'no-btn',
              emailLen:(document.querySelector('#email')||{}).value?document.querySelector('#email').value.length:0,
              err:[...document.querySelectorAll('mat-error,.mat-error,[class*="error" i]')].filter(e=>e.offsetParent&&(e.innerText||'').trim()).map(e=>(e.innerText||'').trim().slice(0,60)).slice(0,4)});})()""")
        log("LOGIN: Sign In never enabled — diag:", diag)
        return False
    # click the Sign In button (now confirmed enabled)
    for b in await page.select_all("button"):
        if "sign in" in ((b.text or "").lower()):
            await b.mouse_click(); break
    url = await jeval(page, "location.href") or ""
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


async def do_login(browser, page):
    """Login with self-heal retry. On the slow VPS a single fill can lose the
    race (email-blank) or the Sign In button never enables; retry up to 3× —
    reload the login page + dismiss consent between attempts — before giving up."""
    for n in range(1, 4):
        log(f"LOGIN attempt {n}/3")
        try:
            if await _attempt_login(browser, page):
                return True
        except Exception as e:
            log(f"LOGIN attempt {n}/3 raised:", str(e)[:90])
        if n < 3:
            log(f"LOGIN attempt {n}/3 failed — reloading login page and retrying")
            try:
                await page.get(LOGIN_URL)
            except Exception:
                pass
            await asyncio.sleep(8)
            await dismiss_consent(page)
    log("LOGIN: all 3 attempts failed")
    return False


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


async def _reenter_wizard_fresh(page):
    """Re-enter the booking wizard FRESH for the next monitor check. A bare
    location.reload() of the mid-wizard URL leaves the SPA without its dropdowns
    (observed: 0 dropdowns on check #2). Navigating to the dashboard and clicking
    'Start New Booking' reliably re-renders the form (as check #1 does). Also
    clears the route cache so select_route re-scans the fresh DOM."""
    _ROUTE_CACHE["sub_idx"] = None
    _ROUTE_CACHE["subcat_texts"] = None
    try:
        await jeval(page, "location.href=%s" % json.dumps(DASHBOARD_URL))
    except Exception:
        await jeval(page, "location.reload()")
    # Wait for the dashboard (Start New Booking) or a wizard dropdown to render.
    await wait_until(page,
        "(()=>{return /start new booking|book appointment|new booking/i.test(document.body.innerText||'') || !!document.querySelector('mat-select');})()",
        timeout=15, interval=0.5)
    await enter_wizard(page)


# JS that scopes option-reading to the CURRENTLY-OPEN CDK overlay panel only.
# Angular Material renders the open mat-select's options in a `.cdk-overlay-pane`
# (containing `.mat-mdc-select-panel` / `[role=listbox]`) appended to <body> —
# NOT inside the <mat-select>. Reading every `mat-option` on the page therefore
# mixes in STALE options from panels that didn't fully tear down, which is why the
# subcat scan read the CATEGORY options. This tags ONLY the live panel's options
# with data-uc-opt so page.select_all('[data-uc-opt]') returns the right ones.
_TAG_OPEN_PANEL_OPTS_JS = r"""(()=>{
    const vis=e=>e&&e.offsetParent!==null&&e.getAttribute('aria-hidden')!=='true';
    // Live select panels = overlay panes that are visible and not collapsing.
    const panes=[...document.querySelectorAll('.cdk-overlay-pane')].filter(p=>{
        if(!vis(p))return false;
        const st=getComputedStyle(p);
        if(st.display==='none'||st.visibility==='hidden')return false;
        return !!p.querySelector('.mat-mdc-select-panel,[role=listbox],mat-option,.mat-mdc-option');
    });
    if(!panes.length){return 0;}
    // Prefer the LAST opened pane (top of the overlay stack = the one we just opened).
    const pane=panes[panes.length-1];
    document.querySelectorAll('[data-uc-opt]').forEach(e=>e.removeAttribute('data-uc-opt'));
    const opts=[...pane.querySelectorAll('mat-option,.mat-mdc-option,[role=option]')]
        .filter(o=>vis(o)&&((o.innerText||'').trim()));
    opts.forEach(o=>o.setAttribute('data-uc-opt','1'));
    return opts.length;})()"""


async def open_select(page, index, label, polls=12):
    """Open mat-select #index and return ONLY the option elements that belong to
    the panel that just opened (scoped to the live CDK overlay pane, not every
    mat-option on the page). polls*0.4s is the max wait for that panel to render."""
    # Close any previously-open overlay first so its (stale) options can't be read
    # as if they were ours — the root cause of the subcat misread.
    await close_overlay(page)
    triggers = await page.select_all("mat-select")
    if index >= len(triggers):
        return []
    try:
        await triggers[index].mouse_click()
    except Exception:
        return []
    # Poll until the OPEN panel renders its options, then read only those.
    for _ in range(polls):
        n = await jeval(page, _TAG_OPEN_PANEL_OPTS_JS)
        if isinstance(n, (int, float)) and n > 0:
            opts = await page.select_all('[data-uc-opt]')
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
    """Tear down any open CDK overlay panel so its options can't be misread as the
    next dropdown's. Click the backdrop AND dispatch Escape (some mat-select panels
    open without a backdrop), then drop any leftover option tags."""
    await jeval(page, """(()=>{
        const b=document.querySelector('.cdk-overlay-backdrop'); if(b)b.click();
        document.querySelectorAll('[data-uc-opt]').forEach(e=>e.removeAttribute('data-uc-opt'));
        ['keydown','keyup'].forEach(t=>document.dispatchEvent(new KeyboardEvent(t,{key:'Escape',keyCode:27,which:27,bubbles:true})));
    })()""")
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


# Match the sub-category dropdown by the human-visible label/placeholder near it
# ("Choose your sub-category" / "Select your sub-category"), independent of order.
SUBCAT_LABEL_RE = re.compile(r"sub[\s-]*category", re.I)


async def _subcat_index_by_label(page):
    """Return the index (within document.querySelectorAll('mat-select')) of the
    dropdown whose surrounding label/placeholder text mentions 'sub-category'.
    This is far more robust than a positional index across reloads. -1 if none."""
    idx = await jeval(page, r"""(()=>{
        const sels=[...document.querySelectorAll('mat-select')];
        const re=/sub[\s-]*category/i;
        for(let i=0;i<sels.length;i++){
            const s=sels[i];
            // gather candidate label sources: aria-label, the select's own text
            // (placeholder), and the enclosing mat-form-field's label.
            const parts=[s.getAttribute('aria-label')||'',(s.innerText||'')];
            const ff=s.closest('mat-form-field,.mat-mdc-form-field,.mat-form-field');
            if(ff){
                const lbl=ff.querySelector('mat-label,label,.mat-mdc-floating-label,.mat-form-field-label');
                if(lbl)parts.push(lbl.innerText||'');
                parts.push(ff.innerText||'');
            }
            if(parts.some(t=>re.test(t)))return i;
        }
        return -1;})()""")
    return int(idx) if isinstance(idx, (int, float)) else -1


async def _scan_for_subcat(page):
    """Find the sub-category dropdown. PREFER matching by its visible label
    ('sub-category'); fall back to scanning every dropdown for one whose OPEN
    panel exposes the subcat list (work/cargo/ocma…). Returns (sub_idx, texts)
    or (None, []). Slow path."""
    for it in range(10):
        selects = await page.select_all("mat-select")
        log(f"scan iter {it}: {len(selects)} dropdowns")
        # 1) Label-based identification (robust to positional index changes).
        lbl_idx = await _subcat_index_by_label(page)
        if 0 <= lbl_idx < len(selects):
            ot = await _option_texts(page, lbl_idx, f"subcat(label[{lbl_idx}])")
            log(f"  subcat label match at [{lbl_idx}] sample:", ot[:3])
            if any(SUBCAT_LIST_RE.search(t) for t in ot):
                return lbl_idx, ot
        # 2) Fallback: open each dropdown and inspect its OWN (scoped) options.
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

    # ── FAST PATH: prefer the LABEL-identified subcat dropdown, else the cached
    # index. Either way we VALIDATE against the open panel before trusting it. ──
    fast_idx = await _subcat_index_by_label(page)
    if not (0 <= fast_idx < len(await page.select_all("mat-select"))):
        fast_idx = _ROUTE_CACHE["sub_idx"]
    if fast_idx is not None:
        selects = await page.select_all("mat-select")
        if fast_idx < len(selects):
            # The subcat dropdown is dependent (loads after category) — wait briefly
            # for it to populate, then verify its OWN (scoped) options look like the
            # subcat list before trusting the index.
            texts = []
            for _ in range(8):  # ≤~4s
                texts = await _option_texts(page, fast_idx, "subcat(fast)")
                if any(SUBCAT_LIST_RE.search(t) for t in texts):
                    break
                await asyncio.sleep(0.5)
            if any(SUBCAT_LIST_RE.search(t) for t in texts):
                log(f"subcat fast-path: index {fast_idx}; options:", texts)
                _ROUTE_CACHE["sub_idx"] = fast_idx
                _ROUTE_CACHE["subcat_texts"] = texts
                return await _try_subcat(page, fast_idx, texts)
        log("subcat fast-path: index didn't expose subcat options — re-scanning")

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
    global BOOK_ENABLED, _REPLAY_PROBED
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
    ui_walks = 0         # heavy UI walks done while codes still unconfirmed
    MAX_UI_WALKS = 4     # after this, back off hard so we don't trip 429201
    while True:
        attempt += 1
        log(f"--- check #{attempt} ---")

        slot = None          # truthy → a slot to book (UI subcat text OR API earliestDate)
        used_api = False     # did the cheap API path resolve this cycle?

        # GUARANTEE CORRECT CODES: until the wizard has fired its OWN
        # CheckIsSlotAvailable (so we sniff the real vac/visacat codes off its POST
        # body), the API body would use GUESSED env defaults → silent false "no
        # slots". So run the UI walk (select_route) FIRST while codes are unconfirmed;
        # it triggers VFS's request → _install_auth_capture stores the real codes →
        # codes_confirmed() flips → subsequent cycles use the fast API path.
        if auth_captured() and codes_confirmed():
            api = await api_check_availability(page)
            if api is not None:
                status = api.get("_status", 0)
                err = api.get("error")
                if status == 200 and not err:
                    used_api = True
                    api_fail_streak = 0
                    # ONE-TIME DIAGNOSTIC: the in-browser API check just worked, so
                    # we have a live token. Probe whether a DIRECT (cookieless) call
                    # also works → tells us if IP-rotation polling is viable.
                    if not _REPLAY_PROBED:
                        _REPLAY_PROBED = True
                        try:
                            await replay_probe(page)
                        except Exception as _pe:
                            log("replay_probe error (non-fatal):", str(_pe)[:100])
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
        elif not auth_captured():
            log("API: auth headers not captured yet — using UI path")
        else:
            # auth headers present but the real codes aren't confirmed yet → drive the
            # UI walk this cycle so VFS fires its own CheckIsSlotAvailable and we sniff
            # the correct vac/visacat codes. Switches to API polling next cycle.
            log("API: codes not confirmed yet — UI walk first to capture real codes")

        # FALLBACK / BACKWARD-COMPAT: if the API didn't resolve this cycle, run the
        # existing UI slot check (unchanged behaviour). Also used when API found a
        # slot but we still need the UI to navigate to bookable state — select_route
        # both confirms availability AND leaves the wizard ready for book().
        if not used_api or slot:
            try:
                ui_slot = await select_route(page)
            except Exception as _se:
                # A transient DOM/nav error in the route walk must NOT kill a
                # multi-hour monitor. Log, treat as "no slot this cycle", keep looping.
                log("select_route errored (continuing loop):", str(_se)[:160])
                ui_slot = None
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

        # Pace the next check with JITTER so requests aren't perfectly periodic
        # (a fixed cadence is itself a bot signal and bunches requests). Once codes
        # are confirmed we're on the cheap API path (1 in-browser fetch/cycle);
        # before that each cycle is a heavy UI walk, which we cap below.
        jitter = random.uniform(0, max(5.0, MONITOR_INTERVAL * 0.4))
        path_tag = "api" if used_api else "ui"
        log(f"no slot — re-checking in ~{int(MONITOR_INTERVAL + jitter)}s ({path_tag})")
        # emit a per-check milestone so the backend sends a "no slots" Telegram
        # on EVERY check (operator wants a message each time, not a summary).
        milestone("monitoring", email=EMAIL, detail=f"check #{attempt} ({path_tag}) — Work D-visa, no slots")
        await asyncio.sleep(MONITOR_INTERVAL + jitter)

        if used_api:
            # Cheap path: no UI reload needed — the next fetch re-reads availability
            # live. But on repeated API failures (token expiry/403), drop back to the
            # UI reload so we re-capture fresh auth headers off the browser's requests.
            if api_fail_streak >= 3:
                log("API: repeated failures — re-entering wizard to re-capture auth headers")
                await _reenter_wizard_fresh(page)
                api_fail_streak = 0
        else:
            # UI path: we only walk the wizard so VFS fires its OWN
            # CheckIsSlotAvailable and we sniff the real codes (→ switch to API).
            # If that capture keeps failing, DON'T keep hammering the heavy walk
            # (full dashboard reload) every cycle — that request volume is exactly
            # what trips 429201. After MAX_UI_WALKS, back off hard so the IP lives.
            ui_walks += 1
            if not codes_confirmed() and ui_walks >= MAX_UI_WALKS:
                slowdown = max(MONITOR_INTERVAL * 4, 180.0)
                log(f"WARN: codes still unconfirmed after {ui_walks} UI walks — backing "
                    f"off {int(slowdown)}s to protect the IP (CDP post-data capture issue?)")
                await asyncio.sleep(slowdown)
            await _reenter_wizard_fresh(page)

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
