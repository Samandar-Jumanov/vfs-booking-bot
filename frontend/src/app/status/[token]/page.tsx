'use client';

import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, CalendarClock, CheckCircle2, Clock3, Loader2, RefreshCw, Search } from 'lucide-react';

type PublicStatus = 'PENDING_PAYMENT' | 'QUEUED' | 'SLOT_DETECTED' | 'CONFIRMED' | 'FAILED';

type StatusResponse = {
  status: PublicStatus;
  destination: string | null;
  visaType: string | null;
  slotDate: string | null;
  slotTime: string | null;
  lastUpdatedAt: string;
};

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';
const REFRESH_MS = 30_000;

const steps: Array<{ key: PublicStatus; label: string }> = [
  { key: 'PENDING_PAYMENT', label: 'Payment' },
  { key: 'QUEUED', label: 'Queued' },
  { key: 'SLOT_DETECTED', label: 'Slot detected' },
  { key: 'CONFIRMED', label: 'Confirmed' },
  { key: 'FAILED', label: 'Failed' },
];

const statusCopy: Record<PublicStatus, { title: string; detail: string; icon: typeof Clock3; tone: string }> = {
  PENDING_PAYMENT: {
    title: 'Pending payment',
    detail: 'Your request was received. Booking starts after an operator confirms payment.',
    icon: Clock3,
    tone: 'text-slate-700 bg-slate-50 border-slate-200 dark:text-slate-200 dark:bg-slate-950/40 dark:border-slate-800',
  },
  QUEUED: {
    title: 'Queued',
    detail: 'Your request is active and waiting for an available appointment slot.',
    icon: Clock3,
    tone: 'text-blue-600 bg-blue-50 border-blue-200 dark:text-blue-300 dark:bg-blue-950/40 dark:border-blue-900',
  },
  SLOT_DETECTED: {
    title: 'Slot detected',
    detail: 'An appointment slot has been found and the booking flow is in progress.',
    icon: Search,
    tone: 'text-amber-600 bg-amber-50 border-amber-200 dark:text-amber-300 dark:bg-amber-950/40 dark:border-amber-900',
  },
  CONFIRMED: {
    title: 'Confirmed',
    detail: 'Your appointment booking has been confirmed.',
    icon: CheckCircle2,
    tone: 'text-emerald-600 bg-emerald-50 border-emerald-200 dark:text-emerald-300 dark:bg-emerald-950/40 dark:border-emerald-900',
  },
  FAILED: {
    title: 'Failed',
    detail: 'The latest booking attempt could not be completed. Support may retry or contact you.',
    icon: AlertCircle,
    tone: 'text-red-600 bg-red-50 border-red-200 dark:text-red-300 dark:bg-red-950/40 dark:border-red-900',
  },
};

function formatDateTime(value: string | null) {
  if (!value) return null;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function currentStep(status: PublicStatus) {
  if (status === 'FAILED') return steps.length - 1;
  return steps.findIndex((step) => step.key === status);
}

export default function CustomerStatusPage({ params }: { params: { token: string } }) {
  const [data, setData] = useState<StatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  async function loadStatus(isRefresh = false) {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);

    try {
      const response = await fetch(`${API_BASE}/api/status/${encodeURIComponent(params.token)}`, {
        cache: 'no-store',
      });
      if (!response.ok) throw new Error(response.status === 404 ? 'Status page not found.' : 'Unable to load status.');
      setData(await response.json());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load status.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    void loadStatus();
    const interval = window.setInterval(() => void loadStatus(true), REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [params.token]);

  const activeStep = useMemo(() => (data ? currentStep(data.status) : 0), [data]);
  const status = data ? statusCopy[data.status] : statusCopy.QUEUED;
  const StatusIcon = loading ? Loader2 : status.icon;

  return (
    <main className="min-h-screen bg-background px-4 py-8 text-foreground sm:px-6 lg:px-8">
      <section className="mx-auto flex min-h-[calc(100vh-4rem)] w-full max-w-3xl items-center">
        <div className="w-full rounded-lg border bg-card p-5 shadow-sm sm:p-8">
          <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-sm font-medium text-muted-foreground">Appointment status</p>
              <h1 className="mt-2 text-2xl font-semibold tracking-normal sm:text-3xl">Booking progress</h1>
            </div>
            <button
              type="button"
              onClick={() => void loadStatus(true)}
              className="btn-secondary h-10 gap-2 self-start"
              disabled={refreshing}
              aria-label="Refresh status"
            >
              <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>

          <div className={`mt-8 rounded-lg border p-5 ${status.tone}`}>
            <div className="flex items-start gap-4">
              <StatusIcon className={`mt-0.5 h-6 w-6 shrink-0 ${loading ? 'animate-spin' : ''}`} />
              <div>
                <p className="text-lg font-semibold">{loading ? 'Loading status' : status.title}</p>
                <p className="mt-1 text-sm opacity-90">{error ?? status.detail}</p>
              </div>
            </div>
          </div>

          {data && !error ? (
            <>
              <div className="mt-8 grid gap-3 sm:grid-cols-2">
                <div className="rounded-lg border bg-background p-4">
                  <p className="text-xs font-medium uppercase text-muted-foreground">Destination</p>
                  <p className="mt-1 text-sm font-semibold">{data.destination ?? 'Pending assignment'}</p>
                </div>
                <div className="rounded-lg border bg-background p-4">
                  <p className="text-xs font-medium uppercase text-muted-foreground">Visa type</p>
                  <p className="mt-1 text-sm font-semibold">{data.visaType ?? 'Pending assignment'}</p>
                </div>
                <div className="rounded-lg border bg-background p-4">
                  <p className="text-xs font-medium uppercase text-muted-foreground">Detected slot</p>
                  <p className="mt-1 flex items-center gap-2 text-sm font-semibold">
                    <CalendarClock className="h-4 w-4 text-muted-foreground" />
                    {formatDateTime(data.slotDate) ?? 'Not detected yet'}
                    {data.slotTime ? `, ${data.slotTime}` : ''}
                  </p>
                </div>
                <div className="rounded-lg border bg-background p-4">
                  <p className="text-xs font-medium uppercase text-muted-foreground">Last updated</p>
                  <p className="mt-1 text-sm font-semibold">{formatDateTime(data.lastUpdatedAt)}</p>
                </div>
              </div>

              <div className="mt-8">
                <div className="grid grid-cols-5 gap-2">
                  {steps.map((step, index) => {
                    const isActive = index <= activeStep;
                    const isFailed = data.status === 'FAILED' && step.key === 'FAILED';
                    return (
                      <div key={step.key} className="min-w-0">
                        <div
                          className={`h-2 rounded-full ${
                            isFailed ? 'bg-red-500' : isActive ? 'bg-primary' : 'bg-muted'
                          }`}
                        />
                        <p className="mt-2 truncate text-xs font-medium text-muted-foreground">{step.label}</p>
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          ) : null}

          <p className="mt-8 text-sm text-muted-foreground">This page refreshes automatically every 30 seconds.</p>
        </div>
      </section>
    </main>
  );
}
