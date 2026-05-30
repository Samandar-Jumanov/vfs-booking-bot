import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { requireAuth } from '@middleware/auth.middleware';
import { AppError } from '@middleware/errorHandler';
import { accountPoolService, autoLinkAccountToProfile } from './accountPool.service';
import { prisma } from '@config/database';
import { decrypt, encrypt } from '@utils/crypto';
import { registerVfsAccount } from '@modules/engine/vfs/vfs.registration';
import { autoRegisterAccount, fetchEmailVerificationLink, visitActivationLink } from './accountAutoRegister.service';
import { accountBatchService } from './accountBatch.service';
import { loginAccount, openAccountLoginTab } from './accountLoginService';
import axios from 'axios';
import { logEvent } from '@modules/logs/logger';
import { isExtensionLive } from '@modules/websocket/ws.server';
import { AccountStatus, EventType, PollingRole } from '@prisma/client';

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

const autoCreateBatchSchema = z.object({
  count: z.coerce.number().int().min(1).max(100),
  spacingSeconds: z.coerce.number().int().min(0).max(1800).default(300),
  source: z.string().min(1).default('uzb'),
  destination: z.string().min(1).default('lva'),
  countryCode: z.string().min(1).default('171'),
});

const pollingRoleSchema = z.object({
  role: z.nativeEnum(PollingRole),
});


const PENDING_STATUS = 'PENDING' as AccountStatus;

// ── nodriver registration queue ─────────────────────────────────────────────
// The Railway backend can't run nodriver (no UZ IP / no Chrome). So the dashboard
// only BUMPS a counter here; the register-runner on the operator's UZ machine
// drains it one-at-a-time (throttle-paced) and inserts the new accounts. This
// decouples the dashboard click from the actual VFS registration.
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

async function setRegQueue(n: number): Promise<number> {
  const val = Math.max(0, Math.floor(n));
  await prisma.settings.upsert({
    where: { key: REG_QUEUE_KEY },
    update: { value: val },
    create: { key: REG_QUEUE_KEY, value: val },
  });
  return val;
}

const requestRegSchema = z.object({ count: z.coerce.number().int().min(1).max(50).default(1) });

function cookieStoreHasDatadome(cookieStore: unknown): boolean {
  if (!cookieStore) return false;
  if (typeof cookieStore === 'string') return /datadome/i.test(cookieStore);
  if (Array.isArray(cookieStore)) {
    return cookieStore.some((cookie) => {
      if (!cookie || typeof cookie !== 'object') return false;
      const name = 'name' in cookie ? String((cookie as { name?: unknown }).name ?? '') : '';
      return /datadome/i.test(name);
    });
  }
  if (typeof cookieStore === 'object') {
    const store = cookieStore as { raw?: unknown; jar?: unknown; hasDatadome?: unknown };
    if (store.hasDatadome === true) return true;
    if (typeof store.raw === 'string' && /datadome/i.test(store.raw)) return true;
    return cookieStoreHasDatadome(store.jar);
  }
  return false;
}

// ── GET /api/accounts ─────────────────────────────────────────────────────────
// Returns all VfsAccounts. encryptedPassword is NEVER included in the response.

accountsRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const status = typeof req.query.status === 'string' ? req.query.status.toUpperCase() : undefined;
    const accounts = await prisma.vfsAccount.findMany({
      where: status && status in AccountStatus ? { status: status as AccountStatus } : undefined,
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        email: true,
        phone: true,
        status: true,
        pollingRole: true,
        lastUsedAt: true,
        lastWarmedAt: true,
        cookieStore: true,
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
      pollingRole: a.pollingRole,
      cookieFresh: cookieStoreHasDatadome(a.cookieStore) && !!a.lastWarmedAt && Date.now() - a.lastWarmedAt.getTime() < 12 * 60 * 60 * 1000,
      lastUsedAt: a.lastUsedAt,
      lastWarmedAt: a.lastWarmedAt,
      cookiesUpdatedAt: a.lastWarmedAt,
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
        pollingRole: true,
        lastUsedAt: true,
        lastWarmedAt: true,
        cookieStore: true,
        cooldownUntil: true,
        profileIds: true,
        createdAt: true,
        updatedAt: true,
        // encryptedPassword intentionally omitted
      },
    });
    await autoLinkAccountToProfile(account.id);

    res.status(201).json({
      id: account.id,
      email: account.email,
      phone: account.phone ?? null,
      status: account.status,
      pollingRole: account.pollingRole,
      cookieFresh: cookieStoreHasDatadome(account.cookieStore) && !!account.lastWarmedAt && Date.now() - account.lastWarmedAt.getTime() < 12 * 60 * 60 * 1000,
      lastUsedAt: account.lastUsedAt,
      lastWarmedAt: account.lastWarmedAt,
      cookiesUpdatedAt: account.lastWarmedAt,
      cooldownUntil: account.cooldownUntil,
      profileCount: account.profileIds.length,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
    });
  } catch (err) {
    next(err);
  }
});

