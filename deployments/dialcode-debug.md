# Dial Code Bug #1 Debug Report

Date: 2026-05-21
Scope: Group A only, extension dial-code automation.

## Summary

Implemented a code-level fix for the VFS Uzbekistan register form dial-code selector. The previous path sent one trusted click to the mat-select trigger and then waited for options. Traces showed the debugger click returned `{ ok: true }`, but the Material MDC overlay never rendered (`panelCount: 0`, `anyOptions: 0`).

The new path tries the MDC sub-elements in order:

1. `.mat-mdc-select-trigger`
2. `.mat-mdc-select-value`
3. `.mat-mdc-select-arrow-wrapper`
4. `.mat-mdc-select-arrow`
5. `mat-select` host

After each trusted click, the bridge records `aria-expanded`, panel count, option count, and the clicked element rect. If pointer targeting still does not open the overlay, it tries Angular component access via `window.ng.getComponent(ms).open()` from the page world. If that is unavailable, it uses debugger-backed trusted keypresses (`Enter`, `Space`, `ArrowDown`) after focusing the select.

## Files Changed

- `extension/content/vfs-bridge.ts`
  - Added structure dump equivalent to the requested Step 1 fields.
  - Added targeted trusted-click sequence for MDC select sub-elements.
  - Added page-world Angular `.open()` fallback.
  - Added trusted keyboard fallback.
  - Added trace events for each open/select attempt.
  - Updated bridge version marker to `2026-05-21-dialcode-mdc-target-sequence-v8`.

- `extension/background/service-worker.ts`
  - Added `TRUSTED_KEY` runtime message handling.
  - Routes trusted keypress requests to the sender tab through `chrome.debugger`.

- `extension/background/debugger.helper.ts`
  - Added `debuggerKeyPress(tabId, key)` using `Input.dispatchKeyEvent`.

## Verification

Local checks run:

```powershell
npm run typecheck
npm run build
rg -n "dial-code trying trusted click target|TRUSTED_KEY|debuggerKeyPress|dialcode-mdc-target-sequence" extension\content\vfs-bridge.ts extension\background\service-worker.ts extension\background\debugger.helper.ts extension\dist -S
```

Results:

- `npm run typecheck`: PASS
- `npm run build`: PASS
- Built files in `extension/dist` contain the new bridge version, targeted click trace, `TRUSTED_KEY`, and `debuggerKeyPress`.

## Live VFS Status

Live operator Chrome/VFS register-page access was not available in this subagent session. I could not run the browser-console structure dump on `https://visa.vfsglobal.com/uzb/en/lva/register`, observe a real MDC panel opening, complete captcha, or prove the full auto-create account flow end-to-end.

The code now emits the requested structure data to backend Activity Logs through `REGISTER_TRACE` as `dial-code structure`, without exposing secrets. On the next live auto-create run, use those logs to identify which target opened the panel.

## Expected Runtime Evidence

Successful runtime should show:

- `selectDialCode998 ENTRY`
- `dial-code structure`
- one or more `dial-code trying trusted click target`
- a `dial-code trusted click target result` with panel/options present, or a successful Angular/key fallback
- `dial-code option found, trusted-clicking`
- `dial-code 998 SELECTED`

If all open attempts fail, the final trace is:

- `dial-code option not found after all open attempts`

That final event includes `clickAttempted`, `debuggerBlocked`, `panelCount`, `anyOptions`, and `expanded`.
