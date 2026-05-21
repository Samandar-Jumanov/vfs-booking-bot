import { runE2e, assert, cleanupByEmailPrefix, createTestAccount, datadomeCookie, sessionCookie } from './common';

runE2e('8. Multi-account rotation', async () => {
  const prefix = 'e2e-rotation';
  await cleanupByEmailPrefix(prefix);
  const { prisma } = await import('../../src/config/database');
  try {
    const now = Date.now();
    const accounts = await Promise.all([0, 1, 2].map((i) => createTestAccount(prefix, {
      email: `${prefix}-${i}-${now}@e2e.local`,
      cookieStore: [datadomeCookie(`dd-${i}`), sessionCookie(`s-${i}`)],
      lastWarmedAt: new Date(),
      lastUsedAt: new Date(now - (10 - i) * 60_000),
    })));
    const { accountPoolService } = await import('../../src/modules/accounts/accountPool.service');

    const unrelatedBefore = await prisma.vfsAccount.findMany({
      where: { status: 'ACTIVE', id: { notIn: accounts.map((account) => account.id) } },
      select: { id: true, lastUsedAt: true },
    });

    let markLocksReady!: () => void;
    let releaseLockRows!: () => void;
    const lockReady = new Promise<void>((resolve) => { markLocksReady = resolve; });
    const releaseLocks = new Promise<void>((resolve) => { releaseLockRows = resolve; });
    const locker = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT id
        FROM "VfsAccount"
        WHERE status = 'ACTIVE'
          AND id NOT IN (${accounts[0].id}, ${accounts[1].id}, ${accounts[2].id})
        FOR UPDATE
      `;
      markLocksReady();
      await releaseLocks;
    }, { timeout: 15_000, maxWait: 5_000 });

    const picked = [];
    try {
      await lockReady;
      for (let i = 0; i < 3; i++) picked.push(await accountPoolService.getAvailableAccount());
    } finally {
      releaseLockRows();
      await locker;
    }

    assert(new Set(picked.map((a) => a.id)).size === 3, `expected 3 different accounts, got ${picked.map((a) => a.email).join(', ')}`);
    assert(picked.every((a) => accounts.some((expected) => expected.id === a.id)), 'rotation picked an account outside the test pool');

    const unrelatedAfter = await prisma.vfsAccount.findMany({
      where: { id: { in: unrelatedBefore.map((account) => account.id) } },
      select: { id: true, lastUsedAt: true },
    });
    for (const before of unrelatedBefore) {
      const after = unrelatedAfter.find((account) => account.id === before.id);
      assert(after?.lastUsedAt?.getTime() === before.lastUsedAt?.getTime(), `rotation mutated unrelated account ${before.id}`);
    }
  } finally {
    await cleanupByEmailPrefix(prefix);
  }
});