accountsRouter.patch('/:id/polling-role', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { role } = pollingRoleSchema.parse(req.body);
    const account = await prisma.vfsAccount.update({
      where: { id: req.params.id },
      data: { pollingRole: role },
      select: {
        id: true,
        email: true,
        phone: true,
        status: true,
        pollingRole: true,
        lastUsedAt: true,
        lastWarmedAt: true,
        cookieStore: true,
        cooldownUntil: true,
        profileIds: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    res.json({
      id: account.id,
      email: account.email,
      phone: account.phone ?? null,
      status: account.status,
      pollingRole: account.pollingRole,
      cookieFresh: cookieStoreHasDatadome(account.cookieStore) && !!account.lastWarmedAt && Date.now() - account.lastWarmedAt.getTime() < 12 * 60 * 60 * 1000,
      lastUsedAt: account.lastUsedAt,
      lastWarmedAt: account.lastWarmedAt,
      cookiesUpdatedAt: account.lastWarmedAt,
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

accountsRouter.get('/:id/password', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = await prisma.vfsAccount.findUnique({
      where: { id: req.params.id },
      select: { id: true, email: true, encryptedPassword: true },
    });
    if (!account) {
      throw new AppError(404, `VfsAccount "${req.params.id}" not found`, 'NOT_FOUND');
    }
    res.json({
      id: account.id,
      email: account.email,
      password: decrypt(account.encryptedPassword),
      expiresInSeconds: 30,
    });
  } catch (err) {
    next(err);
  }
});

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

accountsRouter.post('/:id/auto-login', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.user) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED');
    const fillOnly = Boolean((req.body as { fillOnly?: boolean } | undefined)?.fillOnly);
    const result = await loginAccount(req.params.id, fillOnly);
    res.status(result.success ? 200 : 409).json(result);
  } catch (err) {
    next(err);
  }
});

// Operator picks an account → extension opens a VFS login tab BOUND to this
// account's email. Operator logs in manually in that tab; session-sync is then
// tagged with the right account so the auto-booking orchestrator can fire.
accountsRouter.post('/:id/open-tab', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.user) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED');
    const result = await openAccountLoginTab(req.params.id);
    res.status(result.success ? 200 : 409).json(result);
  } catch (err) {
    next(err);
  }
});

// On-demand single CheckIsSlotAvailable poll via the operator's extension —
// the dashboard "Check slots now" test handle. Rate-limited by VFS, so use
// sparingly. Uses the currently-armed monitor codes (captured on the booking
// page), so it's operator-scoped, not strictly per-account.
accountsRouter.post('/check-slots', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.user) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED');
    const { triggerSlotCheck } = await import('@modules/booking/extension-dispatch.service');
    const result = await triggerSlotCheck();
    res.status(result.ok ? 200 : 409).json(result);
  } catch (err) {
    next(err);
  }
});

// Test the autonomous 5-step booking flow (BG_BOOK_VFS → runBookingSteps).
accountsRouter.post('/book-test', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.user) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED');
    const { triggerAutonomousBooking } = await import('@modules/booking/extension-dispatch.service');
    const b = (req.body ?? {}) as Record<string, unknown>;
    const result = await triggerAutonomousBooking({
      firstName: String(b.firstName ?? ''),
      lastName: String(b.lastName ?? ''),
      nationality: String(b.nationality ?? 'Uzbekistan'),
      passportNumber: String(b.passportNumber ?? ''),
      contact: String(b.contact ?? ''),
      email: String(b.email ?? ''),
      subCategory: String(b.subCategory ?? 'Uzbek'),
      confirmPauseMs: b.confirmPauseMs !== undefined ? Number(b.confirmPauseMs) : 30_000,
    });
    res.status(result.success ? 200 : 409).json(result);
  } catch (err) {
    next(err);
  }
});

