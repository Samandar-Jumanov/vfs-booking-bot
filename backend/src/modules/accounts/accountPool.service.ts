import { VfsAccount, AccountStatus, EventType } from '@prisma/client';
import { prisma } from '@config/database';
import { logEvent } from '@modules/logs/logger';

export class AccountPoolService {
  /**
   * Returns the least-recently-used ACTIVE account, atomically.
   *
   * Before querying, any COOLDOWN account whose cooldownUntil has already
   * passed is reset to ACTIVE in a single batch update.
   *
   * The selection and lastUsedAt stamp are performed in a single atomic
   * UPDATE ... RETURNING statement via $queryRaw to prevent concurrent
   * workers from picking the same account (TOCTOU race condition).
   *
   * Throws if no ACTIVE accounts are available.
   */
  async getAvailableAccount(): Promise<VfsAccount> {
    const now = new Date();

    // Reset expired COOLDOWN accounts back to ACTIVE in one batch.
    await prisma.vfsAccount.updateMany({
      where: {
        status: AccountStatus.COOLDOWN,
        cooldownUntil: { lte: now },
      },
      data: {
        status: AccountStatus.ACTIVE,
        cooldownUntil: null,
      },
    });

    // Atomically select the LRU ACTIVE account and stamp lastUsedAt in one
    // query, preventing concurrent callers from obtaining the same account.
    const rows = await prisma.$queryRaw<VfsAccount[]>`
      UPDATE "VfsAccount"
      SET    "lastUsedAt" = ${now}
      WHERE  id = (
        SELECT id
        FROM   "VfsAccount"
        WHERE  status = 'ACTIVE'
        ORDER BY "lastUsedAt" ASC NULLS FIRST
        LIMIT  1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *
    `;

    if (rows.length === 0) {
      throw new Error('No ACTIVE VFS accounts are currently available.');
    }

    return rows[0];
  }

  /**
   * Permanently marks an account as BLOCKED.
   */
  async markBlocked(id: string): Promise<void> {
    await prisma.vfsAccount.update({
      where: { id },
      data: {
        status: AccountStatus.BLOCKED,
        cooldownUntil: null,
      },
    });
  }

  /**
   * Puts an account into COOLDOWN for the specified number of minutes.
   * cooldownUntil is set to now + minutes.
   */
  async markCooldown(id: string, minutes: number): Promise<void> {
    const cooldownUntil = new Date(Date.now() + minutes * 60 * 1000);

    await prisma.vfsAccount.update({
      where: { id },
      data: {
        status: AccountStatus.COOLDOWN,
        cooldownUntil,
      },
    });
  }

  /**
   * Adds profileId to the account's profileIds array.
   * If the profileId is already present the update is skipped to avoid duplicates.
   */
  async linkToProfile(accountId: string, profileId: string): Promise<void> {
    const account = await prisma.vfsAccount.findUnique({
      where: { id: accountId },
      select: { profileIds: true },
    });

    if (account === null) {
      throw new Error(`VfsAccount with id "${accountId}" not found.`);
    }

    if (account.profileIds.includes(profileId)) {
      // Already linked — nothing to do.
      return;
    }

    await prisma.vfsAccount.update({
      where: { id: accountId },
      data: {
        profileIds: { push: profileId },
      },
    });
  }

  /**
   * 1:1 auto-link (Model-A): link the given profile to the first account that
   * has NO profiles yet. Idempotent — if the profile is already linked to some
   * account, returns that account's id and does nothing. Returns null if no
   * free account is available (caller decides whether to create one).
   */
  async linkProfileToFreeAccount(profileId: string): Promise<string | null> {
    const already = await prisma.vfsAccount.findFirst({
      where: { profileIds: { has: profileId } },
      select: { id: true },
    });
    if (already) return already.id;

    const free = await prisma.vfsAccount.findFirst({
      where: {
        profileIds: { isEmpty: true },
        status: { in: [AccountStatus.ACTIVE, AccountStatus.PENDING] },
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    if (!free) return null;

    await prisma.vfsAccount.update({
      where: { id: free.id },
      data: { profileIds: { push: profileId } },
    });
    return free.id;
  }

  /**
   * 1:1 auto-link from the account side: link a (just-created) account that has
   * no profiles to the first profile not yet linked to ANY account. Returns the
   * linked profileId, or null if the account is already linked / no free
   * profile exists.
   */
  async linkAccountToFreeProfile(accountId: string): Promise<string | null> {
    const acct = await prisma.vfsAccount.findUnique({
      where: { id: accountId },
      select: { profileIds: true },
    });
    if (!acct || acct.profileIds.length > 0) return null;

    const linkedProfileIds = (
      await prisma.vfsAccount.findMany({ select: { profileIds: true } })
    ).flatMap((a) => a.profileIds);

    const candidate = await prisma.profile.findFirst({
      where: { id: { notIn: linkedProfileIds }, isActive: true },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    if (!candidate) return null;

    await prisma.vfsAccount.update({
      where: { id: accountId },
      data: { profileIds: { push: candidate.id } },
    });
    return candidate.id;
  }
}

export const accountPoolService = new AccountPoolService();

/**
 * Non-throwing logging wrapper: auto-link a just-created account to a free
 * profile (1:1). Safe to call from any account-create path — a missing free
 * profile is a no-op (the profile side links when it's added).
 */
export async function autoLinkAccountToProfile(accountId: string): Promise<void> {
  try {
    const profileId = await accountPoolService.linkAccountToFreeProfile(accountId);
    if (profileId) {
      logEvent('info', EventType.MONITOR_STARTED,
        `[AUTO-LINK] account ${accountId} linked to profile ${profileId}`, { profileId });
    }
  } catch (err) {
    logEvent('warn', EventType.MONITOR_STARTED,
      `[AUTO-LINK] failed to link account ${accountId}: ${(err as Error).message}`);
  }
}
