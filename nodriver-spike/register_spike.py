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
import ssl
import urllib.request
import urllib.error
import urllib.parse

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
            # CLICK the resend link with a TRUSTED click — a synthetic JS .click()
            # does NOT fire Angular's handler (same as the Register button), so the
            # email never sends (operator's REAL click works; JS click didn't).
            clicked_resend = False
            for el in await page.select_all("a, button, span, u"):
                if re.search(r"resend|click here", (el.text or ""), re.I) and (el.text or "").strip():
                    if await safe_click(page, el):
                        clicked_resend = True
                    break
            if not clicked_resend:
                # JS fallback only if no trusted target found
                clicked_resend = bool(await jeval(page, "(()=>{const a=[...document.querySelectorAll('a,button,span,u')].find(x=>/resend|click here/i.test(x.innerText||'')&&x.offsetParent!==null); if(a){a.click();return 1;} return 0;})()"))
            await asyncio.sleep(3)
            # confirm a 'sent' acknowledgement if VFS shows one (best-effort)
            ack = await jeval(page, "/(sent|check your email|has been sent|email.*sent)/i.test(document.body.innerText||'')")
            log(f"trigger: resend clicked={bool(clicked_resend)} ack={bool(ack)}")
            milestone("activation_email_triggered", email=email)
        else:
            log("trigger: never reached inactive page (login may not have submitted) — email not triggered")
    except Exception as e:
        log("trigger: non-fatal error:", str(e))


def _mailsac_messages(email):
    """GET the Mailsac message list for `email`. Returns a parsed JSON list (or [])
    using ONLY the Python stdlib (no new pip deps). Best-effort: any HTTP/parse
    error returns [] so the caller's poll loop just retries."""
    url = f"https://mailsac.com/api/addresses/{urllib.parse.quote(email)}/messages"
    # A browser User-Agent is REQUIRED — Mailsac's WAF/Cloudflare 403s the default
    # "Python-urllib/3.x" UA (curl/backend work because their UA is allowed). Also
    # use an unverified SSL context for the VPS's TLS-intercepting proxy.
    req = urllib.request.Request(url, headers={
        "Mailsac-Key": MAILSAC_KEY,
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    })
    _ctx = ssl.create_default_context(); _ctx.check_hostname = False; _ctx.verify_mode = ssl.CERT_NONE
    try:
        with urllib.request.urlopen(req, timeout=15, context=_ctx) as resp:
            body = resp.read().decode("utf-8", "replace")
        data = json.loads(body)
        return data if isinstance(data, list) else []
    except urllib.error.HTTPError as he:
        log(f"mailsac: HTTP {he.code} listing messages (retrying)")
        return []
    except Exception as e:
        log("mailsac: list error (retrying):", str(e))
        return []


def _extract_activation_url(messages):
    """Scan Mailsac messages for the VFS activation link. Handles the known
    wrap-bug: the base64 `q=` token is split across lines with \\n/spaces, so we
    strip ALL whitespace out of the URL and trim trailing non-URL chars
    (a leaked ']', '"', ')' etc.). Returns a clean URL string or None."""
    for m in messages or []:
        # collect candidate link strings from the message's `links` array AND,
        # as a fallback, any raw text fields that might carry the URL.
        candidates = []
        links = m.get("links") if isinstance(m, dict) else None
        if isinstance(links, list):
            candidates.extend([x for x in links if isinstance(x, str)])
        for key in ("body", "text", "html"):
            v = m.get(key) if isinstance(m, dict) else None
            if isinstance(v, str):
                candidates.append(v)
        for raw in candidates:
            if "activateemail" not in raw.lower():
                continue
            # find the activateemail URL inside the candidate string, allowing
            # whitespace/newlines INSIDE the value (the wrap bug). [\s\S] = any char.
            mt = re.search(r"https?://[\s\S]*?activateemail\?q=[\s\S]+", raw, re.I)
            if not mt:
                continue
            url = mt.group(0)
            # strip ALL whitespace/newlines that the wrap-bug injected
            url = re.sub(r"\s+", "", url)
            # trim trailing chars that commonly leak in (closing bracket/quote/paren/comma)
            url = url.rstrip("]>\"').,;")
            # cut at the first stray quote/bracket if one is embedded mid-URL
            url = re.split(r'["\'<>\]]', url, maxsplit=1)[0]
            if "activateemail?q=" in url.lower():
                return url
    return None


