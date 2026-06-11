"""
nodriver VFS idle network probe.

Records what the real nodriver Chrome session does while the operator logs in,
navigates toward Work-D Latvia, and then leaves the page idle. The goal is to
detect whether VFS exposes WebSocket/SSE/long-poll/background refresh/DOM-change
signals without forcing extra CheckIsSlotAvailable polling.

Run from repo root or backend wrapper:
  python nodriver-spike/probe_idle_network.py

Env:
  VFS_PROBE_URL       default https://visa.vfsglobal.com/uzb/en/lva/login
  VFS_PROBE_PREP_SEC  default 180, time to log in/navigate
  VFS_PROBE_IDLE_SEC  default 600, idle recording time
  VFS_PROFILE_DIR     optional persistent Chrome profile
  VFS_PROBE_OUT_DIR   default ops
"""
import asyncio
import json
import os
import pathlib
import sys
import time
from datetime import datetime, timezone
from urllib.parse import urlparse, urlunparse

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

ROOT = pathlib.Path(__file__).resolve().parents[1]
START_URL = os.environ.get("VFS_PROBE_URL", "https://visa.vfsglobal.com/uzb/en/lva/login")
PREP_SEC = int(os.environ.get("VFS_PROBE_PREP_SEC", "180"))
IDLE_SEC = int(os.environ.get("VFS_PROBE_IDLE_SEC", "600"))
OUT_DIR = pathlib.Path(os.environ.get("VFS_PROBE_OUT_DIR", str(ROOT / "ops")))
PROFILE_DIR = os.environ.get("VFS_PROFILE_DIR") or str(ROOT / ".browser-profiles" / "nodriver-idle-probe")


def now_iso():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def log(*a):
    print("[ND-PROBE]", *a, flush=True)


def compact_url(url):
    if not url:
        return url
    try:
        parsed = urlparse(url)
        query = parsed.query
        if len(query) > 180:
            query = query[:180] + "..."
        return urlunparse((parsed.scheme, parsed.netloc, parsed.path, parsed.params, query, parsed.fragment))
    except Exception:
        return url[:260] + ("..." if len(url) > 260 else "")


def interesting(url):
    u = (url or "").lower()
    return (
        "vfsglobal" in u
        or "lift-api" in u
        or "visaservice" in u
        or "checkisslotavailable" in u
        or "slot" in u
        or u.startswith("wss://")
    )


def file_stamp():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z").replace(":", "-").replace(".", "-")


def phase(idle_started_at):
    return "idle" if idle_started_at and time.time() >= idle_started_at else "prep"


async def jeval(page, expr, await_promise=False):
    try:
        v = await page.evaluate(expr, await_promise=await_promise)
        if isinstance(v, dict) and "value" in v and set(v.keys()) <= {"type", "value", "subtype", "className"}:
            return v["value"]
        return v
    except Exception:
        return None


async def install_dom_observer(page):
    js = r"""
(() => {
  window.__vfsIdleProbeMutations = window.__vfsIdleProbeMutations || [];
  if (window.__vfsIdleProbeObserver) return true;
  const install = () => {
    if (!document.body || window.__vfsIdleProbeObserver) return;
    window.__vfsIdleProbeObserver = new MutationObserver((mutations) => {
      const rows = window.__vfsIdleProbeMutations;
      rows.push({
        t: new Date().toISOString(),
        count: mutations.length,
        text: (document.body.innerText || '').slice(0, 800)
      });
      if (rows.length > 500) rows.splice(0, rows.length - 500);
      console.log('[VFS_IDLE_PROBE_DOM_MUTATION]', rows[rows.length - 1].t, mutations.length);
    });
    window.__vfsIdleProbeObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
  else install();
  return true;
})()
"""
    return await jeval(page, js)


async def read_final_page(page):
    raw = await jeval(page, r"""
(() => JSON.stringify({
  url: location.href,
  title: document.title,
  bodyText: (document.body && document.body.innerText || '').slice(0, 2000),
  mutations: (window.__vfsIdleProbeMutations || []).slice(-500),
  resources: performance.getEntriesByType('resource').map(r => ({
    name: r.name,
    initiatorType: r.initiatorType,
    startTime: Math.round(r.startTime),
    duration: Math.round(r.duration)
  }))
}))()
""")
    try:
        return json.loads(raw or "{}")
    except Exception:
        return {"url": await jeval(page, "location.href"), "title": "", "bodyText": "", "mutations": [], "resources": []}


