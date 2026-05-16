import { dispatchNotification } from '@modules/notifications/notification.service';
import { prisma } from '@config/database';

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

export async function handleExtensionEvent(customerId: string, event: { type?: string; [key: string]: unknown }): Promise<void> {
  if (event.type === 'EXT_HEARTBEAT') {
    markExtensionHeartbeat(customerId);
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