// Test the SPA logout flow (BG_LOGOUT_VFS → LOGOUT_VIA_SPA avatar-menu click).
accountsRouter.post('/logout-test', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.user) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED');
    const { triggerLogout } = await import('@modules/booking/extension-dispatch.service');
    const result = await triggerLogout();
    res.status(result.success ? 200 : 409).json(result);
  } catch (err) {
    next(err);
  }
});

// ── GET /api/accounts/warmup-status ──────────────────────────────────────────
/**
 * Operator-facing pool warmup view. Returns each account with cookie freshness
 * info so the dashboard can show "Open Login Tab" prompts for stale accounts.
 *
 * - cookieFresh: lastWarmedAt within 12h
 * - loginUrl: the URL operator should open in Chrome for this account
 */

accountsRouter.get('/warmup-status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const STALE_MS = 12 * 60 * 60 * 1000;
    const now = Date.now();
    const sourceCode = (req.query.source as string | undefined) ?? 'uzb';
    const destCode = (req.query.destination as string | undefined) ?? 'lva';

    const accounts = await prisma.vfsAccount.findMany({
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        email: true,
        status: true,
        pollingRole: true,
        lastWarmedAt: true,
        cookieStore: true,
        tabUrl: true,
        lastUsedAt: true,
        cooldownUntil: true,
        profileIds: true,
      },
    });

    const items = accounts.map((a) => {
      const hasDatadome = cookieStoreHasDatadome(a.cookieStore);
      return {
        id: a.id,
        email: a.email,
        status: a.status,
        pollingRole: a.pollingRole,
        cookieFresh: hasDatadome && !!a.lastWarmedAt && now - a.lastWarmedAt.getTime() < STALE_MS,
        lastWarmedAt: a.lastWarmedAt,
        cookiesUpdatedAt: a.lastWarmedAt,
        tabUrl: a.tabUrl,
        lastUsedAt: a.lastUsedAt,
        cooldownUntil: a.cooldownUntil,
        profileCount: a.profileIds.length,
        loginUrl: `https://visa.vfsglobal.com/${sourceCode}/en/${destCode}/login`,
      };
    });

    const summary = {
      total: items.length,
      active: items.filter((i) => i.status === 'ACTIVE').length,
      fresh: items.filter((i) => i.cookieFresh).length,
      stale: items.filter((i) => i.status === 'ACTIVE' && !i.cookieFresh).length,
      blocked: items.filter((i) => i.status === 'BLOCKED').length,
      cooldown: items.filter((i) => i.status === 'COOLDOWN').length,
      pending: items.filter((i) => i.status === PENDING_STATUS).length,
    };

    res.json({ summary, items });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/accounts/auto-create ───────────────────────────────────────────
/**
 * Operator clicks "Auto-Create Account" → backend allocates email (mailsac)
 * + UZ phone (smsActivate country=171, service=vfs) + dispatches
 * BG_REGISTER_VFS_ACCOUNT to the operator's extension. Extension drives the
 * VFS /register form inside the operator's trusted Chrome (bypasses Datadome).
 * Returns once extension reports EXT_REGISTER_COMPLETED or after 5-min timeout.
 *
 * Body: { source?: 'uzb', destination?: 'lva' }
 */
accountsRouter.post('/auto-create', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.user) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED');
    const source = String(req.body?.source ?? 'uzb');
    const destination = String(req.body?.destination ?? 'lva');
    // smsActivate country codes: 171 = Uzbekistan, 0 = any
    const countryCode = String(req.body?.countryCode ?? '171');

    logEvent('info', EventType.BOOKING_ATTEMPT, 'VFS auto-register started', { source, destination, countryCode });
    const result = await autoRegisterAccount({
      source,
      destination,
      countryCode,
      operatorUserId: req.user.id,
    });

    if (result.ok) {
      logEvent('info', EventType.BOOKING_SUCCESS, 'VFS auto-register succeeded', {
        accountId: result.accountId,
        email: result.email,
      });
      res.status(201).json({ success: true, accountId: result.accountId, email: result.email });
    } else {
      logEvent('warn', EventType.BOOKING_FAILED, 'VFS auto-register failed', { reason: result.reason });
      res.status(409).json({ success: false, reason: result.reason });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logEvent('error', EventType.BOOKING_FAILED, `auto-register threw: ${message}`);
    res.status(500).json({ success: false, error: message });
  }
});

