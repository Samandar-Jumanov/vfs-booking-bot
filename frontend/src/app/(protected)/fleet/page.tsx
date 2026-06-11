'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, Clock, RefreshCw, Save, Server, ShieldAlert, Wifi, WifiOff } from 'lucide-react';
import { DashboardShell } from '@/components/layout/DashboardShell';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

type BoxRole = 'CREATOR' | 'WATCHER' | 'BOOKER' | 'COOLDOWN' | 'OFFLINE';
type BoxStatus = 'ONLINE' | 'WORKING' | 'COOLDOWN' | 'OFFLINE';

interface WorkerBox {
  boxId: string;
  role: BoxRole;
  status: BoxStatus;
  online: boolean;
  heartbeatAt: string | null;
  assignedAccountEmail: string | null;
  currentUrl: string | null;
  pageState: unknown;
  lastSuccessfulCheckAt: string | null;
  lastError: string | null;
  lastBlockReason: string | null;
  cooldownUntil: string | null;
  creationSuccessCount: number;
  creationFailureCount: number;
  hostname: string | null;
  pid: number | null;
  updatedAt: string;
}

interface AccountLease {
  id: string;
  accountId: string;
  boxId: string;
  role: BoxRole;
  runId: string | null;
  heartbeatAt: string;
  expiresAt: string;
  account: {
    email: string;
    pollingRole: string;
    status: string;
    cooldownUntil: string | null;
  };
}

interface FleetStatus {
  generatedAt: string;
  staleAfterSeconds: number;
  boxes: WorkerBox[];
  leases: AccountLease[];
  summary: { total: number; online: number; cooldown: number; offline: number };
}

interface BurstConfig {
  timezone: string;
  windows: Array<{ start: string; end: string }>;
  burstIntervalSeconds: number;
  idleIntervalSeconds: number;
  staggerSeconds: number;
}

const defaultBurst: BurstConfig = {
  timezone: 'Asia/Tashkent',
  windows: [{ start: '11:55', end: '12:15' }],
  burstIntervalSeconds: 3,
  idleIntervalSeconds: 300,
  staggerSeconds: 0,
};

