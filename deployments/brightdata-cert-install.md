# BrightData CA certificate install

Status: MANUAL. The operator performs this once on the Windows user profile that runs `launch-bot-chrome.ps1`.

## Why this is needed

BrightData's residential proxy can present certificates signed by the BrightData CA when Chrome routes VFS traffic through the proxy. If Windows does not trust that CA, Chrome shows `NET::ERR_CERT_AUTHORITY_INVALID` for `visa.vfsglobal.com`.

The launcher now checks the Windows certificate stores for a BrightData certificate. If it is found, Chrome starts with normal certificate validation. If it is missing, the launcher keeps the temporary `--ignore-certificate-errors` fallback and logs a warning.

## Download the BrightData CA

1. Sign in to the BrightData dashboard.
2. Open the zone used by the VFS bot residential proxy.
3. Go to the zone integration settings.
4. Open the **Native integration** or **Certificate** tab.
5. Download the BrightData SSL CA certificate as a `.crt` file.
6. Save it somewhere local, for example `Downloads\brightdata-ca.crt`.

Screenshot checklist for the operator:

- BrightData zone settings page showing the selected residential proxy zone.
- BrightData **Native integration** or **Certificate** tab showing the CA certificate download action.
- The downloaded `.crt` file in Windows Explorer.

## Install the CA in Windows

1. Press `Win+R`, enter `certmgr.msc`, and press Enter.
2. In the left tree, expand **Trusted Root Certification Authorities**.
3. Select **Certificates**.
4. Right-click **Certificates**, then choose **All Tasks > Import**.
5. In the Certificate Import Wizard, choose the downloaded BrightData `.crt` file.
6. Select **Place all certificates in the following store**.
7. Confirm the store is **Trusted Root Certification Authorities**.
8. Finish the wizard and accept the Windows security prompt if shown.
9. In the certificate list, confirm the imported certificate subject or friendly name includes `BrightData` or `Bright Data`.

Screenshot checklist for the operator:

- `certmgr.msc` opened to **Trusted Root Certification Authorities > Certificates**.
- Certificate Import Wizard with the BrightData `.crt` selected.
- Certificate Import Wizard showing **Trusted Root Certification Authorities** as the target store.
- Final certificate list showing the imported BrightData certificate.

## Verify with the launcher

1. Close the dedicated bot Chrome window when you are ready to restart it.
2. Run `.\launch-bot-chrome.ps1`.
3. Confirm the console prints:

   ```text
   BrightData CA certificate found in Windows certificate stores.
   Chrome will use normal certificate validation.
   ```

4. Visit `https://visa.vfsglobal.com/uzb/en/lva/login` in the bot Chrome profile.
5. Confirm there is no `NET::ERR_CERT_AUTHORITY_INVALID` interstitial and no yellow automated-testing warning bar.

If the launcher still prints the warning, re-open `certmgr.msc` and confirm the certificate is under **Trusted Root Certification Authorities**, not only under **Intermediate Certification Authorities**.
