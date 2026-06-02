"""
nodriver VFS REGISTER + ACTIVATE — replaces the flaky extension register
(REGISTER_FORM_NOT_SUBMITTED). nodriver fills the register form with trusted
keystrokes, auto-passes the Turnstile (the thing the extension can't), submits,
then polls Mailsac for the activation email and visits the link.

Run (PowerShell):
  $env:MAILSAC_API_KEY="..."; python nodriver-spike/register_spike.py
Optional env: REG_EMAIL, REG_PASSWORD, REG_PHONE (else generated).
Writes the new creds to nodriver-spike/register-out.json (gitignored).
"""
import asyncio
import json
import os
import re
import secrets
import sys
import pathlib

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

REGISTER_URL = os.environ.get("VFS_REGISTER_URL", "https://visa.vfsglobal.com/uzb/en/lva/register")
LOGIN_URL = os.environ.get("VFS_LOGIN_URL", "https://visa.vfsglobal.com/uzb/en/lva/login")
MAILSAC_KEY = os.environ.get("MAILSAC_API_KEY", "")
SHOTS = pathlib.Path(__file__).parent / "shots"
SHOTS.mkdir(exist_ok=True)

WORKER_BRIDGED = os.environ.get("WORKER_BRIDGED") == "1"


def milestone(step, **kw):
    """Print a machine-readable MILESTONE line for the orchestrator worker to parse."""
    data = {"step": step, **kw}
    print(f"MILESTONE {json.dumps(data)}", flush=True)


def log(*a):
    print("[REG]", *a, flush=True)


def gen_email():
    return os.environ.get("REG_EMAIL") or f"vfs-{secrets.token_hex(6)}@mailsac.com"


def gen_password():
    if os.environ.get("REG_PASSWORD"):
        return os.environ["REG_PASSWORD"]
    upper = "ABCDEFGHJKLMNPQRSTUVWXYZ"; lower = "abcdefghijkmnpqrstuvwxyz"
    digit = "23456789"; special = "@#!%*?"
    pick = lambda s: secrets.choice(s)
    rest = "".join(pick(upper + lower + digit + special) for _ in range(10))
    return ("Q" + pick(upper) + pick(lower) + pick(digit) + pick(special) + rest)[:14]


def gen_phone():
    return os.environ.get("REG_PHONE") or ("9" + "".join(secrets.choice("0123456789") for _ in range(8)))


async def jeval(page, expr):
    try:
        v = await page.evaluate(expr)
        if isinstance(v, dict) and "value" in v and set(v.keys()) <= {"type", "value", "subtype", "className"}:
            return v["value"]
        return v
    except Exception:
        return None


async def dismiss_consent(page):
    await jeval(page, """(()=>{const e=document.getElementById('onetrust-accept-btn-handler'); if(e){e.click();return 1;}
        const b=[...document.querySelectorAll('button,a')].find(x=>/accept all|accept cookies|i agree/i.test(x.innerText||'')); if(b){b.click();return 1;} return 0;})()""")


async def safe_click(page, el):
    """Trusted click with fallbacks. nodriver's mouse_click raises 'could not find
    position' when the element has no layout box (overlay mid-animation, off-screen,
    or covered by the cookie popup). Scroll it in, retry, then JS-click by id."""
    try:
        await el.scroll_into_view()
    except Exception:
        pass
    try:
        await el.mouse_click()
        return True
    except Exception:
        pass
    # fallback: JS click by element id (Material options select on a plain .click())
    try:
        oid = (el.attrs.get("id") if hasattr(el, "attrs") else "") or ""
        if oid:
            ok = await jeval(page, f"(()=>{{const e=document.getElementById('{oid}'); if(e){{e.click(); return 1;}} return 0;}})()")
            return bool(ok)
    except Exception:
        pass
    return False


async def fill(page, selectors, value, label):
    for sel in selectors:
        try:
            el = await page.select(sel, timeout=2)
        except Exception:
            el = None
        if el:
            try:
                await el.send_keys(value); log(f"filled {label}"); return True
            except Exception:
                pass
    log(f"WARN could not fill {label} (tried {selectors[0]})")
    return False



