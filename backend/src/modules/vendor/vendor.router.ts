import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { fetchAllBalances } from './balance.fetcher';
import { requireAuth } from '@middleware/auth.middleware';

const prisma = new PrismaClient();
export const vendorRouter = Router();

vendorRouter.use(requireAuth);

vendorRouter.get('/balance', async (_req, res, next) => {
  try {
    const balances = await fetchAllBalances();
    res.json({ balances });
  } catch (err) {
    next(err);
  }
});

vendorRouter.get('/spend/summary', async (req, res, next) => {
  try {
    const since = req.query.since ? new Date(String(req.query.since)) : firstOfMonth();

    const byVendor = await prisma.vendorSpend.groupBy({
      by: ['vendor'],
      _sum: { costMicroUsd: true },
      _count: { _all: true },
      where: { createdAt: { gte: since } },
    });

    const totalMicroUsd = byVendor.reduce((acc, row) => acc + (row._sum.costMicroUsd ?? 0), 0);

    res.json({
      since: since.toISOString(),
      totalUsd: totalMicroUsd / 1_000_000,
      byVendor: byVendor.map((row) => ({
        vendor: row.vendor,
        usd: (row._sum.costMicroUsd ?? 0) / 1_000_000,
        count: row._count._all,
      })),
    });
  } catch (err) {
    next(err);
  }
});

vendorRouter.get('/spend/per-customer', async (req, res, next) => {
  try {
    const since = req.query.since ? new Date(String(req.query.since)) : firstOfMonth();

    const grouped = await prisma.vendorSpend.groupBy({
      by: ['profileId'],
      _sum: { costMicroUsd: true },
      _count: { _all: true },
      where: { createdAt: { gte: since }, profileId: { not: null } },
    });

    const profiles = await prisma.profile.findMany({
      where: { id: { in: grouped.map((g) => g.profileId).filter(Boolean) as string[] } },
      select: { id: true, fullName: true, email: true },
    });
    const map = new Map(profiles.map((p) => [p.id, p]));

    const rows = grouped
      .map((g) => ({
        profileId: g.profileId!,
        name: map.get(g.profileId!)?.fullName ?? '(deleted)',
        email: map.get(g.profileId!)?.email ?? '',
        usd: (g._sum.costMicroUsd ?? 0) / 1_000_000,
        actions: g._count._all,
      }))
      .sort((a, b) => b.usd - a.usd);

    res.json({ since: since.toISOString(), rows });
  } catch (err) {
    next(err);
  }
});

vendorRouter.get('/spend/recent', async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const rows = await prisma.vendorSpend.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    res.json({
      rows: rows.map((r) => ({
        id: r.id,
        vendor: r.vendor,
        kind: r.kind,
        action: r.action,
        usd: r.costMicroUsd / 1_000_000,
        externalRef: r.externalRef,
        profileId: r.profileId,
        createdAt: r.createdAt,
      })),
    });
  } catch (err) {
    next(err);
  }
});

function firstOfMonth(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}
