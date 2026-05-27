"""
nodriver VFS login spike — tests whether a stealth browser (no chrome.debugger /
CDP-leak) auto-passes the login Turnstile that the extension cannot.

Run (PowerShell):
  $env:VFS_EMAIL="..."; $env:VFS_PASSWORD="..."; python nodriver-spike/login_spike.py

Prints PHASE markers + writes screenshots to nodriver-spike\shots\ so we can see
exactly where it gets (captcha rendered? Sign In enabled? logged in?).
"""
import asyncio
import os
import sys
import json
import pathlib

try:
    sys.stdout.reconfigure(encoding="utf-8")  # avoid cp1252 crash on emoji/unicode
except Exception:
    pass

EMAIL = os.environ.get("VFS_EMAIL", "")
PASSWORD = os.environ.get("VFS_PASSWORD", "")
LOGIN_URL = os.environ.get("VFS_LOGIN_URL", "https://visa.vfsglobal.com/uzb/en/lva/login")
SHOTS = pathlib.Path(__file__).parent / "shots"
SHOTS.mkdir(exist_ok=True)


def log(*a):
    print("[SPIKE]", *a, flush=True)


async def shot(page, name):
    try:
        await page.save_screenshot(str(SHOTS / f"{name}.png"))
        log(f"screenshot -> {name}.png")
    except Exception as e:
        log(f"screenshot {name} failed: {e}")


async def dump_state(page, label):
    try:
        state = await page.evaluate(
            """(() => {
                const q = (s) => document.querySelector(s);
                const btn = [...document.querySelectorAll('button')].find(b => /sign\\s*in/i.test(b.innerText||''));
                let resp = null; try { resp = window.turnstile && window.turnstile.getResponse ? window.turnstile.getResponse() : null; } catch(e){ resp = 'err'; }
                const em = q('#email, input[formcontrolname=\\"username\\"]');
                const pw = q('#password, input[type=\\"password\\"]');
                return JSON.stringify({
                    url: location.href,
                    emailLen: em && em.value ? em.value.length : 0,
                    pwdLen: pw && pw.value ? pw.value.length : 0,
                    cfIframes: document.querySelectorAll('iframe[src*=\\"challenges.cloudflare.com\\"]').length,
                    cfRespLen: (q('[name=\\"cf-turnstile-response\\"]')||{}).value ? q('[name=\\"cf-turnstile-response\\"]').value.length : 0,
                    turnstileResp: resp ? (typeof resp==='string'? resp.length+'-char' : resp) : null,
                    signInDisabled: btn ? !!btn.disabled : 'no-btn',
                    bodyHasInactive: /inactive/i.test(document.body.innerText||''),
                });
            })()"""
        )
        log(f"STATE[{label}]:", state)
        return json.loads(state)
    except Exception as e:
        log(f"dump_state {label} failed: {e}")
        return {}


