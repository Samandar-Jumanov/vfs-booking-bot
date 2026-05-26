/**
 * Auto-booking orchestrator (Track B).
 *
 * When the operator's extension reports a logged-in VFS tab for an account
 * (EXT_SESSION_SYNC, warm), this triggers booking for that account's linked
 * profile (1:1). Behaviour (operator-confirmed spec):
 *   - Try to book immediately; if no slot, fall back to monitoring (bounded
 *     re-attempts) and book the moment a slot is available.
 *   - Fully auto-submit (confirmPauseMs = 0, no confirmation pause).
 *   - All logged-in tabs run in parallel, but each booking is started a few
 *     seconds apart with jitter so VFS never sees a synchronized burst (the
 *     top trigger for 429001 account bans).
 *
 * GATED OFF by default (AUTO_BOOK_ON_TAB_ENABLED). Books REAL appointments, so
 * it must only be enabled after login + the booking flow are validated live.
 */
import { EventType, Profile } from '@prisma/client';
import { env } from '@config/env';
import { prisma } from '@config/database';
import { decrypt } from '@utils/crypto';
import { logEvent } from '@modules/logs/logger';
import { triggerAutonomousBooking, AutonomousBookingInput } from './extension-dispatch.service';

type SessionState = 'booking' | 'monitoring';

// accountId → current state. Guards against EXT_SESSION_SYNC (fires every 60s)
// re-triggering a booking that's already in flight or monitoring.
const activeSessions = new Map<string, SessionState>();

// Accounts currently MONITORING via the cheap CheckIsSlotAvailable API poll
// (armed in the extension). When EXT_SLOT_DETECTED fires we book these — the
// heavy booking wizard runs ONLY on a real slot, not on every check.
type MonitorCtx = {
  account: { id: string; email: string; tabUrl: string | null };
  profile: Profile;
  profileId: string;
};
const monitoringContext = new Map<string, MonitorCtx>();

// Stagger cursor: the wall-clock time the most recently scheduled booking will
// fire at. Each new trigger is scheduled at least AUTO_BOOK_STAGGER_MS after the
// previous one, plus random jitter.
let lastScheduledAt = 0;

function looksLoggedIn(url: string): boolean {
  if (/\/login\b/i.test(url)) return false;
  return /\/(dashboard|account|appointment|application|book)/i.test(url);
}

/**
 * Called from the EXT_SESSION_SYNC handler when an account's tab is detected
 * logged-in (warm + a logged-in URL). No-op unless the feature flag is on.
 */
export async function onLoggedInTab(
  account: { id: string; email: string; tabUrl: string | null },
  url: string,
): Promise<void> {
  if (!env.AUTO_BOOK_ON_TAB_ENABLED) return;
  if (!looksLoggedIn(url)) {
    logEvent('info', EventType.BOOKING_ATTEMPT,
      `[AUTO-BOOK] ${account.email} synced but URL not logged-in yet ("${url}") — waiting`);
    return;
  }
  if (activeSessions.has(account.id)) return; // already booking/monitoring

  const linked = await prisma.vfsAccount.findUnique({
    where: { id: account.id },
    select: { profileIds: true },
  });
  const profileId = linked?.profileIds[0];
  if (!profileId) {
    logEvent('info', EventType.BOOKING_ATTEMPT,
      `[AUTO-BOOK] ${account.email} logged in but no linked profile — skipping`);
    return;
  }
  const profile = await prisma.profile.findUnique({ where: { id: profileId } });
  if (!profile || !profile.isActive) {
    logEvent('info', EventType.BOOKING_ATTEMPT,
      `[AUTO-BOOK] ${account.email} linked profile missing/inactive — skipping`);
    return;
  }

  activeSessions.set(account.id, 'booking');

  // Stagger: schedule at least AUTO_BOOK_STAGGER_MS after the previous trigger,
  // plus random jitter ∈ [0, stagger). Parallel logins thus fan out instead of
  // firing simultaneously.
  const base = env.AUTO_BOOK_STAGGER_MS;
  const now = Date.now();
  const fireAt = Math.max(lastScheduledAt + base, now) + Math.floor(Math.random() * base);
  lastScheduledAt = fireAt;
  const delay = fireAt - now;

  logEvent('info', EventType.BOOKING_ATTEMPT,
    `[AUTO-BOOK] ${account.email} logged in → booking in ${(delay / 1000).toFixed(1)}s (profile ${profileId})`,
    { profileId });

  setTimeout(() => {
    void bookOrMonitor(account, profile, profileId);
  }, delay);
}

/** Drop an account's session state (e.g. on EXT_SESSION_LOST) so a later
 *  re-login can re-trigger booking. */
