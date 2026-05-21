import { runE2e, assert, skip, cleanupByEmailPrefix, createTestAccount, datadomeCookie, sessionCookie } from './common';

runE2e('8. Multi-account rotation', async () => {
  const prefix = 'e2e-rotation';
  await cleanupByEmailPrefix(prefix);
  const { prisma } = await import('../../src/config/database');
  const nonTestActive = await prisma.vfsAccount.count({
    where: { status: 'ACTIVE', email: { not: { startsWith: 'e2e-' } } },
  });
  if (nonTestActive > 0) {
    skip(`found ${nonTestActive} unrelated ACTIVE account(s); refusing to mutate their lastUsedAt during rotation test`);
  }
  try {
    const now = Date.now();
    const accounts = await Promise.all([0, 1, 2].map((i) => createTestAccount(prefix, {
      email: `${prefix}-${i}-${now}@e2e.local`,
      cookieStore: [datadomeCookie(`dd-${i}`), sessionCookie(`s-${i}`)],
      lastWarmedAt: new Date(),
      lastUsedAt: new Date(now - (10 - i) * 60_000),
    })));
    const { accountPoolService } = await import('../../src/modules/accounts/accountPool.service');
    const picked = [];
    for (let i = 0; i < 3; i++) picked.push(await accountPoolService.getAvailableAccount());
    assert(new Set(picked.map((a) => a.id)).size === 3, `expected 3 different accounts, got ${picked.map((a) => a.email).join(', ')}`);
    assert(picked.every((a) => accounts.some((expected) => expected.id === a.id)), 'rotation picked an account outside the test pool');
  } finally {
    await cleanupByEmailPrefix(prefix);
  }
});