export default function FleetPage() {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<BurstConfig>(defaultBurst);

  const statusQuery = useQuery<FleetStatus>({
    queryKey: ['fleet-status'],
    queryFn: () => api.get<FleetStatus>('/fleet/status').then((r) => r.data),
    refetchInterval: 5000,
  });

  const burstQuery = useQuery<BurstConfig>({
    queryKey: ['fleet-burst-config'],
    queryFn: () => api.get<BurstConfig>('/fleet/burst-config').then((r) => r.data),
  });

  useEffect(() => {
    if (burstQuery.data) setDraft(burstQuery.data);
  }, [burstQuery.data]);

  const saveBurst = useMutation({
    mutationFn: () => api.put<BurstConfig>('/fleet/burst-config', draft).then((r) => r.data),
    onSuccess: (data) => {
      setDraft(data);
      qc.invalidateQueries({ queryKey: ['fleet-burst-config'] });
    },
  });

  const boxes = useMemo(() => statusQuery.data?.boxes ?? [], [statusQuery.data?.boxes]);
  const leases = useMemo(() => statusQuery.data?.leases ?? [], [statusQuery.data?.leases]);
  const summary = statusQuery.data?.summary ?? { total: 0, online: 0, cooldown: 0, offline: 0 };
  const activeBoxes = useMemo(() => boxes.filter((box) => box.status === 'WORKING' || box.status === 'ONLINE'), [boxes]);

  const updateWindow = (index: number, key: 'start' | 'end', value: string) => {
    setDraft((current) => ({
      ...current,
      windows: current.windows.map((window, i) => i === index ? { ...window, [key]: value } : window),
    }));
  };

  return (
    <DashboardShell
      title="Fleet status"
      description="Live coordination, cooldowns, account leases, and burst-window timing for VPS boxes."
      actions={(
        <button type="button" className="btn-secondary h-9 gap-2" onClick={() => statusQuery.refetch()}>
          <RefreshCw className="h-4 w-4" />
          Refresh
        </button>
      )}
    >
      <div className="grid gap-3 md:grid-cols-4">
        <Stat label="Boxes" value={summary.total} icon={<Server className="h-4 w-4" />} />
        <Stat label="Usable" value={summary.online} tone="ok" icon={<Wifi className="h-4 w-4" />} />
        <Stat label="Cooling" value={summary.cooldown} tone="warn" icon={<Clock className="h-4 w-4" />} />
        <Stat label="Offline" value={summary.offline} tone="bad" icon={<WifiOff className="h-4 w-4" />} />
      </div>

      <section className="card mt-6 bg-card/70 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Burst windows</p>
            <h2 className="mt-1 text-lg font-black">Fleet timing</h2>
          </div>
          <button type="button" className="btn-primary h-9 gap-2" onClick={() => saveBurst.mutate()} disabled={saveBurst.isPending}>
            <Save className="h-4 w-4" />
            Save
          </button>
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-5">
          <Field label="Timezone" value={draft.timezone} onChange={(value) => setDraft((c) => ({ ...c, timezone: value }))} />
          <Field label="Burst seconds" type="number" value={draft.burstIntervalSeconds} onChange={(value) => setDraft((c) => ({ ...c, burstIntervalSeconds: Number(value) || 3 }))} />
          <Field label="Idle seconds" type="number" value={draft.idleIntervalSeconds} onChange={(value) => setDraft((c) => ({ ...c, idleIntervalSeconds: Number(value) || 300 }))} />
          <Field label="Stagger seconds" type="number" value={draft.staggerSeconds} onChange={(value) => setDraft((c) => ({ ...c, staggerSeconds: Number(value) || 0 }))} />
          <div className="rounded-md border bg-muted/30 p-3 text-sm">
            <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Effective cadence</p>
            <p className="mt-2 font-mono">{activeBoxes.length || 1} box(es), target {draft.burstIntervalSeconds}s</p>
          </div>
        </div>
        <div className="mt-3 grid gap-3 md:grid-cols-3">
          {draft.windows.map((window, index) => (
            <div key={`${window.start}-${index}`} className="grid grid-cols-2 gap-2 rounded-md border bg-muted/20 p-3">
              <Field label="Start" value={window.start} onChange={(value) => updateWindow(index, 'start', value)} />
              <Field label="End" value={window.end} onChange={(value) => updateWindow(index, 'end', value)} />
            </div>
          ))}
        </div>
      </section>

      <section className="card mt-6 overflow-hidden bg-card/70 p-0">
        <table className="w-full text-sm">
          <thead className="bg-zinc-950 text-zinc-400">
            <tr>
              <Th>Box</Th>
              <Th>Status</Th>
              <Th>Role</Th>
              <Th>Account</Th>
              <Th>Last check</Th>
              <Th>Cooldown</Th>
              <Th>Creator stats</Th>
              <Th>Last error</Th>
            </tr>
          </thead>
          <tbody>
            {boxes.length === 0 && (
              <tr>
                <td className="px-4 py-8 text-center text-muted-foreground" colSpan={8}>No worker boxes have reported yet.</td>
              </tr>
            )}
            {boxes.map((box) => (
              <tr key={box.boxId} className="border-t border-border/60 align-top">
                <td className="px-4 py-3">
                  <div className="font-bold">{box.boxId}</div>
                  <div className="text-xs text-muted-foreground">{box.hostname ?? 'host unknown'} {box.pid ? `pid ${box.pid}` : ''}</div>
                  <div className="text-xs text-muted-foreground">Heartbeat {relativeTime(box.heartbeatAt)}</div>
                </td>
                <td className="px-4 py-3"><StatusBadge status={box.status} /></td>
                <td className="px-4 py-3"><RoleBadge role={box.role} /></td>
                <td className="max-w-[220px] px-4 py-3 font-mono text-xs">{box.assignedAccountEmail ?? '-'}</td>
                <td className="px-4 py-3 text-muted-foreground">{relativeTime(box.lastSuccessfulCheckAt)}</td>
                <td className="px-4 py-3 text-muted-foreground">{box.cooldownUntil ? new Date(box.cooldownUntil).toLocaleString() : '-'}</td>
                <td className="px-4 py-3 font-mono text-xs">{box.creationSuccessCount} ok / {box.creationFailureCount} fail</td>
                <td className="max-w-[260px] px-4 py-3">
                  <div className="line-clamp-2 text-xs text-muted-foreground">{box.lastBlockReason ?? box.lastError ?? '-'}</div>
                  {box.currentUrl && <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground">{box.currentUrl}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card mt-6 overflow-hidden bg-card/70 p-0">
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <Activity className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-black">Active account leases</h2>
        </div>
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-muted-foreground">
            <tr>
              <Th>Box</Th>
              <Th>Account</Th>
              <Th>Role</Th>
              <Th>Expires</Th>
              <Th>Run</Th>
            </tr>
          </thead>
          <tbody>
            {leases.length === 0 && (
              <tr><td className="px-4 py-6 text-center text-muted-foreground" colSpan={5}>No active account leases.</td></tr>
            )}
            {leases.map((lease) => (
              <tr key={lease.id} className="border-t border-border/60">
                <td className="px-4 py-3 font-bold">{lease.boxId}</td>
                <td className="px-4 py-3 font-mono text-xs">{lease.account.email}</td>
                <td className="px-4 py-3"><RoleBadge role={lease.role} /></td>
                <td className="px-4 py-3 text-muted-foreground">{new Date(lease.expiresAt).toLocaleString()}</td>
                <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{lease.runId ?? '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </DashboardShell>
  );
}

function Stat({ label, value, tone, icon }: { label: string; value: number; tone?: 'ok' | 'warn' | 'bad'; icon?: React.ReactNode }) {
  return (
    <article className={cn('card bg-card/70 p-4', tone === 'ok' && 'ring-1 ring-green-500/30', tone === 'warn' && 'ring-1 ring-amber-500/30', tone === 'bad' && 'ring-1 ring-red-500/30')}>
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">{label}</p>
        {icon}
      </div>
      <p className="mt-2 text-2xl font-black">{value}</p>
    </article>
  );
}

function Field({ label, value, onChange, type = 'text' }: { label: string; value: string | number; onChange: (value: string) => void; type?: string }) {
  return (
    <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">
      {label}
      <input className="input mt-1 h-10 text-sm normal-case tracking-normal" type={type} value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-4 py-3 text-left text-[10px] font-black uppercase tracking-widest">{children}</th>;
}

function StatusBadge({ status }: { status: BoxStatus }) {
  const map = {
    ONLINE: 'bg-green-500/15 text-green-500',
    WORKING: 'bg-blue-500/15 text-blue-500',
    COOLDOWN: 'bg-amber-500/15 text-amber-500',
    OFFLINE: 'bg-red-500/15 text-red-500',
  } as const;
  const icon = status === 'COOLDOWN' ? <ShieldAlert className="h-3.5 w-3.5" /> : null;
  return <span className={cn('inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-bold', map[status])}>{icon}{status}</span>;
}

function RoleBadge({ role }: { role: BoxRole }) {
  const map = {
    CREATOR: 'bg-cyan-500/15 text-cyan-500',
    WATCHER: 'bg-blue-500/15 text-blue-500',
    BOOKER: 'bg-purple-500/15 text-purple-500',
    COOLDOWN: 'bg-amber-500/15 text-amber-500',
    OFFLINE: 'bg-red-500/15 text-red-500',
  } as const;
  return <span className={cn('inline-flex items-center rounded-full px-2.5 py-1 text-xs font-bold', map[role])}>{role}</span>;
}

function relativeTime(value?: string | null) {
  if (!value) return 'never';
  const seconds = Math.floor((Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
