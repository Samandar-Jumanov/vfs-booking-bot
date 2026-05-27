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
import urllib.request
import urllib.parse

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

REGISTER_URL = os.environ.get("VFS_REGISTER_URL", "https://visa.vfsglobal.com/uzb/en/lva/register")
MAILSAC_KEY = os.environ.get("MAILSAC_API_KEY", "")
SHOTS = pathlib.Path(__file__).parent / "shots"
SHOTS.mkdir(exist_ok=True)


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


def mailsac_link(email):
    """Poll Mailsac for the activation email; extract the clean activation link."""
    base = "https://mailsac.com/api"
    hdr = {"Mailsac-Key": MAILSAC_KEY}
    enc = urllib.parse.quote(email, safe="")  # URL-encode the @ — unencoded => 403
    try:
        req = urllib.request.Request(f"{base}/addresses/{enc}/messages", headers=hdr)
        msgs = json.loads(urllib.request.urlopen(req, timeout=20).read())
    except Exception as e:
        log("mailsac list err:", e); return None
    if not msgs:
        return None
    mid = msgs[0].get("_id")
    try:
        req = urllib.request.Request(f"{base}/text/{enc}/{urllib.parse.quote(str(mid), safe='')}", headers=hdr)
        body = urllib.request.urlopen(req, timeout=20).read().decode("utf-8", "replace")
    except Exception as e:
        log("mailsac body err:", e); return None
    # extract the verify/activate link; strip wrapped whitespace + trailing brackets
    m = re.search(r"https?://[^\s\"'<>]*?(?:verify|confirm|activat)[^\s\"'<>]*", body, re.I) or \
        re.search(r"https?://visa\.vfsglobal\.com/[^\s\"'<>]+", body, re.I)
    if not m:
        return None
    link = re.sub(r"\s+", "", m.group(0))
    link = re.sub(r"[)\]}>'\"`,]+$", "", link)
    return link