def summarize(events, final_page):
    resources = final_page.get("resources") or []
    mutations = final_page.get("mutations") or []
    responses = [e for e in events if e.get("kind") == "response"]
    idle_events = [e for e in events if e.get("phase") == "idle"]
    websockets = [e for e in events if e.get("kind") == "websocket"]
    sse = [e for e in responses if "text/event-stream" in (e.get("contentType") or "").lower()]
    long_polls = [e for e in responses if (e.get("durationMs") or 0) >= 15000]
    slot_checks = [e for e in events if "checkisslotavailable" in (e.get("url") or "").lower()]
    idle_slot_checks = [e for e in slot_checks if e.get("phase") == "idle"]
    idle_interesting = [e for e in idle_events if e.get("kind") == "request" and interesting(e.get("url"))]
    idle_resources = [r for r in resources if interesting(r.get("name"))]
    return {
        "websocketCount": len(websockets),
        "sseResponseCount": len(sse),
        "longPollResponseCount": len(long_polls),
        "checkIsSlotAvailableEvents": len(slot_checks),
        "idleCheckIsSlotAvailableEvents": len(idle_slot_checks),
        "idleInterestingRequestCount": len(idle_interesting),
        "idleResourceEntryCount": len(idle_resources),
        "domMutationCount": len(mutations),
        "verdict": {
            "possiblePushSignal": bool(websockets or sse),
            "possibleLongPollSignal": bool(long_polls),
            "pagePollsWhileIdle": bool(idle_interesting or idle_slot_checks),
            "domChangesWhileIdle": bool(mutations),
        },
    }


def md_report(report):
    s = report["summary"]
    return "\n".join([
        "# VFS nodriver Idle Network Probe",
        "",
        f"Generated: {report['generatedAt']}",
        f"Start URL: {report['startUrl']}",
        f"Final URL: {report.get('finalPage', {}).get('url', '-')}",
        f"Prep seconds: {report['config']['prepSeconds']}",
        f"Idle seconds: {report['config']['idleSeconds']}",
        "",
        "## Summary",
        "",
        f"- WebSockets: {s['websocketCount']}",
        f"- SSE responses: {s['sseResponseCount']}",
        f"- Long-poll responses >=15s: {s['longPollResponseCount']}",
        f"- CheckIsSlotAvailable events: {s['checkIsSlotAvailableEvents']}",
        f"- Idle CheckIsSlotAvailable events: {s['idleCheckIsSlotAvailableEvents']}",
        f"- Idle interesting requests: {s['idleInterestingRequestCount']}",
        f"- Idle resource entries: {s['idleResourceEntryCount']}",
        f"- DOM mutations recorded on final page: {s['domMutationCount']}",
        "",
        "## Verdict",
        "",
        f"- Possible push signal: {s['verdict']['possiblePushSignal']}",
        f"- Possible long-poll signal: {s['verdict']['possibleLongPollSignal']}",
        f"- Page polls while idle: {s['verdict']['pagePollsWhileIdle']}",
        f"- DOM changes while idle: {s['verdict']['domChangesWhileIdle']}",
        "",
        "Interpretation:",
        "",
        "- WebSocket/SSE means inspect the JSON before adding more polling.",
        "- Idle CheckIsSlotAvailable means the page itself is polling.",
        "- No idle signal means VFS is likely request-driven and needs staggered watcher polling.",
        "- DOM mutations must be checked manually; many mutations are timers/tracking, not slots.",
        "",
    ])


