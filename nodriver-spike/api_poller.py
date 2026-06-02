#!/usr/bin/env python3
"""
api_poller.py — direct lift-api slot monitor with IP ROTATION (no browser).

This is the "pass the API at scale" component. Instead of driving a browser on
ONE IP (which trips VFS's per-IP 429201), it replays a REAL captured auth token
as direct HTTP calls, rotating the source IP across a proxy pool each request —
so no single IP exceeds the rate limit. This is how 24/7 services do thousands
of checks/day without getting blocked.

HARD REQUIREMENTS (it does NOT forge anything — you can't fake VFS auth):
  1. A real token: run auto_pipeline.py once (browser login) — it writes
     nodriver-spike/.lift-creds.json with the live authorize/clientsource + codes.
  2. The token must NOT be IP/cookie-bound. The replay_probe in auto_pipeline.py
     tells you: HTTP 200 cookieless = good to go; 401/403 = token bound (this
     poller won't help — you'd need a browser session per IP instead).
  3. A UZ IP pool that also passes Datadome (mobile/residential/several VPSs).

USAGE:
  # one IP (just direct, to sanity-check the token):
  python api_poller.py
  # rotate across a pool (the real use):
  set PROXY_LIST=http://u:p@ip1:port,http://u:p@ip2:port,...
  set POLL_INTERVAL=20
  python api_poller.py

Env:
  LIFT_CREDS         path to creds json (default: ./.lift-creds.json)
  PROXY_LIST         comma-separated proxy URLs; rotated round-robin per request
  POLL_INTERVAL      seconds between checks (default 20)
  TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID   optional alerts
"""
import json
import os
import pathlib
import random
import ssl
import sys
import time
import urllib.error
import urllib.request

LIFT_API_URL = "https://lift-api.vfsglobal.com/appointment/CheckIsSlotAvailable"
CREDS_FILE = os.environ.get("LIFT_CREDS",
                            str(pathlib.Path(__file__).resolve().parent / ".lift-creds.json"))
POLL_INTERVAL = int(os.environ.get("POLL_INTERVAL", "20"))
PROXY_LIST = [p.strip() for p in os.environ.get("PROXY_LIST", "").split(",") if p.strip()]
BROWSER_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")


def log(*a):
    print("[POLLER]", *a, flush=True)


def _tg_ctx():
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


def telegram(msg):
    tok = os.environ.get("TELEGRAM_BOT_TOKEN")
    chat = os.environ.get("TELEGRAM_CHAT_ID")
    if not tok or not chat:
        log("(telegram not configured)", msg)
        return
    try:
        data = json.dumps({"chat_id": chat, "text": msg}).encode()
        req = urllib.request.Request(
            f"https://api.telegram.org/bot{tok}/sendMessage", data=data,
            headers={"Content-Type": "application/json"})
        urllib.request.urlopen(req, timeout=15, context=_tg_ctx())
    except Exception as e:
        log("telegram err:", str(e)[:80])


def load_creds():
    if not os.path.exists(CREDS_FILE):
        log(f"ERROR: {CREDS_FILE} not found. Run auto_pipeline.py once to capture a token.")
        sys.exit(2)
    with open(CREDS_FILE, encoding="utf-8") as f:
        c = json.load(f)
    if not (c.get("auth", {}).get("authorize") and c.get("auth", {}).get("clientsource")):
        log("ERROR: creds file has no authorize/clientsource — re-capture.")
        sys.exit(2)
    return c


def check(creds, proxy):
    """One direct CheckIsSlotAvailable call. Returns (status, data_or_text)."""
    body = dict(creds["body"])
    body.update({"roleName": "Individual", "loginUser": creds.get("email", ""), "payCode": ""})
    headers = {
        "authorize": creds["auth"]["authorize"],
        "clientsource": creds["auth"]["clientsource"],
        "content-type": "application/json;charset=UTF-8",
        "accept": "application/json, text/plain, */*",
        "user-agent": BROWSER_UA,
        "origin": "https://visa.vfsglobal.com",
        "referer": "https://visa.vfsglobal.com/",
    }
    if creds["auth"].get("route"):
        headers["route"] = creds["auth"]["route"]
    if proxy:
        opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({"http": proxy, "https": proxy}))
    else:
        opener = urllib.request.build_opener()
    req = urllib.request.Request(LIFT_API_URL, data=json.dumps(body).encode(),
                                 headers=headers, method="POST")
    try:
        r = opener.open(req, timeout=25)
        raw = r.read().decode("utf-8", "replace")
        try:
            return r.status, json.loads(raw)
        except Exception:
            return r.status, raw[:300]
    except urllib.error.HTTPError as e:
        try:
            return e.code, e.read().decode("utf-8", "replace")[:300]
        except Exception:
            return e.code, ""
    except Exception as e:
        return 0, str(e)[:200]


def main():
    creds = load_creds()
    log(f"loaded token for {creds.get('email')} (captured {creds.get('capturedAt')})")
    log(f"codes: {creds['body']}")
    log(f"proxies: {len(PROXY_LIST)} in pool" if PROXY_LIST else "proxies: NONE (direct, single IP)")
    log(f"interval: {POLL_INTERVAL}s (+jitter)")
    telegram(f"🛰 api_poller started for {creds.get('email')} — "
             f"{len(PROXY_LIST) or 'direct'} IP(s), {POLL_INTERVAL}s")

    n = 0
    while True:
        n += 1
        proxy = PROXY_LIST[n % len(PROXY_LIST)] if PROXY_LIST else None
        where = (proxy.split("@")[-1] if proxy else "direct")
        status, data = check(creds, proxy)
        if status == 200 and isinstance(data, dict):
            earliest = data.get("earliestDate")
            lists = data.get("earliestSlotLists") or []
            if earliest or lists:
                log(f"#{n} [{where}] 🎉 SLOT AVAILABLE — earliestDate={earliest} lists={len(lists)}")
                telegram(f"🎉 SLOT via api_poller: earliestDate={earliest} ({creds.get('email')}) "
                         f"— hand off to the booking browser NOW")
            else:
                log(f"#{n} [{where}] 200 — no slots")
        elif status in (401, 403):
            log(f"#{n} [{where}] {status} — token rejected (IP/cookie-bound or expired). "
                f"Re-capture via auto_pipeline.py.")
        elif status == 429:
            log(f"#{n} [{where}] 429 — this IP is rate-limited; rotation should move past it.")
        else:
            log(f"#{n} [{where}] status={status} {str(data)[:120]}")
        time.sleep(POLL_INTERVAL + random.uniform(0, POLL_INTERVAL * 0.4))


if __name__ == "__main__":
    main()
