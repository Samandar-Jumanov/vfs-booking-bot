"""Proves the captured nodriver session tokens authenticate CheckIsSlotAvailable.
Reads nodriver-spike/session.json (written by login_spike.py) and POSTs the slot
check directly — no browser. A 200/4xx (not 401/403) = auth accepted.
"""
import json
import pathlib
import urllib.request

s = json.loads((pathlib.Path(__file__).parent / "session.json").read_text(encoding="utf-8"))
body = json.dumps({
    "countryCode": "uzb", "missionCode": "lva",
    "vacCode": "", "visaCategoryCode": "",  # empty = probe; auth is what we're testing
    "roleName": "Individual", "loginUser": s["email"], "payCode": "",
}).encode()

req = urllib.request.Request(
    "https://lift-api.vfsglobal.com/appointment/CheckIsSlotAvailable",
    data=body, method="POST",
    headers={
        "Content-Type": "application/json;charset=UTF-8",
        "Accept": "application/json, text/plain, */*",
        "Origin": "https://visa.vfsglobal.com",
        "Referer": "https://visa.vfsglobal.com/",
        "route": s["route"],
        "authorize": s["authorize"],
        "clientsource": s["clientsource"],
        "Cookie": f"cf_clearance={s['cf_clearance']}",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/148.0.0.0 Safari/537.36",
    },
)
try:
    with urllib.request.urlopen(req, timeout=30) as r:
        print("STATUS:", r.status)
        print("BODY:", r.read(400).decode("utf-8", "replace"))
        print("AUTH RESULT: ACCEPTED (tokens work) — login->tokens->slot-API loop PROVEN")
except urllib.error.HTTPError as e:
    print("STATUS:", e.code)
    print("BODY:", e.read(400).decode("utf-8", "replace"))
    print("AUTH RESULT:", "REJECTED (401/403 = tokens bad)" if e.code in (401, 403) else f"ACCEPTED (HTTP {e.code} = auth OK, params/other)")
except Exception as e:
    print("ERROR:", e)
