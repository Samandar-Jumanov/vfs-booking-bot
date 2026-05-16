import { dispatchNotification } from '@modules/notifications/notification.service';
import { prisma } from '@config/database';
import { sendToExtension } from '@modules/websocket/ws.server';
import { AccountStatus, Role } from '@prisma/client';
import { decrypt } from '@utils/crypto';
import crypto from 'crypto';

export interface ExtensionConnectionState {
  customerId: string;
  customerEmail: string;
  connected: boolean;
  connectedAt?: string;
  lastHeartbeatAt?: string;
}

const extensionStates = new Map<string, ExtensionConnectionState>();

export function markExtensionConnected(customerId: string, customerEmail: string): ExtensionConnectionState {
  const state: ExtensionConnectionState = {
    customerId,
    customerEmail,
    connected: true,
    connectedAt: new Date().toISOString(),
    lastHeartbeatAt: new Date().toISOString(),
  };
  extensionStates.set(customerId, state);
  return state;
}

export function markExtensionDisconnected(customerId: string): void {
  const current = extensionStates.get(customerId);
  if (!current) return;
  extensionStates.set(customerId, { ...current, connected: false });
}

export function markExtensionHeartbeat(customerId: string): ExtensionConnectionState | undefined {
  const current = extensionStates.get(customerId);
  if (!current) return undefined;
  const next = { ...current, connected: true, lastHeartbeatAt: new Date().toISOString() };
  extensionStates.set(customerId, next);
  return next;
}

export function getExtensionState(customerId: string): ExtensionConnectionState | undefined {
  return extensionStates.get(customerId);
}

export async function dispatchBookingToExtension(opts: {
  customerId: string;
  accountId: string;
  destination: string;
  visaType: string;
  slot: { date?: string; time?: string };
}): Promise<{ accepted: boolean; reason?: string }> {
  const profile = await prisma.profile.findUnique({ where: { id: opts.customerId } });
  if (!profile) return { accepted: false, reason: 'CUSTOMER_NOT_FOUND' };

  const account = await prisma.vfsAccount.findUnique({ where: { id: opts.accountId } });
  if (!account) return { accepted: false, reason: 'ACCOUNT_NOT_FOUND' };

  const staleCutoffMs = Date.now() - 12 * 60 * 60 * 1000;
  if (!account.cookieStore || !account.lastWarmedAt || account.lastWarmedAt.getTime() < staleCutoffMs) {
    return { accepted: false, reason: 'ACCOUNT_STALE' };
  }

  const operatorCustomerId = await resolveOperatorCustomerId();
  if (!operatorCustomerId) return { accepted: false, reason: 'OPERATOR_NOT_FOUND' };

  const [firstName, ...lastNameParts] = profile.fullName.trim().split(/\s+/);
  const accepted = sendToExtension(operatorCustomerId, {
    type: 'BOOK_FOR_CUSTOMER',
    accountEmail: account.email,
    accountTabUrl: account.tabUrl ?? undefined,
    destination: opts.destination,
    visaType: opts.visaType,
    slot: opts.slot,
    payload: {
      firstName: firstName ?? '',
      lastName: lastNameParts.join(' '),
      passportNumber: decrypt(profile.passportNumberEnc),
      dob: decrypt(profile.dobEnc),
      nationality: profile.nationality,
      email: profile.email,
      phone: profile.phone,
    },
    correlationId: crypto.randomUUID(),
  });

  return accepted ? { accepted: true } : { accepted: false, reason: 'OPERATOR_EXTENSION_OFFLINE' };
}

export async function handleExtensionEvent(customerId: string, event: { type?: string; [key: string]: unknown }): Promise<void> {
  if (event.type === 'EXT_HEARTBEAT') {
    markExtensionHeartbeat(customerId);
    return;
  }

  if (event.type === 'EXT_SESSION_SYNC') {
    const url = String(event.url ?? '');
    const email = String(event.email ?? '');
    const cookies = String(event.cookies ?? '');
    const cookieJar = Array.isArray(event.cookieJar) ? event.cookieJar : null;
    if (!email || (!cookies && !cookieJar)) return;
    const acc = await prisma.vfsAccount.findFirst({ where: { email } });
    if (!acc) {
      console.info(`[EXT_SESSION_SYNC] No account row for ${email}; skipping (operator must add)`);
      return;
    }
    // Validate we actually have a Datadome trust cookie before marking the
    // account warm — without it, bookings will hit lift-api 403.
    const hasDatadome = cookieJar?.some((c: any) => /datadome/i.test(String(c?.name ?? ''))) ?? /datadome/i.test(cookies);
    await prisma.vfsAccount.update({
      where: { id: acc.id },
      data: {
        cookieStore: {
          raw: cookies,
          jar: cookieJar,
          hasDatadome,
          capturedAt: new Date().toISOString(),
        },
        tabUrl: url,
        lastWarmedAt: hasDatadome ? new Date() : acc.lastWarmedAt,
        status: hasDatadome ? AccountStatus.ACTIVE : acc.status,
      },
    });
    if (!hasDatadome) {
      console.warn(`[EXT_SESSION_SYNC] ${email} synced but no datadome cookie present; account NOT marked warm`);
    }
    return;
  }

  if (event.type === 'EXT_SLOT_DETECTED') {
    await dispatchNotification({
      event: 'SLOT_DETECTED',
      destination: String(event.destination ?? 'lva'),
      slotDate: String(event.date ?? ''),
    });
    return;
  }

  if (event.type === 'EXT_BOOKING_COMPLETED') {
    const profile = await prisma.profile.findFirst({ where: { isActive: true }, orderBy: { priority: 'asc' } });
    if (profile) {
      await prisma.booking.create({
        data: {
          profileId: profile.id,
          destination: String(event.destination ?? 'lva'),
          visaType: String(event.visaType ?? 'SCH'),
          status: 'SUCCESS',
          confirmationNo: String(event.confirmationNumber ?? ''),
          completedAt: new Date(),
        },
      });
    }
    await dispatchNotification({
      event: 'BOOKING_SUCCESS',
      profileId: profile?.id,
      destination: String(event.destination ?? 'lva'),
      confirmationNo: String(event.confirmationNumber ?? ''),
    });
    return;
  }

  if (event.type === 'EXT_BOOKING_FAILED') {
    await dispatchNotification({
      event: 'BOOKING_FAILED',
      destination: String(event.destination ?? 'lva'),
      reason: String(event.reason ?? 'Extension booking failed'),
    });
    return;
  }

  if (event.type === 'EXT_SESSION_LOST') {
    await dispatchNotification({
      event: 'BOOKING_FAILED',
      destination: String(event.destination ?? 'lva'),
      reason: `Extension session lost: ${String(event.reason ?? 'customer needs to log in again')}`,
    });
  }
}

async function resolveOperatorCustomerId(): Promise<string | undefined> {
  const configured = process.env.OPERATOR_USER_ID;
  if (configured) return configured;

  console.warn('[dispatchBookingToExtension] OPERATOR_USER_ID is not set; falling back to first ADMIN user');
  const admin = await prisma.user.findFirst({
    where: { role: Role.ADMIN },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  return admin?.id;
}
