import { VfsAccount, AccountStatus } from '@prisma/client';
import { prisma } from '@config/database';

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
}

export const accountPoolService = new AccountPoolService();
