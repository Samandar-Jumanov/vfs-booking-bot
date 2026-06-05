"""
100% hands-off VFS pipeline in ONE nodriver stealth browser:
  login (auto-pass Turnstile) -> enter booking wizard -> select Work D-visa
  -> monitor slot availability on a loop -> book on slot -> Telegram alert.

No extension, no chrome.debugger (those break the captcha). All lift-api calls
run in this real browser (Cloudflare-happy).

Run (PowerShell):
  $env:VFS_EMAIL="..."; $env:VFS_PASSWORD="..."; python nodriver-spike/auto_pipeline.py
Env:
  MONITOR_INTERVAL  seconds between slot re-checks on the UI path (default 30)
  API_MONITOR_INTERVAL  seconds between re-checks on the cheap API path (default 30).
                    Separate from MONITOR_INTERVAL so a large UI interval does NOT
                    stall the fast API cycle.  Usually leave at 30.
  BOOK_ENABLED      "1" to actually book on a slot (default off = monitor only, safe)
  BOOK_DRY_RUN      "1" to run the full booking flow up to the Review screen, take a
                    screenshot, and exit WITHOUT clicking Submit/Confirm. Useful for
                    validating the booking flow end-to-end. If both BOOK_DRY_RUN and
                    BOOK_ENABLED are set, DRY_RUN takes precedence (no actual submit).
  SUBCAT            regex to pick sub-category (default: Work D-visa)
  NATIONALITY_FILTER  regex; subcategory names must MATCH to be polled (default: uzbek|turkmen).
                    Drops Tajik by default; cuts calls/cycle from 4 to 1 (real) or 2 (PROVE_OCMA).
  RATELIMIT_BACKOFF_MIN  minutes to sleep silently after a 429201/429202 rate-limit (default 5).
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
import time
import urllib.error
import urllib.request
import urllib.parse
from datetime import datetime
try:
    from zoneinfo import ZoneInfo
except Exception:
    ZoneInfo = None

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

# Force unbuffered output so logs are never lost when Python exits mid-run
os.environ.setdefault("PYTHONUNBUFFERED", "1")
try:
    sys.stdout.reconfigure(line_buffering=True)
except Exception:
    pass
try:
    sys.stderr.reconfigure(line_buffering=True)
except Exception:
    pass

EMAIL = os.environ.get("VFS_EMAIL", "")
PASSWORD = os.environ.get("VFS_PASSWORD", "")
LOGIN_URL = os.environ.get("VFS_LOGIN_URL", "https://visa.vfsglobal.com/uzb/en/lva/login")
DASHBOARD_URL = os.environ.get("VFS_DASHBOARD_URL", LOGIN_URL.replace("/login", "/dashboard"))
MONITOR_INTERVAL = int(os.environ.get("MONITOR_INTERVAL", "30"))
UI_MONITOR_INTERVAL = int(os.environ.get("UI_MONITOR_INTERVAL", str(min(MONITOR_INTERVAL, 90))))
# API_MONITOR_INTERVAL: seconds between checks when on the cheap API path (one in-
# browser fetch, no wizard walk).  Defaults to 30 regardless of MONITOR_INTERVAL so
# a large MONITOR_INTERVAL value (configured for the heavy UI path) does NOT make the
# fast API path sleep for minutes.  Set to the same value as MONITOR_INTERVAL to
# override.
API_MONITOR_INTERVAL = int(os.environ.get("API_MONITOR_INTERVAL", "30"))
BURST_WINDOWS = os.environ.get("BURST_WINDOWS", "")
BURST_INTERVAL = int(os.environ.get("BURST_INTERVAL", "3"))
IDLE_INTERVAL = int(os.environ.get("IDLE_INTERVAL", "300"))
BURST_TZ = os.environ.get("BURST_TZ", "Asia/Tashkent")
BOOKER_EMAIL = os.environ.get("BOOKER_EMAIL", "")
BOOKER_PASSWORD = os.environ.get("BOOKER_PASSWORD", "")
BOOKER_PASSPORT_IMAGE = os.environ.get("BOOKER_PASSPORT_IMAGE", "")
BOOKER_PROFILE = {
    "firstName": os.environ.get("BOOKER_PROFILE_FIRST_NAME", os.environ.get("BOOKER_PROFILE_FIRSTNAME", "")),
    "lastName": os.environ.get("BOOKER_PROFILE_LAST_NAME", os.environ.get("BOOKER_PROFILE_LASTNAME", "")),
    "dob": os.environ.get("BOOKER_PROFILE_DOB", ""),
    "nationality": os.environ.get("BOOKER_PROFILE_NATIONALITY", ""),
    "passport": os.environ.get("BOOKER_PROFILE_PASSPORT", ""),
    "expiry": os.environ.get("BOOKER_PROFILE_EXPIRY", ""),
}
_BURST_TZ_WARNED = False
_BURST_WINDOWS_LOGGED = False
# DIRECT_POLL=1 → monitor by calling CheckIsSlotAvailable as a DIRECT (cookieless,
# no-browser) HTTP request replaying the captured token — the proven pattern from
# working VFS monitors (khanrn/vfs-slots-api-monitor): the rate limit bites the
# LOGIN flow, not the cheap API poll, so this lets one IP poll often AND lets us
# rotate IPs (PROXY_LIST) without re-logging-in. Default OFF = current in-browser
# fetch (safe). Flip ON only after replay_probe confirms HTTP 200 (token replays).
DIRECT_POLL = os.environ.get("DIRECT_POLL") == "1"
# Optional comma-separated proxy URLs; in DIRECT_POLL mode each cycle rotates to
# the next one so no single IP exceeds the per-IP limit. Empty = direct VPS IP.
PROXY_LIST = [p.strip() for p in os.environ.get("PROXY_LIST", "").split(",") if p.strip()]
BOOK_ENABLED = os.environ.get("BOOK_ENABLED") == "1"
BOOK_DRY_RUN = os.environ.get("BOOK_DRY_RUN") == "1"
SUBCAT = re.compile(os.environ.get("SUBCAT", r"work\s*\(?\s*(?:visa\s*d|d\s*visa)"), re.I)
if os.environ.get("PROVE_OCMA") == "1":
    SUBCAT = re.compile(r"work\s*\(?\s*(?:visa\s*d|d\s*visa)|ocma", re.I)
SHOTS = pathlib.Path(__file__).parent / "shots"
SHOTS.mkdir(exist_ok=True)

WORKER_BRIDGED = os.environ.get("WORKER_BRIDGED") == "1"
MAILSAC_KEY = os.environ.get("MAILSAC_API_KEY", "")
# NATIONALITY_FILTER: regex that nationality names in _WORKD_CODES must MATCH to be
# polled.  Default keeps Uzbek + Turkmen; drops Tajik.  Override via env to add/remove
# nationalities without touching code.
NATIONALITY_FILTER = re.compile(
    os.environ.get("NATIONALITY_FILTER", r"uzbek|turkmen"), re.I
)
# RATELIMIT_BACKOFF_MIN: silent cooldown (in minutes) after a 429201/429202 rate-limit
# response.  No requests are made during this window.  Default 5 minutes.
# For a confirmed 2-hour IP ban set RATELIMIT_BACKOFF_MIN=120 in the environment.
RATELIMIT_BACKOFF_MIN = int(os.environ.get("RATELIMIT_BACKOFF_MIN", "5"))

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


def _parse_burst_windows(raw=None):
    raw = BURST_WINDOWS if raw is None else raw
    windows = []
    for part in (raw or "").split(","):
        part = part.strip()
        if not part or "-" not in part:
            continue
        start, end = [p.strip() for p in part.split("-", 1)]
        try:
            sh, sm = [int(x) for x in start.split(":", 1)]
            eh, em = [int(x) for x in end.split(":", 1)]
        except Exception:
            continue
        if not (0 <= sh <= 23 and 0 <= eh <= 23 and 0 <= sm <= 59 and 0 <= em <= 59):
            continue
        windows.append((sh * 60 + sm, eh * 60 + em))
    return windows


_BURST_WINDOWS_PARSED = _parse_burst_windows()


def _burst_interval_now(now=None):
    """Return BURST_INTERVAL/IDLE_INTERVAL inside configured local windows.
    None means BURST_WINDOWS is empty/invalid and the legacy path interval remains
    in control. One IP still has the same VFS request budget; bursting only spends
    it inside the configured release windows, and the existing 429 rotation/backoff
    chain remains responsible for exhaustion."""
    global _BURST_TZ_WARNED, _BURST_WINDOWS_LOGGED
    if not _BURST_WINDOWS_PARSED:
        return None
    if not _BURST_WINDOWS_LOGGED:
        _BURST_WINDOWS_LOGGED = True
        log("BURST: windows parsed:", _BURST_WINDOWS_PARSED, "tz=", BURST_TZ,
            "burst=", BURST_INTERVAL, "idle=", IDLE_INTERVAL)
    if now is None:
        try:
            if ZoneInfo is None:
                raise RuntimeError("zoneinfo unavailable")
            now = datetime.now(ZoneInfo(BURST_TZ))
        except Exception as e:
            if not _BURST_TZ_WARNED:
                _BURST_TZ_WARNED = True
                log(f"BURST: timezone {BURST_TZ!r} unavailable ({str(e)[:80]}) - using local time")
            now = datetime.now()
    cur = now.hour * 60 + now.minute
    for start, end in _BURST_WINDOWS_PARSED:
        if start <= end:
            in_window = start <= cur < end
        else:
            in_window = cur >= start or cur < end
        if in_window:
            return BURST_INTERVAL
    return IDLE_INTERVAL


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


def telegram(msg, force=False):
    """Send a plain Telegram text message.

    Normally skipped when WORKER_BRIDGED=1 (the Node worker bridges milestone
    events to the backend which fires Telegram). Pass force=True to bypass the
    bridge skip for critical positive alerts (e.g. OCMA available) that MUST
    reach the client directly even in bridged mode.
    """
    if WORKER_BRIDGED and not force:
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

        _seen_urls = set()

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
                # DIAGNOSTIC: log each distinct lift-api endpoint ONCE so we can see
                # exactly which call carries the codes (vac/visacat live here).
                if u not in _seen_urls:
                    _seen_urls.add(u)
                    _hp = getattr(evt.request, "post_data", None) is not None
                    log("LIFT-URL:", u.split("?")[0][:130], "(postData=%s)" % _hp)
                # Sniff the REAL vac/visacat/country/mission codes from ANY lift-api
                # request body that carries them (not just CheckIsSlotAvailable) — the
                # env defaults are guesses; whichever wizard call includes them flips
                # codes_confirmed() and unlocks the cheap API monitor.
                if True:
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


# The visa-category code for "Latvia Long Stay/Visa D" at the TAS centre (from
# /master/visacategory). Static. The Work-D sub-cat codes live under it.
VISACAT_LONGSTAY = os.environ.get("VFS_VISACAT_PARENT", "ZaremaT")
SUBVISACAT_URL = (
    "https://lift-api.vfsglobal.com/master/subvisacategory/%s/%s/%s/%s/en-US"
    % (VFS_MISSION, VFS_COUNTRY, VFS_VAC, VISACAT_LONGSTAY)
)
_WORKD_CODES = []  # list of (name, code) for the Work-D sub-categories


async def load_workd_codes(page):
    """Fetch the (authed) sub-category list IN-BROWSER and extract the Work-D
    codes. This gives the real visaCategoryCode(s) so we can poll the slot API
    DIRECTLY — no wizard, no flaky re-entry. Sets _WORKD_CODES + confirms codes.
    Returns True once the Work-D codes are known."""
    global _WORKD_CODES
    if _WORKD_CODES:
        return True
    if not auth_captured():
        return False
    # The subvisacategory endpoint requires the custom auth HEADERS (authorize/
    # clientsource/route) — cookies alone → HTTP 500. Same headers the wizard sends.
    _hdrs = {
        "accept": "application/json, text/plain, */*",
        "authorize": _LIFT_AUTH.get("authorize") or "",
        "clientsource": _LIFT_AUTH.get("clientsource") or "",
    }
    if _LIFT_AUTH.get("route"):
        _hdrs["route"] = _LIFT_AUTH["route"]
    expr = (
        "(async()=>{try{const r=await fetch(%s,{headers:%s,"
        "credentials:'include'});const j=await r.json();"
        "return JSON.stringify({status:r.status,data:j});}"
        "catch(e){return JSON.stringify({status:0,error:String(e)});}})()"
        % (json.dumps(SUBVISACAT_URL), json.dumps(_hdrs))
    )
    try:
        raw = await page.evaluate(expr, await_promise=True)
        if isinstance(raw, dict) and "value" in raw:
            raw = raw["value"]
        env = json.loads(raw) if isinstance(raw, str) else raw
    except Exception as e:
        log("CODES: subvisacategory fetch failed:", str(e)[:90])
        return False
    data = env.get("data") if isinstance(env, dict) else None
    if not isinstance(data, list):
        log("CODES: unexpected subvisacategory response:", str(env)[:160])
        return False
    found = []
    for it in data:
        if not isinstance(it, dict):
            continue
        nm = (it.get("name") or "").strip()
        cd = (it.get("code") or it.get("subVisaCategoryCode") or "").strip()
        if nm and cd and SUBCAT.search(nm):
            found.append((nm, cd))
    log("CODES: subvisacategory had %d subcats; Work-D matches:" % len(data), found)
    if found:
        # Filter to client-relevant nationalities only (drops Tajik by default).
        # This cuts calls/cycle: real mode 4→1, demo (PROVE_OCMA) 4→2.
        filtered = [(nm, cd) for nm, cd in found if NATIONALITY_FILTER.search(nm)]
        if filtered:
            log("CODES: polling %d relevant categories (nationality_filter=%s): %s"
                % (len(filtered), os.environ.get("NATIONALITY_FILTER", "uzbek|turkmen"),
                   [nm for nm, _ in filtered]))
            found = filtered
        else:
            # Safety: if the filter drops everything (wrong env value), keep all and warn.
            log("CODES: WARN — NATIONALITY_FILTER dropped all %d entries; ignoring filter"
                % len(found))
        _WORKD_CODES = found
        _LIFT_BODY["countryCode"] = _LIFT_BODY.get("countryCode") or VFS_COUNTRY
        _LIFT_BODY["missionCode"] = _LIFT_BODY.get("missionCode") or VFS_MISSION
        _LIFT_BODY["vacCode"] = VFS_VAC
        _LIFT_BODY["visaCategoryCode"] = found[0][1]
        _maybe_confirm_codes()
        return True
    return False


LIFT_CREDS_FILE = str(pathlib.Path(__file__).resolve().parent / ".lift-creds.json")
# Shared pool file — all running auto_pipeline instances write here on login so
# any instance can rotate to another account's token on a 429.
ACCOUNT_POOL_FILE = str(pathlib.Path(__file__).resolve().parent / ".account-pool.json")
# Spare-credentials file — written by orchestrator-worker.ts with ACTIVE+unlinked
# account {email, password} entries.  When the pool has no pre-authed spare, the
# pipeline reads one entry here, logs in inline, captures the token, and continues.
SPARE_CREDENTIALS_FILE = str(pathlib.Path(__file__).resolve().parent / ".spare-credentials.json")


def _pool_read() -> dict:
    """Read .account-pool.json; returns {} on missing/corrupt file."""
    try:
        with open(ACCOUNT_POOL_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def _pool_write(pool: dict) -> None:
    """Atomically write pool dict to .account-pool.json (tmp-file rename)."""
    tmp = ACCOUNT_POOL_FILE + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(pool, f, indent=2)
        os.replace(tmp, ACCOUNT_POOL_FILE)
    except Exception as e:
        log("POOL: write failed:", str(e)[:80])


def _pool_register_self() -> None:
    """Write (or update) this account's entry in the pool file after a
    successful login + auth capture. Idempotent — safe to call multiple times."""
    if not (EMAIL and _LIFT_AUTH.get("authorize") and _LIFT_AUTH.get("clientsource")):
        return
    try:
        pool = _pool_read()
        pool[EMAIL] = {
            "email": EMAIL,
            "auth": {k: _LIFT_AUTH.get(k) for k in ("authorize", "clientsource", "route")},
            "body": {
                "countryCode": _LIFT_BODY.get("countryCode") or VFS_COUNTRY,
                "missionCode": _LIFT_BODY.get("missionCode") or VFS_MISSION,
                "vacCode": _LIFT_BODY.get("vacCode") or VFS_VAC,
                "visaCategoryCode": _LIFT_BODY.get("visaCategoryCode") or VFS_VISACAT,
            },
            "codesConfirmed": _CODES_CONFIRMED,
            "rateLimitedUntil": pool.get(EMAIL, {}).get("rateLimitedUntil"),
            "updatedAt": __import__("datetime").datetime.utcnow().isoformat() + "Z",
        }
        _pool_write(pool)
        log(f"POOL: registered {EMAIL} → {ACCOUNT_POOL_FILE}")
    except Exception as e:
        log("POOL: register_self failed:", str(e)[:80])


def _pool_mark_ratelimited(email: str, cooldown_minutes: int) -> None:
    """Mark email as rate-limited until now + cooldown_minutes in the pool file."""
    try:
        import datetime as _dt
        until = (_dt.datetime.utcnow() + _dt.timedelta(minutes=cooldown_minutes)).isoformat() + "Z"
        pool = _pool_read()
        if email in pool:
            pool[email]["rateLimitedUntil"] = until
            _pool_write(pool)
            log(f"POOL: marked {email} rate-limited until {until}")
    except Exception as e:
        log("POOL: mark_ratelimited failed:", str(e)[:80])


def _pool_next_available(current_email: str) -> dict | None:
    """Return the pool entry for the next non-rate-limited account that is not
    the current one, or None if no such account exists in the pool."""
    try:
        import datetime as _dt
        now_str = _dt.datetime.utcnow().isoformat() + "Z"
        pool = _pool_read()
        for email, entry in pool.items():
            if email == current_email:
                continue
            rl_until = entry.get("rateLimitedUntil")
            if rl_until and rl_until > now_str:
                continue  # still cooling down
            if not entry.get("auth", {}).get("authorize"):
                continue  # incomplete entry
            return entry
    except Exception as e:
        log("POOL: next_available failed:", str(e)[:80])
    return None


def _spare_creds_pop() -> dict | None:
    """Atomically pop and return the first entry from .spare-credentials.json
    (written by orchestrator-worker.ts with ACTIVE+unlinked {email, password}
    entries).  Removes the consumed entry from the file so two concurrent
    instances never pick the same account.  Returns None on any error or when
    the file is empty / missing."""
    try:
        with open(SPARE_CREDENTIALS_FILE, "r", encoding="utf-8") as f:
            creds: list = json.load(f)
        if not creds or not isinstance(creds, list):
            return None
        entry = creds.pop(0)
        # Write back the remaining entries atomically
        tmp = SPARE_CREDENTIALS_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(creds, f, indent=2)
        os.replace(tmp, SPARE_CREDENTIALS_FILE)
        if entry.get("email") and entry.get("password"):
            log(f"SPARE: popped credential for {entry['email']} ({len(creds)} remaining in file)")
            return entry
        return None
    except FileNotFoundError:
        return None  # file not written by worker yet — expected
    except Exception as e:
        log("SPARE: _spare_creds_pop failed:", str(e)[:80])
        return None


def _pool_apply_account(entry: dict) -> None:
    """Hot-swap the global auth state to the credentials from a pool entry.
    Updates _LIFT_AUTH, _LIFT_BODY, and the module-level EMAIL global so all
    subsequent API calls use the new account's token without a re-login."""
    global EMAIL, _API_SOURCE_LOGGED, _CODES_CONFIRMED
    new_email = entry.get("email", "")
    new_auth = entry.get("auth", {})
    new_body = entry.get("body", {})
    if new_email:
        EMAIL = new_email
    for k in ("authorize", "clientsource", "route"):
        _LIFT_AUTH[k] = new_auth.get(k)
    for k in ("countryCode", "missionCode", "vacCode", "visaCategoryCode"):
        if new_body.get(k):
            _LIFT_BODY[k] = new_body[k]
    # Reset the "logged once" flag so the first call with the new token logs its source.
    _API_SOURCE_LOGGED = False
    if entry.get("codesConfirmed") and new_body.get("vacCode") and new_body.get("visaCategoryCode"):
        _CODES_CONFIRMED = True
    else:
        _CODES_CONFIRMED = False
    log(f"POOL: swapped to account {EMAIL} (authorize={str(_LIFT_AUTH.get('authorize') or '')[:16]}…)")


