import { runE2e, assert, cleanupByEmailPrefix, createTestAccount, datadomeCookie, sessionCookie, withTestServer } from './common';

runE2e('7. Account pool warming', async () => {
  const prefix = 'e2e-pool-warm';
  await cleanupByEmailPrefix(prefix);
  const { prisma } = await import('../../src/config/database');
  const { handleExtensionEvent } = await import('../../src/modules/extension/extension.state');
  try {
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

    await withTestServer(async ({ baseUrl, authHeader }) => {
      const res = await fetch(`${baseUrl}/api/accounts/warmup-status?source=uzb&destination=lva`, {
        headers: authHeader,
      });
      assert(res.ok, `warmup-status returned HTTP ${res.status}`);
      const body = await res.json() as { summary?: { active?: number; fresh?: number }; items?: Array<{ id: string; cookieFresh: boolean; loginUrl: string }> };
      const testItems = (body.items ?? []).filter((item) => accounts.some((account) => account.id === item.id));
      assert(testItems.length === 3, 'warmup-status did not include all warmed test accounts');
      assert(testItems.every((item) => item.cookieFresh), 'warmup-status did not mark all warmed accounts fresh');
      assert(testItems.every((item) => item.loginUrl === 'https://visa.vfsglobal.com/uzb/en/lva/login'), 'warmup-status returned an unexpected loginUrl');
      assert((body.summary?.fresh ?? 0) >= 3, 'warmup-status summary did not count fresh accounts');
    });
  } finally {
    await cleanupByEmailPrefix(prefix);
  }
});
