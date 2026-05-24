# Task — capture VFS's live lift-api auth and use it for slot polling (fixes the 401)

## Why
`pollSlot` in `extension/content/vfs-bridge.ts` calls `https://lift-api.vfsglobal.com/appointment/CheckIsSlotAvailable` with cookies only → **HTTP 401**. Evidence (2026-05-23): the bearer token is NOT in localStorage (`loginResponse` = the string `"Individual"` = role, not a token). VFS holds the token in-app and attaches it (plus likely custom headers) to its own requests. So we must **capture the headers VFS itself sends to lift-api** and replay them.

## Approach (Option A — piggyback on VFS's real auth)
1. Inject a **MAIN-world** script that wraps `fetch` + `XMLHttpRequest` and records the **full request header set** of any call to `*.lift-api.vfsglobal.com/*` (especially `Authorization`, and VFS custom headers like `Authorize`, `Route`, `apptoken`, `Content-Type`, `Accept`, plus any `x-*`).
2. Relay the captured headers to the content script (isolated world) via `window.postMessage`.
3. `pollSlot` replays those captured headers on its own `CheckIsSlotAvailable` POST. No token reverse-engineering — we reuse exactly what VFS uses.

## Files
- `extension/content/vfs-bridge.ts` — content script (isolated world). Holds `pollSlot`.
- `extension/background/service-worker.ts` — already injects content scripts; add MAIN-world injection of the interceptor (or inject from the content script via a page `<script>` tag).
- Manifest already has `scripting` + host permissions.

## Implementation

### 1. MAIN-world interceptor (new file `extension/content/lift-auth-sniffer.ts`, compiled to dist)
Runs in the page's main world so it can see VFS's real requests.
```ts
(() => {
  const LIFT = 'lift-api.vfsglobal.com';
  const post = (headers: Record<string,string>, url: string) =>
    window.postMessage({ source: 'vfs-lift-auth', headers, url, at: Date.now() }, window.location.origin);

  // fetch
  const origFetch = window.fetch;
  window.fetch = function (input: any, init?: any) {
    try {
      const url = typeof input === 'string' ? input : input?.url ?? '';
      if (url.includes(LIFT)) {
        const h: Record<string,string> = {};
        const hdrs = init?.headers ?? (input?.headers);
        if (hdrs instanceof Headers) hdrs.forEach((v,k)=>h[k]=v);
        else if (hdrs) Object.assign(h, hdrs);
        if (Object.keys(h).length) post(h, url);
      }
    } catch {}
    return origFetch.apply(this, arguments as any);
  };

  // XHR
  const origOpen = XMLHttpRequest.prototype.open;
  const origSet = XMLHttpRequest.prototype.setRequestHeader;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m: string, url: string) { (this as any).__u = url; (this as any).__h = {}; return origOpen.apply(this, arguments as any); };
  XMLHttpRequest.prototype.setRequestHeader = function (k: string, v: string) { try { if ((this as any).__h) (this as any).__h[k]=v; } catch {} return origSet.apply(this, arguments as any); };
  XMLHttpRequest.prototype.send = function () { try { const u=(this as any).__u||''; if (u.includes(LIFT) && (this as any).__h) post((this as any).__h, u); } catch {} return origSend.apply(this, arguments as any); };
})();
```

### 2. Inject it MAIN-world (service-worker.ts, when a VFS tab is present)
```ts
await chrome.scripting.executeScript({
  target: { tabId },
  files: ['content/lift-auth-sniffer.js'],
  world: 'MAIN',
});
```
Inject alongside the existing content-script injection for warm VFS tabs. Build config must emit `content/lift-auth-sniffer.js` (add to webpack entry).

### 3. Content script captures + caches the headers
In `vfs-bridge.ts`, add a `window.addEventListener('message', …)` for `source==='vfs-lift-auth'`; store the latest header set in a module variable `liftHeaders` (and optionally persist to chrome.storage so it survives SW restarts). 

### 4. `pollSlot` replays the captured headers
Merge `liftHeaders` into the existing fetch headers (captured Authorization + custom headers win). Keep `credentials: 'include'`. If `liftHeaders` is empty, emit a distinct result/log `POLL_NO_AUTH_CAPTURED` so we know the sniffer hasn't seen a real request yet.

### 5. Seeding a real request
The sniffer only captures when VFS's app actually calls lift-api. After login, that happens when the user/bot navigates to the appointment/booking section. So: on monitor start, the extension should ensure the booking page is loaded once (SPA click to "Book/Schedule Appointment") so VFS fires a real authenticated lift-api call → sniffer captures the headers → subsequent polls reuse them. Document this; implement the SPA nav if low-risk, else note operator must open the booking page once.

## Verification
- `cd extension && npm run build` → emits `content/lift-auth-sniffer.js`.
- Live (operator, logged-in VFS tab, F12 closed): navigate to booking once → run `backend/scripts/trigger-poll.ts` → expect `EXT_POLL_RESULT status=200` with real slot JSON (or valid "no slots"), NOT 401.
- Backend log shows `[EXT_POLL_RESULT] dest=lva status=200`.

## Guardrails
- MAIN-world script must be tiny + crash-safe (try/catch everything) — it runs in VFS's page; a throw could break VFS's app.
- Never log full token values; mask in any trace.
- Rate limits still apply — poll ≤ 1/min per account, back off on 429/403.
- Bump `VFS_BRIDGE_VERSION` and `SW_VERSION`.

## Definition of done
One `EXT_POLL_RESULT status=200` with real slot data from a logged-in account = Rung 9 GREEN = the core product proven.
