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
import { getSetting } from '@modules/settings/settings.service';
import type { BookingJobPayload } from '@t/index';

const DISPATCH_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes per booking
const STALE_THRESHOLD_MS = 12 * 60 * 60 * 1000; // 12h cookie freshness
const DEFAULT_ACCOUNT_COOLDOWN_MS = 60 * 60 * 1000; // 60min for a 429001 account flag

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
 * Dispatch the NEW autonomous 5-step booking (BG_BOOK_VFS → runBookingSteps in
 * the extension) and await the EXT_BOOKING result. Used for testing the
 * hands-off booking end to end.
 */
export interface AutonomousBookingInput {
  firstName: string;
  lastName: string;
  nationality: string;
  passportNumber: string;
  contact: string;
  email: string;
  subCategory: string;
  confirmPauseMs?: number;
  // Target a specific account's open tab (parallel multi-account booking).
  accountEmail?: string;
  accountTabUrl?: string;
}

// ── Logout dispatch (BG_LOGOUT_VFS → LOGOUT_VIA_SPA in the extension) ────────
export interface ExtensionLogoutResult {
  success: boolean;
  reason?: string;
}

interface PendingLogout {
  resolve: (result: ExtensionLogoutResult) => void;
  timer: NodeJS.Timeout;
}

const pendingLogout = new Map<string, PendingLogout>();

/** Called by the extension event handler when EXT_LOGOUT_SUCCESS/FAILED arrives. */
export function resolveExtensionLogout(correlationId: string, result: ExtensionLogoutResult): void {
  const slot = pendingLogout.get(correlationId);
  if (!slot) return;
  pendingLogout.delete(correlationId);
  clearTimeout(slot.timer);
  slot.resolve(result);
}

/**
 * Dispatch a logout (BG_LOGOUT_VFS → LOGOUT_VIA_SPA, SPA avatar-menu click in
 * the extension) and await the EXT_LOGOUT result. Used to test hands-off logout.
 */
export async function triggerLogout(): Promise<ExtensionLogoutResult> {
  const operatorId = await resolveOperatorUserId();
  if (!operatorId) return { success: false, reason: 'NO_OPERATOR_CONNECTED' };
  const { sendToExtension, isExtensionLive, listExtensionConnections } = await import('@modules/websocket/ws.server');
  if (!isExtensionLive(operatorId)) {
    return {
      success: false,
      reason: `OPERATOR_EXTENSION_OFFLINE (operatorId=${operatorId}; live keys=[${listExtensionConnections().join(', ')}])`,
    };
  }
  const correlationId = randomUUID();
  const accepted = sendToExtension(operatorId, { type: 'BG_LOGOUT_VFS', correlationId });
  if (!accepted) return { success: false, reason: 'OPERATOR_EXTENSION_OFFLINE' };
  return new Promise<ExtensionLogoutResult>((resolve) => {
    const timer = setTimeout(() => {
      pendingLogout.delete(correlationId);
      resolve({ success: false, reason: 'LOGOUT_TIMEOUT' });
    }, 60_000);
    pendingLogout.set(correlationId, { resolve, timer });
  });
}

// ── Activation-link visit dispatch (BG_VISIT_ACTIVATION_LINK in the extension) ─
// The extension opens the VFS activation link in a real Chrome tab on the
// operator's clean UZ IP and confirms activation, replacing the BrightData
// HTTP visit that returned status=0 and falsely marked accounts ACTIVE.
export interface ExtensionActivationVisitResult {
  success: boolean;
  reason?: string;
}

interface PendingActivationVisit {
  resolve: (result: ExtensionActivationVisitResult) => void;
  timer: NodeJS.Timeout;
}

const pendingActivationVisit = new Map<string, PendingActivationVisit>();

/** Called by the extension event handler when EXT_ACTIVATION_VISIT_SUCCESS/FAILED arrives. */
export function resolveActivationVisit(correlationId: string, result: ExtensionActivationVisitResult): void {
  const slot = pendingActivationVisit.get(correlationId);
  if (!slot) return;
  pendingActivationVisit.delete(correlationId);
  clearTimeout(slot.timer);
  slot.resolve(result);
}

// ── On-demand slot check (dashboard "Check slots now") ──────────────────────
export interface SlotCheckResult {
  ok: boolean;
  status?: number;
  earliestDate?: string;
  data?: unknown;
  reason?: string;
}

interface PendingSlotCheck {
  resolve: (result: SlotCheckResult) => void;
  timer: NodeJS.Timeout;
}

const pendingSlotCheck = new Map<string, PendingSlotCheck>();

/** Called by the extension event handler when EXT_SLOT_CHECK_RESULT arrives. */
export function resolveSlotCheck(correlationId: string, result: SlotCheckResult): void {
  const slot = pendingSlotCheck.get(correlationId);
  if (!slot) return;
  pendingSlotCheck.delete(correlationId);
  clearTimeout(slot.timer);
  slot.resolve(result);
}

