/**
 * MAIN-world helper — token injection ONLY. No monkey-patching.
 *
 * IMPORTANT (2026-05-26): the previous version patched window.fetch,
 * XMLHttpRequest.prototype, and window.turnstile to sniff the lift-api auth
 * header. Cloudflare Turnstile's anti-tamper check detects those non-native
 * functions and WITHHOLDS the widget → Sign In never enables. lift-api auth is
 * now captured at the network layer by chrome.webRequest in the service worker
 * (no page tampering), so this file no longer patches anything.
 *
 * The only thing left here is a passive listener that injects an
 * externally-solved (2Captcha) Turnstile token when the content script posts
 * one — by setting the response field + firing the page's data-callback. It
 * does NOT wrap turnstile.render or any native function, so the page stays
 * untampered and the widget renders normally.
 */
(() => {
  try {
    window.addEventListener('message', (e: MessageEvent) => {
      try {
        if (e.source !== window) return;
        const d = e.data;
        if (!d || d.source !== 'vfs-apply-turnstile' || typeof d.token !== 'string') return;

        // Populate the response field with the native setter + input/change events.
        try {
          const ta = document.querySelector<HTMLTextAreaElement | HTMLInputElement>('[name="cf-turnstile-response"]');
          if (ta) {
            const proto = ta instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
            if (setter) setter.call(ta, d.token); else (ta as any).value = d.token;
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            ta.dispatchEvent(new Event('change', { bubbles: true }));
          }
        } catch {}

        // Fire the page's Turnstile success callback. VFS uses implicit rendering
        // (a [data-callback] attribute naming a global fn), so look it up and call
        // it directly with the solved token. (No turnstile.render wrap needed.)
        try {
          const widget = document.querySelector<HTMLElement>('[data-callback]');
          const cbName = widget?.getAttribute('data-callback');
          if (cbName && typeof (window as any)[cbName] === 'function') {
            (window as any)[cbName](d.token);
          }
        } catch {}
      } catch {
        // Never let this affect the VFS page.
      }
    });
  } catch {
    // Never let this affect the VFS page.
  }
})();
