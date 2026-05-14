'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Cookie,
  Download,
  ExternalLink,
  Pause,
  Play,
  RefreshCcw,
  StopCircle,
  Terminal,
  Trash2,
  X,
  Zap,
} from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { DashboardShell } from '@/components/layout/DashboardShell';
import { useMonitorStore, type LogEntry, type MonitorStatus } from '@/store/monitorStore';
import type { DestinationCode } from '@/types/ws-events';

interface InjectedCookieStatus {
  destination: string;
  setAt: string;
  expiresAt: string;
  cookieCount: number;
  valid: boolean;
}

interface MonitorCardModel extends MonitorStatus {
  cookieStatus?: InjectedCookieStatus;
}

type WizardStep = 'explain' | 'open' | 'paste' | 'inject';
type InjectState = 'idle' | 'saving' | 'success' | 'error';

const DESTINATION_META: Record<string, { name: string; flag: string; loginUrl: string }> = {
  lva: { name: 'Latvia', flag: '🇱🇻', loginUrl: 'https://visa.vfsglobal.com/uzb/en/lva/login' },
  latvia: { name: 'Latvia', flag: '🇱🇻', loginUrl: 'https://visa.vfsglobal.com/uzb/en/lva/login' },
  tjk: { name: 'Tajikistan', flag: '🇹🇯', loginUrl: 'https://visa.vfsglobal.com/uzb/en/tjk/login' },
  tajikistan: { name: 'Tajikistan', flag: '🇹🇯', loginUrl: 'https://visa.vfsglobal.com/uzb/en/tjk/login' },
};

function destinationCode(destination: DestinationCode | undefined) {
  const raw = String(destination ?? 'lva').toLowerCase();
  if (raw === 'latvia') return 'lva';
  if (raw === 'tajikistan') return 'tjk';
  return raw;
}

function destinationMeta(destination: DestinationCode | undefined) {
  const code = destinationCode(destination);
  return DESTINATION_META[code] ?? { name: code.toUpperCase(), flag: '🌐', loginUrl: `https://visa.vfsglobal.com/uzb/en/${code}/login` };
}