// ── POST /api/accounts/request-registration ──────────────────────────────────
/**
 * Dashboard "Create Account (nodriver)" → enqueue N registration requests. The
 * operator's register-runner (running on the clean UZ machine) drains the queue
 * one-at-a-time with throttle pacing and persists each new account. Returns the
 * new pending total. This is the reliable nodriver path (vs the extension-driven
 * /auto-create which can't pass Turnstile).
 *
 * Body: { count?: number }  (default 1, max 50)
 */
accountsRouter.post('/request-registration', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.user) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED');
    const { count } = requestRegSchema.parse(req.body ?? {});
    const pending = await setRegQueue((await getRegQueue()) + count);
    logEvent('info', EventType.BOOKING_ATTEMPT, `Queued ${count} nodriver registration(s)`, { pending });
    res.status(202).json({ success: true, queued: count, pending });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/accounts/registration-queue ─────────────────────────────────────
// Dashboard polls this to show queue depth + how many spare accounts exist.
accountsRouter.get('/registration-queue', async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const [pending, spareActive] = await Promise.all([
      getRegQueue(),
      prisma.vfsAccount.count({ where: { status: 'ACTIVE', profileIds: { isEmpty: true } } }),
    ]);
    res.json({ pending, spareActive });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/accounts/registration-queue/reset ──────────────────────────────
// Clear the queue (operator "cancel pending registrations").
accountsRouter.post('/registration-queue/reset', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.user) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED');
    await setRegQueue(0);
    res.json({ success: true, pending: 0 });
  } catch (err) {
    next(err);
  }
});

accountsRouter.post('/auto-create-batch', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.user) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED');
    const body = autoCreateBatchSchema.parse(req.body ?? {});
    const batch = accountBatchService.startBatch({
      count: body.count,
      source: body.source,
      destination: body.destination,
      countryCode: body.countryCode,
      spacingSeconds: body.spacingSeconds,
      operatorUserId: req.user.id,
    });

    logEvent('info', EventType.BOOKING_ATTEMPT, 'VFS auto-register batch queued', {
      batchId: batch.batchId,
      count: body.count,
      spacingSeconds: body.spacingSeconds,
    });

    res.status(202).json(batch);
  } catch (err) {
    next(err);
  }
});

accountsRouter.post('/auto-create-batch/:batchId/cancel', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.user) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED');
    const batch = accountBatchService.cancelBatch(req.params.batchId, req.user.id);
    if (!batch) {
      throw new AppError(404, `Auto-create batch "${req.params.batchId}" not found`, 'NOT_FOUND');
    }
    res.json(batch);
  } catch (err) {
    next(err);
  }
});

/**
 * Recover an account that was registered on VFS but failed mid-flow on our
 * side (e.g. operator clicked Register manually so EXT_REGISTER_SUBMITTED
 * never fired). For pending pool rows, the operator supplies { accountId }
 * and the backend decrypts the stored password server-side. The legacy
 * { email, password, phone?, smsExternalId? } body is still supported.
 *
 * Body: { accountId } or { email, password, phone?, smsExternalId? }
 */
