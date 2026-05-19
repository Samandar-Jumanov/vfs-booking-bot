'use client';

import { useQuery } from '@tanstack/react-query';
import { DollarSign, Activity, Users, AlertCircle, CheckCircle2 } from 'lucide-react';
import { DashboardShell } from '@/components/layout/DashboardShell';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

interface VendorBalance {
  vendor: string;
  balanceUsd: number | null;
  currency: string;
  configured: boolean;
  error?: string;
}

interface SpendByVendor {
  vendor: string;
  usd: number;
  count: number;
}

interface SpendSummary {
  since: string;
  totalUsd: number;
  byVendor: SpendByVendor[];
}

interface PerCustomerRow {
  profileId: string;
  name: string;
  email: string;
  usd: number;
  actions: number;
}

interface PerCustomerResponse {
  since: string;
  rows: PerCustomerRow[];
}

function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

export default function VendorsPage() {
  const balances = useQuery<{ balances: VendorBalance[] }>({
    queryKey: ['vendor-balances'],
    queryFn: () => api.get('/vendor/balance').then((r) => r.data),
    refetchInterval: 60_000,
  });

  const summary = useQuery<SpendSummary>({
    queryKey: ['vendor-summary'],
    queryFn: () => api.get('/vendor/spend/summary').then((r) => r.data),
    refetchInterval: 30_000,
  });

  const perCustomer = useQuery<PerCustomerResponse>({
    queryKey: ['vendor-per-customer'],
    queryFn: () => api.get('/vendor/spend/per-customer').then((r) => r.data),
    refetchInterval: 30_000,
  });

  return (
    <DashboardShell title="Vendor Costs">
      <div className="space-y-8">
        {/* Top row: live balances */}
        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-widest text-muted-foreground">
            Live vendor balances
          </h2>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
            {balances.isLoading && (
              <div className="col-span-full text-sm text-muted-foreground">Loading…</div>
            )}
            {balances.data?.balances.map((b) => (
              <div key={b.vendor} className="rounded-xl border bg-card p-4">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase text-muted-foreground">
                    {b.vendor}
                  </span>
                  {b.configured ? (
                    b.error ? (
                      <AlertCircle className="h-4 w-4 text-amber-500" />
                    ) : (
                      <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                    )
                  ) : (
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      not configured
                    </span>
                  )}
                </div>
                <div className="mt-2 flex items-baseline gap-1">
                  {b.balanceUsd !== null ? (
                    <>
                      <span className="text-2xl font-bold tabular-nums">
                        {b.currency === 'USD' ? formatUsd(b.balanceUsd) : b.balanceUsd.toFixed(2)}
                      </span>
                      {b.currency !== 'USD' && (
                        <span className="text-xs text-muted-foreground">{b.currency}</span>
                      )}
                    </>
                  ) : (
                    <span className="text-sm text-muted-foreground">—</span>
                  )}
                </div>
                {b.error && (
                  <p className="mt-1 truncate text-[11px] text-amber-600" title={b.error}>
                    {b.error}
                  </p>
                )}
              </div>
            ))}
          </div>
        </section>

        {/* Middle row: month-to-date summary */}
        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-widest text-muted-foreground">
            Month-to-date spend
          </h2>
          <div className="rounded-xl border bg-card p-4">
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <DollarSign className="h-4 w-4 text-primary" />
                <span className="text-2xl font-bold tabular-nums">
                  {summary.data ? formatUsd(summary.data.totalUsd) : '—'}
                </span>
                <span className="text-xs text-muted-foreground">total since {summary.data?.since.slice(0, 10)}</span>
              </div>
            </div>
            <div className="overflow-hidden rounded-lg border">
              <table className="w-full text-sm">
                <thead className="bg-muted/30 text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-semibold">Vendor</th>
                    <th className="px-3 py-2 text-right font-semibold">Calls</th>
                    <th className="px-3 py-2 text-right font-semibold">Spent</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.data?.byVendor.map((row) => (
                    <tr key={row.vendor} className="border-t">
                      <td className="px-3 py-2 font-medium">{row.vendor}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                        {row.count}
                      </td>
                      <td className="px-3 py-2 text-right font-medium tabular-nums">
                        {formatUsd(row.usd)}
                      </td>
                    </tr>
                  ))}
                  {summary.data?.byVendor.length === 0 && (
                    <tr>
                      <td colSpan={3} className="px-3 py-6 text-center text-muted-foreground">
                        No spend yet this month.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        {/* Bottom row: per-customer */}
        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-widest text-muted-foreground">
            Spend by customer
          </h2>
          <div className="overflow-hidden rounded-xl border bg-card">
            <table className="w-full text-sm">
              <thead className="bg-muted/30 text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-semibold">Customer</th>
                  <th className="px-4 py-2 font-semibold">Email</th>
                  <th className="px-4 py-2 text-right font-semibold">Actions</th>
                  <th className="px-4 py-2 text-right font-semibold">Total spend</th>
                </tr>
              </thead>
              <tbody>
                {perCustomer.data?.rows.map((row) => (
                  <tr key={row.profileId} className="border-t">
                    <td className="px-4 py-2 font-medium">{row.name}</td>
                    <td className="px-4 py-2 text-muted-foreground">{row.email}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">
                      {row.actions}
                    </td>
                    <td className="px-4 py-2 text-right font-semibold tabular-nums">
                      {formatUsd(row.usd)}
                    </td>
                  </tr>
                ))}
                {(perCustomer.data?.rows.length ?? 0) === 0 && (
                  <tr>
                    <td colSpan={4} className="px-4 py-6 text-center text-muted-foreground">
                      No per-customer spend yet. Trigger a booking or auto-register to see data here.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </DashboardShell>
  );
}
