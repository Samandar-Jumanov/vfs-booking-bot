import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '@config/database';
import { env } from '@config/env';
import { requireAuth } from '@middleware/auth.middleware';
import { AppError } from '@middleware/errorHandler';
import { WorkerBoxRole, WorkerBoxStatus } from '@prisma/client';

export const fleetRouter = Router();

const HEARTBEAT_STALE_MS = 120_000;
const DEFAULT_LEASE_TTL_SEC = 15 * 60;
const DEFAULT_COOLDOWN_MIN = 120;
const BURST_CONFIG_KEY = 'fleet_burst_config';

function workerAuth(req: Request, _res: Response, next: NextFunction): void {
  const workerToken = env.WORKER_TOKEN;
  if (!workerToken) {
    next();
    return;
  }
  const authHeader = req.headers.authorization ?? '';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!bearer || bearer !== workerToken) {
    next(new AppError(401, 'Invalid or missing worker token', 'UNAUTHORIZED'));
    return;
  }
  next();
}

function parseDate(value: unknown): Date | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function publicStatus(status: WorkerBoxStatus, heartbeatAt: Date | null, cooldownUntil: Date | null): WorkerBoxStatus {
  if (cooldownUntil && cooldownUntil.getTime() > Date.now()) return WorkerBoxStatus.COOLDOWN;
  if (!heartbeatAt || Date.now() - heartbeatAt.getTime() > HEARTBEAT_STALE_MS) return WorkerBoxStatus.OFFLINE;
  return status;
}

const heartbeatSchema = z.object({
  boxId: z.string().min(1),
  role: z.nativeEnum(WorkerBoxRole).optional(),
  status: z.nativeEnum(WorkerBoxStatus).optional(),
  pid: z.number().int().optional(),
  hostname: z.string().optional(),
  assignedAccountId: z.string().optional().nullable(),
  assignedAccountEmail: z.string().optional().nullable(),
  currentUrl: z.string().optional().nullable(),
  pageState: z.unknown().optional(),
  lastSuccessfulCheckAt: z.string().optional(),
  lastError: z.string().optional().nullable(),
});

const cooldownSchema = z.object({
  boxId: z.string().min(1),
  reason: z.string().min(1),
  minutes: z.number().int().min(5).max(24 * 60).default(DEFAULT_COOLDOWN_MIN),
  assignedAccountId: z.string().optional().nullable(),
  assignedAccountEmail: z.string().optional().nullable(),
  currentUrl: z.string().optional().nullable(),
  pageState: z.unknown().optional(),
});

const leaseAcquireSchema = z.object({
  boxId: z.string().min(1),
  accountId: z.string().uuid(),
  role: z.nativeEnum(WorkerBoxRole),
  runId: z.string().optional(),
  ttlSeconds: z.number().int().min(30).max(24 * 60 * 60).default(DEFAULT_LEASE_TTL_SEC),
});

const leaseReleaseSchema = z.object({
  boxId: z.string().min(1),
  accountId: z.string().uuid(),
});

const creationEventSchema = z.object({
  boxId: z.string().min(1),
  ok: z.boolean(),
  reason: z.string().optional(),
});

const burstConfigSchema = z.object({
  timezone: z.string().min(1).default('Asia/Tashkent'),
  windows: z.array(z.object({
    start: z.string().regex(/^\d{2}:\d{2}$/),
    end: z.string().regex(/^\d{2}:\d{2}$/),
  })).default([{ start: '11:55', end: '12:15' }]),
  burstIntervalSeconds: z.number().int().min(1).max(300).default(3),
  idleIntervalSeconds: z.number().int().min(30).max(3600).default(300),
  staggerSeconds: z.number().int().min(0).max(300).default(0),
});

