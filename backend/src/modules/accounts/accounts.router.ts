import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { requireAuth } from '@middleware/auth.middleware';
import { AppError } from '@middleware/errorHandler';
import { accountPoolService } from './accountPool.service';
import { prisma } from '@config/database';
import { encrypt } from '@utils/crypto';
import { registerVfsAccount } from '@modules/engine/vfs/vfs.registration';
import { logEvent } from '@modules/logs/logger';
import { EventType } from '@prisma/client';

export const accountsRouter = Router();

accountsRouter.use(requireAuth);

// ── Validation schemas ─────────────────────────────────────────────────────────

const createAccountSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1, 'password is required'),
  phone: z.string().optional(),
});

const cooldownSchema = z.object({
  minutes: z.number().int().positive(),
});

// ── GET /api/accounts ─────────────────────────────────────────────────────────
// Returns all VfsAccounts. encryptedPassword is NEVER included in the response.

accountsRouter.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const accounts = await prisma.vfsAccount.findMany({
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        email: true,
        phone: true,
        status: true,
        lastUsedAt: true,
        cooldownUntil: true,
        profileIds: true,
        createdAt: true,
        updatedAt: true,
        // encryptedPassword intentionally omitted
      },
    });

    const response = accounts.map((a) => ({
      id: a.id,
      email: a.email,
      phone: a.phone ?? null,
      status: a.status,
      lastUsedAt: a.lastUsedAt,
      cooldownUntil: a.cooldownUntil,
      profileCount: a.profileIds.length,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
    }));

    res.json(response);
  } catch (err) {
    next(err);
  }
});

// ── POST /api/accounts ────────────────────────────────────────────────────────
// Creates a VfsAccount manually. Password is AES-256-GCM encrypted before storage.

accountsRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = createAccountSchema.parse(req.body);

    const encryptedPassword = encrypt(body.password);

    const account = await prisma.vfsAccount.create({
      data: {
        email: body.email,
        encryptedPassword,
        phone: body.phone ?? null,
      },
      select: {
        id: true,
        email: true,
        phone: true,
        status: true,
        lastUsedAt: true,
        cooldownUntil: true,
        profileIds: true,
        createdAt: true,
        updatedAt: true,
        // encryptedPassword intentionally omitted
      },
    });

    res.status(201).json({
      id: account.id,
      email: account.email,
      phone: account.phone ?? null,
      status: account.status,
      lastUsedAt: account.lastUsedAt,
      cooldownUntil: account.cooldownUntil,
      profileCount: account.profileIds.length,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
    });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /api/accounts/:id ──────────────────────────────────────────────────

accountsRouter.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const existing = await prisma.vfsAccount.findUnique({ where: { id }, select: { id: true } });
    if (!existing) {
      throw new AppError(404, `VfsAccount "${id}" not found`, 'NOT_FOUND');
    }

    await prisma.vfsAccount.delete({ where: { id } });

    res.json({ message: 'Account deleted' });
  } catch (err) {
    next(err);
  }
});

// ── PUT /api/accounts/:id/block ───────────────────────────────────────────────

accountsRouter.put('/:id/block', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const existing = await prisma.vfsAccount.findUnique({ where: { id }, select: { id: true } });
    if (!existing) {
      throw new AppError(404, `VfsAccount "${id}" not found`, 'NOT_FOUND');
    }

    await accountPoolService.markBlocked(id);

    res.json({ message: 'Account marked as BLOCKED' });
  } catch (err) {
    next(err);
  }
});

// ── PUT /api/accounts/:id/cooldown ────────────────────────────────────────────

accountsRouter.put('/:id/cooldown', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { minutes } = cooldownSchema.parse(req.body);

    const existing = await prisma.vfsAccount.findUnique({ where: { id }, select: { id: true } });
    if (!existing) {
      throw new AppError(404, `VfsAccount "${id}" not found`, 'NOT_FOUND');
    }

    await accountPoolService.markCooldown(id, minutes);

    res.json({ message: `Account put into COOLDOWN for ${minutes} minute(s)` });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/accounts/register ──────────────────────────────────────────────
/**
 * Triggers fully-automated VFS Global account creation:
 *   - Acquires a temporary phone number via SMS-Activate
 *   - Creates a disposable Mailsac email address
 *   - Drives the VFS registration form with a stealth Playwright browser
 *   - Handles email OTP and SMS OTP verification
 *   - Persists encrypted credentials to the VfsAccount table
 *
 * No request body is required — all data is generated automatically.
 * The operation can take several minutes; the client should wait with a
 * long or no timeout.
 */
accountsRouter.post('/register', async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  logEvent('info', EventType.BOOKING_ATTEMPT, 'VFS account registration started');

  try {
    const result = await registerVfsAccount();

    logEvent('info', EventType.BOOKING_SUCCESS, 'VFS account registration succeeded', {
      accountId: result.accountId,
      email: result.email,
    });

    res.status(201).json({
      success: true,
      account: {
        accountId: result.accountId,
        email: result.email,
        phone: result.phone,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    logEvent('error', EventType.BOOKING_FAILED, 'VFS account registration failed', {
      error: message,
    });

    if (message.startsWith('registerVfsAccount failed:')) {
      res.status(500).json({ success: false, error: message });
      return;
    }

    next(err);
  }
});