function relativeTime(value?: string | null, now = Date.now()) {
  if (!value) return 'never';
  const seconds = Math.max(0, Math.floor((now - new Date(value).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

function duration(value?: string, now = Date.now()) {
  if (!value) return '--:--:--';
  const total = Math.max(0, Math.floor((new Date(value).getTime() - now) / 1000));
  const hours = Math.floor(total / 3600).toString().padStart(2, '0');
  const minutes = Math.floor((total % 3600) / 60).toString().padStart(2, '0');
  const seconds = Math.floor(total % 60).toString().padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

function minutesUntil(value?: string, now = Date.now()) {
  if (!value) return Number.POSITIVE_INFINITY;
  return Math.floor((new Date(value).getTime() - now) / 60_000);
}

function expiryTone(expiresAt?: string, now = Date.now()) {
  const minutes = minutesUntil(expiresAt, now);
  if (minutes < 30) return 'red';
  if (minutes < 120) return 'amber';
  return 'green';
}

function validateCookieJson(text: string) {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) return 'Cookie JSON must be an array.';
    const hasLtSn = parsed.some((item) => (
      item !== null
      && typeof item === 'object'
      && 'name' in item
      && (item as { name?: unknown }).name === 'lt_sn'
    ));
    return hasLtSn ? null : 'Cookie array must include a cookie named lt_sn.';
  } catch {
    return 'Paste valid JSON from EditThisCookie.';
  }
}

function messageFor(entry: LogEntry) {
  return entry.message || entry.eventType;
}

function eventTone(eventType: string) {
  if (eventType === 'SLOT_DETECTED') return 'bg-yellow-500/15 border-yellow-500/30 text-yellow-100';
  if (eventType === 'BOOKING_SUCCESS') return 'bg-green-500/15 border-green-500/30 text-green-100';
  if (eventType === 'BOOKING_FAILED' || eventType === 'MONITOR_CRASHED' || eventType === 'MONITOR_DEAD') return 'bg-red-500/15 border-red-500/30 text-red-100';
  if (eventType === 'CAPTCHA_MANUAL_NEEDED') return 'bg-orange-500/15 border-orange-500/30 text-orange-100';
  if (eventType === 'COOKIE_EXPIRING_SOON') return 'bg-amber-500/15 border-amber-500/30 text-amber-100';
  return 'bg-white/[0.03] border-white/10 text-zinc-200';
}

function useTicker(ms: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [ms]);
  return now;
}

export default function DashboardPage() {
  const queryClient = useQueryClient();
  const { liveLogFeed, monitors, setMonitors, clearLogs } = useMonitorStore();
  const now = useTicker(1000);
  const logContainerRef = useRef<HTMLDivElement>(null);
  const [wizardDestination, setWizardDestination] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [slotToast, setSlotToast] = useState<{ destination?: string; date?: string; nonce: number } | null>(null);
  const [titleFlashActive, setTitleFlashActive] = useState(false);

  const { data: status = [] } = useQuery<MonitorStatus[]>({
    queryKey: ['monitor-status'],
    queryFn: () => api.get<MonitorStatus[]>('/monitor/status').then((response) => {
      setMonitors(response.data);
      return response.data;
    }),
    refetchInterval: 5000,
  });

  const { data: injectedCookies = [], refetch: refetchCookies } = useQuery<InjectedCookieStatus[]>({
    queryKey: ['injected-cookies'],
    queryFn: () => api.get<InjectedCookieStatus[]>('/monitor/injected-cookies').then((response) => response.data),
    refetchInterval: 5000,
  });

  const stopMutation = useMutation({
    mutationFn: async (monitor: MonitorCardModel) => {
      try {
        await api.post('/monitor/stop', { destination: destinationCode(monitor.destination) });
      } catch {
        await api.post(`/monitor/stop/${monitor.id}`);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['monitor-status'] });
    },
  });

  const monitorCards = useMemo<MonitorCardModel[]>(() => {
    const source = status.length ? status : monitors;
    return source.map((monitor) => {
      const code = destinationCode(monitor.destination);
      return {
        ...monitor,
        cookieStatus: injectedCookies.find((item) => destinationCode(item.destination) === code),
      };
    });
  }, [injectedCookies, monitors, status]);

  const expiringMonitor = monitorCards.find((monitor) => minutesUntil(monitor.cookieStatus?.expiresAt, now) < 30);
  const activeCount = monitorCards.filter((monitor) => monitor.isRunning).length;
  const slotCount = monitorCards.reduce((total, monitor) => total + monitor.slotDetectedCount, 0);
  const events = liveLogFeed.slice(0, 100);

  useEffect(() => {
    if (!paused) logContainerRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  }, [events.length, paused]);

  useEffect(() => {
    const latestSlot = liveLogFeed.find((entry) => entry.eventType === 'SLOT_DETECTED');
    if (!latestSlot) return;
    const timestamp = new Date(latestSlot.timestamp).getTime();
    if (Date.now() - timestamp > 1500) return;
    setSlotToast({
      destination: latestSlot.destination,
      date: latestSlot.message.match(/\d{4}-\d{2}-\d{2}/)?.[0],
      nonce: timestamp,
    });
    setTitleFlashActive(true);
  }, [liveLogFeed]);

  useEffect(() => {
    if (!slotToast) return;
    const close = window.setTimeout(() => setSlotToast(null), 4000);
    return () => window.clearTimeout(close);
  }, [slotToast]);

  useEffect(() => {
    if (!titleFlashActive) return;
    const originalTitle = document.title || 'VFS Bot';
    let flash = false;
    const titleId = window.setInterval(() => {
      flash = !flash;
      document.title = flash ? '🎯 SLOT! - VFS Bot' : 'VFS Bot';
    }, 1000);
    const stopFlashing = () => {
      window.clearInterval(titleId);
      document.title = originalTitle;
      setTitleFlashActive(false);
    };
    window.addEventListener('focus', stopFlashing, { once: true });
    return () => {
      window.clearInterval(titleId);
      window.removeEventListener('focus', stopFlashing);
    };
  }, [titleFlashActive]);

  useEffect(() => {
    if (!slotToast || window.localStorage.getItem('vfs.slotSoundEnabled') !== 'true') return;
    const audio = new Audio('/sounds/slot.mp3');
    audio.play().catch(() => {
      // TODO: replace Web Audio fallback with a checked-in 0.5s slot.mp3 asset.
      const audioWindow = window as typeof window & { webkitAudioContext?: typeof AudioContext };
      const AudioContextCtor = globalThis.AudioContext || audioWindow.webkitAudioContext;
      if (!AudioContextCtor) return;
      const context = new AudioContextCtor();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.frequency.value = 880;
      gain.gain.value = 0.08;
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start();
      window.setTimeout(() => {
        oscillator.stop();
        context.close().catch(() => undefined);
      }, 500);
    });
  }, [slotToast]);

  const exportEvents = useCallback(() => {
    const blob = new Blob([JSON.stringify(events, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `events-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }, [events]);

  return (
    <DashboardShell title="Operator Dashboard" description="Run monitors, recover sessions, and watch live booking events.">
      <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
        <AnimatePresence>
          {expiringMonitor && (
            <motion.button
              type="button"
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              onClick={() => setWizardDestination(destinationCode(expiringMonitor.destination))}
              className="w-full rounded-xl border border-red-500/40 bg-red-500/15 p-4 text-left text-red-100 shadow-lg shadow-red-950/20 focus:outline-none focus:ring-2 focus:ring-red-400"
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-300" />
                  <div>
                    <p className="text-sm font-black uppercase tracking-widest">Cookie session expires soon</p>
                    <p className="text-sm text-red-100/80">
                      {destinationMeta(expiringMonitor.destination).name} has {duration(expiringMonitor.cookieStatus?.expiresAt, now)} left. Warm cookies to keep the bot running.
                    </p>
                  </div>
                </div>
                <span className="inline-flex h-10 items-center justify-center rounded-lg bg-red-400 px-4 text-sm font-black uppercase tracking-widest text-red-950">
                  Warm cookies
                </span>
              </div>
            </motion.button>
          )}
        </AnimatePresence>

        <section className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <SummaryCard label="Active monitors" value={activeCount.toString()} icon={Zap} />
          <SummaryCard label="Slots today" value={slotCount.toString()} icon={CheckCircle2} />
          <SummaryCard label="Event buffer" value={events.length.toString()} icon={Terminal} />
        </section>

        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-black uppercase tracking-widest text-foreground">Active monitors</h2>
              <p className="text-xs text-muted-foreground">Status is polled from `/api/monitor/status` every 5s; cookie expiry is joined from `/api/monitor/injected-cookies`.</p>
            </div>
          </div>

          <div className="flex gap-4 overflow-x-auto pb-2 custom-scrollbar">
            {monitorCards.map((monitor) => (
              <MonitorCard
                key={monitor.id}
                monitor={monitor}
                now={now}
                stopping={stopMutation.isPending}
                onStop={() => stopMutation.mutate(monitor)}
                onWarm={() => setWizardDestination(destinationCode(monitor.destination))}
              />
            ))}
            {!monitorCards.length && (
              <div className="card flex min-h-48 min-w-full items-center justify-center border-dashed bg-card/40 p-8 text-center sm:min-w-[420px]">
                <div>
                  <Clock className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
                  <p className="text-sm font-bold">No monitors returned by the backend.</p>
                  <p className="mt-1 text-xs text-muted-foreground">Start UZ to LVA from Setup, then return here.</p>
                </div>
              </div>
            )}
          </div>
        </section>

        <section className="card overflow-hidden bg-zinc-950 text-zinc-100 shadow-2xl">
          <div className="flex flex-col gap-4 border-b border-white/10 bg-zinc-900/70 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              <div className="rounded-lg bg-primary/15 p-2 text-primary">
                <Terminal className="h-4 w-4" />
              </div>
              <div>
                <h2 className="text-sm font-black uppercase tracking-widest">Live event log</h2>
                <p className="text-xs text-zinc-500">Last 100 WebSocket events, newest first.</p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => setPaused((value) => !value)} className="btn-secondary h-10 gap-2 bg-zinc-900 text-zinc-100 hover:bg-zinc-800">
                {paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
                {paused ? 'Resume auto-scroll' : 'Pause auto-scroll'}
              </button>
              <button type="button" onClick={clearLogs} className="btn-secondary h-10 gap-2 bg-zinc-900 text-zinc-100 hover:bg-zinc-800">
                <Trash2 className="h-4 w-4" />
                Clear
              </button>
              <button type="button" onClick={exportEvents} className="btn-secondary h-10 gap-2 bg-zinc-900 text-zinc-100 hover:bg-zinc-800">
                <Download className="h-4 w-4" />
                Export visible as JSON
              </button>
            </div>
          </div>

          <div ref={logContainerRef} className="h-[420px] overflow-y-auto p-4 custom-scrollbar">
            <div className="space-y-2">
              {events.map((entry, index) => (
                <div key={`${entry.timestamp}-${entry.eventType}-${index}`} className={cn('grid grid-cols-1 gap-2 rounded-lg border p-3 text-xs sm:grid-cols-[90px_180px_1fr_90px]', eventTone(entry.eventType))}>
                  <span className="font-mono text-zinc-400">{new Date(entry.timestamp).toLocaleTimeString([], { hour12: false })}</span>
                  <span className="font-black uppercase tracking-wider">{entry.eventType}</span>
                  <span className="text-zinc-100/90">{messageFor(entry)}</span>
                  <span className="w-fit rounded-md bg-black/20 px-2 py-1 font-mono text-[10px] uppercase text-zinc-200">
                    {entry.destination ?? 'system'}
                  </span>
                </div>
              ))}
              {!events.length && (
                <div className="flex h-64 flex-col items-center justify-center text-center text-zinc-500">
                  <Terminal className="mb-3 h-10 w-10" />
                  <p className="text-xs font-black uppercase tracking-widest">Waiting for WebSocket events</p>
                </div>
              )}
            </div>
          </div>
        </section>
      </div>

      <AnimatePresence>
        {wizardDestination && (
          <CookieWizard
            destination={wizardDestination}
            onClose={() => setWizardDestination(null)}
            onInjected={() => {
              refetchCookies();
              queryClient.invalidateQueries({ queryKey: ['monitor-status'] });
            }}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {slotToast && (
          <motion.div
            key={slotToast.nonce}
            initial={{ opacity: 0, scale: 0.92, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 20 }}
            className="fixed inset-0 z-[80] flex pointer-events-none items-center justify-center p-6"
          >
            <div className="max-w-lg rounded-2xl border border-yellow-300/40 bg-zinc-950/90 p-8 text-center text-white shadow-2xl shadow-yellow-500/20 backdrop-blur">
              <Zap className="mx-auto mb-4 h-12 w-12 fill-yellow-300 text-yellow-300" />
              <p className="text-xs font-black uppercase tracking-[0.3em] text-yellow-200">Slot detected</p>
              <h2 className="mt-2 text-3xl font-black">{destinationMeta(slotToast.destination).flag} {destinationMeta(slotToast.destination).name}</h2>
              <p className="mt-2 text-sm text-zinc-300">{slotToast.date ? `First date: ${slotToast.date}` : 'Check the event log for the first available date.'}</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </DashboardShell>
  );
}

function SummaryCard({ label, value, icon: Icon }: { label: string; value: string; icon: typeof Zap }) {
  return (
    <div className="card p-5 bg-card/60">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">{label}</p>
          <p className="mt-2 text-3xl font-black">{value}</p>
        </div>
        <div className="rounded-xl bg-primary/10 p-3 text-primary">
          <Icon className="h-5 w-5" />
        </div>
      </div>
    </div>
  );
}

function MonitorCard({ monitor, now, stopping, onStop, onWarm }: {
  monitor: MonitorCardModel;
  now: number;
  stopping: boolean;
  onStop: () => void;
  onWarm: () => void;
}) {
  const meta = destinationMeta(monitor.destination);
  const tone = expiryTone(monitor.cookieStatus?.expiresAt, now);
  const statusTone = monitor.isRunning ? 'bg-green-400' : monitor.isCoolingDown ? 'bg-amber-400' : 'bg-red-400';

  return (
    <article className={cn(
      'card min-w-[320px] max-w-[380px] flex-1 p-5 bg-card/70',
      tone === 'red' && 'border-red-500/50 shadow-red-950/20',
      tone === 'amber' && 'border-amber-500/50'
    )}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-2xl">{meta.flag}</span>
            <h3 className="text-lg font-black">{meta.name}</h3>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">UZ to {destinationCode(monitor.destination).toUpperCase()} · {monitor.visaType}</p>
        </div>
        <div className="flex items-center gap-2 rounded-full border bg-background px-3 py-1 text-[10px] font-black uppercase tracking-widest">
          <span className={cn('h-2 w-2 rounded-full', statusTone)} />
          {monitor.isRunning ? 'running' : monitor.isCoolingDown ? 'warming' : 'stopped'}
        </div>
      </div>

      <dl className="mt-5 grid grid-cols-2 gap-3 text-sm">
        <div className="rounded-lg bg-accent/40 p-3">
          <dt className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Last checked</dt>
          <dd className="mt-1 font-mono">{relativeTime(monitor.lastCheckedAt, now)}</dd>
        </div>
        <div className="rounded-lg bg-accent/40 p-3">
          <dt className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Slots today</dt>
          <dd className="mt-1">
            <span className="badge-yellow">{monitor.slotDetectedCount}</span>
          </dd>
        </div>
        <div className="col-span-2 rounded-lg bg-accent/40 p-3">
          <dt className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Cookie expiry</dt>
          <dd className={cn(
            'mt-1 font-mono text-2xl font-black',
            tone === 'green' && 'text-green-500',
            tone === 'amber' && 'text-amber-500',
            tone === 'red' && 'text-red-500'
          )}>
            {duration(monitor.cookieStatus?.expiresAt, now)}
          </dd>
        </div>
      </dl>

      <div className="mt-5 flex gap-2">
        <button type="button" onClick={onStop} disabled={stopping} className="btn-danger h-11 flex-1 gap-2">
          {stopping ? <RefreshCcw className="h-4 w-4 animate-spin" /> : <StopCircle className="h-4 w-4" />}
          Stop
        </button>
        <button type="button" onClick={onWarm} className="btn-secondary h-11 flex-1 gap-2">
          <Cookie className="h-4 w-4" />
          Warm cookies
        </button>
      </div>
    </article>
  );
}

function CookieWizard({ destination, onClose, onInjected }: { destination: string; onClose: () => void; onInjected: () => void }) {
  const [step, setStep] = useState<WizardStep>('explain');
  const [cookieText, setCookieText] = useState('');
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [injectState, setInjectState] = useState<InjectState>('idle');
  const [serverError, setServerError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const meta = destinationMeta(destination);

  useEffect(() => {
    const panel = panelRef.current;
    panel?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key !== 'Tab' || !panel) return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>('button, textarea, a, [tabindex]:not([tabindex="-1"])')).filter((item) => !item.hasAttribute('disabled'));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const advance = () => {
    if (step === 'explain') setStep('open');
    if (step === 'open') setStep('paste');
    if (step === 'paste') {
      const error = validateCookieJson(cookieText);
      setInlineError(error);
      if (!error) setStep('inject');
    }
  };

  const inject = async () => {
    const error = validateCookieJson(cookieText);
    setInlineError(error);
    if (error) return;
    setInjectState('saving');
    setServerError(null);
    try {
      await api.post('/monitor/inject-cookies', { destination: destinationCode(destination), cookies: cookieText });
      setInjectState('success');
      onInjected();
      window.setTimeout(onClose, 3000);
    } catch (errorValue) {
      const message = errorValue && typeof errorValue === 'object' && 'response' in errorValue
        ? (errorValue as { response?: { data?: { error?: string; message?: string } }; message?: string }).response?.data?.error
          ?? (errorValue as { response?: { data?: { error?: string; message?: string } }; message?: string }).response?.data?.message
          ?? (errorValue as { message?: string }).message
        : 'Failed to inject cookies.';
      setInjectState('error');
      setServerError(message ?? 'Failed to inject cookies.');
    }
  };

  return (
    <motion.div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <motion.div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="cookie-wizard-title"
        tabIndex={-1}
        initial={{ opacity: 0, y: 24, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 24, scale: 0.98 }}
        className="w-full max-w-2xl rounded-2xl border border-white/10 bg-zinc-950 text-zinc-100 shadow-2xl outline-none"
      >
        <div className="flex items-start justify-between border-b border-white/10 p-5">
          <div>
            <p className="text-[10px] font-black uppercase tracking-[0.3em] text-primary">Cookie warmup</p>
            <h2 id="cookie-wizard-title" className="mt-1 text-2xl font-black">{meta.flag} {meta.name}</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Close cookie wizard" className="rounded-lg p-2 text-zinc-400 hover:bg-white/10 hover:text-white">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="border-b border-white/10 px-5 py-4">
          <div className="grid grid-cols-4 gap-2">
            {(['explain', 'open', 'paste', 'inject'] as const).map((item, index) => (
              <div key={item} className={cn('h-2 rounded-full', index <= ['explain', 'open', 'paste', 'inject'].indexOf(step) ? 'bg-primary' : 'bg-white/10')} />
            ))}
          </div>
        </div>

        <div className="min-h-[360px] p-6">
          {step === 'explain' && (
            <div className="space-y-4">
              <AlertTriangle className="h-10 w-10 text-amber-300" />
              <p className="text-xl font-bold">Your VFS session is expiring.</p>
              {/* TODO: i18n - add Russian translation for operator handoff. */}
              <p className="text-sm leading-6 text-zinc-300">To keep the bot running, sign in to VFS in Chrome, copy your cookies, and paste them here. Takes 30 seconds.</p>
            </div>
          )}

          {step === 'open' && (
            <div className="space-y-5">
              <a href={meta.loginUrl} target="_blank" rel="noreferrer" className="btn-primary h-12 w-fit gap-2">
                <ExternalLink className="h-4 w-4" />
                Open VFS Latvia login
              </a>
              <div className="rounded-xl border border-blue-400/20 bg-blue-500/10 p-4 text-sm leading-6 text-blue-100">
                Install the EditThisCookie extension if it is not already in Chrome. After signing in, export cookies for visa.vfsglobal.com as JSON.
              </div>
            </div>
          )}

          {step === 'paste' && (
            <div className="space-y-3">
              <label htmlFor="cookie-json" className="text-xs font-black uppercase tracking-widest text-zinc-400">Paste cookie JSON from EditThisCookie</label>
              <textarea
                id="cookie-json"
                value={cookieText}
                onChange={(event) => {
                  setCookieText(event.target.value);
                  if (inlineError) setInlineError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) advance();
                }}
                spellCheck={false}
                className="min-h-[220px] w-full rounded-xl border border-white/10 bg-black/40 p-4 font-mono text-sm text-green-200 outline-none focus:border-primary focus:ring-4 focus:ring-primary/10"
              />
              {inlineError && <p className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200">{inlineError}</p>}
            </div>
          )}

          {step === 'inject' && (
            <div className="space-y-5">
              {injectState === 'success' ? (
                <div className="rounded-xl border border-green-500/30 bg-green-500/10 p-5 text-green-100">
                  <CheckCircle2 className="mb-3 h-8 w-8 text-green-300" />
                  <p className="font-bold">Cookies injected. This modal will close in 3 seconds.</p>
                </div>
              ) : (
                <>
                  <p className="text-sm text-zinc-300">Ready to inject cookies for {meta.name}. The monitor card will refresh after the backend accepts them.</p>
                  {serverError && <p className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200">{serverError}</p>}
                  <button type="button" onClick={inject} disabled={injectState === 'saving'} className="btn-primary h-12 gap-2">
                    {injectState === 'saving' ? <RefreshCcw className="h-4 w-4 animate-spin" /> : <Cookie className="h-4 w-4" />}
                    Inject cookies
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        <div className="flex justify-between border-t border-white/10 p-5">
          <button type="button" onClick={() => setStep(step === 'inject' ? 'paste' : step === 'paste' ? 'open' : 'explain')} disabled={step === 'explain' || injectState === 'success'} className="btn-secondary bg-zinc-900 text-zinc-100 hover:bg-zinc-800">
            Back
          </button>
          {step !== 'inject' && (
            <button type="button" onClick={advance} className="btn-primary">
              Continue
            </button>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}