fleetRouter.get('/status', requireAuth, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    await prisma.accountLease.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    const [boxes, leases] = await Promise.all([
      prisma.workerBox.findMany({ orderBy: { boxId: 'asc' } }),
      prisma.accountLease.findMany({
        include: { account: { select: { email: true, pollingRole: true, status: true, cooldownUntil: true } } },
        orderBy: { boxId: 'asc' },
      }),
    ]);

    res.json({
      generatedAt: new Date().toISOString(),
      staleAfterSeconds: HEARTBEAT_STALE_MS / 1000,
      boxes: boxes.map((box) => ({
        ...box,
        status: publicStatus(box.status, box.heartbeatAt, box.cooldownUntil),
        online: !!box.heartbeatAt && Date.now() - box.heartbeatAt.getTime() <= HEARTBEAT_STALE_MS,
      })),
      leases,
      summary: {
        total: boxes.length,
        online: boxes.filter((box) => publicStatus(box.status, box.heartbeatAt, box.cooldownUntil) !== WorkerBoxStatus.OFFLINE).length,
        cooldown: boxes.filter((box) => publicStatus(box.status, box.heartbeatAt, box.cooldownUntil) === WorkerBoxStatus.COOLDOWN).length,
        offline: boxes.filter((box) => publicStatus(box.status, box.heartbeatAt, box.cooldownUntil) === WorkerBoxStatus.OFFLINE).length,
      },
    });
  } catch (err) {
    next(err);
  }
});

fleetRouter.post('/worker/heartbeat', workerAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = heartbeatSchema.parse(req.body ?? {});
    const now = new Date();
    const lastSuccessfulCheckAt = parseDate(body.lastSuccessfulCheckAt);
    const existing = await prisma.workerBox.findUnique({ where: { boxId: body.boxId } });
    const cooldownActive = existing?.cooldownUntil && existing.cooldownUntil.getTime() > Date.now();
    const role = cooldownActive ? WorkerBoxRole.COOLDOWN : (body.role ?? existing?.role ?? WorkerBoxRole.OFFLINE);
    const status = cooldownActive ? WorkerBoxStatus.COOLDOWN : (body.status ?? WorkerBoxStatus.ONLINE);

    const box = await prisma.workerBox.upsert({
      where: { boxId: body.boxId },
      update: {
        role,
        status,
        heartbeatAt: now,
        pid: body.pid,
        hostname: body.hostname,
        assignedAccountId: body.assignedAccountId ?? null,
        assignedAccountEmail: body.assignedAccountEmail ?? null,
        currentUrl: body.currentUrl ?? existing?.currentUrl ?? null,
        pageState: body.pageState === undefined ? existing?.pageState ?? undefined : body.pageState as never,
        lastSuccessfulCheckAt: lastSuccessfulCheckAt ?? existing?.lastSuccessfulCheckAt ?? null,
        lastError: body.lastError ?? existing?.lastError ?? null,
        startedAt: existing?.startedAt ?? now,
      },
      create: {
        boxId: body.boxId,
        role,
        status,
        heartbeatAt: now,
        pid: body.pid,
        hostname: body.hostname,
        assignedAccountId: body.assignedAccountId ?? null,
        assignedAccountEmail: body.assignedAccountEmail ?? null,
        currentUrl: body.currentUrl ?? null,
        pageState: body.pageState as never,
        lastSuccessfulCheckAt: lastSuccessfulCheckAt ?? null,
        lastError: body.lastError ?? null,
        startedAt: now,
      },
    });
    res.json({ ok: true, box });
  } catch (err) {
    next(err);
  }
});

