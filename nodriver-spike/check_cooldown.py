# check_cooldown.py — is VFS's IP/session throttle lifted?
#
# Loads the VFS register page in a real (nodriver) browser and reports whether
# the form renders (COOLED DOWN) or it redirects to /page-not-found (STILL
# THROTTLED). Run this BEFORE re-enabling the worker after a throttle.
#
#   py -3.12 check_cooldown.py
#
# Exit code 0 = cooled down (safe to resume), 1 = throttled/unclear (wait).
import asyncio
import os
import sys
import nodriver as uc

REGISTER_URL = os.environ.get("VFS_REGISTER_URL", "https://visa.vfsglobal.com/uzb/en/lva/register")
LOGIN_URL = os.environ.get("VFS_LOGIN_URL", "https://visa.vfsglobal.com/uzb/en/lva/login")


async def probe(browser, url, label):
    page = await browser.get(url)
    # give the SPA time to settle / redirect
    await asyncio.sleep(8)
    final = ""
    try:
        final = await page.evaluate("window.location.href") or ""
    except Exception:
        final = ""
    # does an email field exist? (form rendered)
    has_email = False
    try:
        has_email = bool(await page.evaluate(
            "!!(document.querySelector('input#email')||"
            "document.querySelector('input[formcontrolname=\"username\"]')||"
            "document.querySelector('input[type=email]'))"
        ))
    except Exception:
        has_email = False
    pnf = "page-not-found" in (final or "").lower()
    print(f"  [{label}] final_url={final}")
    print(f"  [{label}] page-not-found={pnf} | email_field_present={has_email}")
    return (not pnf) and has_email


async def main():
    print("Checking VFS throttle status (real browser)…")
    browser = await uc.start(headless=False, browser_args=["--lang=en-US"])
    try:
        reg_ok = await probe(browser, REGISTER_URL, "register")
        login_ok = await probe(browser, LOGIN_URL, "login")
    finally:
        try:
            browser.stop()
        except Exception:
            pass

    print("")
    if reg_ok:
        print("VERDICT: COOLED DOWN - register form renders. Safe to resume (gently).")
        sys.exit(0)
    elif login_ok:
        print("VERDICT: PARTIAL - login renders but REGISTER still blocked (page-not-found).")
        print("         Account creation will still fail. Wait longer before registering.")
        sys.exit(1)
    else:
        print("VERDICT: STILL THROTTLED - VFS not loading the form. Wait (hours) and re-check.")
        sys.exit(1)


if __name__ == "__main__":
    uc.loop().run_until_complete(main())
