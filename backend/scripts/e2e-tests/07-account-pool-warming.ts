import { runE2e, assert, cleanupByEmailPrefix, createTestAccount, datadomeCookie, sessionCookie } from './common';

runE2e('7. Account pool warming', async () => {
  const prefix = 'e2e-pool-warm';
  await cleanupByEmailPrefix(prefix);
  const { prisma } = await import('../../src/config/database');
  const { handleExtensionEvent } = await import('../../src/modules/extension/extension.state');
  const accounts = await Promise.all([0, 1, 2].map((i) => createTestAccount(prefix, {
    email: `${prefix}-${i}-${Date.now()}@e2e.local`,
    status: 'BLOCKED',
    lastWarmedAt: null,
  })));

  for (const account of accounts) {
    await handleExtensionEvent('e2e-operator', {
      type: 'EXT_SESSION_SYNC',
      email: account.email,
      url: 'https://visa.vfsglobal.com/uzb/en/lva/dashboard',
      cookies: 'datadome=ok; session=ok',
      cookieJar: [datadomeCookie(`dd-${account.id}`), sessionCookie(`s-${account.id}`)],
    });
  }

  const warmed = await prisma.vfsAccount.findMany({ where: { id: { in: accounts.map((a) => a.id) } } });
  assert(warmed.length === 3, 'not all test accounts were found after warming');
  assert(warmed.every((a) => a.status === 'ACTIVE' && a.lastWarmedAt), 'not all accounts are ACTIVE and fresh after session sync');
  await cleanupByEmailPrefix(prefix);
});
