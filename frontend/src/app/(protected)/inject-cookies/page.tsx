'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Cookie, CheckCircle2, AlertCircle } from 'lucide-react';
import { DashboardShell } from '@/components/layout/DashboardShell';
import { api } from '@/lib/api';

interface InjectResponse {
  success: boolean;
  accountId: string;
  email: string;
  cookiesCount: number;
  lastWarmedAt: string;
}

export default function InjectCookiesPage() {
  const [email, setEmail] = useState('jumanovsamandar84@gmail.com');
  const [password, setPassword] = useState('');
  const [cookiesRaw, setCookiesRaw] = useState('');
  const [tabUrl, setTabUrl] = useState('https://visa.vfsglobal.com/uzb/en/lva/dashboard');
  const [error, setError] = useState<string | null>(null);

  const inject = useMutation<InjectResponse>({
    mutationFn: async () => {
      setError(null);
      let cookies: unknown;
      try {
        cookies = JSON.parse(cookiesRaw);
      } catch {
        throw new Error('Cookies must be valid JSON. Use DevTools → Application → Cookies → right-click → "Copy all as JSON".');
      }
      if (!Array.isArray(cookies)) {
        throw new Error('Cookies JSON must be an array.');
      }
      const normalized = (cookies as Record<string, unknown>[]).map((c) => ({
        name: String(c.name ?? ''),
        value: String(c.value ?? ''),
        domain: typeof c.domain === 'string' ? c.domain : undefined,
        path: typeof c.path === 'string' ? c.path : undefined,
        secure: typeof c.secure === 'boolean' ? c.secure : undefined,
        httpOnly: typeof c.httpOnly === 'boolean' ? c.httpOnly : undefined,
        sameSite: typeof c.sameSite === 'string' ? c.sameSite : undefined,
        expirationDate: typeof c.expirationDate === 'number' ? c.expirationDate : undefined,
      })).filter((c) => c.name && c.value);

      const response = await api.post<InjectResponse>('/accounts/inject-cookies', {
        email,
        password: password || undefined,
        tabUrl: tabUrl || undefined,
        cookies: normalized,
      });
      return response.data;
    },
    onError: (err: unknown) => setError((err as Error).message),
  });

  return (
    <DashboardShell title="Inject VFS Cookies">
      <div className="max-w-3xl space-y-6">
        <section className="rounded-xl border bg-card p-5">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-widest text-muted-foreground">How to copy cookies</h2>
          <ol className="list-decimal space-y-1 pl-5 text-sm text-foreground">
            <li>In Chrome, open <code className="rounded bg-muted px-1.5 py-0.5 text-xs">https://visa.vfsglobal.com/uzb/en/lva/dashboard</code> while logged in.</li>
            <li>Press <code className="rounded bg-muted px-1.5 py-0.5 text-xs">F12</code> to open DevTools.</li>
            <li>Application tab → Storage → Cookies → click <code className="rounded bg-muted px-1.5 py-0.5 text-xs">https://visa.vfsglobal.com</code>.</li>
            <li>Right-click anywhere in the cookies table → <strong>"Copy all as JSON"</strong>.</li>
            <li>Paste the JSON in the box below and click Save.</li>
          </ol>
          <p className="mt-3 text-xs text-muted-foreground">Cookies expire after ~8 hours. Repeat this when you see polling errors in the Activity Logs.</p>
        </section>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            inject.mutate();
          }}
          className="space-y-4 rounded-xl border bg-card p-5"
        >
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">VFS account email</label>
              <input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full h-10 px-3 rounded-md border border-border bg-background text-sm font-mono focus:border-primary outline-none"
                placeholder="account@gmail.com"
                required
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">VFS password (optional)</label>
              <input
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                type="password"
                className="w-full h-10 px-3 rounded-md border border-border bg-background text-sm focus:border-primary outline-none"
                placeholder="Optional — only if updating"
              />
            </div>
            <div className="md:col-span-2 space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Tab URL (after login)</label>
              <input
                value={tabUrl}
                onChange={(e) => setTabUrl(e.target.value)}
                className="w-full h-10 px-3 rounded-md border border-border bg-background text-sm font-mono focus:border-primary outline-none"
              />
            </div>
            <div className="md:col-span-2 space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Cookies JSON</label>
              <textarea
                value={cookiesRaw}
                onChange={(e) => setCookiesRaw(e.target.value)}
                className="w-full h-72 px-3 py-2 rounded-md border border-border bg-background text-xs font-mono focus:border-primary outline-none resize-y"
                placeholder='[{"name":"datadome","value":"...","domain":".vfsglobal.com",...}, ...]'
                required
              />
            </div>
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}
          {inject.data && (
            <div className="flex items-start gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-700">
              <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" />
              <span>
                Injected {inject.data.cookiesCount} cookies for {inject.data.email}. Backend will use these for slot polling.
              </span>
            </div>
          )}

          <div className="flex items-center justify-end gap-2">
            <button
              type="submit"
              className="h-10 px-5 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 inline-flex items-center gap-2"
              disabled={inject.isPending || !cookiesRaw.trim()}
            >
              <Cookie className="h-4 w-4" />
              {inject.isPending ? 'Injecting…' : 'Inject cookies'}
            </button>
          </div>
        </form>
      </div>
    </DashboardShell>
  );
}
