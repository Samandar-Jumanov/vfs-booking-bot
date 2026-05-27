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
    try:
        req = urllib.request.Request(f"{base}/addresses/{email}/messages", headers=hdr)
        msgs = json.loads(urllib.request.urlopen(req, timeout=20).read())
    except Exception as e:
        log("mailsac list err:", e); return None
    if not msgs:
        return None
    mid = msgs[0].get("_id")
    try:
        req = urllib.request.Request(f"{base}/text/{email}/{mid}", headers=hdr)
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
    await asyncio.sleep(10)
    await dismiss_consent(page)

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
            await trig.mouse_click(); await asyncio.sleep(1)
            # type into a search box if the panel has one (VFS dial pickers often do)
            await jeval(page, """(()=>{const i=document.querySelector('.cdk-overlay-container input, .mat-select-search input, input[aria-label*=\"search\" i]'); if(i){i.focus();i.value='998';i.dispatchEvent(new Event('input',{bubbles:true}));}})()""")
            await asyncio.sleep(1)
            picked = False
            for _ in range(8):
                for o in await page.select_all("mat-option, .mat-mdc-option"):
                    if re.search(r"\b\+?998\b|uzbek", (o.text or ""), re.I):
                        await o.mouse_click(); picked = True; break
                if picked:
                    break
                await asyncio.sleep(0.6)
            log("dialcode +998 mat-select:", picked)
        else:
            log("WARN dialcode dropdown not found")

    # check all consent checkboxes (trusted clicks)
    await jeval(page, "(()=>{document.querySelectorAll('mat-checkbox input[type=checkbox]:not(:checked), input[type=checkbox]:not(:checked)').forEach(c=>c.click());})()")
    log("consents checked")
    await asyncio.sleep(1)

    # wait for Turnstile to auto-pass → Register button enables
    log("waiting for Turnstile auto-pass…")
    enabled = False
    for _ in range(30):
        st = await jeval(page, """(()=>{const b=[...document.querySelectorAll('button')].find(x=>/register|sign\\s*up|create/i.test(x.innerText||'')&&x.offsetParent);
            const f=document.querySelector('[name="cf-turnstile-response"]');
            return JSON.stringify({dis:b?!!b.disabled:'no-btn', cf:f&&f.value?f.value.length:0});})()""")
        d = json.loads(st) if st else {}
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

    # click Register
    clicked = False
    for b in await page.select_all("button"):
        if re.search(r"register|sign\s*up|create", (b.text or ""), re.I):
            try:
                await b.mouse_click(); clicked = True; log("clicked Register:", (b.text or '').strip()[:20]); break
            except Exception:
                pass
    await asyncio.sleep(6)
    url = await jeval(page, "location.href") or ""
    errs = await jeval(page, """(()=>[...document.querySelectorAll('mat-error,.mat-error,[class*="error" i]')].filter(e=>e.offsetParent&&(e.innerText||'').trim()).map(e=>(e.innerText||'').trim().slice(0,60)).slice(0,4))()""")
    submitted = "/register" not in url or bool(await jeval(page, "/success|verification|check your email|activate/i.test(document.body.innerText||'')"))
    log("post-register url:", url, "| clicked:", clicked, "| errors:", errs, "| submittedSignal:", submitted)

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
