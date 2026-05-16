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
import { EventType } from '@prisma/client';
import { decrypt } from '@utils/crypto';
import { accountPoolService } from '@modules/accounts/accountPool.service';
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
  // 1. Pick an account from the pool (LRU + ACTIVE only).
  let account;
  try {
    account = await accountPoolService.getAvailableAccount();
  } catch (err) {
    return { success: false, reason: 'NO_ACTIVE_ACCOUNTS_IN_POOL' };
  }

  // 2. Check session freshness — extension can only book if a recent SESSION_SYNC came in.
  const lastWarmedAt = (account as any).lastWarmedAt as Date | null | undefined;
  const cookieStore = (account as any).cookieStore;
  if (!cookieStore || !lastWarmedAt || Date.now() - new Date(lastWarmedAt).getTime() > STALE_THRESHOLD_MS) {
    await accountPoolService.markCooldown(account.id, 60); // 1h cooldown — operator needs to re-warm
    return { success: false, reason: 'ACCOUNT_STALE', accountEmail: account.email };
  }

  // 3. Load customer profile (passport data).
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
      await accountPoolService.markCooldown(account.id, 24 * 60); // 24h cooldown
    }
  }

  return { ...result, accountEmail: account.email };
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
