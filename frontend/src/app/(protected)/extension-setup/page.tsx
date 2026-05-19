'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { CheckCircle2, ExternalLink, KeyRound, MonitorCheck, PlugZap } from 'lucide-react';
import { DashboardShell } from '@/components/layout/DashboardShell';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

interface ExtensionTokenResponse {
  setupCode: string;
  extensionToken: string;
  expiresAt: string;
}

interface ExtensionStatus {
  connected: boolean;
  customerEmail?: string;
  connectedAt?: string;
  lastHeartbeatAt?: string;
}

export default function ExtensionSetupPage() {
  const [extensionDetected, setExtensionDetected] = useState(false);
  const [tokenResponse, setTokenResponse] = useState<ExtensionTokenResponse | null>(null);

  const statusQuery = useQuery<ExtensionStatus>({
    queryKey: ['extension-status'],
    queryFn: () => api.get<ExtensionStatus>('/extension/status').then((response) => response.data),
    refetchInterval: 5000,
  });

  const tokenMutation = useMutation({
    mutationFn: () => api.post<ExtensionTokenResponse>('/auth/extension-token').then((response) => response.data),
    onSuccess: setTokenResponse,
  });

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.data?.source === 'vfs-booking-extension' && event.data?.type === 'EXTENSION_PRESENT') {
        setExtensionDetected(true);
      }
    };
    window.addEventListener('message', onMessage);
    window.postMessage({ source: 'vfs-dashboard', type: 'PING_EXTENSION' }, window.location.origin);
    const id = window.setInterval(() => {
      window.postMessage({ source: 'vfs-dashboard', type: 'PING_EXTENSION' }, window.location.origin);
    }, 2000);
    return () => {
      window.removeEventListener('message', onMessage);
      window.clearInterval(id);
    };
  }, []);

  const steps = useMemo(() => [
    {
      title: 'Install the extension',
      description: 'Use the unpacked development build until the Chrome Web Store package is published.',
      done: extensionDetected,
      icon: PlugZap,
    },
    {
      title: 'Connect to backend',
      description: 'Generate a setup code and paste it into the extension options page.',
      done: Boolean(statusQuery.data?.connected),
      icon: KeyRound,
    },
    {
      title: 'Log in to VFS',
      description: 'Open the Latvia login page and sign in normally in this Chrome profile.',
      done: Boolean(statusQuery.data?.lastHeartbeatAt),
      icon: ExternalLink,
    },
    {
      title: 'Confirmation',
      description: 'When the heartbeat is current, the customer browser is ready to poll and book.',
      done: Boolean(statusQuery.data?.connected && statusQuery.data.lastHeartbeatAt),
      icon: MonitorCheck,
    },
  ], [extensionDetected, statusQuery.data]);

  return (
    <DashboardShell title="Extension setup" description="Pair the customer Chrome extension and use their browser as the booking engine.">
      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <section className="space-y-4">
          {steps.map((step, index) => {
            const Icon = step.icon;
            return (
              <article key={step.title} className="card bg-card/70 p-5">
                <div className="flex items-start gap-4">
                  <div className={cn('grid h-10 w-10 place-items-center rounded-lg', step.done ? 'bg-green-500/15 text-green-500' : 'bg-primary/10 text-primary')}>
                    {step.done ? <CheckCircle2 className="h-5 w-5" /> : <Icon className="h-5 w-5" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Step {index + 1}</p>
                    <h2 className="mt-1 text-lg font-black">{step.title}</h2>
                    <p className="mt-1 text-sm text-muted-foreground">{step.description}</p>
                    {index === 0 && (
                      <div className="mt-4 rounded-lg border bg-muted/40 p-4 text-sm">
                        <p className="font-medium">Local install (unpacked):</p>
                        <ol className="mt-2 list-decimal space-y-1 pl-5 text-muted-foreground">
                          <li>Open <code className="rounded bg-background px-1.5 py-0.5">chrome://extensions</code></li>
                          <li>Enable <strong>Developer mode</strong> (top-right)</li>
                          <li>Click <strong>Load unpacked</strong> → pick the <code className="rounded bg-background px-1.5 py-0.5">extension/dist</code> folder from this repo</li>
                        </ol>
                      </div>
                    )}
                    {index === 1 && (
                      <div className="mt-4 flex flex-wrap items-center gap-3">
                        <button type="button" className="btn-primary h-10" onClick={() => tokenMutation.mutate()} disabled={tokenMutation.isPending}>
                          Generate setup code
                        </button>
                        {tokenResponse && (
                          <code className="rounded-lg border bg-background px-4 py-2 text-2xl font-black tracking-[0.3em]">
                            {tokenResponse.setupCode}
                          </code>
                        )}
                      </div>
                    )}
                    {index === 2 && (
                      <a className="btn-secondary mt-4 h-10 w-fit gap-2" href="https://visa.vfsglobal.com/uzb/en/lva/login" target="_blank" rel="noreferrer">
                        <ExternalLink className="h-4 w-4" />
                        Open VFS Latvia login
                      </a>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </section>

        <aside className="card h-fit bg-zinc-950 p-5 text-zinc-100">
          <p className="text-[10px] font-black uppercase tracking-widest text-zinc-500">Extension status</p>
          <div className="mt-4 space-y-3 text-sm">
            <StatusRow label="Installed" value={extensionDetected ? 'Detected' : 'Waiting'} ok={extensionDetected} />
            <StatusRow label="Backend" value={statusQuery.data?.connected ? 'Connected' : 'Offline'} ok={Boolean(statusQuery.data?.connected)} />
            <StatusRow label="Customer" value={statusQuery.data?.customerEmail ?? 'Unknown'} />
            <StatusRow label="Last heartbeat" value={statusQuery.data?.lastHeartbeatAt ? new Date(statusQuery.data.lastHeartbeatAt).toLocaleString() : 'Never'} />
          </div>
          {statusQuery.data?.connected && (
            <a href="/dashboard" className="btn-primary mt-5 h-11 w-full">All set</a>
          )}
        </aside>
      </div>
    </DashboardShell>
  );
}

function StatusRow({ label, value, ok }: { label: string; value: string; ok?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg bg-white/5 px-3 py-2">
      <span className="text-zinc-500">{label}</span>
      <span className={cn('text-right font-bold', ok === true && 'text-green-300', ok === false && 'text-amber-300')}>{value}</span>
    </div>
  );
}
