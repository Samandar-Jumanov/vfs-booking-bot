/**
 * Scenario router — the "Start Scenario" button backend.
 *
 * Implements the end-to-end pipeline trigger:
 *   1. Check spare ACTIVE pool vs poolMinSpare (default 2)
 *   2. If short: queue registration requests (increments pending_registration_requests counter)
 *   3. Trigger reconciliation for PENDING accounts (dry-run=false activates Mailsac accounts)
 *   4. Return current account states for the dashboard
 *
 * Flag-gated: SCENARIO_ENABLED=false (or unset) means the endpoint returns a 200 with
 * `{ triggered: false, reason: 'SCENARIO_DISABLED' }` — no error, just a no-op.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { requireAuth } from '@middleware/auth.middleware';
import { prisma } from '@config/database';
import { reconcilePending, type ReconciliationReport } from '@modules/accounts/reconciliation.service';

export const scenarioRouter = Router();

// ── Validation ─────────────────────────────────────────────────────────────────

const startScenarioSchema = z.object({
  poolMinSpare: z.coerce.number().int().min(1).max(50).default(2),
});

// ── Helpers ────────────────────────────────────────────────────────────────────

const REG_QUEUE_KEY = 'pending_registration_requests';

async function getRegQueue(): Promise<number> {
  const row = await prisma.settings.findUnique({ where: { key: REG_QUEUE_KEY } });
  const v = row?.value as unknown;
  if (typeof v === 'number') return Math.max(0, Math.floor(v));
  if (v && typeof v === 'object' && typeof (v as { count?: unknown }).count === 'number') {
    return Math.max(0, Math.floor((v as { count: number }).count));
  }
  return 0;
}

async function addToRegQueue(n: number): Promise<number> {
  const current = await getRegQueue();
  const next = Math.max(0, current + n);
  await prisma.settings.upsert({
    where: { key: REG_QUEUE_KEY },
    update: { value: next },
    create: { key: REG_QUEUE_KEY, value: next },
  });
  return next;
}

// ── POST /api/scenario/start ───────────────────────────────────────────────────

interface ScenarioAccountItem {
  id: string;
  email: string;
  status: string;
  lifecycleState: string;
  pollingRole: string;
  lastAttemptAt: Date | null;
  cooldownUntil: Date | null;
}

interface ScenarioStartResponse {
  triggered: boolean;
  reason?: string;
  registrationsQueued?: number;
  reconciliation?: ReconciliationReport;
  accounts?: {
    total: number;
    active: number;
    pending: number;
    spare: number;
    items: ScenarioAccountItem[];
  };
}

scenarioRouter.post(
  '/start',
  requireAuth,
  async (req: Request, res: Response<ScenarioStartResponse>, next: NextFunction): Promise<void> => {
    try {
      // ── Flag gate ──────────────────────────────────────────────────────────
      const scenarioEnabled = process.env.SCENARIO_ENABLED === 'true';
      if (!scenarioEnabled) {
        res.status(200).json({ triggered: false, reason: 'SCENARIO_DISABLED' });
        return;
      }

      // ── Parse body ─────────────────────────────────────────────────────────
      const body = startScenarioSchema.parse(req.body ?? {});
      const { poolMinSpare } = body;

      // ── Step 1: Query current pool state ───────────────────────────────────
      const [spareActive, totalActive, pendingCount] = await Promise.all([
        prisma.vfsAccount.count({
          where: { status: 'ACTIVE', profileIds: { isEmpty: true } },
        }),
        prisma.vfsAccount.count({ where: { status: 'ACTIVE' } }),
        prisma.vfsAccount.count({ where: { status: 'PENDING' } }),
      ]);

      // ── Step 2: Queue registrations if pool is short ───────────────────────
      let registrationsQueued = 0;
      if (spareActive < poolMinSpare) {
        registrationsQueued = poolMinSpare - spareActive;
        await addToRegQueue(registrationsQueued);
        console.log(`[scenario] spare=${spareActive} < min=${poolMinSpare}, queued ${registrationsQueued} registration(s)`);
      } else {
        console.log(`[scenario] spare=${spareActive} >= min=${poolMinSpare}, no registrations queued`);
      }

      // ── Step 3: Reconcile PENDING accounts (live mode, activates via Mailsac) ─
      console.log(`[scenario] reconciling ${pendingCount} PENDING account(s)...`);
      const reconciliation = await reconcilePending(false);
      console.log(`[scenario] reconcile done: activated=${reconciliation.activated} linkMissing=${reconciliation.linkMissing} failed=${reconciliation.failed}`);

      // ── Step 4: Snapshot all accounts for dashboard display ────────────────
      const accountRows = await prisma.vfsAccount.findMany({
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          email: true,
          status: true,
          lifecycleState: true,
          pollingRole: true,
          lastAttemptAt: true,
          cooldownUntil: true,
        },
      });

      const items: ScenarioAccountItem[] = accountRows.map((a) => ({
        id: a.id,
        email: a.email,
        status: a.status,
        lifecycleState: a.lifecycleState,
        pollingRole: a.pollingRole,
        lastAttemptAt: a.lastAttemptAt,
        cooldownUntil: a.cooldownUntil,
      }));

      const activeFinal = items.filter((i) => i.status === 'ACTIVE').length;
      const pendingFinal = items.filter((i) => i.status === 'PENDING').length;
      const spareFinal = await prisma.vfsAccount.count({
        where: { status: 'ACTIVE', profileIds: { isEmpty: true } },
      });

      res.status(200).json({
        triggered: true,
        registrationsQueued,
        reconciliation,
        accounts: {
          total: items.length,
          active: activeFinal,
          pending: pendingFinal,
          spare: spareFinal,
          items,
        },
      });
    } catch (err) {
      next(err);
    }
  },
);