async def activate_via_nodriver(browser, email):
    """HANDS-OFF activation with NO Chrome extension: after the resend click sends
    the VFS activation email, poll Mailsac (stdlib urllib) for the activateemail
    link, clean the wrap-bug whitespace, then navigate this nodriver browser to it.
    Returns True if activation looks confirmed. Best-effort: wrapped in try/except
    so it can never crash the register flow (account stays registered+PENDING and
    the backend reconcile can retry later)."""
    if not MAILSAC_KEY:
        log("activate: MAILSAC_API_KEY not set — cannot self-activate (left PENDING)")
        return False
    try:
        log("activate: polling Mailsac for the activation link (≤90s)…")
        activation_url = None
        for attempt in range(18):  # 18 × 5s ≈ 90s
            msgs = _mailsac_messages(email)
            activation_url = _extract_activation_url(msgs)
            if activation_url:
                log(f"activate: found activation link after ~{attempt * 5}s")
                break
            await asyncio.sleep(5)
        if not activation_url:
            log("activate: no activation email arrived in ~90s — leaving PENDING (non-fatal)")
            return False
        log("activate: visiting cleaned activation URL:", activation_url[:80] + ("…" if len(activation_url) > 80 else ""))
        page = await browser.get(activation_url)
        await asyncio.sleep(6)
        await dismiss_consent(page)
        final_url = await jeval(page, "location.href") or ""
        verdict = await jeval(page, """(()=>{const t=(document.body.innerText||'').toLowerCase();
            const bad=/inactive|not activated|invalid|expired|link has expired/.test(t);
            const good=/activated|success|verified|your account is active|now active/.test(t);
            return JSON.stringify({bad, good});})()""")
        v = json.loads(verdict) if verdict else {}
        url_l = (final_url or "").lower()
        # confirmed if: page says activated/success/verified, OR no 'inactive'/error
        # wording AND we landed on a login/dashboard/account URL (VFS redirects there
        # after a successful activation).
        redirected_ok = any(k in url_l for k in ("/login", "dashboard", "/account", "activated", "success", "verified"))
        confirmed = bool(v.get("good")) or (not v.get("bad") and redirected_ok)
        log(f"activate: final_url={final_url} verdict(good={v.get('good')},bad={v.get('bad')}) → confirmed={confirmed}")
        if confirmed:
            log("activate: account ACTIVATED hands-off (no extension)")
            milestone("activated", email=email)
            return True
        log("activate: visit did NOT confirm activation — leaving PENDING (non-fatal)")
        return False
    except Exception as e:
        log("activate: non-fatal error:", str(e))
        return False


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

    # dismiss the cookie-consent popup BEFORE the dial-code dropdown — it loads
    # late and covers/displaces the dropdown overlay, which made mouse_click on the
    # +998 option crash with "could not find position".
    await dismiss_consent(page)
    await asyncio.sleep(0.4)

    # ── Dial Code: select +998 Uzbekistan ─────────────────────────────────────
    # VFS uses a mat-select for the dial code. We must VERIFY the displayed value
    # reads 998 after selection (past runs showed 992 Tajikistan despite the click
    # claiming success — the option match or the selection didn't stick).
    dial_done = await jeval(page, """(()=>{const s=document.querySelector('select[formcontrolname="dialcode" i],select[name*="dial" i],select[name="countryCode"]');
        if(s){const o=[...s.options].find(o=>o.value==='998'||/998/.test(o.textContent||'')); if(o){s.value=o.value; s.dispatchEvent(new Event('change',{bubbles:true})); return 'native-998';}} return null;})()""")
    if dial_done:
        log("dialcode:", dial_done)
    else:
        # Find the mat-select for dial code
        trig = None
        try:
            trig = await page.select('mat-select[formcontrolname="dialcode"]', timeout=2)
        except Exception:
            pass
        if not trig:
            try:
                trig = await page.select('mat-select[formcontrolname="dialCode"]', timeout=1)
            except Exception:
                pass
        if not trig:
            for s in await page.select_all("mat-select"):
                fcn = (s.attrs.get("formcontrolname", "") if hasattr(s, "attrs") else "") or ""
                if re.search(r"dial|country|code", fcn, re.I):
                    trig = s; break

        if trig:
            OPT_SEL = "mat-option, .mat-option, .mat-mdc-option, [role=option], .ng-option"
            # Retry up to 3 times: open → pick 998 → verify displayed value
            for dial_retry in range(3):
                inner = None
                try:
                    inner = await trig.query_selector('.mat-mdc-select-trigger, .mat-select-trigger')
                except Exception:
                    pass
                await safe_click(page, inner or trig)
                await asyncio.sleep(1.2)
                picked = False
                for attempt in range(10):
                    for o in await page.select_all(OPT_SEL):
                        if re.search(r"\b\+?998\b|uzbek", (o.text or ""), re.I):
                            if await safe_click(page, o):
                                picked = True
                                log("dialcode option clicked: %s" % (o.text or "").strip()[:30])
                            break
                    if picked:
                        break
                    if attempt == 3:
                        await safe_click(page, inner or trig)
                    await asyncio.sleep(0.5)
                # Verify the displayed value now shows 998
                await asyncio.sleep(0.5)
                disp = await jeval(page, """(()=>{const s=document.querySelector('mat-select[formcontrolname="dialcode"],mat-select[formcontrolname="dialCode"]');
                    if(!s)return ''; const v=s.querySelector('.mat-mdc-select-value-text,.mat-select-value-text,.mat-mdc-select-value,.mat-select-value');
                    return ((v&&v.innerText)||s.innerText||'').trim();})()""") or ""
                log("dialcode displayed after pick (retry %d): %r" % (dial_retry, disp[:40]))
                if "998" in disp or re.search(r"uzbek", disp, re.I):
                    log("dialcode VERIFIED = 998")
                    break
                log("dialcode NOT 998 yet — retrying selection")
                # close panel before retry
                await jeval(page, "(()=>{['keydown','keyup'].forEach(t=>document.dispatchEvent(new KeyboardEvent(t,{key:'Escape',keyCode:27,bubbles:true})));})()")
                await asyncio.sleep(0.5)
            else:
                log("WARN: dial code could not be set to 998 after 3 retries (showing: %r)" % disp[:40])
        else:
            log("WARN dialcode mat-select not found")

    # ── Mobile Number: type into the phone text input ──────────────────────────
    # The Mobile Number text field is a SEPARATE input from the dial-code mat-select.
    # Inspect visible inputs and find the one that is NOT email/password/confirm and
    # whose formcontrolname/placeholder/type suggests a phone/contact number.
    # Use trusted Angular-sync fill (same as login) so the framework registers it.
    phone_filled = False
    # First try: direct selector for the contact input
    phone_sel = None
    for sel in ['input[formcontrolname="contact"]', 'input[formcontrolname="mobileNumber"]',
                'input[formcontrolname="mobile"]', 'input[formcontrolname="phone"]',
                'input[type="tel"]', 'input[name="contact"]']:
        exists = await jeval(page, "(()=>{const e=document.querySelector(%s); return e&&e.offsetParent!==null?1:0;})()" % json.dumps(sel))
        if exists:
            phone_sel = sel
            break
    if not phone_sel:
        # Fallback: find any visible text/number input that's not email/password/confirm
        phone_sel_js = r"""(()=>{
            const skip=/email|password|confirm/i;
            const inputs=[...document.querySelectorAll('input')].filter(i=>{
                if(!i.offsetParent) return false;
                if(i.type==='hidden'||i.type==='checkbox') return false;
                const fc=i.getAttribute('formcontrolname')||'';
                const n=i.name||''; const pl=i.placeholder||'';
                if(skip.test(fc)||skip.test(n)||skip.test(pl)) return false;
                return true;
            });
            return inputs.length ? (inputs[0].getAttribute('formcontrolname')||inputs[0].id||inputs[0].name||'[0]') : '';
        })()"""
        fc_found = await jeval(page, phone_sel_js) or ""
        if fc_found and fc_found != '[0]':
            phone_sel = '[formcontrolname="%s"]' % fc_found
        elif fc_found == '[0]':
            phone_sel = 'input:not([type=hidden]):not([type=checkbox])'
    if phone_sel:
        # Use trusted sync fill (Angular reactive form)
        result = await jeval(page, "(%s)(%s,%s)" % (_SYNC_FIELD_JS, json.dumps(phone_sel), json.dumps(phone)))
        log("phone fill result: sel=%r result=%s" % (phone_sel, str(result)[:60]))
        # also try send_keys in case sync alone isn't enough
        try:
            el = await page.select(phone_sel, timeout=2)
            if el:
                await el.click()
                await asyncio.sleep(0.2)
                await el.send_keys(phone)
        except Exception as sk_e:
            log("phone send_keys error (non-fatal): %s" % str(sk_e)[:60])
        # re-sync after send_keys
        await jeval(page, "(%s)(%s,%s)" % (_SYNC_FIELD_JS, json.dumps(phone_sel), json.dumps(phone)))
        # verify
        val = await jeval(page, "(()=>{const e=document.querySelector(%s); return e?(e.value||''):'';})()" % json.dumps(phone_sel)) or ""
        log("phone field value after fill: %r (len=%d)" % (val[:20], len(val)))
        if val:
            phone_filled = True
            log("phone FILLED OK")
        else:
            log("WARN: phone field still empty after fill")
    else:
        log("WARN: could not identify phone input selector")

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

    log("phone_filled=%s" % phone_filled)

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
            diag = await jeval(page, """(()=>{
                const ms=document.querySelector('mat-select[formcontrolname="dialcode"],mat-select[formcontrolname="dialCode"]');
                const dialDisp=ms?(ms.querySelector('.mat-mdc-select-value-text,.mat-select-value-text')||ms).innerText||'':'?';
                const ph=document.querySelector('input[formcontrolname="contact"],input[formcontrolname="mobileNumber"],input[type="tel"]');
                const phVal=ph?ph.value||'':'?';
                return JSON.stringify({dial:dialDisp.trim().slice(0,15), phLen:phVal.length});
            })()""") or "{}"
            import json as _json
            _d = {}
            try: _d = _json.loads(diag)
            except: pass
            log(f"wait{i}: disabled={d.get('dis')} captchaLen={d.get('cf')} errors={d.get('errs')} dial={_d.get('dial')} phLen={_d.get('phLen')}")
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
        # Then SELF-ACTIVATE with this same nodriver browser (no Chrome extension):
        # poll Mailsac for the activation link and navigate to it here.
        activated = await activate_via_nodriver(browser, email)
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
