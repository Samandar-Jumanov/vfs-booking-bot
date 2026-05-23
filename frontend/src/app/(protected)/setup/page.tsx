'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Bell, Check, Clock, Loader2, Play, Radio, StopCircle } from 'lucide-react';
import { DashboardShell } from '@/components/layout/DashboardShell';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useMonitorStore } from '@/store/monitorStore';

type RouteOption = {
  destination: 'lva' | 'tjk';
  visaType: string;
  flag: string;
  title: string;
  subtitle: string;
  badge: string;
};

type AccountRow = {
  id: string;
  email: string;
  status: 'PENDING' | 'ACTIVE' | 'BLOCKED' | 'COOLDOWN';
  cookiesUpdatedAt?: string | null;
  lastWarmedAt?: string | null;
  pollingRole?: 'WATCHER' | 'BOOKER' | 'BOTH';
};

type MonitorRow = {
  id: string;
  isRunning: boolean;
  sourceCountry?: string;
  destination: string;
  visaType: string;
  intervalMs?: number;
  lastCheckedAt?: string | null;
  lastPollAt?: string | null;
  lastPollStatus?: number | null;
  lastPollError?: string | null;
  nextPollAt?: string | null;
  pollerAccountEmail?: string | null;
  recentPolls?: Array<{ at: string; status: number; ok: boolean; accountEmail: string }>;
};

const ROUTES: RouteOption[] = [
  {
    destination: 'lva',
    visaType: 'LTV',
    flag: 'UZ -> LV',
    title: 'UZ -> Latvia',
    subtitle: 'D-visa (Work)',
    badge: 'Production',
  },
  {
    destination: 'tjk',
    visaType: 'TST',
    flag: 'UZ -> TJ',
    title: 'UZ -> Tajikistan',
    subtitle: 'Test route',
    badge: 'Test only',
  },
];

const FRESH_COOKIE_MS = 12 * 60 * 60 * 1000;