async def trigger_activation_email(browser, email, password):
    """VFS does NOT send the activation email at registration time — it sends it
    when you ATTEMPT TO LOGIN with the still-inactive account (the page then shows
    'This account is currently inactive. Please click here to resend the activation
    email'). So after registering we attempt a login here to TRIGGER that email,
    then the backend Mailsac-poll can actually find a link to visit. Best-effort:
    any failure here is non-fatal (the account is still registered)."""
    try:
        log("trigger: opening login to make VFS send the activation email")
        page = await browser.get(LOGIN_URL)
        await asyncio.sleep(3)
        await dismiss_consent(page)
        # wait for the login form (email + password) to render
        ready = False
        for i in range(30):
            st = await jeval(page, """(()=>{const vis=e=>e&&e.offsetParent!==null;
                const ov=[...document.querySelectorAll('.ngx-overlay,[class*="loading-foreground"]')].some(vis);
                const e=document.querySelector('input#email,input[formcontrolname="username"],input[type="email"]');
                const p=document.querySelector('input[formcontrolname="password"],input[type="password"]');
                return JSON.stringify({overlay:ov, email:!!e, pwd:!!p});})()""")
            d = json.loads(st) if st else {}
            if d.get("email") and d.get("pwd") and not d.get("overlay"):
                ready = True; break
            await asyncio.sleep(1)
        if not ready:
            url = await jeval(page, "location.href") or ""
            log("trigger: login form did not render — skipping (url:", url, ")")
            return
        await fill(page, ['input#email', 'input[formcontrolname="username"]', 'input[type="email"]'], email, "login-email")
        await fill(page, ['input[formcontrolname="password"]', 'input[type="password"]'], password, "login-password")
        # wait for Turnstile auto-pass → Sign In enables
        for i in range(30):
            st = await jeval(page, """(()=>{const b=[...document.querySelectorAll('button')].find(x=>/sign\\s*in|log\\s*in/i.test(x.innerText||'')&&x.offsetParent);
                const f=document.querySelector('[name="cf-turnstile-response"]');
                return JSON.stringify({dis:b?!!b.disabled:'no-btn', cf:f&&f.value?f.value.length:0});})()""")
            d = json.loads(st) if st else {}
            if d.get("dis") is False:
                break
            await asyncio.sleep(1)
        # click Sign In (trusted, then JS fallback)
        clicked = False
        for b in await page.select_all("button"):
            if re.search(r"sign\s*in|log\s*in", (b.text or ""), re.I):
                if await safe_click(page, b):
                    clicked = True
                break
        if not clicked:
            await jeval(page, "(()=>{const b=[...document.querySelectorAll('button')].find(x=>/sign\\s*in|log\\s*in/i.test(x.innerText||'')&&!x.disabled&&x.offsetParent); if(b){b.click();}})()")
        # POLL up to 15s for the 'account inactive / not activated' page to render
        # (VFS takes a few seconds to process the login and show it — a single 4s
        # check missed it). Detect the inactive state OR the resend link.
        inactive = False
        for _ in range(15):
            d = await jeval(page, """(()=>{const t=(document.body.innerText||'').toLowerCase();
                const inact=/inactive|not activated|activation email|resend/.test(t);
                const link=[...document.querySelectorAll('a,button,span,u')].some(e=>/resend|click here/i.test(e.innerText||'')&&e.offsetParent!==null);
                return JSON.stringify({inact, link});})()""")
            dd = json.loads(d) if d else {}
            if dd.get("inact") or dd.get("link"):
                inactive = True; break
            await asyncio.sleep(1)
        if inactive:
            log("trigger: 'account inactive' page shown — clicking 'resend activation email'")
            # CLICK the resend link — seeing the message is NOT enough; the email
            # only sends when this link is clicked (confirmed by operator manually).
            clicked_resend = await jeval(page, "(()=>{const a=[...document.querySelectorAll('a,button,span,u')].find(x=>/resend|click here/i.test(x.innerText||'')&&x.offsetParent!==null); if(a){a.click();return 1;} return 0;})()")
            await asyncio.sleep(3)
            # confirm a 'sent' acknowledgement if VFS shows one (best-effort)
            ack = await jeval(page, "/(sent|check your email|has been sent|email.*sent)/i.test(document.body.innerText||'')")
            log(f"trigger: resend clicked={bool(clicked_resend)} ack={bool(ack)}")
            milestone("activation_email_triggered", email=email)
        else:
            log("trigger: never reached inactive page (login may not have submitted) — email not triggered")
    except Exception as e:
        log("trigger: non-fatal error:", str(e))