export function clearAccountSession(accountId: string): void {
  activeSessions.delete(accountId);
  monitoringContext.delete(accountId);
}

/**
 * Called when the extension's cheap CheckIsSlotAvailable poll reports a slot
 * (EXT_SLOT_DETECTED). Book every account currently MONITORING — the booking
 * wizard runs only now, on a real slot, not on every check. (One logged-in
 * account per Chrome profile today, so this is typically a single account.)
 */
export async function onSlotDetected(date?: string): Promise<void> {
  if (!env.AUTO_BOOK_ON_TAB_ENABLED) return;
  for (const [accountId, ctx] of monitoringContext) {
    if (activeSessions.get(accountId) === 'booking') continue; // already booking
    logEvent('info', EventType.BOOKING_ATTEMPT,
      `[AUTO-BOOK] slot detected (${date ?? '?'}) → booking ${ctx.account.email}`,
      { profileId: ctx.profileId });
    activeSessions.set(accountId, 'booking');
    void bookOrMonitor(ctx.account, ctx.profile, ctx.profileId);
  }
}

async function bookOrMonitor(
  account: { id: string; email: string; tabUrl: string | null },
  profile: Profile,
  profileId: string,
): Promise<void> {
  // If the session was cleared (logout / session lost) while we waited, abort.
  if (!activeSessions.has(account.id)) return;

  try {
    const result = await triggerAutonomousBooking(buildBookingInput(profile, account));

    if (result.success) {
      logEvent('info', EventType.BOOKING_SUCCESS,
        `[AUTO-BOOK] booked ${account.email} (conf ${result.confirmationNumber ?? '?'})`,
        { profileId });
      // Notify (Telegram/email) — goes to the customer's telegramChatId if set,
      // else the operator channel. Booking success always fires regardless of
      // the failure-alert flag.
      try {
        const { dispatchNotification } = await import('@modules/notifications/notification.service');
        await dispatchNotification({
          event: 'BOOKING_SUCCESS',
          profileId,
          profileName: profile.fullName,
          accountEmail: account.email,
          confirmationNo: result.confirmationNumber,
          destination: 'lva',
        });
      } catch (e) {
        logEvent('warn', EventType.BOOKING_FAILED,
          `[AUTO-BOOK] booked but notify failed: ${(e as Error).message}`, { profileId });
      }
      clearAccountSession(account.id);
      return;
    }

    const reason = result.reason ?? 'UNKNOWN';
    // No slot → DON'T re-run the heavy wizard (that's what burns the account
    // into a 429). The one wizard pass just now armed the extension's cheap
    // CheckIsSlotAvailable poll (auto-captured codes). Register for MONITORING
    // and wait for EXT_SLOT_DETECTED → onSlotDetected() books then.
    if (/NO_SLOT|SLOT|NOT_AVAILABLE|NO_APPOINTMENT|UNAVAILABLE/i.test(reason)) {
      activeSessions.set(account.id, 'monitoring');
      monitoringContext.set(account.id, { account, profile, profileId });
      logEvent('info', EventType.BOOKING_ATTEMPT,
        `[AUTO-BOOK] ${account.email} no slot → now MONITORING via cheap API poll (books on slot-detected, no wizard re-runs)`,
        { profileId });
      return;
    }

    // Hard failure (offline/timeout/error) — release so a later login re-arms.
    logEvent('warn', EventType.BOOKING_FAILED,
      `[AUTO-BOOK] ${account.email} booking failed: ${reason}`, { profileId });
    clearAccountSession(account.id);
  } catch (err) {
    logEvent('warn', EventType.BOOKING_FAILED,
      `[AUTO-BOOK] ${account.email} booking threw: ${(err as Error).message}`, { profileId });
    clearAccountSession(account.id);
  }
}

function buildBookingInput(
  profile: Profile,
  account: { email: string; tabUrl: string | null },
): AutonomousBookingInput {
  const [firstName, ...rest] = profile.fullName.trim().split(/\s+/);
  const lastName = rest.join(' ').trim() || firstName;
  return {
    firstName,
    lastName,
    nationality: profile.nationality,
    passportNumber: profile.passportNumberEnc ? decrypt(profile.passportNumberEnc) : '',
    contact: profile.phone,
    email: profile.email,
    // Empty → the extension's booking steps auto-pick the first sub-category
    // that has slots (selectMatOptionByIndex). Operator can refine later.
    subCategory: '',
    confirmPauseMs: 0, // fully auto-submit (operator-confirmed)
    accountEmail: account.email,
    accountTabUrl: account.tabUrl ?? undefined,
  };
}
