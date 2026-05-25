(() => {
  try {
    const LIFT_HOST = 'lift-api.vfsglobal.com';

    const isLiftUrl = (url: string): boolean => {
      try {
        return url.includes(LIFT_HOST);
      } catch {
        return false;
      }
    };

    const maskAuthorization = (headers: Record<string, string>): Record<string, string> => {
      try {
        const masked = { ...headers };
        for (const key of Object.keys(masked)) {
          if (key.toLowerCase() === 'authorization') {
            masked[key] = `${masked[key].slice(0, 8)}...`;
          }
        }
        return masked;
      } catch {
        return {};
      }
    };

    const normalizeHeaders = (headers: unknown): Record<string, string> => {
      try {
        const out: Record<string, string> = {};
        if (!headers) return out;
        if (headers instanceof Headers) {
          headers.forEach((value, key) => {
            out[key] = value;
          });
          return out;
        }
        if (Array.isArray(headers)) {
          for (const pair of headers) {
            if (Array.isArray(pair) && pair.length >= 2) out[String(pair[0])] = String(pair[1]);
          }
          return out;
        }
        if (typeof headers === 'object') {
          for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
            out[key] = String(value);
          }
        }
        return out;
      } catch {
        return {};
      }
    };

    const post = (headers: Record<string, string>, url: string): void => {
      try {
        void maskAuthorization(headers);
        window.postMessage({ source: 'vfs-lift-auth', headers, url, at: Date.now() }, window.location.origin);
      } catch {
        // Never let the interceptor affect the VFS page.
      }
    };

    try {
      const originalFetch = window.fetch;
      window.fetch = function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
        try {
          const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
          if (isLiftUrl(url)) {
            const headers = normalizeHeaders(init?.headers ?? (input instanceof Request ? input.headers : undefined));
            if (Object.keys(headers).length > 0) post(headers, url);
          }
        } catch {
          // Never let the interceptor affect the VFS page.
        }
        return originalFetch.apply(this, arguments as unknown as [RequestInfo | URL, RequestInit?]);
      };
    } catch {
      // Never let the interceptor affect the VFS page.
    }

    try {
      const originalOpen = XMLHttpRequest.prototype.open;
      const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
      const originalSend = XMLHttpRequest.prototype.send;

      XMLHttpRequest.prototype.open = function (
        method: string,
        url: string | URL,
        async?: boolean,
        username?: string | null,
        password?: string | null
      ): void {
        try {
          (this as XMLHttpRequest & { __vfsLiftUrl?: string; __vfsLiftHeaders?: Record<string, string> }).__vfsLiftUrl = String(url);
          (this as XMLHttpRequest & { __vfsLiftHeaders?: Record<string, string> }).__vfsLiftHeaders = {};
        } catch {
          // Never let the interceptor affect the VFS page.
        }
        return originalOpen.apply(this, [method, url, async ?? true, username, password]);
      };

      XMLHttpRequest.prototype.setRequestHeader = function (key: string, value: string): void {
        try {
          const req = this as XMLHttpRequest & { __vfsLiftHeaders?: Record<string, string> };
          if (req.__vfsLiftHeaders) req.__vfsLiftHeaders[key] = value;
        } catch {
          // Never let the interceptor affect the VFS page.
        }
        return originalSetRequestHeader.apply(this, [key, value]);
      };

      XMLHttpRequest.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null): void {
        try {
          const req = this as XMLHttpRequest & { __vfsLiftUrl?: string; __vfsLiftHeaders?: Record<string, string> };
          const url = req.__vfsLiftUrl ?? '';
          const headers = req.__vfsLiftHeaders ?? {};
          if (isLiftUrl(url) && Object.keys(headers).length > 0) post(headers, url);
        } catch {
          // Never let the interceptor affect the VFS page.
        }
        return originalSend.apply(this, [body]);
      };
    } catch {
      // Never let the interceptor affect the VFS page.
    }

    // ── Turnstile callback capture (MAIN world) ──────────────────────────────
    // VFS enables Sign In via the Turnstile render callback, which lives here in
    // the page's MAIN world — the isolated content script can't call it. We wrap
    // turnstile.render to capture every callback, then fire them with an
    // externally-solved (2Captcha) token when the content script posts it.
    try {
      const tsCallbacks: Array<(token: string) => void> = [];
      const wrap = (ts: any): any => {
        try {
          if (!ts || ts.__vfsWrapped) return ts;
          const origRender = ts.render;
          if (typeof origRender === 'function') {
            ts.render = function (container: unknown, params: any) {
              try {
                if (params && typeof params.callback === 'function') tsCallbacks.push(params.callback);
              } catch {}
              return origRender.apply(this, arguments as unknown as [unknown, unknown]);
            };
          }
          ts.__vfsWrapped = true;
        } catch {}
        return ts;
      };

      let _ts = (window as any).turnstile;
      if (_ts) wrap(_ts);
      try {
        Object.defineProperty(window, 'turnstile', {
          configurable: true,
          get() { return _ts; },
          set(v) { _ts = wrap(v); },
        });
      } catch {
        // turnstile already non-configurable — wrap whatever is there.
        wrap((window as any).turnstile);
      }

      window.addEventListener('message', (e: MessageEvent) => {
        try {
          if (e.source !== window) return;
          const d = e.data;
          if (!d || d.source !== 'vfs-apply-turnstile' || typeof d.token !== 'string') return;
          // Fire every captured Turnstile callback with the solved token.
          for (const cb of tsCallbacks) { try { cb(d.token); } catch {} }
          // Also populate the response field with native setter + events.
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
          // Implicit-rendering path: VFS may register its success callback as a
          // named global via data-callback attribute rather than passing it to
          // turnstile.render(). The isolated content script cannot reach MAIN-world
          // globals, so look it up here and fire it directly.
          try {
            const widget = document.querySelector<HTMLElement>('[data-callback]');
            const cbName = widget?.getAttribute('data-callback');
            if (cbName && typeof (window as any)[cbName] === 'function') {
              (window as any)[cbName](d.token);
            }
          } catch {}
        } catch {}
      });
    } catch {
      // Never let the interceptor affect the VFS page.
    }
  } catch {
    // Never let the interceptor affect the VFS page.
  }
})();