accountsRouter.post('/recover-from-mailsac', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.user) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED');
    const accountId = req.body?.accountId ? String(req.body.accountId) : null;
    let email = String(req.body?.email ?? '').trim();
    let password = String(req.body?.password ?? '');
    let phone = req.body?.phone ? String(req.body.phone) : null;
    let smsExternalId = req.body?.smsExternalId ? String(req.body.smsExternalId) : null;
    let existingAccount: {
      id: string;
      email: string;
      encryptedPassword: string;
      phone: string | null;
      smsExternalId: string | null;
      status: AccountStatus;
    } | null = null;

    if (accountId) {
      existingAccount = await prisma.vfsAccount.findUnique({
        where: { id: accountId },
        select: {
          id: true,
          email: true,
          encryptedPassword: true,
          phone: true,
          smsExternalId: true,
          status: true,
        },
      });
      if (!existingAccount) {
        res.status(404).json({ success: false, reason: 'ACCOUNT_NOT_FOUND' });
        return;
      }
      email = existingAccount.email;
      password = decrypt(existingAccount.encryptedPassword);
      phone = existingAccount.phone;
      smsExternalId = existingAccount.smsExternalId;
    }

    if (!email || !password) {
      res.status(400).json({ success: false, reason: 'EMAIL_AND_PASSWORD_REQUIRED' });
      return;
    }

    logEvent('info', EventType.BOOKING_ATTEMPT, `[RECOVER] polling Mailsac for ${email}`);
    const link = await fetchEmailVerificationLink(email);
    if (!link) {
      res.status(409).json({ success: false, reason: 'EMAIL_LINK_NOT_RECEIVED' });
      return;
    }

    // Preferred path: the operator's extension opens the link in a real Chrome
    // tab on its clean UZ IP and confirms activation. The old BrightData HTTP
    // visit returned status=0 (proxy never landed on VFS) yet the account was
    // marked ACTIVE anyway — a fake activation. We mark ACTIVE only on a
    // CONFIRMED success in either path.
    const operatorId = process.env.OPERATOR_USER_ID;
    const operatorLive = operatorId ? isExtensionLive(operatorId) : false;
    if (operatorLive) {
      logEvent('info', EventType.BOOKING_ATTEMPT, `[RECOVER] visiting link for ${email} (via operator extension)`);
      const { triggerActivationVisit } = await import('@modules/booking/extension-dispatch.service');
      const visit = await triggerActivationVisit(link);
      logEvent('info', EventType.BOOKING_ATTEMPT, `[RECOVER] extension activation visit success=${visit.success} reason=${visit.reason ?? ''}`);
      if (!visit.success) {
        logEvent('warn', EventType.BOOKING_FAILED, `[RECOVER] activation NOT confirmed for ${email} (${visit.reason ?? 'unknown'}) — not marking ACTIVE`);
        res.status(409).json({ success: false, reason: `EMAIL_LINK_VISIT_FAILED_${visit.reason ?? 'EXTENSION'}` });
        return;
      }
    } else {
      logEvent('info', EventType.BOOKING_ATTEMPT, `[RECOVER] visiting link for ${email} (via BrightData fallback)`);
      const visit = await visitActivationLink(link).catch((e) => ({ status: 0, err: (e as Error).message }));
      logEvent('info', EventType.BOOKING_ATTEMPT, `[RECOVER] activation link response status=${visit.status}`);
      // The activation only counts if the link visit genuinely succeeded (2xx/3xx).
      // status=0 means the request never landed (BrightData proxy failed / blocked)
      // — marking the account ACTIVE on a status=0 produced "ACTIVE in our DB but
      // VFS says inactive" (fake activations). Require a real success status.
      const visitStatus = ('status' in visit && typeof visit.status === 'number') ? visit.status : 0;
      if (visitStatus < 200 || visitStatus >= 400) {
        logEvent('warn', EventType.BOOKING_FAILED, `[RECOVER] activation NOT confirmed for ${email} (status=${visitStatus}) — not marking ACTIVE`);
        res.status(409).json({ success: false, reason: `EMAIL_LINK_VISIT_FAILED_${visitStatus || 'NO_RESPONSE'}` });
        return;
      }
    }

    const existing = existingAccount ?? await prisma.vfsAccount.findUnique({ where: { email } });
    if (existing) {
      const account = await prisma.vfsAccount.update({
        where: { id: existing.id },
        data: {
          status: existing.status === PENDING_STATUS ? AccountStatus.ACTIVE : existing.status,
          phone: phone ?? existing.phone,
          smsExternalId: smsExternalId ?? existing.smsExternalId,
          ...(req.body?.password ? { encryptedPassword: encrypt(password) } : {}),
        },
        select: { id: true, email: true },
      });
      logEvent('info', EventType.BOOKING_SUCCESS, `[RECOVER] account activated ${account.email}`);
      res.status(200).json({ success: true, accountId: account.id, email: account.email, note: 'ACTIVATED_EXISTING' });
      return;
    }

    const account = await prisma.vfsAccount.create({
      data: {
        email,
        encryptedPassword: encrypt(password),
        phone,
        smsExternalId,
        status: 'ACTIVE',
      },
      select: { id: true, email: true },
    });
    await autoLinkAccountToProfile(account.id);
    logEvent('info', EventType.BOOKING_SUCCESS, `[RECOVER] account persisted ${account.email}`);
    res.status(201).json({ success: true, accountId: account.id, email: account.email });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logEvent('error', EventType.BOOKING_FAILED, `recover-from-mailsac threw: ${message}`);
    res.status(500).json({ success: false, error: message });
  }
});