fleetRouter.post('/worker/cooldown', workerAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = cooldownSchema.parse(req.body ?? {});
    const cooldownUntil = new Date(Date.now() + body.minutes * 60_000);
    const box = await prisma.workerBox.upsert({
      where: { boxId: body.boxId },
      update: {
        role: WorkerBoxRole.COOLDOWN,
        status: WorkerBoxStatus.COOLDOWN,
        heartbeatAt: new Date(),
        assignedAccountId: body.assignedAccountId ?? null,
        assignedAccountEmail: body.assignedAccountEmail ?? null,
        currentUrl: body.currentUrl ?? null,
        pageState: body.pageState as never,
        lastError: body.reason,
        lastBlockReason: body.reason,
        cooldownUntil,
      },
      create: {
        boxId: body.boxId,
        role: WorkerBoxRole.COOLDOWN,
        status: WorkerBoxStatus.COOLDOWN,
        heartbeatAt: new Date(),
        assignedAccountId: body.assignedAccountId ?? null,
        assignedAccountEmail: body.assignedAccountEmail ?? null,
        currentUrl: body.currentUrl ?? null,
        pageState: body.pageState as never,
        lastError: body.reason,
        lastBlockReason: body.reason,
        cooldownUntil,
        startedAt: new Date(),
      },
    });
    await prisma.accountLease.deleteMany({ where: { boxId: body.boxId } });
    res.json({ ok: true, box, cooldownUntil });
  } catch (err) {
    next(err);
  }
});

fleetRouter.post('/worker/leases/acquire', workerAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = leaseAcquireSchema.parse(req.body ?? {});
    const now = new Date();
    const expiresAt = new Date(now.getTime() + body.ttlSeconds * 1000);

    const lease = await prisma.$transaction(async (tx) => {
      await tx.accountLease.deleteMany({ where: { expiresAt: { lt: now } } });
      const existing = await tx.accountLease.findUnique({ where: { accountId: body.accountId } });
      if (existing && existing.boxId !== body.boxId && existing.expiresAt > now) return null;
      return tx.accountLease.upsert({
        where: { accountId: body.accountId },
        update: {
          boxId: body.boxId,
          role: body.role,
          runId: body.runId,
          heartbeatAt: now,
          expiresAt,
        },
        create: {
          accountId: body.accountId,
          boxId: body.boxId,
          role: body.role,
          runId: body.runId,
          heartbeatAt: now,
          expiresAt,
        },
      });
    });

    if (!lease) {
      res.status(409).json({ ok: false, reason: 'ACCOUNT_LEASED' });
      return;
    }
    res.json({ ok: true, lease });
  } catch (err) {
    next(err);
  }
});

fleetRouter.post('/worker/leases/release', workerAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = leaseReleaseSchema.parse(req.body ?? {});
    await prisma.accountLease.deleteMany({ where: { accountId: body.accountId, boxId: body.boxId } });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

fleetRouter.post('/worker/creation-event', workerAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = creationEventSchema.parse(req.body ?? {});
    const update = body.ok
      ? { creationSuccessCount: { increment: 1 }, lastError: null as string | null }
      : { creationFailureCount: { increment: 1 }, lastError: body.reason ?? 'creation_failed' };
    await prisma.workerBox.upsert({
      where: { boxId: body.boxId },
      update,
      create: {
        boxId: body.boxId,
        role: WorkerBoxRole.CREATOR,
        status: WorkerBoxStatus.ONLINE,
        heartbeatAt: new Date(),
        startedAt: new Date(),
        creationSuccessCount: body.ok ? 1 : 0,
        creationFailureCount: body.ok ? 0 : 1,
        lastError: body.ok ? null : body.reason ?? 'creation_failed',
      },
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

fleetRouter.get('/burst-config', requireAuth, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const row = await prisma.settings.findUnique({ where: { key: BURST_CONFIG_KEY } });
    const parsed = burstConfigSchema.safeParse(row?.value ?? {});
    res.json(parsed.success ? parsed.data : burstConfigSchema.parse({}));
  } catch (err) {
    next(err);
  }
});

fleetRouter.put('/burst-config', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = burstConfigSchema.parse(req.body ?? {});
    await prisma.settings.upsert({
      where: { key: BURST_CONFIG_KEY },
      update: { value: body as never },
      create: { key: BURST_CONFIG_KEY, value: body as never },
    });
    res.json(body);
  } catch (err) {
    next(err);
  }
});
