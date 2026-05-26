'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ExternalLink, AlertTriangle, ShieldOff, Plus, Clock, Snowflake, Loader2, RefreshCw, Eye, Copy, X } from 'lucide-react';
import { DashboardShell } from '@/components/layout/DashboardShell';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { addWebSocketListener } from '@/hooks/useWebSocket';
import type { BatchProgressPayload } from '@/types/ws-events';

interface PoolItem {
  id: string;
  email: string;
  status: 'PENDING' | 'ACTIVE' | 'BLOCKED' | 'COOLDOWN';
  cookieFresh: boolean;
  cookiesUpdatedAt?: string | null;
  lastWarmedAt: string | null;
  tabUrl: string | null;
  lastUsedAt: string | null;
  cooldownUntil: string | null;
  profileCount: number;
  loginUrl: string;
  pollingRole?: 'WATCHER' | 'BOOKER' | 'BOTH';
}

interface PoolSummary {
  total: number;
  active: number;
  fresh: number;
  stale: number;
  blocked: number;
  cooldown: number;
  pending: number;
}

interface PoolResponse {
  summary: PoolSummary;
  items: PoolItem[];
}

interface LoginBatchJob {
  jobId: string;
  startedAt: string;
  finishedAt: string | null;
  state: 'running' | 'done' | 'cancelled';
  items: Array<{
    accountId: string;
    email: string;
    state: 'pending' | 'running' | 'success' | 'failed';
    startedAt: string | null;
    finishedAt: string | null;
    error: string | null;
  }>;
}

const STALE_LOGIN_MS = 6 * 60 * 60 * 1000;