async def main():
    if not MAILSAC_KEY:
        log("WARN: MAILSAC_API_KEY not set — will register but can't auto-activate")
    email, password, phone = gen_email(), gen_password(), gen_phone()
    log("registering", email, "phone +998", phone)
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
    await asyncio.sleep(1)  # let last bindings settle
    if not form_ready:
        url = await jeval(page, "location.href") or ""
        log("ABORT: register form never rendered — url:", url, "(likely throttle/page-not-found)")
        out = {"email": email, "password": password, "phone": "998" + phone, "registered": False, "activated": False, "error": "form_not_rendered"}
        (SHOTS.parent / "register-out.json").write_text(json.dumps(out, indent=2), encoding="utf-8")
        log("RESULT:", json.dumps(out))
        await asyncio.sleep(2); browser.stop(); return

    await fill(page, ['input[formcontrolname="emailid"]', 'input[name="emailid"]', 'input[type="email"]'], email, "email")
    await fill(page, ['input[formcontrolname="password"]', 'input[type="password"]'], password, "password")
    await fill(page, ['input[formcontrolname="confirmPassword"]', 'input[name="confirmPassword"]'], password, "confirmPassword")
    await fill(page, ['input[formcontrolname="contact"]', 'input[type="tel"]', 'input[name="contact"]'], phone, "contact")

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
            await (inner or trig).mouse_click()
            await asyncio.sleep(1.2)
            OPT_SEL = "mat-option, .mat-option, .mat-mdc-option, [role=option], .ng-option"
            picked = False
            for attempt in range(10):
                for o in await page.select_all(OPT_SEL):
                    if re.search(r"\b\+?998\b|uzbek", (o.text or ""), re.I):
                        await o.mouse_click(); picked = True; log("dialcode chose", (o.text or '').strip()[:30]); break
                if picked:
                    break
                if attempt == 3:  # re-click to (re)open if panel didn't appear
                    await (inner or trig).mouse_click()
                await asyncio.sleep(0.5)
            if not picked:
                opts = [(o.text or "").strip() for o in await page.select_all(OPT_SEL)]
                log("dialcode NOT picked — options seen:", opts[:15])
            log("dialcode mat-select picked:", picked)
        else:
            log("WARN dialcode dropdown not found")

    # check all consent checkboxes — JS .click() on Material checkboxes silently
    # fails (proved by a screenshot: boxes stayed unchecked → button disabled).
    # Use TRUSTED clicks on each checkbox host, then VERIFY every box is ticked.
    async def count_checked():
        # only count VISIBLE consent checkboxes (hidden Cloudflare/form boxes inflate the count)
        v = await jeval(page, "(()=>{const all=[...document.querySelectorAll('mat-checkbox input[type=checkbox],input[type=checkbox]')].filter(c=>{const h=c.closest('mat-checkbox')||c; return h.offsetParent!==null;}); return JSON.stringify({total:all.length, checked:all.filter(c=>c.checked).length});})()")
        try:
            return json.loads(v)
        except Exception:
            return {"total": 0, "checked": 0}
    for attempt in range(5):
        st = await count_checked()
        if st["total"] and st["checked"] >= st["total"]:
            break
        # trusted click each unchecked box (click the mat-checkbox host / label, not the hidden input)
        boxes = await page.select_all("mat-checkbox, .mat-checkbox, .mat-mdc-checkbox")
        if not boxes:
            boxes = await page.select_all("input[type=checkbox]")
        for bx in boxes:
            try:
                ck = None
                try:
                    ck = await bx.query_selector("input[type=checkbox]")
                except Exception:
                    ck = None
                is_checked = bool(ck and (ck.attrs.get("checked") is not None if hasattr(ck, "attrs") else False))
                if not is_checked:
                    await bx.scroll_into_view()
                    await bx.mouse_click()
                    await asyncio.sleep(0.2)
            except Exception:
                pass
        await asyncio.sleep(0.4)
    st = await count_checked()
    log(f"consents checked: {st['checked']}/{st['total']}")
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

    # click Register — the button is BELOW THE FOLD (elementFromPoint=null at its
    # center → coordinate-click hit nothing → no API fired). Scroll it into view first.
    clicked = False
    for b in await page.select_all("button"):
        if re.search(r"register|sign\s*up|create", (b.text or ""), re.I):
            try:
                await b.scroll_into_view()
                await asyncio.sleep(0.4)
                # re-clear any overlay that may have appeared, then verify on-screen
                await jeval(page, "(()=>{['#onetrust-banner-sdk','.cdk-overlay-backdrop','.onetrust-pc-dark-filter'].forEach(s=>{const e=document.querySelector(s);if(e)e.remove();});})()")
                onscreen = await jeval(page, """(()=>{const b=[...document.querySelectorAll('button')].find(x=>/register|sign\\s*up|create/i.test(x.innerText||'')&&x.offsetParent);
                    if(!b)return 'no-btn'; const r=b.getBoundingClientRect(); const el=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
                    return JSON.stringify({onScreen: !!(el&&(el===b||b.contains(el)||b.contains(el)||el.contains(b))), topEl: el?el.tagName.toLowerCase():'null', top: Math.round(r.top), vh: window.innerHeight});})()""")
                log("button after scroll:", onscreen)
                await b.mouse_click(); clicked = True; log("clicked Register:", (b.text or '').strip()[:20]); break
            except Exception as e:
                log("click err:", e)
    await asyncio.sleep(6)
    url = await jeval(page, "location.href") or ""
    errs = await jeval(page, """(()=>[...document.querySelectorAll('mat-error,.mat-error,[class*="error" i]')].filter(e=>e.offsetParent&&(e.innerText||'').trim()).map(e=>(e.innerText||'').trim().slice(0,60)).slice(0,4))()""")
    submitted = "/register" not in url or bool(await jeval(page, "/success|verification|check your email|activate/i.test(document.body.innerText||'')"))
    log("post-register url:", url, "| clicked:", clicked, "| submittedSignal:", submitted)
    log("NETWORK (register/user/lift-api calls):", net if net else "(NONE — click fired no API)")

    # activation via Mailsac
    activated = False
    if MAILSAC_KEY:
        log("polling Mailsac for activation email…")
        link = None
        for _ in range(20):  # ~2 min
            link = mailsac_link(email)
            if link:
                break
            await asyncio.sleep(6)
        if link:
            log("activation link:", link[:70], "…")
            try:
                tab = await browser.get(link, new_tab=True)
                await asyncio.sleep(8)
                txt = await jeval(tab, "document.body.innerText.slice(0,200)") or ""
                activated = not re.search(r"invalid|expired|error", txt, re.I)
                log("activation page:", txt.replace(chr(10), " ")[:120])
            except Exception as e:
                log("activation visit err:", e)
        else:
            log("no activation email found in Mailsac (register may not have submitted)")

    out = {"email": email, "password": password, "phone": "998" + phone, "registered": submitted, "activated": activated}
    (SHOTS.parent / "register-out.json").write_text(json.dumps(out, indent=2), encoding="utf-8")
    log("RESULT:", json.dumps(out))
    log("done — browser open 10s")
    await asyncio.sleep(10)
    browser.stop()


if __name__ == "__main__":
    import nodriver as uc
    uc.loop().run_until_complete(main())
