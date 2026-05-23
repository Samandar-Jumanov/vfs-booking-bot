/**
 * Bridge between BullMQ booking worker and the Chrome extension running on the
 * operator's machine. Instead of driving Chrome via CDP server-side (which
 * Datadome blocks in 2026), we ask the operator's extension — running inside
 * a real Chrome session that already passed Datadome — to do the booking
 * inside its own browser.
 *
 * Flow:
 *   1. Worker picks an ACTIVE VFS account from the pool (least-recently-used).
 *   2. We send BOOK_FOR_CUSTOMER over WS to the extension with:
 *        - target accountEmail (which tab to drive)
 *        - customer's passport data (what to fill in the form)
 *        - destination + visaType + slot
 *        - correlationId (so we can match the async response)
 *   3. Extension picks the right Chrome tab, content script fills + submits.
 *   4. Extension posts EXT_BOOKING_COMPLETED or EXT_BOOKING_FAILED with
 *      correlationId. We resolve the pending promise here.
 */
import { randomUUID } from 'crypto';
import { prisma } from '@config/database';
import { logEvent } from '@modules/logs/logger';
import { EventType, PollingRole, type VfsAccount } from '@prisma/client';
import { decrypt } from '@utils/crypto';
import type { BookingJobPayload } from '@t/index';

const DISPATCH_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes per booking
const STALE_THRESHOLD_MS = 12 * 60 * 60 * 1000; // 12h cookie freshness

interface PendingDispatch {
  resolve: (result: ExtensionBookingResult) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface ExtensionBookingResult {
  success: boolean;
  confirmationNumber?: string;
  reason?: string;
  accountEmail?: string;
  dryRun?: boolean;
  screenshotPath?: string;
}

const pending = new Map<string, PendingDispatch>();

/**
 * Called by the extension event handler when the extension reports back via WS.
 */
export function resolveExtensionBooking(correlationId: string, result: ExtensionBookingResult): void {
  const slot = pending.get(correlationId);
  if (!slot) return;
  pending.delete(correlationId);
  clearTimeout(slot.timer);
  slot.resolve(result);
}

/**
 * Picks the next available pool account and dispatches the booking to the
 * extension. Returns the final outcome when the extension responds (or
 * timeout / no extension connected).
 */
export async function bookViaExtension(payload: BookingJobPayload): Promise<ExtensionBookingResult> {
  // 1. Pick an ACTIVE account with a fresh Datadome session.
  const account = await selectFreshBookerAccount(payload.profileId, payload.pollerAccountEmail);
  if (!account) {
    return { success: false, reason: 'NO_COOKIE_FRESH_ACTIVE_ACCOUNTS' };
  }
  // 2. Load customer profile (passport data).
  const profile = await prisma.profile.findUnique({ where: { id: payload.profileId } });
  if (!profile) return { success: false, reason: 'PROFILE_NOT_FOUND' };

  const passportNumber = profile.passportNumberEnc ? safeDecrypt(profile.passportNumberEnc) : '';
  const dob = profile.dobEnc ? safeDecrypt(profile.dobEnc) : '';
  const [firstName, ...rest] = profile.fullName.split(' ');
  const lastName = rest.join(' ').trim() || firstName;

  // 4. Resolve operator's WS connection. Use OPERATOR_USER_ID env, fall back to first ADMIN.
  const operatorId = await resolveOperatorUserId();
  if (!operatorId) {
    return { success: false, reason: 'NO_OPERATOR_CONNECTED' };
  }

  // Lazy-import to avoid circular deps with ws.server.ts.
  const { sendToExtension } = await import('@modules/websocket/ws.server');

  const correlationId = randomUUID();
  const message = {
    type: 'BOOK_FOR_CUSTOMER',
    accountEmail: account.email,
    accountTabUrl: (account as any).tabUrl,
    destination: payload.destination,
    visaType: payload.visaType,
    slot: { date: payload.slot?.date, time: payload.slot?.time },
    payload: {
      firstName,
      lastName,
      passportNumber,
      dob,
      nationality: profile.nationality,
      email: profile.email,
      phone: profile.phone,
      passportExpiry: profile.passportExpiry.toISOString().slice(0, 10),
    },
    correlationId,
  };

  // 5. Register pending promise + send.
  const result = await new Promise<ExtensionBookingResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(correlationId);
      resolve({ success: false, reason: 'EXTENSION_TIMEOUT', accountEmail: account.email });
    }, DISPATCH_TIMEOUT_MS);
    pending.set(correlationId, { resolve, reject, timer });

    const sent = sendToExtension(operatorId, message);
    if (!sent) {
      clearTimeout(timer);
      pending.delete(correlationId);
      resolve({ success: false, reason: 'EXTENSION_NOT_CONNECTED', accountEmail: account.email });
    }
  });

  // 6. Update account status based on result.
  if (!result.success) {
    const r = result.reason || '';
    if (/403|datadome|blocked|forbidden/i.test(r)) {
      await prisma.vfsAccount.update({
        where: { id: account.id },
        data: {
          status: 'COOLDOWN',
          cooldownUntil: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
      });
    }
  }

  return { ...result, accountEmail: account.email };
}

export async function selectFreshBookerAccount(profileId: string, pollerAccountEmail?: string | null): Promise<VfsAccount | null> {
  const now = new Date();
  const staleCutoff = new Date(Date.now() - STALE_THRESHOLD_MS);

  await prisma.vfsAccount.updateMany({
    where: {
      status: 'COOLDOWN',
      cooldownUntil: { lte: now },
    },
    data: {
      status: 'ACTIVE',
      cooldownUntil: null,
    },
  });

  const baseWhere = {
    status: 'ACTIVE' as const,
    pollingRole: { in: [PollingRole.BOOKER, PollingRole.BOTH] },
    lastWarmedAt: { gte: staleCutoff },
    cookieStore: { not: null as never },
  };

  const candidates = await prisma.vfsAccount.findMany({
    where: pollerAccountEmail ? { ...baseWhere, email: { not: pollerAccountEmail } } : baseWhere,
    orderBy: [{ lastUsedAt: 'asc' }, { lastWarmedAt: 'desc' }],
    take: 25,
  });

  let account: (typeof candidates)[number] | null =
    candidates.find((candidate) => candidate.profileIds.includes(profileId)) ?? candidates[0] ?? null;
  if (!account && pollerAccountEmail) {
    account = await prisma.vfsAccount.findFirst({
      where: { ...baseWhere, email: pollerAccountEmail },
      orderBy: [{ lastUsedAt: 'asc' }, { lastWarmedAt: 'desc' }],
    });
    if (account) {
      logEvent('warn', EventType.BOOKING_ATTEMPT, 'BOOKING_ON_POLLER_ACCOUNT', {
        profileId,
        accountEmail: account.email,
      });
    }
  }

  if (!account || !String(JSON.stringify(account.cookieStore)).match(/datadome/i)) return null;
  await prisma.vfsAccount.update({
    where: { id: account.id },
    data: { lastUsedAt: now },
  }).catch(() => undefined);
  return account;
}

async function resolveOperatorUserId(): Promise<string | undefined> {
  if (process.env.OPERATOR_USER_ID) return process.env.OPERATOR_USER_ID;
  const admin = await prisma.user.findFirst({
    where: { role: 'ADMIN' },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  if (!admin) {
    logEvent('warn', EventType.BOOKING_FAILED, '[ExtDispatch] No OPERATOR_USER_ID set and no ADMIN user found');
    return undefined;
  }
  return admin.id;
}

function safeDecrypt(value: string): string {
  try {
    return decrypt(value);
  } catch {
    return '';
  }
}