export default function AccountPoolPage() {
  const qc = useQueryClient();
  const [revealed, setRevealed] = useState<{ accountId: string; email: string; password: string } | null>(null);
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchCount, setBatchCount] = useState(5);
  const [batchSpacingSeconds, setBatchSpacingSeconds] = useState(300);
  const [batchProgress, setBatchProgress] = useState<BatchProgressPayload | null>(null);
  const [batchMsg, setBatchMsg] = useState<string | null>(null);
  const [loginBatchOpen, setLoginBatchOpen] = useState(false);
  const [loginBatchJobId, setLoginBatchJobId] = useState<string | null>(null);
  const [roleMenuAccountId, setRoleMenuAccountId] = useState<string | null>(null);

  const poolQuery = useQuery<PoolResponse>({
    queryKey: ['account-pool'],
    queryFn: () => api.get<PoolResponse>('/accounts/warmup-status').then((r) => r.data),
    refetchInterval: 5000,
  });

  const blockMutation = useMutation({
    mutationFn: (id: string) => api.put(`/accounts/${id}/block`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['account-pool'] }),
  });

  const cooldownMutation = useMutation({
    mutationFn: ({ id, minutes }: { id: string; minutes: number }) => api.put(`/accounts/${id}/cooldown`, { minutes }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['account-pool'] }),
  });

  const [autoCreateMsg, setAutoCreateMsg] = useState<string | null>(null);
  const autoCreateMutation = useMutation({
    mutationFn: () => api.post('/accounts/auto-create', { source: 'uzb', destination: 'lva', countryCode: '171' }).then((r) => r.data),
    onSuccess: (data) => {
      setAutoCreateMsg(data?.success ? `Created ${data.email}` : `Failed: ${data?.reason ?? 'unknown'}`);
      qc.invalidateQueries({ queryKey: ['account-pool'] });
    },
    onError: (err: any) => {
      const reason = err?.response?.data?.reason ?? err?.message ?? 'unknown error';
      setAutoCreateMsg(`Failed: ${reason}`);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['account-pool'] }),
  });

  const batchCreateMutation = useMutation({
    mutationFn: () =>
      api.post<BatchProgressPayload>('/accounts/auto-create-batch', {
        count: batchCount,
        spacingSeconds: batchSpacingSeconds,
        source: 'uzb',
        destination: 'lva',
        countryCode: '171',
      }).then((r) => r.data),
    onSuccess: (data) => {
      setBatchProgress(data);
      setBatchMsg(null);
      setBatchOpen(false);
    },
    onError: (err: any) => {
      const reason = err?.response?.data?.message ?? err?.response?.data?.error ?? err?.message ?? 'unknown error';
      setBatchMsg(`Failed: ${reason}`);
    },
  });

  const cancelBatchMutation = useMutation({
    mutationFn: (batchId: string) => api.post<BatchProgressPayload>(`/accounts/auto-create-batch/${batchId}/cancel`).then((r) => r.data),
    onSuccess: (data) => {
      setBatchProgress(data);
      qc.invalidateQueries({ queryKey: ['account-pool'] });
    },
  });

  const loginBatchQuery = useQuery<LoginBatchJob>({
    queryKey: ['login-batch', loginBatchJobId],
    queryFn: () => api.get<LoginBatchJob>(`/accounts/login-batch/${loginBatchJobId}`).then((r) => r.data),
    enabled: Boolean(loginBatchJobId),
    refetchInterval: (query) => query.state.data?.state === 'running' ? 2000 : false,
  });

  const startLoginBatchMutation = useMutation({
    mutationFn: (accountIds: string[]) =>
      api.post<{ jobId: string }>('/accounts/login-batch', { accountIds, spacingMs: 60000 }).then((r) => r.data),
    onSuccess: (data) => {
      setLoginBatchJobId(data.jobId);
    },
  });

  const cancelLoginBatchMutation = useMutation({
    mutationFn: (jobId: string) => api.post(`/accounts/login-batch/${jobId}/cancel`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['login-batch', loginBatchJobId] });
    },
  });

  const updateRoleMutation = useMutation({
    mutationFn: ({ accountId, role }: { accountId: string; role: NonNullable<PoolItem['pollingRole']> }) =>
      api.patch(`/accounts/${accountId}/polling-role`, { role }),
    onSuccess: () => {
      setRoleMenuAccountId(null);
      qc.invalidateQueries({ queryKey: ['account-pool'] });
    },
  });

  const [retryMsg, setRetryMsg] = useState<string | null>(null);
  const retryActivationMutation = useMutation({
    mutationFn: (accountId: string) =>
      api.post('/accounts/recover-from-mailsac', { accountId }).then((r) => r.data),
    onSuccess: (data) => {
      setRetryMsg(data?.success ? `Activated ${data.email}` : `Failed: ${data?.reason ?? 'unknown'}`);
      qc.invalidateQueries({ queryKey: ['account-pool'] });
    },
    onError: (err: any) => {
      const reason = err?.response?.data?.reason ?? err?.response?.data?.error ?? err?.message ?? 'unknown error';
      setRetryMsg(`Failed: ${reason}`);
      qc.invalidateQueries({ queryKey: ['account-pool'] });
    },
  });

  const [autoLoginMsg, setAutoLoginMsg] = useState<string | null>(null);
  const autoLoginMutation = useMutation({
    mutationFn: ({ accountId, fillOnly }: { accountId: string; fillOnly?: boolean }) =>
      api.post(`/accounts/${accountId}/auto-login`, { fillOnly: Boolean(fillOnly) }).then((r) => r.data),
    onSuccess: (data, vars) => {
      if (!data?.success) {
        setAutoLoginMsg(`Failed: ${data?.reason ?? 'unknown'}`);
      } else if (vars.fillOnly) {
        setAutoLoginMsg(`Fields filled for ${data.email} — solve the captcha & click Sign In in the opened tab`);
      } else {
        setAutoLoginMsg(`Warmed ${data.email}`);
      }
      qc.invalidateQueries({ queryKey: ['account-pool'] });
    },
    onError: (err: any) => {
      const reason = err?.response?.data?.reason ?? err?.response?.data?.error ?? err?.message ?? 'unknown error';
      setAutoLoginMsg(`Failed: ${reason}`);
      qc.invalidateQueries({ queryKey: ['account-pool'] });
    },
  });

  // Open a CLEAN VFS login tab bound to this account (no debugger, no autofill —
  // so the Turnstile captcha actually renders). Operator logs in manually; the
  // bound tab lets the backend tag session-sync with the right account, which
  // is what lets auto-booking fire.
  const openTabMutation = useMutation({
    mutationFn: (accountId: string) => api.post(`/accounts/${accountId}/open-tab`).then((r) => r.data),
    onSuccess: (data) => {
      setAutoLoginMsg(data?.success
        ? `Opened bound login tab for ${data.email} — log in there; booking arms automatically`
        : `Failed: ${data?.reason ?? 'unknown'}`);
    },
    onError: (err: any) => {
      const reason = err?.response?.data?.reason ?? err?.response?.data?.error ?? err?.message ?? 'unknown error';
      setAutoLoginMsg(`Failed: ${reason}`);
    },
  });

  // On-demand "Check slots now" — one CheckIsSlotAvailable poll via the extension.
  const [checkSlotsMsg, setCheckSlotsMsg] = useState<string | null>(null);
  const checkSlotsMutation = useMutation({
    mutationFn: () => api.post('/accounts/check-slots').then((r) => r.data),
    onSuccess: (data) => {
      if (data?.earliestDate) setCheckSlotsMsg(`Slot available! earliest: ${data.earliestDate}`);
      else if (data?.ok) setCheckSlotsMsg(`No slots (HTTP ${data.status ?? '?'})`);
      else setCheckSlotsMsg(`Failed: ${data?.reason ?? 'unknown'}`);
    },
    onError: (err: any) => {
      const reason = err?.response?.data?.reason ?? err?.response?.data?.error ?? err?.message ?? 'unknown error';
      setCheckSlotsMsg(`Failed: ${reason}`);
    },
  });

  const [manualOpen, setManualOpen] = useState(false);
  const [mEmail, setMEmail] = useState('');
  const [mPassword, setMPassword] = useState('');
  const [mPhone, setMPhone] = useState('');
  const [manualMsg, setManualMsg] = useState<string | null>(null);
  const manualAddMutation = useMutation({
    mutationFn: () =>
      api.post('/accounts', {
        email: mEmail.trim(),
        password: mPassword,
        phone: mPhone.trim() || undefined,
      }).then((r) => r.data),
    onSuccess: (data) => {
      setManualMsg(`Added ${data.email}`);
      setMEmail(''); setMPassword(''); setMPhone('');
      setManualOpen(false);
      qc.invalidateQueries({ queryKey: ['account-pool'] });
    },
    onError: (err: any) => {
      const msg = err?.response?.data?.message ?? err?.response?.data?.error ?? err?.message ?? 'unknown error';
      setManualMsg(`Failed: ${msg}`);
    },
  });

  const summary = poolQuery.data?.summary ?? { total: 0, active: 0, fresh: 0, stale: 0, blocked: 0, cooldown: 0, pending: 0 };
  const items = useMemo(() => poolQuery.data?.items ?? [], [poolQuery.data?.items]);

  const staleAccounts = useMemo(() => items.filter((i) => i.status === 'ACTIVE' && !i.cookieFresh), [items]);
  const staleLoginAccounts = useMemo(() => items.filter((i) => {
    if (i.status !== 'ACTIVE') return false;
    const stamp = i.cookiesUpdatedAt ?? i.lastWarmedAt;
    return !stamp || Date.now() - new Date(stamp).getTime() > STALE_LOGIN_MS;
  }), [items]);
  const loginBatchJob = loginBatchQuery.data;
  const loginBatchDone = loginBatchJob?.items.filter((item) => item.state === 'success' || item.state === 'failed').length ?? 0;
  const loginBatchSuccess = loginBatchJob?.items.filter((item) => item.state === 'success').length ?? 0;
  const loginBatchFailed = loginBatchJob?.items.filter((item) => item.state === 'failed').length ?? 0;
  const loginBatchNeedsWarmTab = loginBatchJob?.items.some((item) => item.error === 'WARM_TAB_REQUIRED') ?? false;

  useEffect(() => {
    return addWebSocketListener<BatchProgressPayload>('BATCH_PROGRESS', (data) => {
      setBatchProgress((current) => current && current.batchId !== data.batchId ? current : data);
      if (data.completed > 0 || data.status === 'COMPLETED' || data.status === 'CANCELLED') {
        qc.invalidateQueries({ queryKey: ['account-pool'] });
      }
    });
  }, [qc]);

  useEffect(() => {
    if (loginBatchJob?.state === 'done') {
      qc.invalidateQueries({ queryKey: ['account-pool'] });
    }
  }, [loginBatchJob?.state, qc]);

  const revealPasswordMutation = useMutation({
    mutationFn: (account: PoolItem) =>
      api.get<{ email: string; password: string; expiresInSeconds: number }>(`/accounts/${account.id}/password`)
        .then((r) => ({ accountId: account.id, email: r.data.email, password: r.data.password, expiresInSeconds: r.data.expiresInSeconds })),
    onSuccess: (data) => {
      setRevealed({ accountId: data.accountId, email: data.email, password: data.password });
      window.setTimeout(() => {
        setRevealed((current) => current?.accountId === data.accountId ? null : current);
      }, data.expiresInSeconds * 1000);
    },
  });

  const copyText = (text: string) => {
    void navigator.clipboard?.writeText(text).catch(() => undefined);
  };

  const openAllStale = () => {
    for (const acc of staleAccounts) {
      window.open(acc.loginUrl, '_blank', 'noopener,noreferrer');
    }
  };

  return (
    <DashboardShell
      title="Account pool"
      description="Operator-managed VFS account pool. The extension keeps each account's session warm so the booking worker can dispatch bookings to your Chrome."
    >
      <div className="grid grid-cols-2 gap-3 md:grid-cols-7">
        <Stat label="Total" value={summary.total} />
        <Stat label="Pending" value={summary.pending} tone="warn" icon={<Clock className="h-4 w-4" />} />
        <Stat label="Active" value={summary.active} tone="ok" />
        <Stat label="Cookies fresh" value={summary.fresh} tone="ok" icon={<CheckCircle2 className="h-4 w-4" />} />
        <Stat label="Stale" value={summary.stale} tone="warn" icon={<AlertTriangle className="h-4 w-4" />} />
        <Stat label="Cooldown" value={summary.cooldown} icon={<Snowflake className="h-4 w-4" />} />
        <Stat label="Blocked" value={summary.blocked} tone="bad" icon={<ShieldOff className="h-4 w-4" />} />
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="btn-primary h-10 gap-2"
          onClick={() => { setBatchMsg(null); setBatchOpen(true); }}
        >
          <Plus className="h-4 w-4" />
          Create accounts
        </button>
        <button
          type="button"
          className="btn-secondary h-10 gap-2"
          onClick={() => { setAutoCreateMsg(null); autoCreateMutation.mutate(); }}
          disabled={autoCreateMutation.isPending}
        >
          {autoCreateMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          {autoCreateMutation.isPending ? 'Auto-creating...' : 'Auto-create one'}
        </button>
        <button
          type="button"
          className="btn-secondary h-10 gap-2"
          onClick={() => { setManualMsg(null); setManualOpen((v) => !v); }}
        >
          <Plus className="h-4 w-4" />
          Add existing account
        </button>
        <button
          type="button"
          className="btn-secondary h-10 gap-2"
          onClick={() => {
            setLoginBatchOpen(true);
            setLoginBatchJobId(null);
          }}
          disabled={staleLoginAccounts.length === 0}
        >
          <RefreshCw className="h-4 w-4" />
          Login All Stale ({staleLoginAccounts.length})
        </button>
        <button
          type="button"
          className="btn-secondary h-10 gap-2"
          onClick={openAllStale}
          disabled={staleAccounts.length === 0}
        >
          <ExternalLink className="h-4 w-4" />
          Open {staleAccounts.length} stale login tab{staleAccounts.length === 1 ? '' : 's'}
        </button>
        <button
          type="button"
          className="btn-secondary h-10 gap-2"
          title="Run ONE CheckIsSlotAvailable poll right now (uses the booking codes captured from the logged-in tab). Rate-limited — use sparingly."
          onClick={() => checkSlotsMutation.mutate()}
          disabled={checkSlotsMutation.isPending}
        >
          {checkSlotsMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Check slots now
        </button>
        {checkSlotsMsg && (
          <span className={`text-sm ${checkSlotsMsg.startsWith('Failed') || checkSlotsMsg.startsWith('No') ? 'text-red-500' : 'text-green-500'}`}>{checkSlotsMsg}</span>
        )}
        {autoCreateMsg && (
          <span className={`text-sm ${autoCreateMsg.startsWith('Failed') ? 'text-red-500' : 'text-green-500'}`}>{autoCreateMsg}</span>
        )}
        {batchMsg && (
          <span className={`text-sm ${batchMsg.startsWith('Failed') ? 'text-red-500' : 'text-green-500'}`}>{batchMsg}</span>
        )}
        {manualMsg && (
          <span className={`text-sm ${manualMsg.startsWith('Failed') ? 'text-red-500' : 'text-green-500'}`}>{manualMsg}</span>
        )}
        {retryMsg && (
          <span className={`text-sm ${retryMsg.startsWith('Failed') ? 'text-red-500' : 'text-green-500'}`}>{retryMsg}</span>
        )}
        {autoLoginMsg && (
          <span className={`text-sm ${autoLoginMsg.startsWith('Failed') ? 'text-red-500' : 'text-green-500'}`}>{autoLoginMsg}</span>
        )}
      </div>
      {batchProgress && (
        <div className="card mt-4 bg-card/70 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Batch auto-create</p>
              <h3 className="mt-1 text-lg font-black">
                {batchProgress.completed}/{batchProgress.total} complete
              </h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {batchProgress.succeeded} succeeded, {batchProgress.failed} failed
                {batchProgress.status === 'RUNNING' ? `, next spacing ${batchProgress.nextSpacingSeconds}s` : ''}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <BatchStatusBadge status={batchProgress.status} />
              {(batchProgress.status === 'QUEUED' || batchProgress.status === 'RUNNING') && (
                <button
                  type="button"
                  className="btn-danger h-9 gap-2"
                  onClick={() => cancelBatchMutation.mutate(batchProgress.batchId)}
                  disabled={cancelBatchMutation.isPending}
                >
                  {cancelBatchMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
                  Cancel
                </button>
              )}
            </div>
          </div>
          <div className="mt-4 h-2 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full bg-primary transition-all"
              style={{ width: `${batchProgress.total ? (batchProgress.completed / batchProgress.total) * 100 : 0}%` }}
            />
          </div>
          {batchProgress.lastResult && (
            <p className={`mt-3 text-sm ${batchProgress.lastResult.ok ? 'text-green-500' : 'text-red-500'}`}>
              #{batchProgress.lastResult.index}: {batchProgress.lastResult.ok ? `Created ${batchProgress.lastResult.email}` : `Failed: ${batchProgress.lastResult.reason ?? 'unknown'}`}
            </p>
          )}
        </div>
      )}
      {manualOpen && (
        <div className="card mt-4 p-4">
          <h3 className="mb-3 font-semibold">Add existing VFS account</h3>
          <p className="mb-3 text-xs text-muted-foreground">
            Paste credentials for a VFS account you've already activated. Password is encrypted before storage.
          </p>
          <div className="grid gap-3 md:grid-cols-3">
            <input
              type="email"
              placeholder="email (e.g. vfs-abc@mailsac.com)"
              value={mEmail}
              onChange={(e) => setMEmail(e.target.value)}
              className="input h-10"
              autoComplete="off"
            />
            <input
              type="text"
              placeholder="password"
              value={mPassword}
              onChange={(e) => setMPassword(e.target.value)}
              className="input h-10"
              autoComplete="off"
            />
            <input
              type="text"
              placeholder="phone (optional, e.g. +998936191865)"
              value={mPhone}
              onChange={(e) => setMPhone(e.target.value)}
              className="input h-10"
              autoComplete="off"
            />
          </div>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              className="btn-primary h-9"
              onClick={() => { setManualMsg(null); manualAddMutation.mutate(); }}
              disabled={!mEmail.trim() || !mPassword || manualAddMutation.isPending}
            >
              {manualAddMutation.isPending ? 'Saving…' : 'Save account'}
            </button>
            <button
              type="button"
              className="btn-secondary h-9"
              onClick={() => { setManualOpen(false); setManualMsg(null); }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {batchOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded-lg border border-border bg-card p-5 shadow-xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-base font-bold">Create VFS accounts</h3>
                <p className="mt-1 text-xs text-muted-foreground">Queued sequentially. Default spacing is 300 seconds.</p>
              </div>
              <button type="button" className="btn-secondary h-8 w-8 p-0" onClick={() => setBatchOpen(false)} aria-label="Close">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="mt-4 grid gap-3">
              <label className="text-xs font-bold text-muted-foreground">
                Count
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={batchCount}
                  onChange={(e) => setBatchCount(Math.max(1, Math.min(100, Number(e.target.value) || 1)))}
                  className="input mt-1 h-10 w-full"
                />
              </label>
              <label className="text-xs font-bold text-muted-foreground">
                Spacing seconds
                <input
                  type="number"
                  min={0}
                  max={1800}
                  step={30}
                  value={batchSpacingSeconds}
                  onChange={(e) => setBatchSpacingSeconds(Math.max(0, Math.min(1800, Number(e.target.value) || 0)))}
                  className="input mt-1 h-10 w-full"
                />
              </label>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" className="btn-secondary h-9" onClick={() => setBatchOpen(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn-primary h-9 gap-2"
                onClick={() => batchCreateMutation.mutate()}
                disabled={batchCreateMutation.isPending}
              >
                {batchCreateMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                Queue batch
              </button>
            </div>
          </div>
        </div>
      )}

      {loginBatchOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="max-h-[86vh] w-full max-w-2xl overflow-auto rounded-lg border border-border bg-card p-5 shadow-xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-base font-bold">Login all stale accounts</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  {loginBatchJobId ? `${loginBatchDone} of ${loginBatchJob?.items.length ?? staleLoginAccounts.length} done` : `Estimated time: ${staleLoginAccounts.length * 60}s`}
                </p>
              </div>
              <button
                type="button"
                className="btn-secondary h-8 w-8 p-0"
                onClick={() => {
                  setLoginBatchOpen(false);
                  setLoginBatchJobId(null);
                }}
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {!loginBatchJobId ? (
              <>
                <div className="mt-4 rounded-lg border">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/40 text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2 text-left text-[10px] font-black uppercase tracking-widest">Email</th>
                        <th className="px-3 py-2 text-left text-[10px] font-black uppercase tracking-widest">Last login</th>
                      </tr>
                    </thead>
                    <tbody>
                      {staleLoginAccounts.map((account) => (
                        <tr key={account.id} className="border-t">
                          <td className="px-3 py-2 font-semibold">{account.email}</td>
                          <td className="px-3 py-2 text-muted-foreground">{formatLoginAge(account.cookiesUpdatedAt ?? account.lastWarmedAt)}</td>
                        </tr>
                      ))}
                      {staleLoginAccounts.length === 0 && (
                        <tr>
                          <td colSpan={2} className="px-3 py-6 text-center text-muted-foreground">No stale active accounts.</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
                <div className="mt-5 flex justify-end gap-2">
                  <button type="button" className="btn-secondary h-9" onClick={() => setLoginBatchOpen(false)}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="btn-primary h-9 gap-2"
                    disabled={staleLoginAccounts.length === 0 || startLoginBatchMutation.isPending}
                    onClick={() => startLoginBatchMutation.mutate(staleLoginAccounts.map((account) => account.id))}
                  >
                    {startLoginBatchMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                    Start batch
                  </button>
                </div>
              </>
            ) : (
              <>
                {loginBatchNeedsWarmTab && (
                  <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm font-semibold text-amber-500">
                    Open bot Chrome and navigate to any VFS page before running the batch. The bot reuses your warm tab to avoid Datadome.
                  </div>
                )}
                <div className="mt-4 rounded-lg border">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/40 text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2 text-left text-[10px] font-black uppercase tracking-widest">Email</th>
                        <th className="px-3 py-2 text-left text-[10px] font-black uppercase tracking-widest">State</th>
                        <th className="px-3 py-2 text-left text-[10px] font-black uppercase tracking-widest">Error</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(loginBatchJob?.items ?? []).map((item) => {
                        const isActivation = item.error?.startsWith('ACTIVATION_FAILED:');
                        const errorText = isActivation
                          ? `Activation: ${item.error!.slice('ACTIVATION_FAILED:'.length)}`
                          : item.error;
                        return (
                          <tr key={item.accountId} className="border-t">
                            <td className="px-3 py-2 font-semibold">{item.email}</td>
                            <td className="px-3 py-2"><LoginBatchStatePill state={item.state} /></td>
                            <td className={`px-3 py-2 text-xs ${isActivation ? 'text-amber-500' : 'text-red-500'}`}>{errorText}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {loginBatchJob?.state === 'done' && (
                  <p className="mt-3 text-sm font-semibold text-muted-foreground">
                    {loginBatchSuccess} succeeded, {loginBatchFailed} failed.
                  </p>
                )}
                <div className="mt-5 flex justify-end gap-2">
                  {loginBatchJob?.state === 'running' ? (
                    <button
                      type="button"
                      className="btn-danger h-9"
                      disabled={cancelLoginBatchMutation.isPending}
                      onClick={() => loginBatchJobId && cancelLoginBatchMutation.mutate(loginBatchJobId)}
                    >
                      Cancel job
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn-primary h-9"
                      onClick={() => {
                        setLoginBatchOpen(false);
                        setLoginBatchJobId(null);
                      }}
                    >
                      Close
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {revealed && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded-lg border border-border bg-card p-5 shadow-xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-base font-bold">VFS password</h3>
                <p className="mt-1 text-xs text-muted-foreground">Auto-hides after 30 seconds.</p>
              </div>
              <button type="button" className="btn-secondary h-8 w-8 p-0" onClick={() => setRevealed(null)} aria-label="Close">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="mt-4 space-y-3">
              <div>
                <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Email</label>
                <div className="mt-1 flex gap-2">
                  <input className="input h-10 flex-1" readOnly value={revealed.email} />
                  <button type="button" className="btn-secondary h-10 w-10 p-0" onClick={() => copyText(revealed.email)} aria-label="Copy email">
                    <Copy className="h-4 w-4" />
                  </button>
                </div>
              </div>
              <div>
                <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Password</label>
                <div className="mt-1 flex gap-2">
                  <input className="input h-10 flex-1 font-mono" readOnly value={revealed.password} />
                  <button type="button" className="btn-secondary h-10 w-10 p-0" onClick={() => copyText(revealed.password)} aria-label="Copy password">
                    <Copy className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="card mt-6 overflow-hidden bg-card/70 p-0">
        <table className="w-full text-sm">
          <thead className="bg-zinc-950 text-zinc-400">
            <tr>
              <th className="px-4 py-3 text-left text-[10px] font-black uppercase tracking-widest">Email</th>
              <th className="px-4 py-3 text-left text-[10px] font-black uppercase tracking-widest">Status</th>
              <th className="px-4 py-3 text-left text-[10px] font-black uppercase tracking-widest">Role</th>
              <th className="px-4 py-3 text-left text-[10px] font-black uppercase tracking-widest">Cookies</th>
              <th className="px-4 py-3 text-left text-[10px] font-black uppercase tracking-widest">Last warmed</th>
              <th className="px-4 py-3 text-left text-[10px] font-black uppercase tracking-widest">Profiles</th>
              <th className="px-4 py-3 text-right text-[10px] font-black uppercase tracking-widest">Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr>
                <td className="px-4 py-8 text-center text-muted-foreground" colSpan={7}>
                  No VFS accounts in the pool yet. Add one via POST /api/accounts or use the Account Setup flow.
                </td>
              </tr>
            )}
            {items.map((a) => (
              <tr key={a.id} className="border-t border-border/60">
                <td className="px-4 py-3 font-bold">{a.email}</td>
                <td className="px-4 py-3">
                  <StatusBadge status={a.status} />
                </td>
                <td className="px-4 py-3">
                  <div className="relative inline-block">
                    <button
                      type="button"
                      onClick={() => setRoleMenuAccountId((current) => current === a.id ? null : a.id)}
                    >
                      <RoleChip role={a.pollingRole ?? 'BOTH'} />
                    </button>
                    {roleMenuAccountId === a.id && (
                      <div className="absolute left-0 z-20 mt-2 w-32 rounded-lg border border-border bg-card p-1 shadow-xl">
                        {(['WATCHER', 'BOOKER', 'BOTH'] as const).map((role) => (
                          <button
                            key={role}
                            type="button"
                            className="block w-full rounded-md px-2 py-1.5 text-left text-xs font-bold hover:bg-muted"
                            onClick={() => updateRoleMutation.mutate({ accountId: a.id, role })}
                          >
                            {role}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </td>
                <td className="px-4 py-3">
                  {a.status === 'PENDING' ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2.5 py-1 text-xs font-bold text-amber-500">
                      <Clock className="h-3.5 w-3.5" /> pending
                    </span>
                  ) : a.cookieFresh ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-green-500/15 px-2.5 py-1 text-xs font-bold text-green-500">
                      <CheckCircle2 className="h-3.5 w-3.5" /> fresh
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2.5 py-1 text-xs font-bold text-amber-500">
                      <Clock className="h-3.5 w-3.5" /> stale
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-muted-foreground">
                  {a.lastWarmedAt ? new Date(a.lastWarmedAt).toLocaleString() : 'never'}
                </td>
                <td className="px-4 py-3">{a.profileCount}</td>
                <td className="px-4 py-3 text-right">
                  <div className="flex justify-end gap-2">
                    {a.status === 'PENDING' && (
                      <button
                        type="button"
                        className="btn-primary h-8 gap-1.5 text-xs"
                        onClick={() => { setRetryMsg(null); retryActivationMutation.mutate(a.id); }}
                        disabled={retryActivationMutation.isPending && retryActivationMutation.variables === a.id}
                      >
                        {retryActivationMutation.isPending && retryActivationMutation.variables === a.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <RefreshCw className="h-3.5 w-3.5" />
                        )}
                        Retry activation
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn-secondary h-8 gap-1.5 text-xs"
                      title="Opens a CLEAN VFS login tab bound to this account (no bot driving it, so the captcha renders). Log in manually here — booking then arms automatically for this account."
                      onClick={() => { setAutoLoginMsg(null); copyText(a.email); openTabMutation.mutate(a.id); }}
                      disabled={openTabMutation.isPending && openTabMutation.variables === a.id}
                    >
                      {openTabMutation.isPending && openTabMutation.variables === a.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <ExternalLink className="h-3.5 w-3.5" />
                      )}
                      Open login (bind)
                    </button>
                    <button
                      type="button"
                      className="btn-secondary h-8 gap-1.5 text-xs"
                      onClick={() => { setAutoLoginMsg(null); autoLoginMutation.mutate({ accountId: a.id }); }}
                      disabled={autoLoginMutation.isPending && autoLoginMutation.variables?.accountId === a.id}
                    >
                      {autoLoginMutation.isPending && autoLoginMutation.variables?.accountId === a.id && !autoLoginMutation.variables?.fillOnly ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <RefreshCw className="h-3.5 w-3.5" />
                      )}
                      Auto-login
                    </button>
                    <button
                      type="button"
                      className="btn-secondary h-8 gap-1.5 text-xs"
                      onClick={() => revealPasswordMutation.mutate(a)}
                      disabled={revealPasswordMutation.isPending && revealPasswordMutation.variables?.id === a.id}
                    >
                      {revealPasswordMutation.isPending && revealPasswordMutation.variables?.id === a.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Eye className="h-3.5 w-3.5" />
                      )}
                      Reveal password
                    </button>
                    {a.status === 'ACTIVE' && (
                      <button
                        type="button"
                        className="btn-secondary h-8 gap-1.5 text-xs"
                        onClick={() => cooldownMutation.mutate({ id: a.id, minutes: 60 })}
                      >
                        <Snowflake className="h-3.5 w-3.5" />
                        Cooldown 1h
                      </button>
                    )}
                    {a.status !== 'BLOCKED' && (
                      <button
                        type="button"
                        className="btn-danger h-8 gap-1.5 text-xs"
                        onClick={() => blockMutation.mutate(a.id)}
                      >
                        <ShieldOff className="h-3.5 w-3.5" />
                        Block
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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

function StatusBadge({ status }: { status: PoolItem['status'] }) {
  const map = {
    PENDING: 'bg-amber-500/15 text-amber-500',
    ACTIVE: 'bg-green-500/15 text-green-500',
    BLOCKED: 'bg-red-500/15 text-red-500',
    COOLDOWN: 'bg-blue-500/15 text-blue-500',
  } as const;
  return <span className={cn('inline-flex items-center rounded-full px-2.5 py-1 text-xs font-bold', map[status])}>{status}</span>;
}

function RoleChip({ role }: { role: NonNullable<PoolItem['pollingRole']> }) {
  const map = {
    WATCHER: 'bg-blue-500/15 text-blue-500',
    BOOKER: 'bg-purple-500/15 text-purple-500',
    BOTH: 'bg-green-500/15 text-green-500',
  } as const;
  return <span className={cn('inline-flex items-center rounded-full px-2.5 py-1 text-xs font-bold', map[role])}>{role}</span>;
}

function BatchStatusBadge({ status }: { status: BatchProgressPayload['status'] }) {
  const map = {
    QUEUED: 'bg-amber-500/15 text-amber-500',
    RUNNING: 'bg-blue-500/15 text-blue-500',
    COMPLETED: 'bg-green-500/15 text-green-500',
    CANCELLED: 'bg-red-500/15 text-red-500',
  } as const;
  return <span className={cn('inline-flex items-center rounded-full px-2.5 py-1 text-xs font-bold', map[status])}>{status}</span>;
}

function LoginBatchStatePill({ state }: { state: LoginBatchJob['items'][number]['state'] }) {
  const map = {
    pending: 'bg-zinc-500/15 text-zinc-400',
    running: 'bg-amber-500/15 text-amber-500 animate-pulse',
    success: 'bg-green-500/15 text-green-500',
    failed: 'bg-red-500/15 text-red-500',
  } as const;
  return <span className={cn('inline-flex items-center rounded-full px-2.5 py-1 text-xs font-bold', map[state])}>{state}</span>;
}

function formatLoginAge(value?: string | null) {
  if (!value) return 'never';
  const hours = Math.floor((Date.now() - new Date(value).getTime()) / (60 * 60 * 1000));
  if (hours < 1) return 'under 1h ago';
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