def _dump_lift_creds():
    """Persist the captured auth token + real codes to .lift-creds.json so the
    standalone direct-API poller (api_poller.py) can replay the slot-check from a
    POOL OF ROTATING IPS — without a browser. This is the artifact that lets us
    poll the API at scale (each IP makes few requests → no per-IP 429201). Only
    useful if the token isn't IP/cookie-bound (see replay_probe verdict)."""
    try:
        creds = {
            "email": EMAIL,
            "capturedAt": __import__("datetime").datetime.utcnow().isoformat() + "Z",
            "auth": {k: _LIFT_AUTH.get(k) for k in ("authorize", "clientsource", "route")},
            "body": {
                "countryCode": _LIFT_BODY.get("countryCode") or VFS_COUNTRY,
                "missionCode": _LIFT_BODY.get("missionCode") or VFS_MISSION,
                "vacCode": _LIFT_BODY.get("vacCode") or VFS_VAC,
                "visaCategoryCode": _LIFT_BODY.get("visaCategoryCode") or VFS_VISACAT,
            },
        }
        with open(LIFT_CREDS_FILE, "w", encoding="utf-8") as f:
            json.dump(creds, f, indent=2)
        log(f"API: dumped live token + codes → {LIFT_CREDS_FILE} (for api_poller.py)")
        # Also write to the shared account pool so other running instances (and this
        # one after a 429 swap) can rotate to this account's token.
        _pool_register_self()
    except Exception as e:
        log("API: failed to dump lift creds:", str(e)[:100])


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
        _dump_lift_creds()