async def main():
    if not MAILSAC_KEY:
        log("WARN: MAILSAC_API_KEY not set — will register but can't auto-activate")
    email, password, phone = gen_email(), gen_password(), gen_phone()
    log("registering", email, "phone +998", phone)
    milestone("register_started", email=email)
    import nodriver as uc
    browser = await uc.start(headless=False, browser_args=["--lang=en-US"])
    page = await browser.get(REGISTER_URL)
    # network capture — did a register/user API call fire on the Register click?
    net = []
    try:
        from nodriver import cdp
        async def on_req(evt):
            try:
                u = evt.request.url
                if "lift-api" in u or "register" in u.lower() or "user/" in u:
                    net.append(f"{evt.request.method} {u.split('?')[0].split('lift-api.vfsglobal.com')[-1]}")
            except Exception:
                pass
        page.add_handler(cdp.network.RequestWillBeSent, on_req)
        await page.send(cdp.network.enable())
    except Exception as e:
        log("net capture setup failed:", e)
    await asyncio.sleep(3)
    await dismiss_consent(page)

    # WAIT FOR THE FORM TO FULLY HYDRATE before filling. Root cause of all the
    # flakiness (reg8/reg9 + the screenshot): a loading spinner overlay
    # (.ngx-overlay.loading-foreground) lingers — email/password render FIRST but
    # contact, dial-code, consents and Turnstile load LATER, behind the spinner.
    # Gate must wait for: spinner GONE + email + contact + a consent checkbox.
    form_ready = False
    for i in range(45):
        st = await jeval(page, """(()=>{const vis=e=>e&&e.offsetParent!==null;
            const ov=[...document.querySelectorAll('.ngx-overlay.loading-foreground,.ngx-overlay,[class*="loading-foreground"]')].some(vis);
            const e=document.querySelector('input[formcontrolname="emailid"],input[name="emailid"],input[type="email"]');
            const c=document.querySelector('input[formcontrolname="contact"],input[type="tel"],input[name="contact"]');
            const cb=document.querySelector('mat-checkbox input[type=checkbox],input[type=checkbox]');
            return JSON.stringify({overlay:ov, email:!!e, contact:!!c, consent:!!cb});})()""")
        d = json.loads(st) if st else {}
        if d.get("email") and d.get("contact") and d.get("consent") and not d.get("overlay"):
            form_ready = True; break
        if i and i % 10 == 0:
            log(f"form not ready yet ({i}s): {st}")
        await asyncio.sleep(1)
    log("form ready:", form_ready)
    if form_ready:
        milestone("form_rendered", email=email)
    await asyncio.sleep(1)  # let last bindings settle
    if not form_ready:
        url = await jeval(page, "location.href") or ""
        log("ABORT: register form never rendered — url:", url, "(likely throttle/page-not-found)")
        out = {"email": email, "password": password, "phone": "998" + phone, "registered": False, "activated": False, "error": "form_not_rendered"}
        (SHOTS.parent / "register-out.json").write_text(json.dumps(out, indent=2), encoding="utf-8")
        log("RESULT:", json.dumps(out))
        milestone("failed", error="form_not_rendered", email=email)
        await asyncio.sleep(2); browser.stop(); return

    await fill(page, ['input[formcontrolname="emailid"]', 'input[name="emailid"]', 'input[type="email"]'], email, "email")
    await fill(page, ['input[formcontrolname="password"]', 'input[type="password"]'], password, "password")
    await fill(page, ['input[formcontrolname="confirmPassword"]', 'input[name="confirmPassword"]'], password, "confirmPassword")
    await fill(page, ['input[formcontrolname="contact"]', 'input[type="tel"]', 'input[name="contact"]'], phone, "contact")

    # dismiss the cookie-consent popup BEFORE the dial-code dropdown — it loads
    # late and covers/displaces the dropdown overlay, which made mouse_click on the
    # +998 option crash with "could not find position".
    await dismiss_consent(page)
    await asyncio.sleep(0.4)

    # dial code → +998 / Uzbekistan. VFS UZ uses formcontrolname="dialcode"
    # (lowercase). Try native <select> first, then the mat-select (open → maybe
    # type "998" into a search box → click the matching option).
    dial_done = await jeval(page, """(()=>{const s=document.querySelector('select[formcontrolname=\"dialcode\" i],select[name*=\"dial\" i],select[name=\"countryCode\"]');
        if(s){const o=[...s.options].find(o=>o.value==='998'||/998/.test(o.textContent||'')); if(o){s.value=o.value; s.dispatchEvent(new Event('change',{bubbles:true})); return 'native-998';}} return null;})()""")
    if dial_done:
        log("dialcode:", dial_done)
    else:
        try:
            trig = (await page.select('mat-select[formcontrolname="dialcode"]', timeout=2)
                    or await page.select('mat-select[formcontrolname="dialCode"]', timeout=1))
        except Exception:
            trig = None
        if not trig:
            # fuzzy: first mat-select whose attrs mention dial/country/code
            for s in await page.select_all("mat-select, .mat-mdc-select"):
                fcn = (s.attrs.get("formcontrolname", "") if hasattr(s, "attrs") else "") or ""
                if re.search(r"dial|country|code", fcn, re.I):
                    trig = s; break
        if trig:
            # open: click the inner trigger (like the extension), retry the host
            inner = None
            try:
                inner = await trig.query_selector('.mat-mdc-select-trigger, .mat-select-trigger')
            except Exception:
                inner = None
            await safe_click(page, inner or trig)
            await asyncio.sleep(1.2)
            OPT_SEL = "mat-option, .mat-option, .mat-mdc-option, [role=option], .ng-option"
            picked = False
            for attempt in range(10):
                for o in await page.select_all(OPT_SEL):
                    if re.search(r"\b\+?998\b|uzbek", (o.text or ""), re.I):
                        if await safe_click(page, o):
                            picked = True; log("dialcode chose", (o.text or '').strip()[:30])
                        break
                if picked:
                    break
                if attempt == 3:  # re-click to (re)open if panel didn't appear
                    await safe_click(page, inner or trig)
                await asyncio.sleep(0.5)
            if not picked:
                opts = [(o.text or "").strip() for o in await page.select_all(OPT_SEL)]
                log("dialcode NOT picked — options seen:", opts[:15])
            log("dialcode mat-select picked:", picked)
        else:
            log("WARN dialcode dropdown not found")

    # Tick ALL 3 consents reliably. Material MDC checkboxes are flaky to click
    # (trusted host-click landed 2/3 or 0/3 on some runs → button stayed disabled).
    # Per visible+unchecked box: trusted-click its clickable region, then a JS
    # native-input .click() fallback (toggles + fires change → Angular), verifying.
    async def boxes_state():
        v = await jeval(page, """(()=>{const arr=[...document.querySelectorAll('mat-checkbox')];
            return JSON.stringify(arr.map((c,i)=>{const inp=c.querySelector('input[type=checkbox]'); return {i, vis:c.offsetParent!==null, chk:!!(inp&&inp.checked)};}));})()""")
        try:
            return json.loads(v)
        except Exception:
            return []
    for attempt in range(8):
        states = await boxes_state()
        unchecked = [s["i"] for s in states if s.get("vis") and not s.get("chk")]
        total_vis = len([s for s in states if s.get("vis")])
        if total_vis and not unchecked:
            break
        hosts = await page.select_all("mat-checkbox")
        for idx in unchecked:
            if idx >= len(hosts):
                continue
            bx = hosts[idx]
            # 1) trusted click on the clickable region (ripple/touch-target/label), else host
            target = None
            for sel in (".mdc-checkbox", ".mat-mdc-checkbox-touch-target", "label", ".mdc-checkbox__ripple"):
                try:
                    t = await bx.query_selector(sel)
                    if t:
                        target = t; break
                except Exception:
                    pass
            await safe_click(page, target or bx)
            await asyncio.sleep(0.15)
            # 2) JS native-input fallback if still unchecked
            await jeval(page, f"(()=>{{const c=document.querySelectorAll('mat-checkbox')[{idx}]; if(c){{const i=c.querySelector('input[type=checkbox]'); if(i&&!i.checked){{i.click();}}}}}})()")
            await asyncio.sleep(0.15)
        await asyncio.sleep(0.3)
    states = await boxes_state()
    checked_vis = len([s for s in states if s.get("vis") and s.get("chk")])
    total_vis = len([s for s in states if s.get("vis")])
    log(f"consents checked: {checked_vis}/{total_vis}")
    if total_vis > 0 and checked_vis == total_vis:
        milestone("consents_ticked", email=email)
    await asyncio.sleep(1)

    # wait for Turnstile to auto-pass → Register button enables
    log("waiting for Turnstile auto-pass…")
    enabled = False
    for i in range(30):
        st = await jeval(page, """(()=>{const b=[...document.querySelectorAll('button')].find(x=>/register|sign\\s*up|create/i.test(x.innerText||'')&&x.offsetParent);
            const f=document.querySelector('[name="cf-turnstile-response"]');
            const errs=[...document.querySelectorAll('mat-error,.mat-error')].filter(e=>e.offsetParent&&(e.innerText||'').trim()).length;
            return JSON.stringify({dis:b?!!b.disabled:'no-btn', cf:f&&f.value?f.value.length:0, errs});})()""")
        d = json.loads(st) if st else {}
        if i % 5 == 0:
            log(f"wait{i}: disabled={d.get('dis')} captchaLen={d.get('cf')} errors={d.get('errs')}")
        if d.get("dis") is False:
            enabled = True; log("Register button ENABLED (captcha cf=%s)" % d.get("cf")); break
        await asyncio.sleep(1)
    await dismiss_consent(page)
    try:
        await page.save_screenshot(str(SHOTS / "reg_filled.png"))
    except Exception:
        pass
    if not enabled:
        log("WARN Register never enabled — submitting anyway")

    # The click is being eaten (no register API fired) — same as the login bug.
    # Forcibly clear the OneTrust banner/backdrop and check the button isn't covered.
    await jeval(page, """(()=>{const a=document.getElementById('onetrust-accept-btn-handler'); if(a)a.click();
        ['#onetrust-banner-sdk','.onetrust-pc-dark-filter','.cdk-overlay-backdrop','#onetrust-consent-sdk'].forEach(s=>{const e=document.querySelector(s); if(e)e.remove();});})()""")
    await asyncio.sleep(0.5)
    ov = await jeval(page, """(()=>{const b=[...document.querySelectorAll('button')].find(x=>/register|sign\\s*up|create/i.test(x.innerText||'')&&x.offsetParent);
        if(!b)return 'no-btn'; const r=b.getBoundingClientRect(); const el=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
        return JSON.stringify({covered: el!==b && !b.contains(el), topEl: el?el.tagName.toLowerCase()+'.'+String(el.className||'').slice(0,30):'none'});})()""")
    log("overlay check before submit:", ov)

    # Submit is FLAKY: a single synthetic click sometimes fires no /user/registration
    # POST (Angular's submit handler doesn't latch the CDP click). So RETRY, alternating
    # a trusted coordinate-click with an in-page JS .click(), until the POST actually
    # fires (watched via the network capture) or we navigate off /register.
    def reg_posted():
        return any("registration" in n.lower() or "/user/register" in n.lower() for n in net)

    clicked = False
    submitted = False
    for attempt in range(6):
        # clear any late overlay each time
        await jeval(page, "(()=>{['#onetrust-banner-sdk','.cdk-overlay-backdrop','.onetrust-pc-dark-filter'].forEach(s=>{const e=document.querySelector(s);if(e)e.remove();});})()")
        if attempt % 2 == 0:
            # trusted coordinate click on the (scrolled-in) Register button
            tb = None
            for b in await page.select_all("button"):
                if re.search(r"register|sign\s*up|create", (b.text or ""), re.I):
                    tb = b; break
            if tb and await safe_click(page, tb):
                clicked = True
        else:
            # in-page JS click fallback (fires Angular's handler directly)
            did = await jeval(page, "(()=>{const b=[...document.querySelectorAll('button')].find(x=>/register|sign\\s*up|create/i.test(x.innerText||'')&&!x.disabled&&x.offsetParent); if(b){b.click();return 1;} return 0;})()")
            if did:
                clicked = True
        await asyncio.sleep(3)
        url = await jeval(page, "location.href") or ""
        if reg_posted() or "/register" not in url or bool(await jeval(page, "/success|verification|check your email|activate/i.test(document.body.innerText||'')")):
            submitted = True; break
        log(f"submit attempt {attempt + 1}: no POST yet (url=…/{url.rsplit('/', 1)[-1]}), retrying")
    url = await jeval(page, "location.href") or ""
    if reg_posted():
        submitted = True
    log("post-register url:", url, "| clicked:", clicked, "| submittedSignal:", submitted)
    log("NETWORK (register/user/lift-api calls):", net if net else "(NONE — click fired no API)")
    if submitted:
        milestone("register_submitted", email=email)

    # Registration confirmed from the network POST signal captured above.
    # Activation is handled separately by the backend/extension via /api/pipeline/reconcile
    # (the WORKER_BRIDGED path); polling Mailsac here would only add ~20 extra calls and a
    # ~2-minute delay with no benefit since the worker never uses the activation link anyway.
    activated = False
    registered = bool(submitted)
    if registered:
        milestone("registered", email=email, password="***")
        # VFS sends the activation email on a LOGIN ATTEMPT, not at registration —
        # so trigger it now while we still have a browser session.
        await trigger_activation_email(browser, email, password)
    else:
        milestone("failed", error="registration_not_confirmed", email=email)
    out = {"email": email, "password": password, "phone": "998" + phone, "registered": registered, "activated": activated}
    (SHOTS.parent / "register-out.json").write_text(json.dumps(out, indent=2), encoding="utf-8")
    log("RESULT:", json.dumps(out))
    log("done — flushing stdout")
    await asyncio.sleep(2)
    browser.stop()


if __name__ == "__main__":
    import nodriver as uc
    try:
        uc.loop().run_until_complete(main())
    except Exception as _e:
        milestone("failed", error=str(_e))
        raise
