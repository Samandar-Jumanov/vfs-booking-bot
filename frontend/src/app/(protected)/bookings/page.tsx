'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CalendarClock, Download, Filter, RefreshCw, Search } from 'lucide-react';
import { DashboardShell } from '@/components/layout/DashboardShell';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

type BookingStatus = 'QUEUED' | 'RUNNING' | 'SUCCESS' | 'FAILED' | 'CANCELLED';

interface BookingRow {
  id: string;
  profileId: string;
  destination: string;
  visaType: string;
  slotDate: string | null;
  slotTime: string | null;
  status: BookingStatus;
  confirmationNo: string | null;
  errorMessage: string | null;
  attempt: number;
  jobId: string | null;
  createdAt: string;
  completedAt: string | null;
  profile: { fullName: string };
}

interface BookingHistoryResponse {
  total: number;
  items: BookingRow[];
}

interface ProfileOption {
  id: string;
  fullName: string;
}

const STATUSES: Array<BookingStatus | 'ALL'> = ['ALL', 'QUEUED', 'RUNNING', 'SUCCESS', 'FAILED', 'CANCELLED'];
const PAGE_SIZE = 50;

export default function BookingsPage() {
  const [status, setStatus] = useState<BookingStatus | 'ALL'>('ALL');
  const [profileId, setProfileId] = useState('');
  const [destination, setDestination] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);

  const params = useMemo(() => ({
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
    ...(status !== 'ALL' && { status }),
    ...(profileId && { profileId }),
    ...(destination && { destination }),
    ...(from && { from }),
    ...(to && { to }),
    ...(search && { search }),
  }), [destination, from, page, profileId, search, status, to]);

  const historyQuery = useQuery<BookingHistoryResponse>({
    queryKey: ['booking-history', params],
    queryFn: () => api.get<BookingHistoryResponse>('/booking/history', { params }).then((r) => r.data),
  });

  const profilesQuery = useQuery<{ items: ProfileOption[] }>({
    queryKey: ['profiles', 'booking-filter'],
    queryFn: () => api.get('/profiles', { params: { limit: 100 } }).then((r) => r.data),
  });

  const items = historyQuery.data?.items ?? [];
  const total = historyQuery.data?.total ?? 0;
  const maxPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);

  const exportCsv = () => {
    const headers = ['createdAt', 'profile', 'destination', 'visaType', 'slot', 'status', 'confirmationNo', 'attempt', 'errorMessage', 'jobId'];
    const escape = (value: unknown) => {
      const text = value == null ? '' : String(value);
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const lines = items.map((row) => [
      row.createdAt,
      row.profile.fullName,
      row.destination,
      row.visaType,
      `${formatDate(row.slotDate)} ${row.slotTime ?? ''}`.trim(),
      row.status,
      row.confirmationNo ?? '',
      row.attempt,
      row.errorMessage ?? '',
      row.jobId ?? '',
    ].map(escape).join(','));
    const blob = new Blob([[headers.join(','), ...lines].join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `booking-history-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <DashboardShell title="Bookings" description="Filtered booking history for queue, dispatch, confirmation, and failure review.">
      <div className="space-y-5">
        <section className="card bg-card/70 p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Filter className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-black uppercase tracking-widest">Filters</h2>
            </div>
            <button type="button" className="btn-secondary h-9 gap-2" onClick={() => historyQuery.refetch()} disabled={historyQuery.isFetching}>
              <RefreshCw className={cn('h-4 w-4', historyQuery.isFetching && 'animate-spin')} />
              Refresh
            </button>
          </div>

          <div className="grid gap-3 md:grid-cols-6">
            <div className="relative md:col-span-2">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input className="input h-10 pl-9" placeholder="Name, confirmation, error" value={search} onChange={(e) => { setSearch(e.target.value); setPage(0); }} />
            </div>
            <select className="input h-10" value={status} onChange={(e) => { setStatus(e.target.value as BookingStatus | 'ALL'); setPage(0); }}>
              {STATUSES.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
            <select className="input h-10" value={profileId} onChange={(e) => { setProfileId(e.target.value); setPage(0); }}>
              <option value="">All profiles</option>
              {(profilesQuery.data?.items ?? []).map((profile) => <option key={profile.id} value={profile.id}>{profile.fullName}</option>)}
            </select>
            <input className="input h-10" placeholder="Destination" value={destination} onChange={(e) => { setDestination(e.target.value); setPage(0); }} />
            <button type="button" className="btn-primary h-10 gap-2" onClick={exportCsv} disabled={items.length === 0}>
              <Download className="h-4 w-4" />
              CSV
            </button>
          </div>

          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <input type="date" className="input h-10" value={from} onChange={(e) => { setFrom(e.target.value); setPage(0); }} />
            <input type="date" className="input h-10" value={to} onChange={(e) => { setTo(e.target.value); setPage(0); }} />
          </div>
        </section>

        <section className="card overflow-hidden bg-card/70 p-0">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div className="flex items-center gap-2">
              <CalendarClock className="h-4 w-4 text-primary" />
              <span className="text-xs font-black uppercase tracking-widest">{total} bookings</span>
            </div>
            <span className="text-xs text-muted-foreground">Page {page + 1} of {maxPage + 1}</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[980px] text-sm">
              <thead className="bg-zinc-950 text-zinc-400">
                <tr>
                  <Th>Created</Th>
                  <Th>Profile</Th>
                  <Th>Route</Th>
                  <Th>Slot</Th>
                  <Th>Status</Th>
                  <Th>Confirmation</Th>
                  <Th>Attempt</Th>
                  <Th>Last error</Th>
                </tr>
              </thead>
              <tbody>
                {items.map((row) => (
                  <tr key={row.id} className="border-t border-border/60">
                    <Td mono>{new Date(row.createdAt).toLocaleString()}</Td>
                    <Td strong>{row.profile.fullName}</Td>
                    <Td>{row.destination.toUpperCase()} / {row.visaType}</Td>
                    <Td mono>{formatDate(row.slotDate)} {row.slotTime ?? ''}</Td>
                    <Td><StatusBadge status={row.status} /></Td>
                    <Td mono>{row.confirmationNo ?? '-'}</Td>
                    <Td>{row.attempt}</Td>
                    <Td muted>{row.errorMessage ?? '-'}</Td>
                  </tr>
                ))}
                {!historyQuery.isLoading && items.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-4 py-10 text-center text-sm text-muted-foreground">No bookings match the active filters.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
            <button className="btn-secondary h-9" disabled={page === 0} onClick={() => setPage((value) => Math.max(0, value - 1))}>Previous</button>
            <button className="btn-secondary h-9" disabled={page >= maxPage} onClick={() => setPage((value) => Math.min(maxPage, value + 1))}>Next</button>
          </div>
        </section>
      </div>
    </DashboardShell>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-4 py-3 text-left text-[10px] font-black uppercase tracking-widest">{children}</th>;
}

function Td({ children, mono, muted, strong }: { children: React.ReactNode; mono?: boolean; muted?: boolean; strong?: boolean }) {
  return <td className={cn('px-4 py-3 align-top', mono && 'font-mono text-xs', muted && 'max-w-xs truncate text-muted-foreground', strong && 'font-bold')}>{children}</td>;
}

function StatusBadge({ status }: { status: BookingStatus }) {
  const map = {
    QUEUED: 'bg-blue-500/15 text-blue-500',
    RUNNING: 'bg-amber-500/15 text-amber-500',
    SUCCESS: 'bg-green-500/15 text-green-500',
    FAILED: 'bg-red-500/15 text-red-500',
    CANCELLED: 'bg-zinc-500/15 text-zinc-500',
  } as const;
  return <span className={cn('inline-flex rounded-full px-2.5 py-1 text-xs font-bold', map[status])}>{status}</span>;
}

function formatDate(value?: string | null) {
  if (!value) return '-';
  return new Date(value).toLocaleDateString();
}