/** Run ONE CheckIsSlotAvailable poll via the operator's extension (uses the
 *  currently-armed monitor codes). Awaits the result with a 30s timeout. */
export async function triggerSlotCheck(): Promise<SlotCheckResult> {
  const operatorId = await resolveOperatorUserId();
  if (!operatorId) return { ok: false, reason: 'NO_OPERATOR_CONNECTED' };
  const { sendToExtension, isExtensionLive } = await import('@modules/websocket/ws.server');
  if (!isExtensionLive(operatorId)) return { ok: false, reason: 'OPERATOR_EXTENSION_OFFLINE' };
  const correlationId = randomUUID();
  const accepted = sendToExtension(operatorId, { type: 'BG_CHECK_SLOTS_NOW', correlationId });
  if (!accepted) return { ok: false, reason: 'OPERATOR_EXTENSION_OFFLINE' };
  return new Promise<SlotCheckResult>((resolve) => {
    const timer = setTimeout(() => {
      pendingSlotCheck.delete(correlationId);
      resolve({ ok: false, reason: 'SLOT_CHECK_TIMEOUT' });
    }, 30_000);
    pendingSlotCheck.set(correlationId, { resolve, timer });
  });
}

/**
 * Ask the operator's extension to open the activation link in its own Chrome
 * tab (clean UZ IP) and confirm activation. Awaits the EXT_ACTIVATION_VISIT
 * result with a 60s timeout.
 */
export async function triggerActivationVisit(link: string): Promise<ExtensionActivationVisitResult> {
  const operatorId = await resolveOperatorUserId();
  if (!operatorId) return { success: false, reason: 'NO_OPERATOR_CONNECTED' };
  const { sendToExtension, isExtensionLive, listExtensionConnections } = await import('@modules/websocket/ws.server');
  if (!isExtensionLive(operatorId)) {
    return {
      success: false,
      reason: `OPERATOR_EXTENSION_OFFLINE (operatorId=${operatorId}; live keys=[${listExtensionConnections().join(', ')}])`,
    };
  }
  const correlationId = randomUUID();
  const accepted = sendToExtension(operatorId, { type: 'BG_VISIT_ACTIVATION_LINK', correlationId, link });
  if (!accepted) return { success: false, reason: 'OPERATOR_EXTENSION_OFFLINE' };
  return new Promise<ExtensionActivationVisitResult>((resolve) => {
    const timer = setTimeout(() => {
      pendingActivationVisit.delete(correlationId);
      resolve({ success: false, reason: 'ACTIVATION_VISIT_TIMEOUT' });
    }, 60_000);
    pendingActivationVisit.set(correlationId, { resolve, timer });
  });
}

export async function triggerAutonomousBooking(input: AutonomousBookingInput): Promise<ExtensionBookingResult> {
  const operatorId = await resolveOperatorUserId();
  if (!operatorId) return { success: false, reason: 'NO_OPERATOR_CONNECTED' };
  const { sendToExtension, isExtensionLive, listExtensionConnections } = await import('@modules/websocket/ws.server');
  // Booking is time-sensitive — don't queue it for a phantom socket and wait
  // 250s. If the operator's extension isn't live under this exact key, fail
  // fast with the keys we DO have so the mismatch is obvious.
  if (!isExtensionLive(operatorId)) {
    return {
      success: false,
      reason: `OPERATOR_EXTENSION_OFFLINE (operatorId=${operatorId}; live keys=[${listExtensionConnections().join(', ')}])`,
    };
  }
  const correlationId = randomUUID();
  const accepted = sendToExtension(operatorId, { type: 'BG_BOOK_VFS', payload: { ...input, correlationId } });
  if (!accepted) return { success: false, reason: 'OPERATOR_EXTENSION_OFFLINE' };
  return new Promise<ExtensionBookingResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(correlationId);
      resolve({ success: false, reason: 'BOOKING_TIMEOUT' });
    }, 250_000);
    pending.set(correlationId, { resolve, reject, timer });
  });
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
      // Hard IP/bot ban — sit the account out for a day.
      await prisma.vfsAccount.update({
        where: { id: account.id },
        data: {
          status: 'COOLDOWN',
          cooldownUntil: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
      });
    } else if (/429001|account.*lock|too many attempts/i.test(r)) {
      // VFS account-level throttle (429001) — cool the flagged account so the
      // next booking auto-swaps to a different ACTIVE account. Not an IP issue,
      // so we do NOT rotate the proxy. Returns to rotation after the cooldown.
      const cooldownMs = (await getSetting<number>('account.cooldownMs')) ?? DEFAULT_ACCOUNT_COOLDOWN_MS;
      await prisma.vfsAccount.update({
        where: { id: account.id },
        data: {
          status: 'COOLDOWN',
          cooldownUntil: new Date(Date.now() + cooldownMs),
        },
      });
      logEvent('warn', EventType.BOOKING_FAILED,
        `[AUTO-BOOK] account ${account.email} flagged (429001) → COOLDOWN ${Math.round(cooldownMs / 60000)}m, swapping`,
        { accountEmail: account.email });
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