async def main():
    if not EMAIL or not PASSWORD:
        log("ERROR: set VFS_EMAIL and VFS_PASSWORD env vars")
        sys.exit(2)
    log("starting nodriver (headed)…", "email=", EMAIL)
    import nodriver as uc

    start_kwargs = {"headless": False, "browser_args": ["--lang=en-US"]}
    ext = os.environ.get("VFS_LOAD_EXTENSION")  # path to extension/dist for handoff
    if ext:
        start_kwargs["browser_args"] += [
            f"--load-extension={ext}",
            f"--disable-extensions-except={ext}",
            "--no-first-run", "--no-default-browser-check",
            "--disable-features=AutofillServerCommunication",
        ]
        log("loading extension:", ext)
    prof = os.environ.get("VFS_PROFILE_DIR")  # persistent profile (keeps extension settings)
    if prof:
        start_kwargs["user_data_dir"] = prof
        log("using profile:", prof)
    browser = await uc.start(**start_kwargs)
    log("PHASE 1: browser started")
    page = await browser.get(LOGIN_URL)
    log("PHASE 2: navigated to", LOGIN_URL)

    # Network capture — did /user/login (or any lift-api) actually get called?
    net_log = []
    captured_auth = {}
    try:
        from nodriver import cdp

        async def on_req(evt):
            try:
                u = evt.request.url
                if "lift-api" in u or "user/login" in u:
                    net_log.append(f"{evt.request.method} {u.split('?')[0]}")
                    hdrs = dict(evt.request.headers or {})
                    for k, v in hdrs.items():
                        if k.lower() in ("authorize", "clientsource", "route") and v:
                            captured_auth[k.lower()] = v
            except Exception:
                pass

        async def on_resp(evt):
            try:
                u = evt.response.url
                if "user/login" in u or "lift-api" in u:
                    net_log.append(f"<-- {evt.response.status} {u.split('?')[0]}")
            except Exception:
                pass

        page.add_handler(cdp.network.RequestWillBeSent, on_req)
        page.add_handler(cdp.network.ResponseReceived, on_resp)
        await page.send(cdp.network.enable())
        log("network capture enabled")
    except Exception as e:
        log("network capture setup failed:", e)
    await asyncio.sleep(10)  # let Cloudflare + Turnstile render/auto-pass
    await shot(page, "01_loaded")
    await dump_state(page, "loaded")

    # Fill email
    try:
        email_el = await page.select("#email", timeout=25)
    except Exception:
        email_el = await page.select('input[formcontrolname="username"]', timeout=10)
    await email_el.send_keys(EMAIL)
    log("PHASE 3: typed email")

    pwd_el = await page.select('#password, input[type="password"]', timeout=15)
    await pwd_el.send_keys(PASSWORD)
    log("PHASE 4: typed password")
    await asyncio.sleep(2)
    await shot(page, "02_filled")
    await dump_state(page, "filled")

    # Wait up to 30s for the Turnstile to clear → Sign In enabled
    log("PHASE 5: waiting for Sign In to enable (Turnstile auto-pass)…")
    enabled = False
    for i in range(30):
        st = await dump_state(page, f"wait{i}")
        if st.get("signInDisabled") is False:
            enabled = True
            log("PHASE 5: Sign In ENABLED after", i, "s")
            break
        await asyncio.sleep(1)
    await shot(page, "03_after_wait")
    if not enabled:
        log("RESULT: Sign In never enabled — Turnstile did NOT auto-pass for nodriver")

    async def capture_errors(label):
        try:
            errs = await page.evaluate(
                """(()=>[...document.querySelectorAll('mat-error,.mat-error,[class*="error" i],.invalid-feedback')]
                    .filter(e=>e.offsetParent&&(e.innerText||'').trim())
                    .map(e=>(e.innerText||'').trim().replace(/\\s+/g,' ').slice(0,90)).slice(0,8))()"""
            )
            log(f"ERRORS[{label}]:", errs)
            return errs
        except Exception as e:
            log(f"capture_errors {label} failed:", e)
            return []

    # Dismiss any cookie/consent overlay (OneTrust) that could be eating clicks.
    try:
        dismissed = await page.evaluate(
            """(()=>{ const ids=['onetrust-accept-btn-handler','onetrust-reject-all-handler'];
               for(const id of ids){ const e=document.getElementById(id); if(e){ e.click(); return 'clicked #'+id; } }
               const b=[...document.querySelectorAll('button,a')].find(x=>/accept all|accept cookies|i agree|got it/i.test(x.innerText||''));
               if(b){ b.click(); return 'clicked '+(b.innerText||'').trim().slice(0,25); }
               return 'no consent banner'; })()"""
        )
        log("consent:", dismissed)
        await asyncio.sleep(1)
    except Exception as e:
        log("consent dismiss failed:", e)

    # Diagnose: is the Sign In button actually the top element at its center, or
    # is something covering it (overlay eating the click)?
    try:
        ov = await page.evaluate(
            """(()=>{ const b=[...document.querySelectorAll('button')].find(x=>/sign\\s*in/i.test(x.innerText||''));
               if(!b) return 'no-button';
               const r=b.getBoundingClientRect();
               const el=document.elementFromPoint(r.left+r.width/2, r.top+r.height/2);
               return JSON.stringify({ btnType:b.getAttribute('type'), disabled:b.disabled,
                 topEl: el?(el.tagName.toLowerCase()+'.'+String(el.className||'').slice(0,40)):'none',
                 coversButton: el!==b && !b.contains(el) }); })()"""
        )
        log("OVERLAY CHECK:", ov)
    except Exception as e:
        log("overlay check failed:", e)

    # PHASE 6 — submit. Click the actual <button> (NOT the "Sign in" heading).
    log("PHASE 6: submitting…")
    clicked = False
    try:
        buttons = await page.select_all("button")
        log(f"found {len(buttons)} buttons")
        for b in buttons:
            try:
                txt = (b.text or "").strip()
            except Exception:
                txt = ""
            if txt and ("sign in" in txt.lower() or "signin" in txt.lower() or "log in" in txt.lower()):
                log(f"clicking button with text: '{txt[:30]}'")
                await b.mouse_click()
                clicked = True
                break
        if not clicked:
            log("no Sign In <button> found; button texts:",
                [((b.text or "").strip()[:20]) for b in buttons][:10])
    except Exception as e:
        log("button-select submit failed:", e)
    if not clicked:
        try:
            btn = await page.find("Sign In", best_match=True)
            await btn.mouse_click()
            log("fallback: clicked find('Sign In')")
        except Exception as e:
            log("fallback click failed:", e)

    await asyncio.sleep(4)
    st = await dump_state(page, "after_click")
    await capture_errors("after_click")

    # Fallback: press Enter in the password field if still on login.
    if "/login" in st.get("url", ""):
        try:
            pwd2 = await page.select('#password, input[type="password"]')
            await pwd2.send_keys("\n")
            log("pressed Enter in password field")
        except Exception as e:
            log("enter fallback failed:", e)

    # Wait up to 25s for navigation.
    final = {}
    for i in range(25):
        final = await dump_state(page, f"post{i}")
        if "/login" not in final.get("url", ""):
            break
        await asyncio.sleep(1)
    await shot(page, "04_after_signin")
    await capture_errors("final")

    # PHASE 7 — force an authenticated page so lift-api calls fire carrying the
    # `authorize` header (only sent AFTER login, on authed requests). Retry a
    # couple of routes since the post-login redirect can transiently 404.
    for route in ("dashboard", "application-detail", "dashboard"):
        if captured_auth.get("authorize"):
            break
        try:
            log(f"PHASE 7: warming /{route} to capture authorize…")
            await browser.get(f"https://visa.vfsglobal.com/uzb/en/lva/{route}")
            await asyncio.sleep(7)
        except Exception as e:
            log(f"warm {route} failed:", e)

    log("NETWORK (lift-api / user/login calls seen):", net_log if net_log else "(NONE — submit never hit the API)")

    url = final.get("url", "")
    if url and "/login" not in url and not final.get("bodyHasInactive"):
        log("RESULT: LOGIN SUCCESS — url:", url)
    elif final.get("bodyHasInactive"):
        log("RESULT: account INACTIVE (needs activation) — but captcha/login mechanics worked")
    else:
        log("RESULT: still on login — url:", url)

    # Capture any auth tokens VFS stored (best-effort)
    try:
        tokens = await page.evaluate(
            """(() => { const o={l:{},s:{}};
               try{for(const k of Object.keys(localStorage)) if(/token|auth|lift|client/i.test(k)) o.l[k]=(localStorage.getItem(k)||'').slice(0,40);}catch(e){}
               try{for(const k of Object.keys(sessionStorage)) if(/token|auth|lift|client/i.test(k)) o.s[k]=(sessionStorage.getItem(k)||'').slice(0,40);}catch(e){}
               return JSON.stringify(o); })()"""
        )
        log("AUTH-ISH STORAGE KEYS:", tokens)
    except Exception as e:
        log("token capture failed:", e)

    # Capture the session tokens (the whole point — feed these to the cheap
    # CheckIsSlotAvailable monitor). Also grab cf_clearance cookie.
    try:
        cookies = await browser.cookies.get_all()
        cf = next((c.value for c in cookies if c.name == "cf_clearance"), None)
    except Exception:
        cf = None
    log("CAPTURED AUTH HEADERS:", {k: (v[:24] + "…") for k, v in captured_auth.items()})
    if captured_auth.get("authorize") and captured_auth.get("clientsource"):
        log("LOGIN CAPABILITY: COMPLETE — got authorize + clientsource tokens hands-off")
        session = {
            "email": EMAIL,
            "authorize": captured_auth.get("authorize"),
            "clientsource": captured_auth.get("clientsource"),
            "route": captured_auth.get("route", "uzb/en/lva"),
            "cf_clearance": cf,
        }
        out = SHOTS.parent / "session.json"
        out.write_text(json.dumps(session, indent=2), encoding="utf-8")
        log("session tokens written to nodriver-spike/session.json (gitignored)")
    else:
        log("WARN: login succeeded but auth headers not captured (timing) — re-run")

    # HANDOFF mode: keep Chrome alive so the loaded extension takes over
    # (monitor + book in the now-logged-in session). The script idles.
    if os.environ.get("VFS_KEEP_ALIVE") == "1":
        log("HANDOFF: login done — keeping Chrome alive; extension now drives monitor+book. Ctrl+C to stop.")
        while True:
            await asyncio.sleep(60)

    log("done — leaving browser open 8s")
    await asyncio.sleep(8)
    browser.stop()


if __name__ == "__main__":
    import nodriver as uc
    uc.loop().run_until_complete(main())