def codes_confirmed():
    """True once the wizard's real vacCode + visaCategoryCode have been captured."""
    return _CODES_CONFIRMED


async def api_check_availability(page, code_override=None):
    """Poll VFS's authed CheckIsSlotAvailable endpoint via an IN-BROWSER fetch()
    (reuses the live session/cookies/origin — most Cloudflare-happy). Returns a
    dict {earliestDate, earliestSlotLists, error, _status} on a parsed HTTP
    response, or None on a transport/JS failure (caller then falls back to UI).

    code_override: when set, query that specific visaCategoryCode (used to check
    each Work-D sub-category in turn). Else uses the captured/env code.
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
    visacat = code_override or _LIFT_BODY.get("visaCategoryCode") or VFS_VISACAT
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


def _lift_headers():
    h = {
        "authorize": _LIFT_AUTH.get("authorize") or "",
        "clientsource": _LIFT_AUTH.get("clientsource") or "",
        "content-type": "application/json;charset=UTF-8",
        "accept": "application/json, text/plain, */*",
        "user-agent": BROWSER_UA,
        "origin": "https://visa.vfsglobal.com",
        "referer": "https://visa.vfsglobal.com/",
    }
    if _LIFT_AUTH.get("route"):
        h["route"] = _LIFT_AUTH["route"]
    return h


def _lift_body():
    return {
        "countryCode": _LIFT_BODY.get("countryCode") or VFS_COUNTRY,
        "missionCode": _LIFT_BODY.get("missionCode") or VFS_MISSION,
        "vacCode": _LIFT_BODY.get("vacCode") or VFS_VAC,
        "visaCategoryCode": _LIFT_BODY.get("visaCategoryCode") or VFS_VISACAT,
        "roleName": "Individual",
        "loginUser": EMAIL,
        "payCode": "",
    }


def _next_proxy(n):
    """Round-robin the proxy pool (DIRECT_POLL mode). None = direct VPS IP."""
    if not PROXY_LIST:
        return None
    return PROXY_LIST[n % len(PROXY_LIST)]


async def api_check_direct(proxy=None):
    """DIRECT (cookieless, no-browser) CheckIsSlotAvailable — same return shape as
    api_check_availability ({earliestDate, earliestSlotLists, error, _status}).
    This is the proven 24/7 pattern: replay the captured token as a plain header,
    optionally through a rotating proxy, so the cheap poll never depends on the
    heavy browser session and the per-IP limit can be spread across many IPs."""
    if not auth_captured():
        return None
    headers = _lift_headers()
    body_bytes = json.dumps(_lift_body()).encode()

    def _do():
        opener = (urllib.request.build_opener(
            urllib.request.ProxyHandler({"http": proxy, "https": proxy}))
            if proxy else urllib.request.build_opener())
        req = urllib.request.Request(LIFT_API_URL, data=body_bytes, headers=headers, method="POST")
        try:
            r = opener.open(req, timeout=25)
            return r.status, r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            try:
                return e.code, e.read().decode("utf-8", "replace")
            except Exception:
                return e.code, ""
        except Exception as e:
            return 0, str(e)[:160]

    try:
        status, raw = await asyncio.to_thread(_do)
    except Exception as e:
        log("DIRECT: call failed:", str(e)[:100])
        return None
    if status == 0:
        log("DIRECT: transport error:", str(raw)[:100])
        return None
    try:
        data = json.loads(raw) if raw else {}
    except Exception:
        data = {}
    if status != 200:
        log(f"DIRECT: HTTP {status}", str(data)[:120])
    return {
        "earliestDate": (data or {}).get("earliestDate"),
        "earliestSlotLists": (data or {}).get("earliestSlotLists") or [],
        "error": (data or {}).get("error"),
        "_status": status,
    }


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


async def _fill_login_form(page, email=None, password=None):
    """Fill email + password, verifying each input holds its value (Angular synced)
    and polling until the Sign In button is enabled (Turnstile passed + form valid).
    Returns True when the button is enabled, False otherwise."""
    email = EMAIL if email is None else email
    password = PASSWORD if password is None else password
    email_el = await page.select("#email", timeout=20)
    if not email_el:
        return False
    ok_email = await _fill_login_field(page, email_el, "#email", email)
    pwd_el = await page.select('#password, input[type="password"]', timeout=15)
    if not pwd_el:
        return False
    ok_pwd = await _fill_login_field(page, pwd_el, "#password", password)
    log(f"LOGIN: filled (email_ok={ok_email} pwd_ok={ok_pwd}); waiting for Turnstile auto-pass + form-valid…")
    # Poll up to ~30s for the Sign In button to enable. If the fields never stuck,
    # re-sync them ONCE so a late-hydrating Angular form picks the values up.
    refilled = False
    for i in range(30):
        if await sign_in_disabled(page) is False:
            token_len = await jeval(page, "(()=>{const f=document.querySelector('[name=\"cf-turnstile-response\"]'); return f&&f.value?f.value.length:0;})()")
            if token_len:
                return True
        if i == 8 and not refilled:
            refilled = True
            log("LOGIN: Sign In still disabled @8s — re-syncing fields once")
            await jeval(page, "(%s)(%s,%s)" % (_SYNC_FIELD_JS, json.dumps("#email"), json.dumps(email)))
            await jeval(page, "(%s)(%s,%s)" % (_SYNC_FIELD_JS, json.dumps("#password"), json.dumps(password)))
        await asyncio.sleep(1)
    return await sign_in_disabled(page) is False


async def _attempt_login(browser, page, email=None, password=None):
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
    btn_enabled = await _fill_login_form(page, email=email, password=password)
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


async def do_login(browser, page, email=None, password=None):
    """Login with self-heal retry. On the slow VPS a single fill can lose the
    race (email-blank) or the Sign In button never enables; retry up to 3× —
    reload the login page + dismiss consent between attempts — before giving up."""
    for n in range(1, 4):
        log(f"LOGIN attempt {n}/3")
        try:
            if await _attempt_login(browser, page, email=email, password=password):
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
    # Re-entry is flaky: the SPA sometimes renders the 3 mat-selects but WITHOUT
    # their data (centre/category options never load) → every later check sees
    # empty dropdowns → false "no slots". So after entering, VERIFY the centre
    # dropdown actually loaded its value ("VFS GLOBAL SERVICES …"); if the form
    # came back empty, HARD-reload and retry (up to 3x).
    for attempt in range(3):
        try:
            await jeval(page, "location.href=%s" % json.dumps(DASHBOARD_URL))
        except Exception:
            await jeval(page, "location.reload()")
        await wait_until(page,
            "(()=>{return /start new booking|book appointment|new booking/i.test(document.body.innerText||'') || !!document.querySelector('mat-select');})()",
            timeout=15, interval=0.5)
        await enter_wizard(page)
        # Wait for the centre dropdown to auto-fill (1 Centre auto-selects) — the
        # signal that the form's data actually loaded, not just the empty shell.
        await wait_until(page,
            "(()=>{const s=document.querySelectorAll('mat-select'); if(s.length<2)return false;"
            "const v=s[0].querySelector('.mat-mdc-select-value,.mat-select-value,[class*=select-value]');"
            "const t=((v&&v.innerText)||'').trim(); return t && !/choose|select/i.test(t);})()",
            timeout=10, interval=0.4)
        centre = await _select_value_text(page, 0)
        if centre and not re.search(r"choose|select", centre, re.I):
            log("wizard re-entered OK, centre loaded:", centre[:30])
            return
        log(f"wizard re-entry EMPTY (centre='{centre[:25]}') — hard reload, retry {attempt + 1}/3")
        try:
            await jeval(page, "location.reload()")
        except Exception:
            pass
        await asyncio.sleep(3)
    log("wizard re-entry: form still empty after 3 tries — select_route will retry centre")


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


async def _try_subcat(page, sub_idx, texts, subcat_re=None):
    """Given the subcat dropdown index + its option texts, pick each Work-D-visa
    option and check whether a slot is available (Continue enabled). Returns the
    chosen subcat text on a hit, None on no slot, or the sentinel string
    "SUBCAT_NOT_READY" when the opened dropdown exposes category options (index
    drifted after _scan_for_subcat closed its panels) — so the caller can retry
    cleanly rather than emitting a false 'no slot'.

    On each open we RE-LOCATE the subcat dropdown by OPTIONS CONTENT (matching
    SUBCAT_LIST_RE) rather than reusing sub_idx, which may have shifted since the
    scan.  If the found index disagrees with sub_idx we log it and use the live
    one.  If no dropdown currently exposes subcat options we return SUBCAT_NOT_READY
    immediately — the caller handles it as a transient DOM-not-ready state."""
    subcat_re = subcat_re or SUBCAT
    work = [t for t in texts if subcat_re.search(t)]
    if not work:
        log("no Work-D-visa sub-category in list"); return None
    for wt in work:
        # Re-locate the subcat dropdown by content — the index can shift between
        # the scan phase (which opens+closes panels) and this selection phase.
        all_selects = await page.select_all("mat-select")
        live_idx = sub_idx  # default: trust the passed index
        for probe_i in range(len(all_selects)):
            probe_texts = await _option_texts(page, probe_i, f"probe[{probe_i}]")
            if any(SUBCAT_LIST_RE.search(t) for t in probe_texts):
                if probe_i != sub_idx:
                    log(f"_try_subcat: subcat index drifted {sub_idx}→{probe_i} — using live idx")
                live_idx = probe_i
                break
        else:
            # No dropdown currently has subcat options — form is in a transient state.
            log("_try_subcat: no dropdown has subcat options — returning SUBCAT_NOT_READY")
            return "SUBCAT_NOT_READY"

        opts = await open_select(page, live_idx, "subcat")
        # Guard: verify the panel we opened is the subcat panel (not the category
        # dropdown, which would contain 'Latvia...' options).  If its options don't
        # match SUBCAT_LIST_RE, the DOM is inconsistent — signal NOT_READY.
        opt_texts = [(o.text or "").strip() for o in opts]
        if not any(SUBCAT_LIST_RE.search(t) for t in opt_texts):
            await close_overlay(page)
            log("_try_subcat: opened panel has non-subcat options %s — returning SUBCAT_NOT_READY" % opt_texts[:3])
            return "SUBCAT_NOT_READY"

        picked = await pick_option(opts, lambda t, wt=wt: t == wt, "sub:" + wt[:18])
        if not picked:
            continue
        # Verify the dropdown now shows the intended value (not just a stale display).
        displayed = await _select_value_text(page, live_idx)
        if not re.search(re.escape(wt[:15]), displayed, re.I):
            log(f"_try_subcat: displayed value '{displayed[:30]}' != intended '{wt[:18]}' — skipping (index drift?)")
            continue
        # VFS sometimes pops a Verify/captcha modal right after subcat selection
        # (before evaluating slot availability). Dismiss it so the Continue-button
        # poll below can actually see the enabled state. No-ops fast when absent.
        await handle_captcha_modal(page)
        # VFS evaluates availability → enables Continue. Poll (≤3s) instead of a
        # blind sleep so the happy path is fast but slow evaluations still pass.
        if await wait_until(page,
                "(()=>{const b=[...document.querySelectorAll('button')].find(x=>/continue/i.test(x.innerText||'')&&x.offsetParent); return b?!b.disabled:false;})()",
                timeout=3, interval=0.3):
            log("SLOT AVAILABLE in:", wt); return wt
        log("no slot in:", wt)
    return None


async def _select_value_text(page, index):
    """Return the DISPLAYED value of mat-select #index (placeholder text if nothing
    is chosen). Used to verify a dependent dropdown selection actually registered."""
    return (await jeval(page, """((i)=>{const s=document.querySelectorAll('mat-select')[i];
        if(!s)return ''; const v=s.querySelector('.mat-mdc-select-value,.mat-select-value,[class*=select-value]');
        return ((v&&v.innerText)||s.innerText||'').trim();})(%d)""" % index)) or ""


async def select_route(page, subcat_re=None):
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

    # category (index 1): pick "Long Stay/Visa D" and VERIFY it registered. The
    # sub-category dropdown is DEPENDENT on this — if the category pick doesn't
    # stick (page still spinner-loading, click landed mid-render), the subcat never
    # populates and we get a false "no slots". So pick → confirm the displayed value
    # changed off the placeholder → retry up to 3x → then wait for subcat to load.
    cat_registered = False
    for _cat_try in range(3):
        opts = await open_select(page, 1, "category")
        if opts:
            await pick_option(opts, lambda t: re.search("long stay", t, re.I), "category")
        await asyncio.sleep(1.2)
        catval = await _select_value_text(page, 1)
        if re.search(r"long\s*stay|visa\s*d", catval, re.I):
            log("category registered:", catval[:40])
            cat_registered = True
            break
        log(f"category NOT registered (shows '{catval[:30]}') — retry {_cat_try + 1}/3")
        await asyncio.sleep(1.5)

    if not cat_registered:
        # All 3 category retries exhausted without it sticking.  The subcat will
        # NOT be populated, so scanning now would either find nothing or the category
        # dropdown itself — both produce false results.  Return None so the monitor
        # loop's _reenter_wizard_fresh path takes over on the next cycle.
        log("select_route: category failed all retries — skipping subcat (will re-enter wizard next cycle)")
        return None

    # subcat is API-loaded right after the category sticks — wait for it to populate.
    await wait_until(page,
        "(()=>{const s=document.querySelectorAll('mat-select'); return s.length>=3;})()",
        timeout=6, interval=0.3)

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
            for _ in range(16):  # ≤~8s — VFS loads subcat via an API call post-category
                texts = await _option_texts(page, fast_idx, "subcat(fast)")
                if any(SUBCAT_LIST_RE.search(t) for t in texts):
                    break
                await asyncio.sleep(0.5)
            if any(SUBCAT_LIST_RE.search(t) for t in texts):
                log(f"subcat fast-path: index {fast_idx}; options:", texts)
                _ROUTE_CACHE["sub_idx"] = fast_idx
                _ROUTE_CACHE["subcat_texts"] = texts
                result = await _try_subcat(page, fast_idx, texts, subcat_re=subcat_re)
                if result == "SUBCAT_NOT_READY":
                    log("subcat select failed (index drifted post-scan) — retry next cycle")
                    return None
                return result
        log("subcat fast-path: index didn't expose subcat options — re-scanning")

    # ── SLOW PATH: scan every dropdown for the subcat list, then cache it ──────
    sub_idx, texts = await _scan_for_subcat(page)
    if sub_idx is None:
        log("subcat dropdown not found (still loading?)"); return None
    log(f"subcat at index {sub_idx}; options:", texts)
    _ROUTE_CACHE["sub_idx"] = sub_idx
    _ROUTE_CACHE["subcat_texts"] = texts
    result = await _try_subcat(page, sub_idx, texts, subcat_re=subcat_re)
    if result == "SUBCAT_NOT_READY":
        log("subcat select failed (index drifted post-scan) — retry next cycle")
        return None
    return result


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
    # A plain mat-select dropdown also creates .cdk-overlay-pane but only contains
    # mat-option elements.  Only treat an overlay as a REAL captcha/verify modal when:
    #   (a) a mat-dialog-container or [role="dialog"] element is present, OR
    #   (b) a Cloudflare Turnstile frame / element is inside any overlay, OR
    #   (c) a visible action button (submit/verify/confirm/proceed) exists in the overlay.
    # A dropdown panel with nothing but mat-option nodes satisfies none of these → skip.
    has_modal = await jeval(page, """(()=>{
        const pane = document.querySelector('.cdk-overlay-pane');
        if (!pane) return false;
        if (document.querySelector('mat-dialog-container, [role="dialog"]')) return true;
        if (pane.querySelector('iframe[src*="challenges.cloudflare.com"], [name="cf-turnstile-response"], .cf-turnstile')) return true;
        const btnText = txt => ['submit','verify','confirm','proceed'].some(k => txt.toLowerCase().includes(k));
        const actionBtn = [...(pane.querySelectorAll('button') || [])].find(b => btnText((b.innerText || '').trim()));
        return !!actionBtn;
    })()""")
    if not has_modal:
        return
    await click_button_text(page, ["submit", "verify", "confirm", "proceed"], timeout=6)


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


def _default_profile():
    return {
        "firstName": os.environ.get("PROFILE_FIRST_NAME", os.environ.get("PROFILE_FIRSTNAME", "")),
        "lastName": os.environ.get("PROFILE_LAST_NAME", os.environ.get("PROFILE_LASTNAME", "")),
        "dob": os.environ.get("PROFILE_DOB", ""),
        "nationality": os.environ.get("PROFILE_NATIONALITY", ""),
        "passport": os.environ.get("PROFILE_PASSPORT", ""),
        "expiry": os.environ.get("PROFILE_EXPIRY", ""),
    }


async def book(page, subcat, *, email=None, passport=None, profile=None):
    book_email = email or EMAIL
    passport_path = passport or PASSPORT_IMAGE
    profile_data = profile or _default_profile()
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
    if file_inputs and os.path.exists(passport_path):
        try:
            await file_inputs[0].send_file(passport_path)
            log("BOOK: uploaded passport image:", passport_path)
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
        log("BOOK: no file input or passport image missing", "(inputs=%d, img=%s)" % (len(file_inputs), passport_path))
    # Save the applicant (footer Save) → applicant Summary page.
    await click_button_text(page, ["save"], timeout=30)
    await asyncio.sleep(3)
    await dump_state(page, "2c_after_save")
    # ── Step 2b: post-OCR applicant detail form ────────────────────────────────
    # After OCR, VFS may render a verification form (the page stays on "your-details"
    # with visible mat-input-* fields for name/DOB/nationality/passport#/expiry).
    # Detect, log all fields (with their OCR-extracted values), fill any empty
    # required ones, then Save so the page advances to the Summary/OTP gate.
    still_on_details = await jeval(page,
        "(()=>{const url=location.href; const inputs=[...document.querySelectorAll('input')].filter(i=>i.offsetParent!==null&&i.type!=='hidden'); return url.includes('your-details')&&inputs.length>0;})()")
    if still_on_details:
        log("STEP2b: post-OCR form detected — inspecting fields")
        # Read each visible input: label, placeholder, formcontrolname, current value
        fields_info_raw = await jeval(page, r"""(()=>{
            const inputs=[...document.querySelectorAll('input')].filter(i=>i.offsetParent!==null&&i.type!=='hidden');
            return JSON.stringify(inputs.map(i=>{
                const ff=i.closest('mat-form-field,.mat-mdc-form-field,.mat-form-field');
                const lbl=ff?((ff.querySelector('mat-label,label,.mat-mdc-floating-label,.mat-form-field-label')||{}).innerText||'').trim():'';
                return {
                    id:i.id||'',fc:i.getAttribute('formcontrolname')||'',
                    placeholder:(i.placeholder||'').trim(),label:lbl,
                    value:(i.value||'').trim(),required:i.required||i.getAttribute('aria-required')==='true'
                };
            }));
        })()""")
        # jeval returns non-dict structures unpredictably for JS objects — JSON.stringify
        # and parse ensures we always get a proper list of dicts.
        try:
            fields_info = json.loads(fields_info_raw) if isinstance(fields_info_raw, str) else (fields_info_raw or [])
        except Exception:
            fields_info = []
        log("STEP2b fields: %s" % str(fields_info)[:300])
        if isinstance(fields_info, list):
            for f in fields_info:
                log("STEP2b FIELD: label=%r fc=%r placeholder=%r value=%r required=%s" % (
                    f.get('label',''), f.get('fc',''), f.get('placeholder',''),
                    f.get('value','')[:30] if f.get('value') else '', f.get('required')))
        # Build a profile fallback dict from env (worker passes these for linked profiles)
        _profile = profile_data
        # Fill each visible empty input. Prefer the value VFS OCR already placed in the
        # DOM (often in a read-only sibling span) — re-read off the page if value is empty.
        # Fall back to the _profile dict keys matched by label keywords.
        _LABEL_MAP = [
            (re.compile(r"first|given", re.I),  "firstName"),
            (re.compile(r"last|surname|family", re.I), "lastName"),
            (re.compile(r"birth|dob|date of birth", re.I), "dob"),
            (re.compile(r"national|country", re.I), "nationality"),
            (re.compile(r"passport.*num|number|doc", re.I), "passport"),
            (re.compile(r"expir|valid|till", re.I), "expiry"),
        ]
        if isinstance(fields_info, list):
            for f in fields_info:
                if f.get('value'):
                    log("STEP2b: '%s' already filled → skipping" % f.get('label','?')[:30])
                    continue
                # Derive fill value from label
                fill_val = ""
                lbl = f.get('label','') + ' ' + f.get('placeholder','') + ' ' + f.get('fc','')
                for pat, key in _LABEL_MAP:
                    if pat.search(lbl):
                        fill_val = _profile.get(key, "")
                        break
                if not fill_val:
                    log("STEP2b: '%s' empty, no profile match → skipping" % f.get('label','?')[:30])
                    continue
                log("STEP2b: filling '%s' with profile value (len=%d)" % (f.get('label','?')[:30], len(fill_val)))
                # Trusted typing: same Angular-sync approach as login fill
                sel_expr = ""
                if f.get('id'):
                    sel_expr = "#" + f['id']
                elif f.get('fc'):
                    sel_expr = "[formcontrolname='%s']" % f['fc']
                if sel_expr:
                    await jeval(page, "(%s)(%s,%s)" % (_SYNC_FIELD_JS, json.dumps(sel_expr), json.dumps(fill_val)))
        # ── Nationality mat-select ────────────────────────────────────────────
        # After OCR, VFS loads a Nationality dropdown (loaded from master/nationality).
        # It is a mat-select, not an input, so the input loop above misses it.
        # Open it, pick "Uzbekistan", verify the displayed value, then Save.
        nat_selects = await page.select_all("mat-select")
        if nat_selects:
            log("STEP2b: %d mat-select(s) visible — attempting Nationality pick" % len(nat_selects))
            nat_picked = False
            for ns_idx, ns in enumerate(nat_selects):
                # open this mat-select
                await close_overlay(page)
                try:
                    await ns.mouse_click()
                except Exception:
                    await jeval(page, "(()=>{const s=document.querySelectorAll('mat-select')[%d]; if(s)s.click();})()" % ns_idx)
                await asyncio.sleep(1.2)
                # check if the panel has nationality-shaped options
                opts = await page.select_all("mat-option, .mat-option, .mat-mdc-option, [role=option]")
                opts_text = [(o.text or "").strip() for o in opts if (o.text or "").strip()]
                log("STEP2b: mat-select[%d] options sample: %s" % (ns_idx, opts_text[:5]))
                uzb_opt = next((o for o in opts if re.search(r"uzbek", (o.text or ""), re.I)), None)
                if uzb_opt:
                    try:
                        await uzb_opt.mouse_click()
                    except Exception:
                        await jeval(page, "(()=>{const o=[...document.querySelectorAll('mat-option,.mat-mdc-option,[role=option]')].find(o=>/uzbek/i.test(o.innerText||'')); if(o)o.click();})()")
                    await asyncio.sleep(0.8)
                    # verify displayed value
                    disp = await jeval(page, """(()=>{const s=document.querySelectorAll('mat-select')[%d];
                        const v=s&&s.querySelector('.mat-mdc-select-value-text,.mat-select-value-text,.mat-mdc-select-value,.mat-select-value');
                        return ((v&&v.innerText)||'').trim();})()""" % ns_idx) or ""
                    log("STEP2b: Nationality mat-select[%d] now shows: %r" % (ns_idx, disp[:40]))
                    nat_picked = True
                    break
                else:
                    await close_overlay(page)
            if not nat_picked:
                log("STEP2b: Uzbekistan option not found in any mat-select — proceeding anyway")
        # Wait briefly for Angular validation, then click Save/Continue
        await asyncio.sleep(1.5)
        # Try Continue first (it may now be enabled once nationality is set), then Save
        advanced = False
        for btn_label in [["continue"], ["save"]]:
            await click_button_text(page, btn_label, timeout=8)
            await asyncio.sleep(2)
            chk_url = await jeval(page, "location.href") or ""
            if "your-details" not in chk_url:
                advanced = True
                log("STEP2b: page advanced → %s" % chk_url.split('/')[-1].split('?')[0][:30])
                break
        if not advanced:
            log("STEP2b: still on your-details after save/continue")
        await dump_state(page, "2d_after_detail_save")
        new_url = await jeval(page, "location.href") or ""
        log("STEP2b: after detail-save url=%s" % new_url.split('/')[-1].split('?')[0][:30])
    # Summary page → Continue advances to the OTP gate. Snapshot existing Mailsac
    # message ids first so we can distinguish the new OTP email from old mail.
    pre_ids = set(m.get("_id") for m in mailsac_list(book_email))
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
        milestone("otp_requested", email=book_email)
        code = await mailsac_otp_code(book_email, pre_ids, timeout=120)
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
            milestone("otp_filled", email=book_email)
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
            milestone("otp_timeout", email=book_email, error="otp_timeout")
            await dump_state(page, "3b_after_otp")
            telegram_photo(shot_path("book_3b_after_otp"), f"⏱ OTP timeout (check MAILSAC_API_KEY) — {book_email}")
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
    global BOOK_ENABLED, _REPLAY_PROBED, EMAIL, PASSWORD
    if not EMAIL or not PASSWORD:
        log("ERROR: set VFS_EMAIL/VFS_PASSWORD"); sys.exit(2)
    if BOOK_DRY_RUN and BOOK_ENABLED:
        log("WARN: both BOOK_DRY_RUN and BOOK_ENABLED are set — DRY_RUN takes precedence (no actual submit)")
        BOOK_ENABLED = False
    import nodriver as uc
    slot_q = asyncio.Queue(maxsize=1)
    stop_event = asyncio.Event()
    booker_state = {"direct_fallback": False}

    async def booker_task():
        """Keep a second account logged in at dashboard with zero availability
        calls; the watcher spends the slot-check budget and signals this session."""
        if not BOOKER_EMAIL:
            return
        booker_browser = None
        try:
            log(f"BOOKER: starting second browser for {BOOKER_EMAIL}")
            booker_browser = await uc.start(headless=False, browser_args=["--lang=en-US"])
            booker_page = await booker_browser.get(LOGIN_URL)
            if not await do_login(booker_browser, booker_page, email=BOOKER_EMAIL, password=BOOKER_PASSWORD):
                log("BOOKER: login failed — watcher will book directly if a slot appears")
                booker_state["direct_fallback"] = True
                return
            log("BOOKER: login OK — parked at dashboard")
            milestone("logged_in", email=BOOKER_EMAIL)
            try:
                await jeval(booker_page, "location.href=%s" % json.dumps(DASHBOARD_URL))
            except Exception:
                pass
            # Same-IP two-session mode shares the IP request budget. Keep-alive is
            # intentionally minimal and never calls CheckIsSlotAvailable.
            while not stop_event.is_set():
                try:
                    payload = await asyncio.wait_for(slot_q.get(), timeout=9 * 60)
                except asyncio.TimeoutError:
                    try:
                        url = await jeval(booker_page, "location.href") or ""
                        if "/login" in url:
                            log("BOOKER: session redirected to login — re-logging")
                            if not await do_login(booker_browser, booker_page, email=BOOKER_EMAIL, password=BOOKER_PASSWORD):
                                log("BOOKER: re-login failed — watcher direct fallback enabled")
                                booker_state["direct_fallback"] = True
                                return
                        else:
                            await jeval(booker_page, "location.href=%s" % json.dumps(DASHBOARD_URL))
                            log("BOOKER: dashboard keep-alive")
                    except Exception as e:
                        log("BOOKER: keep-alive error:", str(e)[:100])
                    continue

                subcat = payload.get("subcat") or ""
                log(f"BOOKER: slot signal received — entering wizard for {subcat}")
                try:
                    await enter_wizard(booker_page)
                    exact_subcat = re.compile(r"^%s$" % re.escape(subcat), re.I)
                    selected = await select_route(booker_page, subcat_re=exact_subcat)
                    if not selected:
                        log("BOOKER: exact subcat not selectable/available — watcher direct fallback enabled")
                        booker_state["direct_fallback"] = True
                        continue
                    if not BOOK_DRY_RUN and not BOOK_ENABLED:
                        log("BOOKER: slot found but BOOK_ENABLED off — stopping for operator")
                        stop_event.set()
                        return
                    outcome, detail = await book(
                        booker_page,
                        selected,
                        email=BOOKER_EMAIL,
                        passport=BOOKER_PASSPORT_IMAGE or PASSPORT_IMAGE,
                        profile=BOOKER_PROFILE,
                    )
                    if outcome == "confirmed":
                        milestone("booked", email=BOOKER_EMAIL, slotId=selected, confirmation=detail)
                        telegram_photo(shot_path("pipe_confirmed"), f"🎉 Booked: {detail} — {BOOKER_EMAIL} ({selected})")
                    elif outcome == "payment_wall":
                        milestone("booking_submitted", email=BOOKER_EMAIL, slotId=selected, detail="payment_wall")
                        telegram_photo(shot_path("pipe_payment_wall"), f"⚠️ Payment wall — manual payment needed — {BOOKER_EMAIL} ({selected})")
                    elif outcome == "dry_run":
                        milestone("booking_submitted", email=BOOKER_EMAIL, slotId=selected, detail="dry_run")
                    else:
                        milestone("failed", email=BOOKER_EMAIL, error=detail, slotId=selected)
                        telegram_photo(shot_path("pipe_submit_uncertain"), f"❌ Booking blocked: {detail} — {BOOKER_EMAIL} ({selected})")
                    stop_event.set()
                    return
                except Exception as e:
                    log("BOOKER: booking flow error:", str(e)[:160])
                    milestone("failed", email=BOOKER_EMAIL, error=str(e)[:120], slotId=subcat)
                    stop_event.set()
                    return
        finally:
            if booker_browser is not None:
                try:
                    booker_browser.stop()
                except Exception:
                    pass

    booker_runner = asyncio.create_task(booker_task()) if BOOKER_EMAIL else None
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
        await asyncio.sleep(5)
        stop_event.set()
        if booker_runner is not None and not booker_runner.done():
            booker_runner.cancel()
            try:
                await booker_runner
            except asyncio.CancelledError:
                pass
        browser.stop(); return
    log("LOGIN OK")
    milestone("logged_in", email=EMAIL)
    telegram(f"[bot] logged in {EMAIL}, monitoring Work D-visa slots…")
    # Pre-register this account in the shared pool immediately after login.
    # At this point auth headers may not yet be captured (they arrive when the
    # wizard fires its first lift-api request), so the entry will be sparse.
    # _dump_lift_creds() called later from _maybe_confirm_codes() will overwrite
    # with the full token.  This early write lets a concurrent instance see this
    # account exists in the pool even if it 429s before our codes confirm.
    _pool_register_self()

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
    api_403_streak = 0   # consecutive HTTP-403 responses → re-login after 1-2 hits
    ui_walks = 0         # heavy UI walks done while codes still unconfirmed
    MAX_UI_WALKS = 4     # after this, back off hard so we don't trip 429201
    _ocma_last_report = 0  # epoch-seconds of last OCMA Telegram alert (rate-limit ~10min)
    while True:
        if stop_event.is_set():
            log("watcher stopping — booker completed")
            break
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
        # Once auth is captured, fetch the real Work-D codes (in-browser, authed)
        # so we can poll the slot API DIRECTLY and SKIP the flaky wizard entirely.
        if auth_captured() and not codes_confirmed():
            try:
                await load_workd_codes(page)
            except Exception as _ce:
                log("load_workd_codes error (non-fatal):", str(_ce)[:100])

        if auth_captured() and codes_confirmed():
            # Check EACH Work-D sub-category code via the API — no wizard, no
            # re-entry. (DIRECT_POLL uses the single captured code through a proxy.)
            # OCMA and Work-D are treated differently: OCMA → report-only (no booking,
            # no select_route nav); Work-D → report + book (gated by BOOK_ENABLED).
            # Scan ALL subcats every cycle — do NOT break early on OCMA so Work-D is
            # always checked even when OCMA has slots.
            checks = _WORKD_CODES if (_WORKD_CODES and not DIRECT_POLL) else [(None, None)]
            ocma_avail = None   # (earliestDate, slot_count) if OCMA has slots this cycle
            workd_slot = None   # earliest/marker if Work-D has slots this cycle
            _api_broke = False  # true if any API call errored → fall through to UI
            for _nm, _cd in checks:
                is_ocma = bool(re.search(r"ocma", _nm or "", re.I))
                if DIRECT_POLL:
                    proxy = _next_proxy(attempt)
                    if proxy:
                        log(f"DIRECT poll via {proxy.split('@')[-1]}")
                    api = await api_check_direct(proxy)
                else:
                    api = await api_check_availability(page, code_override=_cd)
                if api is None:
                    api_fail_streak += 1
                    log(f"API: call failed (streak={api_fail_streak})")
                    _api_broke = True
                    break
                status = api.get("_status", 0)
                err = api.get("error")
                err_code = (err or {}).get("code") if isinstance(err, dict) else None
                # error.code 1035 means "No slots available" — a legitimate negative
                # result from VFS's own API.  Treat it as a clean no-slot, NOT a
                # transport/block failure; keep scanning the remaining subcategories.
                if err_code == 1035:
                    log(f"API: no slots in {_nm or 'work-d'} (1035 — confirmed by API)")
                    used_api = True
                    api_fail_streak = 0
                    api_403_streak = 0
                    continue  # next subcategory; do NOT break to UI
                if status == 429 or err_code in (429201, 429202):
                    # Hard per-IP rate-limit.  Primary strategy: rotate to another
                    # account's token from the shared pool so polling continues
                    # WITHOUT a sleep.  Fall back to the original RATELIMIT_BACKOFF_MIN
                    # sleep only when the pool has no other available account.
                    log(f"API: rate-limited (status={status}, code={err_code}) — "
                        f"checking account pool for rotation")
                    api_fail_streak = 0  # don't also trigger re-login on 429
                    api_403_streak = 0
                    used_api = False
                    _api_broke = True   # suppress slot/booking path this cycle

                    # Mark the current account as cooling down in the pool file.
                    _pool_mark_ratelimited(EMAIL, RATELIMIT_BACKOFF_MIN)

                    next_acct = _pool_next_available(EMAIL)
                    if next_acct:
                        _prev_email = EMAIL
                        _pool_apply_account(next_acct)
                        _api_broke = False
                        log(f"POOL: rotated {_prev_email} → {EMAIL} — continuing poll immediately")
                        milestone("monitoring", email=EMAIL,
                                  detail=f"check #{attempt} — rotated from {_prev_email} after 429 ({err_code or status})")
                        # Continue the outer while loop immediately (no sleep) so the
                        # next cycle polls with the new account's token right away.
                        break  # break the for-subcat loop; outer while resumes
                    else:
                        # No pre-authed pool spare.  Before sleeping, try to log in
                        # an ACTIVE+unlinked account whose credentials were pre-written
                        # by orchestrator-worker.ts into .spare-credentials.json.
                        _spare_rotated = False
                        spare_cred = _spare_creds_pop()
                        if spare_cred:
                            _prev_email_spare = EMAIL
                            EMAIL = spare_cred["email"]
                            PASSWORD = spare_cred["password"]
                            log(f"SPARE: logging in {EMAIL} inline (no pool spare after 429)")
                            milestone("monitoring", email=EMAIL,
                                      detail=f"check #{attempt} — no pool spare, inline login of spare {EMAIL}")
                            try:
                                login_ok = await do_login(browser, page)
                            except Exception as _le:
                                log(f"SPARE: inline login raised: {str(_le)[:80]}")
                                login_ok = False
                            if login_ok:
                                # Token capture fires when wizard loads its first
                                # lift-api request; pre-register now so the pool
                                # entry exists, then enter wizard to capture the token.
                                _pool_register_self()
                                try:
                                    await enter_wizard(page)
                                    _pool_register_self()  # re-register with token if now captured
                                except Exception as _we:
                                    log(f"SPARE: enter_wizard after inline login raised: {str(_we)[:80]}")
                                next_from_spare = _pool_next_available(_prev_email_spare)
                                if next_from_spare:
                                    _pool_apply_account(next_from_spare)
                                    log(f"SPARE: rotated {_prev_email_spare} → {EMAIL} — continuing poll immediately")
                                    milestone("monitoring", email=EMAIL,
                                              detail=f"check #{attempt} — spare logged in, rotated from {_prev_email_spare}")
                                else:
                                    # Already on the new account (EMAIL was set above);
                                    # pool entry may be sparse (no token yet) but the
                                    # next cycle will poll with the new session.
                                    log(f"SPARE: now polling as {EMAIL} (token capture pending wizard walk)")
                                _api_broke = False
                                _spare_rotated = True
                                break  # outer while resumes immediately with new account
                            else:
                                log(f"SPARE: inline login failed for {EMAIL} — reverting to {_prev_email_spare}")
                                EMAIL = _prev_email_spare
                                PASSWORD = ""  # clear — we don't know the original password here
                        if not _spare_rotated:
                            # Option B: no spare credential (or inline login failed) —
                            # register a brand-new VFS account on the spot, then log in
                            # with it so polling continues without a sleep.
                            # Falls back to the original RATELIMIT_BACKOFF_MIN sleep only
                            # if registration itself fails.
                            _reg_success = False
                            if MAILSAC_KEY:
                                log(f"REGISTER: no spare accounts left — registering a new VFS account on the spot")
                                milestone("monitoring", email=EMAIL,
                                          detail=f"check #{attempt} — no spare, starting auto-registration")
                                try:
                                    _reg_script = str(pathlib.Path(__file__).resolve().parent / "register_spike.py")
                                    # Run register_spike in a SUBPROCESS so its own nodriver
                                    # browser does not conflict with this pipeline's browser.
                                    _reg_env = {**os.environ, "MAILSAC_API_KEY": MAILSAC_KEY}
                                    _reg_proc = await asyncio.create_subprocess_exec(
                                        sys.executable, _reg_script,
                                        stdout=asyncio.subprocess.PIPE,
                                        stderr=asyncio.subprocess.STDOUT,
                                        env=_reg_env,
                                    )
                                    log("REGISTER: subprocess started — waiting up to 3 minutes")
                                    try:
                                        _reg_out_bytes, _ = await asyncio.wait_for(
                                            _reg_proc.communicate(), timeout=180
                                        )
                                    except asyncio.TimeoutError:
                                        log("REGISTER: subprocess timed out after 3 minutes — killing")
                                        try:
                                            _reg_proc.kill()
                                        except Exception:
                                            pass
                                        _reg_out_bytes = b""
                                    _reg_out = _reg_out_bytes.decode("utf-8", "replace") if _reg_out_bytes else ""
                                    log("REGISTER: subprocess output (last 1000 chars):\n" + _reg_out[-1000:])
                                    # Parse the RESULT line: RESULT: {"email":..., "password":..., "registered":...}
                                    _reg_data = None
                                    for _line in _reg_out.splitlines():
                                        if _line.startswith("RESULT:") or "[REG] RESULT:" in _line:
                                            _json_part = _line[_line.index("{"):]
                                            try:
                                                _reg_data = json.loads(_json_part)
                                            except Exception:
                                                pass
                                            break
                                    if _reg_data and _reg_data.get("registered") and _reg_data.get("email") and _reg_data.get("password"):
                                        _new_email = _reg_data["email"]
                                        _new_password = _reg_data["password"]
                                        log(f"REGISTER: new account registered: {_new_email} (activated={_reg_data.get('activated')}) — logging in")
                                        milestone("monitoring", email=EMAIL,
                                                  detail=f"check #{attempt} — registered {_new_email}, logging in inline")
                                        _prev_email_reg = EMAIL
                                        EMAIL = _new_email
                                        PASSWORD = _new_password
                                        try:
                                            login_ok = await do_login(browser, page)
                                        except Exception as _rle:
                                            log(f"REGISTER: inline login raised: {str(_rle)[:80]}")
                                            login_ok = False
                                        if login_ok:
                                            _pool_register_self()
                                            try:
                                                await enter_wizard(page)
                                                _pool_register_self()
                                            except Exception as _rwe:
                                                log(f"REGISTER: enter_wizard after reg-login raised: {str(_rwe)[:80]}")
                                            log(f"REGISTER: now polling as freshly-registered {EMAIL}")
                                            milestone("monitoring", email=EMAIL,
                                                      detail=f"check #{attempt} — registered+logged-in {EMAIL}, resuming poll")
                                            _reg_success = True
                                            _api_broke = False
                                            break  # outer while resumes immediately
                                        else:
                                            log(f"REGISTER: login failed for new account {EMAIL} — reverting to {_prev_email_reg}")
                                            EMAIL = _prev_email_reg
                                            PASSWORD = ""
                                    else:
                                        _err_hint = (_reg_data or {}).get("error", "no RESULT line found")
                                        log(f"REGISTER: registration did not succeed (error={_err_hint}) — falling back to sleep")
                                except Exception as _reg_exc:
                                    log(f"REGISTER: unexpected error: {str(_reg_exc)[:120]} — falling back to sleep")
                            else:
                                log("REGISTER: MAILSAC_API_KEY not set — cannot auto-register, falling back to sleep")

                            if not _reg_success:
                                # Registration failed (or MAILSAC key missing) —
                                # fall back to original sleep behaviour.
                                _backoff_s = RATELIMIT_BACKOFF_MIN * 60
                                log(f"POOL: no spare account available and registration failed — "
                                    f"sleeping {RATELIMIT_BACKOFF_MIN}min as fallback")
                                milestone("monitoring", email=EMAIL,
                                          detail=f"check #{attempt} — rate-limited ({err_code or status}), "
                                                 f"no pool spare, registration failed, silent backoff {RATELIMIT_BACKOFF_MIN}min")
                                await asyncio.sleep(_backoff_s)
                                break  # restart the for-subcat loop after sleep; outer while resumes
                elif status == 403:
                    # Token/cookie challenge — NOT a hard rate-limit.  Trigger re-login
                    # after 1-2 consecutive 403s; short backoff; do NOT UI-walk.
                    api_403_streak += 1
                    log(f"API: 403 (streak={api_403_streak}) — will re-login if streak>=2; "
                        f"NO UI walk")
                    used_api = False
                    _api_broke = True
                    if api_403_streak >= 2:
                        _short_backoff_s = random.uniform(120, 180)
                        log(f"API: 403 streak={api_403_streak} — re-login in "
                            f"{int(_short_backoff_s)}s (token refresh)")
                        milestone("monitoring", email=EMAIL,
                                  detail=f"check #{attempt} — 403 streak, re-login in "
                                         f"{int(_short_backoff_s)}s")
                        await asyncio.sleep(_short_backoff_s)
                        api_fail_streak = 3  # force re-login branch below loop
                        api_403_streak = 0
                    break
                elif status != 200 or err:
                    api_fail_streak += 1
                    api_403_streak = 0
                    log(f"API: unusable (status={status}, code={err_code}, streak={api_fail_streak}) — falling back to UI")
                    used_api = False
                    _api_broke = True
                    break
                used_api = True
                api_fail_streak = 0
                api_403_streak = 0
                if not _REPLAY_PROBED:
                    _REPLAY_PROBED = True
                    try:
                        await replay_probe(page)
                    except Exception as _pe:
                        log("replay_probe error (non-fatal):", str(_pe)[:100])
                earliest = api.get("earliestDate")
                slot_lists = api.get("earliestSlotLists") or []
                if earliest or slot_lists:
                    _count = len(slot_lists)
                    log("API: SLOT AVAILABLE in %s — earliestDate=%s lists=%d" % (_nm or "work-d", earliest, _count))
                    if is_ocma:
                        ocma_avail = (earliest, _count)
                        # Do NOT set slot / break — keep scanning for Work-D
                    else:
                        workd_slot = earliest or "slot"
                        # Found Work-D slot; can stop scanning subcats early
                        break
                else:
                    log("API: no slots in %s" % (_nm or "work-d"))

            # ── OCMA report path (report-only, never book) ────────────────────
            if ocma_avail and not _api_broke:
                _now = time.time()
                if _now - _ocma_last_report >= 600:  # at most once per ~10 min
                    _ocma_last_report = _now
                    _ed, _cnt = ocma_avail
                    milestone("ocma_available", email=EMAIL, detail=f"earliestDate={_ed} lists={_cnt}")
                    telegram(f"[bot] ✅ OCMA slots available — {_ed}, {_cnt} lists — bot detection confirmed ({EMAIL})", force=True)
                    log(f"OCMA report sent (earliestDate={_ed}, lists={_cnt})")
                else:
                    log("OCMA slots available but report rate-limited (sent <10min ago)")

            # Work-D slot drives select_route() + book(); OCMA never sets this.
            if workd_slot:
                slot = workd_slot

            # Safety-net flag: API returned all-1035 (clean no-slot across every
            # subcategory, no break, no real error).  We keep the UI cross-check
            # for now so we can compare API vs UI in logs and confirm whether the
            # API surfaces OCMA the same way the wizard does.  Once logs show
            # agreement we can drop the UI walk for the all-clear case.
            _api_all_clear = (used_api and not _api_broke and not slot and not ocma_avail)
        elif not auth_captured():
            log("API: auth headers not captured yet — using UI path")
            _api_all_clear = False
        else:
            log("API: codes not confirmed yet — UI walk first to capture real codes")
            _api_all_clear = False

        # FALLBACK / BACKWARD-COMPAT: run the existing UI slot check when:
        #   a) API didn't resolve this cycle (used_api=False or _api_broke), OR
        #   b) API found a slot (select_route needed to leave wizard in bookable state), OR
        #   c) API returned all-1035 clean (_api_all_clear) — UI cross-check safety net.
        # When _api_all_clear, log explicitly so we can later compare API vs UI output.
        if _api_all_clear:
            log("API: all subcategories returned 1035 (no slots) — running UI cross-check for safety")
        if not used_api or slot or _api_all_clear:
            try:
                ui_slot = await select_route(page)
            except Exception as _se:
                # A transient DOM/nav error in the route walk must NOT kill a
                # multi-hour monitor. Log, treat as "no slot this cycle", keep looping.
                log("select_route errored (continuing loop):", str(_se)[:160])
                ui_slot = None

            # UI-path OCMA filter: if select_route landed on an OCMA subcat, treat
            # it as report-only (same as the API path). Never book OCMA via the UI.
            if ui_slot and re.search(r"ocma", ui_slot or "", re.I):
                _now = time.time()
                if _now - _ocma_last_report >= 600:
                    _ocma_last_report = _now
                    milestone("ocma_available", email=EMAIL, detail=f"subcatName={ui_slot}")
                    telegram(f"[bot] ✅ OCMA slots available — {ui_slot} — bot detection confirmed ({EMAIL})", force=True)
                    log(f"OCMA report (UI path) sent: {ui_slot}")
                else:
                    log(f"OCMA UI slot '{ui_slot}' rate-limited (sent <10min ago) — skipping report")
                ui_slot = None  # do NOT pass to slot → no booking for OCMA

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
            if BOOKER_EMAIL and not booker_state["direct_fallback"]:
                if slot_q.full():
                    log("BOOKER: slot already queued — continuing watcher loop")
                else:
                    await slot_q.put({"subcat": slot})
                    log(f"BOOKER: queued slot handoff for {slot} — watcher continues")
                continue
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
        # On the API path use API_MONITOR_INTERVAL (default 30s) so a large
        # MONITOR_INTERVAL set for the UI path doesn't stall the fast API cycle.
        interval_for_path = API_MONITOR_INTERVAL if used_api else UI_MONITOR_INTERVAL
        burst = _burst_interval_now()
        if burst is not None:
            interval_for_path = burst
        jitter = random.uniform(0, 1.0) if burst == BURST_INTERVAL else random.uniform(0, max(5.0, interval_for_path * 0.4))
        path_tag = "api" if used_api else "ui"
        log(f"no slot — re-checking in ~{int(interval_for_path + jitter)}s ({path_tag})")
        # emit a per-check milestone so the backend sends a "no slots" Telegram
        # on EVERY check (operator wants a message each time, not a summary).
        milestone("monitoring", email=EMAIL, detail=f"check #{attempt} ({path_tag}) — Work D-visa, no slots")
        await asyncio.sleep(interval_for_path + jitter)

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
                slowdown = max(MONITOR_INTERVAL * 2, 60.0)
                log(f"WARN: codes still unconfirmed after {ui_walks} UI walks — backing "
                    f"off {int(slowdown)}s to protect the IP (CDP post-data capture issue?)")
                await asyncio.sleep(slowdown)
            await _reenter_wizard_fresh(page)

    log("done — keeping browser open 15s")
    await asyncio.sleep(15)
    stop_event.set()
    if booker_runner is not None and not booker_runner.done():
        booker_runner.cancel()
        try:
            await booker_runner
        except asyncio.CancelledError:
            pass
    browser.stop()


if __name__ == "__main__":
    import nodriver as uc
    try:
        uc.loop().run_until_complete(main())
    except Exception as _e:
        milestone("failed", error=str(_e))
        raise
