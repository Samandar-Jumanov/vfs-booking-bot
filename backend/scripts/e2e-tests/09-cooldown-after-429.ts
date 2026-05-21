import { runE2e, assert, cleanupByEmailPrefix, createTestAccount, withTestServer } from './common';

runE2e('9. Cooldown after 429 from VFS', async () => {
  const prefix = 'e2e-cooldown';
  await cleanupByEmailPrefix(prefix);
  try {
    const account = await createTestAccount(prefix, { email: `${prefix}-${Date.now()}@e2e.local` });
    const fallback = await createTestAccount(prefix, { email: `${prefix}-fallback-${Date.now()}@e2e.local` });
    const { prisma } = await import('../../src/config/database');
    await withTestServer(async ({ baseUrl, authHeader }) => {
      const res = await fetch(`${baseUrl}/api/accounts/${account.id}/cooldown`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', ...authHeader },
        body: JSON.stringify({ minutes: 5 }),
      });
      assert(res.ok, `account cooldown returned HTTP ${res.status}`);
      const body = await res.json() as { message?: string };
      assert(body.message === 'Account put into COOLDOWN for 5 minute(s)', `unexpected cooldown response "${body.message}"`);
    });
    const updated = await prisma.vfsAccount.findUniqueOrThrow({ where: { id: account.id } });
    assert(updated.status === 'COOLDOWN', 'account was not marked COOLDOWN');
    assert(updated.cooldownUntil && updated.cooldownUntil.getTime() > Date.now(), 'cooldownUntil was not set in the future');

    let markLocksReady!: () => void;
    let releaseLockRows!: () => void;
    const lockReady = new Promise<void>((resolve) => { markLocksReady = resolve; });
    const releaseLocks = new Promise<void>((resolve) => { releaseLockRows = resolve; });
    const locker = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT id
        FROM "VfsAccount"
        WHERE status = 'ACTIVE'
          AND id NOT IN (${fallback.id})
        FOR UPDATE
      `;
      markLocksReady();
      await releaseLocks;
    }, { timeout: 15_000, maxWait: 5_000 });

    const { accountPoolService } = await import('../../src/modules/accounts/accountPool.service');
    let pickedId = '';
    try {
      await lockReady;
      const picked = await accountPoolService.getAvailableAccount();
      pickedId = picked.id;
    } finally {
      releaseLockRows();
      await locker;
    }
    assert(pickedId === fallback.id, 'account pool did not skip the account in future cooldown');
  } finally {
    await cleanupByEmailPrefix(prefix);
  }
});
