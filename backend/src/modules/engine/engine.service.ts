import { BookingJobPayload } from '@t/index';
import { env } from '@config/env';
import { getProxy, reportBlock } from '@modules/proxy/proxy.service';
import { getProfileForBooking } from '@modules/profiles/profiles.service';
import { getSetting } from '@modules/settings/settings.service';
import { loadSession, saveSession, clearSession } from './sessionStore';
import { createBrowserContext } from './browser.factory';
import { runBookingFlow } from './vfs/vfs.navigator';
import { applyOverrides, VfsSelectors } from './vfs/vfs.selectors';
import { withRetry } from '@utils/retry';
import { logEvent } from '@modules/logs/logger';
import { EventType } from '@prisma/client';
import { AppError } from '@middleware/errorHandler';
import { accountPoolService } from '@modules/accounts/accountPool.service';
import { decrypt } from '@utils/crypto';

export interface BookingResult {
  success: boolean;
  confirmationNo?: string;
  error?: string;
}

export async function runBooking(job: BookingJobPayload): Promise<BookingResult> {
  // Load selector overrides from Settings
  const selectorOverrides = await getSetting<Partial<VfsSelectors>>('vfs.selectors');
  if (selectorOverrides) applyOverrides(selectorOverrides);

  // Load profile (fully decrypted)
  const profile = await getProfileForBooking(job.profileId);

  // Resolve VFS credentials:
  //   1. Per-profile credentials take priority (profile.vfsPassword is already decrypted by getProfileForBooking)
  //   2. Otherwise pull the least-recently-used ACTIVE account from the pool
  //   3. If the pool is empty, fall back to env.VFS_EMAIL / VFS_PASSWORD so the
  //      system keeps working without a populated pool
  let vfsEmail: string;
  let vfsPassword: string;
  let accountId: string | undefined;

  if (profile.vfsPassword) {
    // getProfileForBooking already decrypts this field
    vfsEmail = profile.email || '';
    vfsPassword = profile.vfsPassword;
  } else {
    try {
      const poolAccount = await accountPoolService.getAvailableAccount();
      vfsEmail = poolAccount.email;
      vfsPassword = decrypt(poolAccount.encryptedPassword);
      accountId = poolAccount.id;
    } catch (poolErr) {
      logEvent('warn', EventType.BOOKING_ATTEMPT,
        `Account pool exhausted for profile ${profile.fullName} — falling back to env credentials`,
        { profileId: job.profileId, error: String(poolErr) },
      );
      vfsEmail = env.VFS_EMAIL || '';
      vfsPassword = env.VFS_PASSWORD || '';
    }
  }

  if (!vfsPassword) {
    logEvent('warn', EventType.BOOKING_ATTEMPT,
      `No VFS password for profile ${profile.fullName} and no VFS_PASSWORD in .env — booking will fail at login`,
      { profileId: job.profileId },
    );
  }

  logEvent('info', EventType.BOOKING_ATTEMPT, `Starting booking for profile ${profile.fullName}`, {
    profileId: job.profileId,
    destination: job.destination,
  });

  // How many parallel tabs to race (configurable via Settings; default 2)
  const parallelTabs = Math.min(
    Math.max(1, (await getSetting<number>('booking.parallelTabs')) ?? 2),
    4, // hard cap — more than 4 tabs rarely helps and wastes RAM
  );

  let lastProxyId: string | undefined;

  try {
    const result = await withRetry(
      async () => {
        // ── Launch N parallel browser attempts, take first success ─────────
        const attempts = Array.from({ length: parallelTabs }, (_, i) =>
          runSingleAttempt(i, job, profile, vfsEmail, vfsPassword)
        );

        // Race: first fulfilled (successful booking) wins.
        // If ALL fail, throw the last error so withRetry can retry the whole round.
        const results = await Promise.allSettled(attempts);
        const winner = results.find(
          (r): r is PromiseFulfilledResult<{ confirmationNo: string; proxyId?: string }> =>
            r.status === 'fulfilled'
        );

        if (winner) {
          lastProxyId = winner.value.proxyId;
          return winner.value.confirmationNo;
        }

        // All tabs failed — collect errors and throw the first one for retry logic
        const errors = results
          .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
          .map((r) => String(r.reason));
        throw new Error(errors[0] ?? 'All parallel booking attempts failed');
      },
      {
        maxAttempts: job.attempt ?? 3,
        backoffMs: 2000,
        factor: 2,
        onRetry: (attempt, err) => {
          logEvent('warn', EventType.BOOKING_ATTEMPT, `Retry ${attempt} for profile ${job.profileId}`, {
            profileId: job.profileId,
            error: String(err),
          });
        },
      }
    );

    logEvent('info', EventType.BOOKING_SUCCESS, `Booking successful: ${result}`, {
      profileId: job.profileId,
      destination: job.destination,
      result,
    });

    return { success: true, confirmationNo: result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isBlock = err instanceof AppError && err.code === 'IP_BLOCKED';

    if (isBlock && lastProxyId) {
      await reportBlock(lastProxyId);
    }

    if (message.includes('session') || message.includes('login')) {
      await clearSession(job.profileId);

      // Session/auth errors suggest the VFS account needs a cooldown
      if (accountId) {
        await accountPoolService.markCooldown(accountId, 30).catch((e: unknown) =>
          logEvent('warn', EventType.BOOKING_ATTEMPT, `Failed to set cooldown on account ${accountId}`, { error: String(e) }),
        );
      }
    }

    // If the error signals the account is outright blocked/banned, mark it permanently
    if (accountId && (
      message.toLowerCase().includes('blocked') ||
      message.toLowerCase().includes('banned') ||
      message.toLowerCase().includes('suspended') ||
      message.toLowerCase().includes('account disabled')
    )) {
      await accountPoolService.markBlocked(accountId).catch((e: unknown) =>
        logEvent('warn', EventType.BOOKING_ATTEMPT, `Failed to mark account ${accountId} as blocked`, { error: String(e) }),
      );
    }

    logEvent('error', EventType.BOOKING_FAILED, `Booking failed: ${message}`, {
      profileId: job.profileId,
      destination: job.destination,
      proxyUsed: lastProxyId,
      result: 'FAILED',
    });

    return { success: false, error: message };
  }
}

// ── Single browser attempt (one tab) ──────────────────────────────────────────

async function runSingleAttempt(
  tabIndex: number,
  job: BookingJobPayload,
  profile: Awaited<ReturnType<typeof getProfileForBooking>>,
  vfsEmail: string,
  vfsPassword: string,
): Promise<{ confirmationNo: string; proxyId?: string }> {
  const proxy = await getProxy(job.destination);
  const proxyId = proxy?.id;

  // Each tab gets its own session to avoid cookie conflicts on parallel runs
  const cookieState = tabIndex === 0 ? await loadSession(job.profileId) : undefined;
  const context = await createBrowserContext(proxy, cookieState ?? undefined, job.destination);

  try {
    const confirmationNo = await runBookingFlow(context, {
      sessionId: `${job.profileId}-tab${tabIndex}`,
      sourceCountry: job.sourceCountry,
      destination: job.destination,
      visaType: job.visaType,
      slot: job.slot,
      profile: {
        fullName: profile.fullName,
        passportNumber: profile.passportNumber,
        dob: profile.dob,
        passportExpiry: profile.passportExpiry,
        nationality: profile.nationality,
        email: profile.email,
        phone: profile.phone,
        vfsEmail,
        vfsPassword,
      },
    });

    // Only persist session cookies from the winning tab (tab 0 = primary)
    if (tabIndex === 0) {
      await saveSession(job.profileId, context);
    }

    return { confirmationNo, proxyId };
  } finally {
    await context.close();
  }
}
