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
  } catch {
    // Never let the interceptor affect the VFS page.
  }
})();