async def main():
    if "--help" in sys.argv or "-h" in sys.argv:
        print(__doc__)
        return

    import nodriver as uc
    from nodriver import cdp

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    pathlib.Path(PROFILE_DIR).mkdir(parents=True, exist_ok=True)

    events = []
    req_started = {}
    idle_started_at = None

    def add_event(kind, **kw):
        row = {"at": now_iso(), "phase": phase(idle_started_at), "kind": kind, **kw}
        events.append(row)
        if len(events) > 10000:
            del events[: len(events) - 10000]
        if interesting(row.get("url")):
            log(row["phase"], kind, row.get("status", ""), row.get("method", ""), row.get("resourceType", ""), compact_url(row.get("url", "")))

    async def on_req(evt):
        try:
            rid = str(evt.request_id)
            req_started[rid] = time.time()
            add_event(
                "request",
                requestId=rid,
                method=evt.request.method,
                url=compact_url(evt.request.url),
                resourceType=str(getattr(evt, "type_", "") or getattr(evt, "type", "") or ""),
            )
        except Exception:
            pass

    async def on_resp(evt):
        try:
            rid = str(evt.request_id)
            started = req_started.get(rid)
            add_event(
                "response",
                requestId=rid,
                url=compact_url(evt.response.url),
                status=getattr(evt.response, "status", None),
                contentType=(getattr(evt.response, "mime_type", "") or ""),
                durationMs=round((time.time() - started) * 1000) if started else None,
            )
        except Exception:
            pass

    async def on_loading_failed(evt):
        try:
            add_event("requestfailed", requestId=str(evt.request_id), message=str(getattr(evt, "error_text", "")))
        except Exception:
            pass

    async def on_ws_created(evt):
        try:
            add_event("websocket", requestId=str(evt.request_id), url=compact_url(evt.url))
        except Exception:
            pass

    async def on_ws_recv(evt):
        try:
            payload = getattr(getattr(evt, "response", None), "payload_data", "")
            add_event("websocket_frame_received", requestId=str(evt.request_id), message=str(payload)[:300])
        except Exception:
            pass

    async def on_ws_sent(evt):
        try:
            payload = getattr(getattr(evt, "response", None), "payload_data", "")
            add_event("websocket_frame_sent", requestId=str(evt.request_id), message=str(payload)[:300])
        except Exception:
            pass

    log("starting nodriver headed Chrome")
    log("profile:", PROFILE_DIR)
    log("start URL:", START_URL)
    log(f"prep={PREP_SEC}s idle={IDLE_SEC}s")

    browser = await uc.start(
        headless=False,
        user_data_dir=PROFILE_DIR,
        browser_args=[
            "--lang=en-US",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-notifications",
        ],
    )

    page = await browser.get(START_URL)
    page.add_handler(cdp.network.RequestWillBeSent, on_req)
    page.add_handler(cdp.network.ResponseReceived, on_resp)
    page.add_handler(cdp.network.LoadingFailed, on_loading_failed)
    page.add_handler(cdp.network.WebSocketCreated, on_ws_created)
    page.add_handler(cdp.network.WebSocketFrameReceived, on_ws_recv)
    page.add_handler(cdp.network.WebSocketFrameSent, on_ws_sent)
    try:
        await page.send(cdp.network.enable(max_post_data_size=262144))
    except TypeError:
        await page.send(cdp.network.enable())

    await install_dom_observer(page)
    log("CDP network capture enabled")
    log("Use the Chrome window now: log in and navigate as deep as possible toward Work-D Latvia.")
    log(f"Prep timer running for {PREP_SEC}s.")
    await asyncio.sleep(max(0, PREP_SEC))

    await install_dom_observer(page)
    idle_started_at = time.time()
    log(f"IDLE CAPTURE STARTED for {IDLE_SEC}s. Do not click/refresh unless intentionally testing an action.")
    await asyncio.sleep(max(1, IDLE_SEC))

    final_page = await read_final_page(page)
    report = {
        "generatedAt": now_iso(),
        "config": {
            "startUrl": START_URL,
            "prepSeconds": PREP_SEC,
            "idleSeconds": IDLE_SEC,
            "profileDir": PROFILE_DIR,
        },
        "startUrl": START_URL,
        "finalPage": final_page,
        "summary": summarize(events, final_page),
        "events": events,
    }
    base = OUT_DIR / f"vfs-nodriver-idle-network-report-{file_stamp()}"
    (base.with_suffix(".json")).write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    (base.with_suffix(".md")).write_text(md_report(report), encoding="utf-8")
    log("wrote:", str(base.with_suffix(".json")))
    log("wrote:", str(base.with_suffix(".md")))
    log("summary:", json.dumps(report["summary"], indent=2))
    try:
        await browser.stop()
    except Exception:
        pass


if __name__ == "__main__":
    asyncio.run(main())
