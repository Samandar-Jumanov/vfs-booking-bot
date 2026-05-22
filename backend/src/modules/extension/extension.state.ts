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
  const state = extensionStates.get(customerId);
  if (!state) return undefined;
  // Don't claim "connected" if last heartbeat is older than 60s. The TCP
  // socket may not have closed cleanly (idle-killed service worker, network
  // drop, NAT timeout) so we use heartbeat freshness as ground truth.
  if (state.connected && state.lastHeartbeatAt) {
    const ageMs = Date.now() - new Date(state.lastHeartbeatAt).getTime();
    if (ageMs > 60_000) {
      const stale = { ...state, connected: false };
      extensionStates.set(customerId, stale);
      return stale;
    }
  }
  return state;
}

// Periodic sweeper so anyone polling the state sees fresh data even when
// they're not the one to trigger getExtensionState.
setInterval(() => {
  const now = Date.now();
  for (const [id, state] of extensionStates) {
    if (state.connected && state.lastHeartbeatAt) {
      const ageMs = now - new Date(state.lastHeartbeatAt).getTime();
      if (ageMs > 60_000) {
        extensionStates.set(id, { ...state, connected: false });
      }
    }
  }
}, 30_000).unref();

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
  // Log every event we receive from the extension so the operator can see in
  // the Activity Logs whether polling is actually happening. EXT_HEARTBEAT is
  // too noisy (every 30s) — log it only at trace level to console.
  if (event.type === 'EXT_HEARTBEAT') {
    markExtensionHeartbeat(customerId);
    return;
  }
  if (event.type === 'EXT_POLL_RESULT') {
    const { logEvent } = await import('@modules/logs/logger');
    const { EventType } = await import('@prisma/client');
    logEvent('info', EventType.MONITOR_STARTED,
      `[EXT_POLL_RESULT] dest=${event.destination} status=${event.status} hasData=${Boolean(event.data)}`);
    return;
  }

  // Catch-all so any unexpected extension event surfaces in Activity Logs.
  // Helps diagnose why poll attempts aren't completing.
  if (event.type && !['EXT_HEARTBEAT', 'EXT_SESSION_SYNC', 'EXT_SLOT_DETECTED',
    'EXT_SESSION_LOST', 'EXT_REGISTER_NEED_EMAIL_LINK', 'EXT_REGISTER_NEED_SMS_OTP',
    'EXT_REGISTER_NEED_CAPTCHA', 'EXT_REGISTER_SUBMITTED', 'EXT_REGISTER_COMPLETED', 'EXT_REGISTER_FAILED',
    'EXT_LOGIN_NEED_CAPTCHA', 'EXT_LOGIN_SUCCESS', 'EXT_LOGIN_FAILED',
    'EXT_BOOKING_COMPLETED', 'EXT_BOOKING_FAILED', 'EXT_POLL_RESULT'].includes(String(event.type))) {
    const { logEvent } = await import('@modules/logs/logger');
    const { EventType } = await import('@prisma/client');
    logEvent('warn', EventType.MONITOR_STARTED, `[EXT_UNKNOWN] type=${event.type}`);
  }

  if (event.type === 'EXT_SESSION_SYNC') {
    const url = String(event.url ?? '');
    const email = String(event.email ?? '');
    const cookies = String(event.cookies ?? '');
    const cookieJar = Array.isArray(event.cookieJar) ? event.cookieJar : null;
    if (!cookies && !cookieJar) return;
    // Match account by email first; if no match (extension can't always detect
    // the VFS account email from the dashboard), fall back to single-account
    // mode: if there is exactly ONE non-blocked account in the pool, use it.
    // This covers the 1-operator/1-account dev scenario.
    let acc = email ? await prisma.vfsAccount.findFirst({ where: { email } }) : null;
    if (!acc) {
      const candidates = await prisma.vfsAccount.findMany({
        where: { status: { not: 'BLOCKED' } },
        orderBy: { lastWarmedAt: 'asc' },
        take: 2,
      });
      if (candidates.length === 1) {
        acc = candidates[0];
        console.info(`[EXT_SESSION_SYNC] No email in payload; single-account fallback → ${acc.email}`);
      } else {
        console.info(`[EXT_SESSION_SYNC] No account row for "${email}" and ${candidates.length} candidates — skipping`);
        return;
      }
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
    // If this event carries a correlationId from a worker-dispatched
    // BOOK_FOR_CUSTOMER, resolve the pending promise so the booking worker
    // finishes its job. The worker handles the DB write + Telegram alert
    // via its own success path; do NOT also create a Booking row here or
    // we'll get duplicates.
    if (typeof event.correlationId === 'string' && event.correlationId) {
      const { resolveExtensionBooking } = await import('@modules/booking/extension-dispatch.service');
      resolveExtensionBooking(event.correlationId, {
        success: true,
        confirmationNumber: String(event.confirmationNumber ?? ''),
        accountEmail: typeof event.accountEmail === 'string' ? event.accountEmail : undefined,
      });
      return;
    }
    // Legacy path: standalone extension booking (no worker correlation).
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
    if (typeof event.correlationId === 'string' && event.correlationId) {
      const { resolveExtensionBooking } = await import('@modules/booking/extension-dispatch.service');
      resolveExtensionBooking(event.correlationId, {
        success: false,
        reason: String(event.reason ?? 'EXTENSION_BOOKING_FAILED'),
        accountEmail: typeof event.accountEmail === 'string' ? event.accountEmail : undefined,
      });
      return;
    }
    await dispatchNotification({
      event: 'BOOKING_FAILED',
      destination: String(event.destination ?? 'lva'),
      reason: String(event.reason ?? 'Extension booking failed'),
    });
    return;
  }

  if (event.type === 'EXT_SESSION_LOST') {
    const { logEvent } = await import('@modules/logs/logger');
    const { EventType } = await import('@prisma/client');
    logEvent('warn', EventType.SESSION_EXPIRED,
      `[EXT_SESSION_LOST] dest=${event.destination} reason=${String(event.reason ?? 'unknown')}`);
    await dispatchNotification({
      event: 'BOOKING_FAILED',
      destination: String(event.destination ?? 'lva'),
      reason: `Extension session lost: ${String(event.reason ?? 'customer needs to log in again')}`,
    });
    return;
  }

  // ── Auto-register bridge events ──────────────────────────────────────────
  if (event.type === 'EXT_LOGIN_NEED_CAPTCHA' && typeof event.correlationId === 'string') {
    const { handleLoginNeedsCaptcha } = await import('@modules/accounts/accountLoginService');
    await handleLoginNeedsCaptcha(customerId, {
      correlationId: event.correlationId,
      siteKey: String(event.siteKey ?? ''),
      pageUrl: String(event.pageUrl ?? ''),
    });
    return;
  }

  if (event.type === 'EXT_LOGIN_SUCCESS' && typeof event.correlationId === 'string') {
    const { resolveLoginSuccess } = await import('@modules/accounts/accountLoginService');
    await resolveLoginSuccess(event.correlationId);
    return;
  }

  if (event.type === 'EXT_LOGIN_FAILED' && typeof event.correlationId === 'string') {
    const { resolveLoginFailed } = await import('@modules/accounts/accountLoginService');
    resolveLoginFailed(event.correlationId, String(event.reason ?? 'EXT_LOGIN_FAILED'));
    return;
  }

  // Extension asks backend for a verification link (poll Mailsac inbox).
  if (event.type === 'EXT_REGISTER_NEED_EMAIL_LINK' && typeof event.correlationId === 'string') {
    const { logEvent } = await import('@modules/logs/logger');
    const { EventType } = await import('@prisma/client');
    logEvent('info', EventType.BOOKING_ATTEMPT,
      `[REGISTER] step: NEED_EMAIL_LINK — polling Mailsac for ${event.email}`);
    const { fetchEmailVerificationLink } = await import('@modules/accounts/accountAutoRegister.service');
    const link = await fetchEmailVerificationLink(String(event.email ?? ''));
    logEvent('info', EventType.BOOKING_ATTEMPT,
      `[REGISTER] email link ${link ? 'received' : 'MISSING after 2 min'}: ${link ? link.slice(0,60) + '…' : 'null'}`);
    sendToExtension(customerId, {
      type: 'BG_REGISTER_EMAIL_LINK',
      correlationId: event.correlationId,
      link: link ?? null,
    });
    return;
  }

  // Extension asks backend for the SMS OTP (poll smsActivate).
  if (event.type === 'EXT_REGISTER_NEED_SMS_OTP' && typeof event.correlationId === 'string') {
    const { logEvent } = await import('@modules/logs/logger');
    const { EventType } = await import('@prisma/client');
    logEvent('info', EventType.BOOKING_ATTEMPT,
      `[REGISTER] step: NEED_SMS_OTP — polling SMS provider id=${event.smsActivateId}`);
    const { fetchSmsOtp } = await import('@modules/accounts/accountAutoRegister.service');
    const otp = await fetchSmsOtp(String(event.smsActivateId ?? ''));
    logEvent('info', EventType.BOOKING_ATTEMPT,
      `[REGISTER] SMS OTP ${otp ? 'received: ' + otp : 'MISSING after timeout'}`);
    sendToExtension(customerId, {
      type: 'BG_REGISTER_SMS_OTP',
      correlationId: event.correlationId,
      otp: otp ?? null,
    });
    return;
  }

  // Extension asks backend to solve Turnstile via 2Captcha.
  if (event.type === 'EXT_REGISTER_NEED_CAPTCHA' && typeof event.correlationId === 'string') {
    const { logEvent } = await import('@modules/logs/logger');
    const { EventType } = await import('@prisma/client');
    logEvent('info', EventType.BOOKING_ATTEMPT,
      `[REGISTER] step: NEED_CAPTCHA — siteKey=${String(event.siteKey).slice(0,12)}… solving via 2Captcha`);
    const { fetchRegisterCaptchaToken } = await import('@modules/accounts/accountAutoRegister.service');
    const token = await fetchRegisterCaptchaToken(
      String(event.siteKey ?? ''),
      String(event.pageUrl ?? ''),
    );
    logEvent('info', EventType.BOOKING_ATTEMPT,
      `[REGISTER] captcha ${token ? 'solved (token len=' + token.length + ')' : 'FAILED'}`);
    sendToExtension(customerId, {
      type: 'BG_REGISTER_CAPTCHA_TOKEN',
      correlationId: event.correlationId,
      token: token ?? null,
    });
    return;
  }

  if (event.type === 'EXT_REGISTER_SUBMITTED' && typeof event.correlationId === 'string') {
    const { logEvent } = await import('@modules/logs/logger');
    const { EventType } = await import('@prisma/client');
    logEvent('info', EventType.BOOKING_ATTEMPT,
      `[REGISTER] step: SUBMITTED — form posted, waiting for email link for ${event.email ?? '(unknown)'}`);
    const { resolveAutoRegisterSubmitted } = await import('@modules/accounts/accountAutoRegister.service');
    resolveAutoRegisterSubmitted(event.correlationId);
    return;
  }

  if (event.type === 'EXT_REGISTER_COMPLETED' && typeof event.correlationId === 'string') {
    const { logEvent } = await import('@modules/logs/logger');
    const { EventType } = await import('@prisma/client');
    logEvent('info', EventType.BOOKING_SUCCESS,
      `[REGISTER] step: COMPLETED for correlation ${event.correlationId.slice(0,8)}…`);
    const { resolveAutoRegister } = await import('@modules/accounts/accountAutoRegister.service');
    resolveAutoRegister(event.correlationId, { ok: true });
    return;
  }

  if (event.type === 'EXT_REGISTER_FAILED' && typeof event.correlationId === 'string') {
    const { logEvent } = await import('@modules/logs/logger');
    const { EventType } = await import('@prisma/client');
    logEvent('error', EventType.BOOKING_FAILED,
      `[REGISTER] step: FAILED reason=${String(event.reason ?? 'unknown')}`);
    const { resolveAutoRegister } = await import('@modules/accounts/accountAutoRegister.service');
    resolveAutoRegister(event.correlationId, {
      ok: false,
      reason: String(event.reason ?? 'EXT_REGISTER_FAILED'),
    });
    return;
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