// ── POST /api/accounts/inject-cookies ────────────────────────────────────────
/**
 * Operator-driven session injection. Operator logs into VFS in their own
 * Chrome, exports the cookies (DevTools → Application → Cookies → Copy All),
 * pastes the JSON into the dashboard. We store the session as a VfsAccount
 * row so the backend monitor can use it for slot polling via the IPRoyal UZ
 * proxy.
 *
 * Body:
 * {
 *   email: string,            // VFS account email
 *   password?: string,        // optional; useful for re-login if cookies expire
 *   cookies: Array<{ name, value, domain, path, secure, httpOnly, sameSite, expirationDate }>
 *   tabUrl?: string           // e.g. https://visa.vfsglobal.com/uzb/en/lva/dashboard
 * }
 */
const injectCookiesSchema = z.object({
  email: z.string().email(),
  password: z.string().optional(),
  cookies: z.array(z.object({
    name: z.string(),
    value: z.string(),
    domain: z.string().optional(),
    path: z.string().optional(),
    secure: z.boolean().optional(),
    httpOnly: z.boolean().optional(),
    sameSite: z.string().optional(),
    expirationDate: z.number().optional(),
  })).min(1, 'cookies array cannot be empty'),
  tabUrl: z.string().url().optional(),
});

accountsRouter.post('/inject-cookies', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = injectCookiesSchema.parse(req.body);
    const now = new Date();
    const hasDatadome = cookieStoreHasDatadome(body.cookies);

    const existing = await prisma.vfsAccount.findUnique({ where: { email: body.email } });

    const account = existing
      ? await prisma.vfsAccount.update({
          where: { email: body.email },
          data: {
            cookieStore: body.cookies as never,
            lastWarmedAt: hasDatadome ? now : existing.lastWarmedAt,
            tabUrl: body.tabUrl ?? existing.tabUrl,
            status: hasDatadome ? 'ACTIVE' : existing.status,
            ...(body.password ? { encryptedPassword: encrypt(body.password) } : {}),
          },
          select: { id: true, email: true, status: true, lastWarmedAt: true },
        })
      : await prisma.vfsAccount.create({
          data: {
            email: body.email,
            encryptedPassword: encrypt(body.password ?? ''),
            cookieStore: body.cookies as never,
            lastWarmedAt: hasDatadome ? now : null,
            tabUrl: body.tabUrl ?? null,
            status: 'ACTIVE',
          },
          select: { id: true, email: true, status: true, lastWarmedAt: true },
        });

    logEvent('info', EventType.MONITOR_STARTED, `VFS cookies injected for ${account.email} (${body.cookies.length} cookies)`);

    // This HTTP cookie-push is the active warm path. Arm the auto-booking
    // orchestrator whenever the tab is on a logged-in page — NOT gated on the
    // datadome cookie: booking runs as UI clicks in the already-logged-in tab,
    // which doesn't need datadome (that's only for backend lift-api polling).
    // The orchestrator's own looksLoggedIn(url) is the real gate. No-op unless
    // AUTO_BOOK_ON_TAB_ENABLED.
    {
      const { onLoggedInTab } = await import('@modules/booking/autoBooking.orchestrator');
      void onLoggedInTab(
        { id: account.id, email: account.email, tabUrl: body.tabUrl ?? null },
        body.tabUrl ?? '',
      );
    }

    res.json({
      success: true,
      accountId: account.id,
      email: account.email,
      cookiesCount: body.cookies.length,
      lastWarmedAt: account.lastWarmedAt,
    });
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
