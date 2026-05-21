import { runE2e, assert, cleanupByEmailPrefix, createTestAccount, datadomeCookie, sessionCookie, withTestServer } from './common';

runE2e('2. Manual cookie injection via /inject-cookies page backend route', async () => {
  const prefix = 'e2e-manual-cookies';
  await cleanupByEmailPrefix(prefix);
  try {
    const account = await createTestAccount(prefix, { email: `${prefix}-${Date.now()}@e2e.local`, status: 'BLOCKED', lastWarmedAt: null });
    const { prisma } = await import('../../src/config/database');

    await withTestServer(async ({ baseUrl, authHeader }) => {
      const noDd = await fetch(`${baseUrl}/api/accounts/inject-cookies`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeader },
        body: JSON.stringify({ email: account.email, cookies: [sessionCookie('manual-no-dd')] }),
      });
      assert(noDd.ok, `inject without datadome returned HTTP ${noDd.status}`);
    });

    const afterNoDd = await prisma.vfsAccount.findUniqueOrThrow({ where: { id: account.id } });
    assert(afterNoDd.lastWarmedAt === null, 'manual injection marked account fresh without datadome cookie');
    assert(afterNoDd.status === 'BLOCKED', 'manual injection changed account status without datadome cookie');

    await withTestServer(async ({ baseUrl, authHeader }) => {
      const withDd = await fetch(`${baseUrl}/api/accounts/inject-cookies`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeader },
        body: JSON.stringify({ email: account.email, cookies: [datadomeCookie('manual-dd'), sessionCookie('manual-with-dd')] }),
      });
      assert(withDd.ok, `inject with datadome returned HTTP ${withDd.status}`);
    });

    const afterDd = await prisma.vfsAccount.findUniqueOrThrow({ where: { id: account.id } });
    assert(afterDd.lastWarmedAt instanceof Date, 'manual injection did not mark account fresh with datadome cookie');
    assert(afterDd.status === 'ACTIVE', 'manual injection did not mark account ACTIVE with datadome cookie');
  } finally {
    await cleanupByEmailPrefix(prefix);
  }

});