export default function SetupPage() {
  const qc = useQueryClient();
  const { setMonitors } = useMonitorStore();
  const [step, setStep] = useState(1);
  const [route, setRoute] = useState<RouteOption>(ROUTES[0]);
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([]);
  const [intervalSeconds, setIntervalSeconds] = useState(60);
  const [mode, setMode] = useState<'auto' | 'manual'>('auto');
  const [now, setNow] = useState(Date.now());

  const accountsQuery = useQuery<AccountRow[]>({
    queryKey: ['accounts', 'active'],
    queryFn: () => api.get('/accounts', { params: { status: 'ACTIVE' } }).then((r) => r.data),
  });

  const monitorQuery = useQuery<MonitorRow[]>({
    queryKey: ['monitor-status'],
    queryFn: () => api.get('/monitor/status').then((r) => {
      setMonitors(r.data);
      return r.data;
    }),
    refetchInterval: 5000,
  });

  const healthQuery = useQuery({
    queryKey: ['health-full'],
    queryFn: () => api.get('/health/full').then((r) => r.data),
    refetchInterval: 30000,
  });

  const logsQuery = useQuery({
    queryKey: ['logs', 'slot-detected', 3],
    queryFn: () => api.get('/logs', { params: { eventType: 'SLOT_DETECTED', limit: 3 } }).then((r) => r.data),
    refetchInterval: 10000,
  });

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const accounts = accountsQuery.data ?? [];
  const freshAccounts = useMemo(
    () => accounts.filter((account) => {
      if (account.status !== 'ACTIVE') return false;
      const stamp = account.cookiesUpdatedAt ?? account.lastWarmedAt;
      return stamp ? Date.now() - new Date(stamp).getTime() < FRESH_COOKIE_MS : false;
    }),
    [accounts],
  );
  const selectedAccounts = freshAccounts.filter((account) => selectedAccountIds.includes(account.id));
  const bookerCount = selectedAccounts.filter((account) => ['BOOKER', 'BOTH', undefined].includes(account.pollingRole)).length;
  const hasFreshAccounts = freshAccounts.length > 0;
  const activeMonitors = (monitorQuery.data ?? []).filter((monitor) => monitor.isRunning);
  const latestPoll = activeMonitors
    .flatMap((monitor) => monitor.recentPolls?.map((poll) => ({ ...poll, monitor })) ?? [])
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())[0];
  const lastPollAt = latestPoll?.at ?? activeMonitors.find((monitor) => monitor.lastPollAt || monitor.lastCheckedAt)?.lastPollAt ?? activeMonitors[0]?.lastCheckedAt ?? null;
  const nextPollAt = activeMonitors
    .map((monitor) => monitor.nextPollAt)
    .filter(Boolean)
    .sort()[0] ?? null;
  const recentPolls = activeMonitors.flatMap((monitor) => monitor.recentPolls ?? []).slice(0, 5);
  const slotLogs = logsQuery.data?.items ?? [];
  const telegramConfigured = String(healthQuery.data?.checks?.['env-vendor-keys']?.note ?? '').includes('TELEGRAM_BOT');

  const startMutation = useMutation({
    mutationFn: () => api.post('/monitor/start', {
      sourceCountry: 'uzbekistan',
      destination: route.destination,
      visaType: route.visaType,
      intervalMs: intervalSeconds * 1000,
      profileIds: [],
      mode,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['monitor-status'] });
      setStep(4);
    },
  });

  const stopMutation = useMutation({
    mutationFn: (id: string) => api.post(`/monitor/stop/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['monitor-status'] }),
  });

  const toggleAccount = (id: string) => {
    setSelectedAccountIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  };

  return (
    <DashboardShell
      title="Start monitor"
      description="Pick the route, choose fresh VFS accounts, and start polling."
    >
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <main className="lg:col-span-7">
          <div className="card bg-card/80 p-6">
            <StepHeader step={step} setStep={setStep} />

            {step === 1 && (
              <section className="mt-6 space-y-4">
                <div>
                  <h3 className="text-lg font-bold">Pick a route</h3>
                  <p className="text-sm text-muted-foreground">Only tested monitor routes are shown.</p>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  {ROUTES.map((option) => (
                    <button
                      key={option.destination}
                      type="button"
                      disabled={!hasFreshAccounts}
                      onClick={() => {
                        setRoute(option);
                        setStep(2);
                      }}
                      className={cn(
                        'rounded-lg border p-5 text-left transition hover:border-primary disabled:cursor-not-allowed disabled:opacity-45',
                        route.destination === option.destination ? 'border-primary bg-primary/5' : 'bg-background',
                      )}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-sm font-black text-muted-foreground">{option.flag}</p>
                          <h4 className="mt-2 text-lg font-black">{option.title}</h4>
                          <p className="text-sm text-muted-foreground">{option.subtitle}</p>
                        </div>
                        <span className="badge-blue">{option.badge}</span>
                      </div>
                      {!hasFreshAccounts && (
                        <p className="mt-4 text-xs font-semibold text-amber-500">Needs a fresh-cookie account</p>
                      )}
                    </button>
                  ))}
                </div>
                {!hasFreshAccounts && <FreshAccountCallout />}
              </section>
            )}

            {step === 2 && (
              <section className="mt-6 space-y-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-lg font-bold">Pick polling accounts</h3>
                    <p className="text-sm text-muted-foreground">Only accounts with cookies refreshed in the last 12 hours are useful for polling.</p>
                  </div>
                  <button type="button" className="btn-secondary h-9" onClick={() => setStep(1)}>Back</button>
                </div>
                {freshAccounts.length === 0 ? (
                  <FreshAccountCallout />
                ) : (
                  <div className="overflow-hidden rounded-lg border">
                    <table className="w-full text-sm">
                      <thead className="bg-muted/50 text-muted-foreground">
                        <tr>
                          <th className="px-4 py-3 text-left text-[10px] font-black uppercase tracking-widest">Email</th>
                          <th className="px-4 py-3 text-left text-[10px] font-black uppercase tracking-widest">Last login age</th>
                          <th className="px-4 py-3 text-left text-[10px] font-black uppercase tracking-widest">Polling role</th>
                          <th className="px-4 py-3 text-right text-[10px] font-black uppercase tracking-widest">Select</th>
                        </tr>
                      </thead>
                      <tbody>
                        {freshAccounts.map((account) => {
                          const selected = selectedAccountIds.includes(account.id);
                          const stamp = account.cookiesUpdatedAt ?? account.lastWarmedAt;
                          return (
                            <tr key={account.id} className="border-t">
                              <td className="px-4 py-3 font-semibold">{account.email}</td>
                              <td className="px-4 py-3 text-muted-foreground">{relativeTime(stamp, now)}</td>
                              <td className="px-4 py-3"><RolePill role={account.pollingRole ?? 'BOTH'} /></td>
                              <td className="px-4 py-3 text-right">
                                <button
                                  type="button"
                                  aria-label={`Select ${account.email}`}
                                  onClick={() => toggleAccount(account.id)}
                                  className={cn('inline-flex h-8 w-8 items-center justify-center rounded-md border', selected && 'border-primary bg-primary text-primary-foreground')}
                                >
                                  {selected && <Check className="h-4 w-4" />}
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
                <div className="flex justify-end">
                  <button
                    type="button"
                    className="btn-primary h-10"
                    disabled={selectedAccountIds.length === 0}
                    onClick={() => setStep(3)}
                  >
                    Continue
                  </button>
                </div>
              </section>
            )}

            {step === 3 && (
              <section className="mt-6 space-y-6">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-lg font-bold">Settings</h3>
                    <p className="text-sm text-muted-foreground">Defaults match the current rate-limit cooldown.</p>
                  </div>
                  <button type="button" className="btn-secondary h-9" onClick={() => setStep(2)}>Back</button>
                </div>
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-black uppercase tracking-widest text-muted-foreground">Polling interval</label>
                    <span className="rounded-md bg-primary/10 px-2 py-1 text-sm font-bold text-primary">{intervalSeconds}s</span>
                  </div>
                  <input
                    type="range"
                    min={30}
                    max={300}
                    step={15}
                    value={intervalSeconds}
                    onChange={(event) => setIntervalSeconds(Number(event.target.value))}
                    className="w-full accent-primary"
                  />
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>30s</span>
                    <span>300s</span>
                  </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  {[
                    { value: 'auto', label: 'Auto-book' },
                    { value: 'manual', label: 'Alert only' },
                  ].map((item) => (
                    <button
                      key={item.value}
                      type="button"
                      onClick={() => setMode(item.value as 'auto' | 'manual')}
                      className={cn('rounded-lg border p-4 text-left font-bold', mode === item.value ? 'border-primary bg-primary/5' : 'bg-background')}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
                <div className="rounded-lg border bg-background p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <Bell className="h-4 w-4 text-muted-foreground" />
                      <span className="font-semibold">Telegram alerts</span>
                    </div>
                    <span className={telegramConfigured ? 'badge-green' : 'badge-yellow'}>
                      {telegramConfigured ? 'Configured' : 'Not configured'}
                    </span>
                  </div>
                  {!telegramConfigured && (
                    <p className="mt-3 text-sm text-muted-foreground">Configure Telegram in Settings to receive slot alerts.</p>
                  )}
                </div>
                <div className="flex justify-end">
                  <button type="button" className="btn-primary h-10" onClick={() => setStep(4)}>Review</button>
                </div>
              </section>
            )}

            {step === 4 && (
              <section className="mt-6 space-y-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-lg font-bold">Confirm and start</h3>
                    <p className="text-sm text-muted-foreground">Review the monitor before dispatching it.</p>
                  </div>
                  <button type="button" className="btn-secondary h-9" onClick={() => setStep(3)}>Back</button>
                </div>
                <div className="rounded-lg border bg-background p-5">
                  <p className="font-bold">You're about to:</p>
                  <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
                    <li>{`Poll UZ -> ${route.destination === 'lva' ? 'Latvia' : 'Tajikistan'} every ${intervalSeconds}s`}</li>
                    <li>Use {selectedAccounts.length} watcher account(s) ({selectedAccounts.map((a) => a.email).join(', ') || 'none selected'})</li>
                    <li>{mode === 'auto' ? `Auto-book when slot found, dispatching to ${bookerCount} booker account(s)` : 'Send alerts only when a slot is found'}</li>
                    <li>{telegramConfigured ? 'Send Telegram alert on detection' : 'Telegram alert disabled until configured'}</li>
                  </ul>
                </div>
                {startMutation.error && (
                  <p className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-500">
                    {(startMutation.error as any)?.response?.data?.message ?? (startMutation.error as Error).message}
                  </p>
                )}
                <button
                  type="button"
                  className="btn-primary h-12 w-full gap-2"
                  disabled={selectedAccountIds.length === 0 || startMutation.isPending}
                  onClick={() => startMutation.mutate()}
                >
                  {startMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                  Start Monitor
                </button>
              </section>
            )}
          </div>
        </main>

        <aside className="lg:col-span-5">
          <div className="card sticky top-6 bg-card/80 p-5">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold">Live status</h3>
              <span className="badge-blue">Active monitors: {activeMonitors.length}</span>
            </div>
            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              <StatusTile label="Last poll" value={relativeTime(lastPollAt, now)} icon={<Radio className="h-4 w-4" />} />
              <StatusTile label="Next poll in" value={countdown(nextPollAt, now)} icon={<Clock className="h-4 w-4" />} />
            </div>
            <div className="mt-5">
              <p className="mb-2 text-[10px] font-black uppercase tracking-widest text-muted-foreground">Last 5 poll outcomes</p>
              <div className="space-y-2">
                {recentPolls.length ? recentPolls.map((poll, index) => (
                  <div key={`${poll.at}-${index}`} className="flex items-center justify-between rounded-md border bg-background px-3 py-2 text-sm">
                    <span className="text-muted-foreground">{relativeTime(poll.at, now)} · {poll.accountEmail || 'unknown'}</span>
                    <span className={cn('rounded px-2 py-0.5 text-xs font-bold', poll.ok ? 'bg-green-500/15 text-green-500' : poll.status >= 400 ? 'bg-red-500/15 text-red-500' : 'bg-yellow-500/15 text-yellow-500')}>
                      {poll.status || 'empty'}
                    </span>
                  </div>
                )) : (
                  <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">No poll outcomes yet.</p>
                )}
              </div>
            </div>
            <div className="mt-5">
              <p className="mb-2 text-[10px] font-black uppercase tracking-widest text-muted-foreground">Recent slot detections</p>
              <div className="space-y-2">
                {slotLogs.length ? slotLogs.map((log: any) => (
                  <div key={log.id} className="rounded-md border bg-background px-3 py-2 text-sm">
                    <p className="font-semibold">{log.destination ?? 'slot'} · {relativeTime(log.timestamp, now)}</p>
                    <p className="text-muted-foreground">{log.message}</p>
                  </div>
                )) : (
                  <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">No detections yet.</p>
                )}
              </div>
            </div>
            {activeMonitors.length > 0 && (
              <div className="mt-5 space-y-2">
                {activeMonitors.map((monitor) => (
                  <div key={monitor.id} className="flex items-center justify-between rounded-md border bg-background px-3 py-2">
                    <span className="text-sm font-semibold">{`${monitor.sourceCountry ?? 'UZ'} -> ${monitor.destination}`}</span>
                    <button
                      type="button"
                      className="btn-secondary h-8 w-8 p-0 text-destructive"
                      aria-label={`Stop ${monitor.destination}`}
                      onClick={() => stopMutation.mutate(monitor.id)}
                    >
                      <StopCircle className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </aside>
      </div>
    </DashboardShell>
  );
}

function StepHeader({ step, setStep }: { step: number; setStep: (step: number) => void }) {
  const labels = ['Route', 'Accounts', 'Settings', 'Start'];
  return (
    <div className="grid grid-cols-4 gap-2">
      {labels.map((label, index) => {
        const value = index + 1;
        return (
          <button
            key={label}
            type="button"
            onClick={() => setStep(value)}
            className={cn('rounded-md border px-2 py-2 text-xs font-black uppercase tracking-widest', step === value ? 'border-primary bg-primary text-primary-foreground' : 'bg-background text-muted-foreground')}
          >
            {value}. {label}
          </button>
        );
      })}
    </div>
  );
}

function FreshAccountCallout() {
  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm">
      <div className="flex gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 text-amber-500" />
        <div>
          <p className="font-bold text-amber-500">No fresh-cookie accounts.</p>
          <p className="mt-1 text-muted-foreground">{'Go to Account Pool -> "Login all stale" first.'}</p>
          <Link href="/account-pool" className="mt-3 inline-flex text-sm font-bold text-primary">Open Account Pool</Link>
        </div>
      </div>
    </div>
  );
}

function RolePill({ role }: { role: 'WATCHER' | 'BOOKER' | 'BOTH' }) {
  const className = role === 'WATCHER' ? 'badge-blue' : role === 'BOOKER' ? 'badge-yellow' : 'badge-green';
  return <span className={className}>{role}</span>;
}

function StatusTile({ label, value, icon }: { label: string; value: string; icon: React.ReactNode }) {
  return (
    <div className="rounded-lg border bg-background p-3">
      <div className="flex items-center justify-between text-muted-foreground">
        <span className="text-[10px] font-black uppercase tracking-widest">{label}</span>
        {icon}
      </div>
      <p className="mt-2 text-lg font-black">{value}</p>
    </div>
  );
}

function relativeTime(value: string | null | undefined, now: number) {
  if (!value) return 'never';
  const diffSeconds = Math.max(0, Math.floor((now - new Date(value).getTime()) / 1000));
  if (diffSeconds < 60) return `${diffSeconds}s ago`;
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${Math.floor(diffHours / 24)}d ago`;
}

function countdown(value: string | null | undefined, now: number) {
  if (!value) return 'unknown';
  const diffSeconds = Math.max(0, Math.ceil((new Date(value).getTime() - now) / 1000));
  if (diffSeconds < 60) return `${diffSeconds}s`;
  return `${Math.floor(diffSeconds / 60)}m ${diffSeconds % 60}s`;
}
