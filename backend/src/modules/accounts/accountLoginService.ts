import crypto from 'crypto';
import cron from 'node-cron';
import { AccountStatus, EventType, Role } from '@prisma/client';
import { prisma } from '@config/database';
import { AppError } from '@middleware/errorHandler';
import { solveTurnstile } from '@modules/captcha/twoCaptcha';
import { logEvent } from '@modules/logs/logger';
import { sendToExtension } from '@modules/websocket/ws.server';
import { decrypt } from '@utils/crypto';

const LOGIN_TIMEOUT_MS = 90_000;
const CRON_STALE_MS = 10 * 60 * 60 * 1000;

type LoginResult =
  | { success: true; accountId: string; email: string; lastWarmedAt: Date | null }
  | { success: false; accountId: string; email: string; reason: string };

type PendingLogin = {
  accountId: string;
  email: string;
  timer: NodeJS.Timeout;
  resolve: (result: LoginResult) => void;
};

const pendingLogins = new Map<string, PendingLogin>();
let cronStarted = false;
let cronRunning = false;

export async function loginAccount(accountId: string): Promise<LoginResult> {
  const account = await prisma.vfsAccount.findUnique({
    where: { id: accountId },
    select: { id: true, email: true, encryptedPassword: true, status: true },
  });
  if (!account) {
    throw new AppError(404, `VfsAccount "${accountId}" not found`, 'NOT_FOUND');
  }
  if (account.status === AccountStatus.BLOCKED) {
    return { success: false, accountId: account.id, email: account.email, reason: 'ACCOUNT_BLOCKED' };
  }

  const operatorUserId = await resolveOperatorUserId();
  if (!operatorUserId) {
    return { success: false, accountId: account.id, email: account.email, reason: 'OPERATOR_NOT_FOUND' };
  }

  const correlationId = crypto.randomUUID();
  const loginUrl = 'https://visa.vfsglobal.com/uzb/en/lva/login';
  const accepted = sendToExtension(operatorUserId, {
    type: 'BG_LOGIN_VFS_ACCOUNT',
    email: account.email,
    password: decrypt(account.encryptedPassword),
    loginUrl,
    correlationId,
  });
  if (!accepted) {
    return { success: false, accountId: account.id, email: account.email, reason: 'OPERATOR_EXTENSION_OFFLINE' };
  }

  logEvent('info', EventType.BOOKING_ATTEMPT, `[LOGIN] dispatched auto-login for ${account.email}`, {
    accountId: account.id,
    correlationId,
  });

  return new Promise<LoginResult>((resolve) => {
    const timer = setTimeout(() => {
      pendingLogins.delete(correlationId);
      resolve({ success: false, accountId: account.id, email: account.email, reason: 'LOGIN_TIMEOUT' });
    }, LOGIN_TIMEOUT_MS);
    pendingLogins.set(correlationId, { accountId: account.id, email: account.email, timer, resolve });
  });
}

export async function handleLoginNeedsCaptcha(
  operatorUserId: string,
  event: { correlationId: string; siteKey: string; pageUrl: string },
): Promise<void> {
  logEvent('info', EventType.BOOKING_ATTEMPT,
    `[LOGIN] Turnstile requested for correlation ${event.correlationId.slice(0, 8)}`);
  let token: string | null = null;
  try {
    token = await solveTurnstile(event.siteKey, event.pageUrl);
  } catch (err) {
    logEvent('warn', EventType.BOOKING_FAILED, `[LOGIN] Turnstile solve failed: ${(err as Error).message}`);
  }
  sendToExtension(operatorUserId, {
    type: 'BG_LOGIN_CAPTCHA_TOKEN',
    correlationId: event.correlationId,
    token,
  });
}

export async function resolveLoginSuccess(correlationId: string): Promise<void> {
  const pending = pendingLogins.get(correlationId);
  if (!pending) return;
  pendingLogins.delete(correlationId);
  clearTimeout(pending.timer);
  const account = await prisma.vfsAccount.findUnique({
    where: { id: pending.accountId },
    select: { lastWarmedAt: true },
  });
  logEvent('info', EventType.BOOKING_SUCCESS, `[LOGIN] auto-login succeeded for ${pending.email}`, {
    accountId: pending.accountId,
    correlationId,
  });
  pending.resolve({
    success: true,
    accountId: pending.accountId,
    email: pending.email,
    lastWarmedAt: account?.lastWarmedAt ?? null,
  });
}

export function resolveLoginFailed(correlationId: string, reason: string): void {
  const pending = pendingLogins.get(correlationId);
  if (!pending) return;
  pendingLogins.delete(correlationId);
  clearTimeout(pending.timer);
  logEvent('warn', EventType.BOOKING_FAILED, `[LOGIN] auto-login failed for ${pending.email}: ${reason}`, {
    accountId: pending.accountId,
    correlationId,
  });
  pending.resolve({
    success: false,
    accountId: pending.accountId,
    email: pending.email,
    reason,
  });
}

export function startAccountLoginCron(): void {
  if (cronStarted) return;
  cronStarted = true;
  cron.schedule('0 */6 * * *', () => {
    void refreshStaleActiveAccounts().catch((err) => {
      logEvent('error', EventType.BOOKING_FAILED, `[LOGIN-CRON] refresh failed: ${(err as Error).message}`);
    });
  });
}

export async function refreshStaleActiveAccounts(): Promise<{ attempted: number; succeeded: number; failed: number }> {
  if (cronRunning) return { attempted: 0, succeeded: 0, failed: 0 };
  cronRunning = true;
  let attempted = 0;
  let succeeded = 0;
  let failed = 0;
  try {
    const staleBefore = new Date(Date.now() - CRON_STALE_MS);
    const accounts = await prisma.vfsAccount.findMany({
      where: {
        status: AccountStatus.ACTIVE,
        OR: [{ lastWarmedAt: null }, { lastWarmedAt: { lt: staleBefore } }],
      },
      orderBy: { lastWarmedAt: 'asc' },
      select: { id: true, email: true },
    });

    for (const account of accounts) {
      attempted += 1;
      const result = await loginAccount(account.id);
      if (result.success) succeeded += 1;
      else failed += 1;
    }
    if (attempted > 0) {
      logEvent('info', EventType.BOOKING_ATTEMPT,
        `[LOGIN-CRON] refreshed stale accounts attempted=${attempted} succeeded=${succeeded} failed=${failed}`);
    }
    return { attempted, succeeded, failed };
  } finally {
    cronRunning = false;
  }
}

async function resolveOperatorUserId(): Promise<string | undefined> {
  if (process.env.OPERATOR_USER_ID) return process.env.OPERATOR_USER_ID;
  const admin = await prisma.user.findFirst({
    where: { role: Role.ADMIN },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  return admin?.id;
}
