import { runE2e, assert, cleanupByEmailPrefix, createTestAccount, datadomeCookie, sessionCookie, withTestServer } from './common';

runE2e('2. Manual cookie injection via /inject-cookies page backend route', async () => {
  const prefix = 'e2e-manual-cookies';
  await cleanupByEmailPrefix(prefix);
  try {
    const account = await createTestAccount(prefix, { email: `${prefix}-${Date.now()}@e2e.local`, status: 'BLOCKED', lastWarmedAt: null });
    const { prisma } = await import('../../src/config/database');

    await withTestServer(async ({ baseUrl, authHeader }) => {
      const passwordRes = await fetch(`${baseUrl}/api/accounts/${account.id}/password`, {
        headers: authHeader,
      });
      assert(passwordRes.ok, `reveal password returned HTTP ${passwordRes.status}`);
      const passwordBody = await passwordRes.json() as { email?: string; password?: string; expiresInSeconds?: number };
      assert(passwordBody.email === account.email, 'reveal password returned wrong account email');
      assert(passwordBody.password === 'E2ePassw0rd!', 'reveal password did not decrypt stored password');
      assert(passwordBody.expiresInSeconds === 30, 'reveal password did not return 30 second expiry');

      const noDd = await fetch(`${baseUrl}/api/accounts/inject-cookies`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeader },
        body: JSON.stringify({ email: account.email, cookies: [sessionCookie('manual-no-dd')] }),
      });
      assert(noDd.ok, `inject without datadome returned HTTP ${noDd.status}`);
      const noDdBody = await noDd.json() as { success?: boolean; cookiesCount?: number; lastWarmedAt?: string | null };
      assert(noDdBody.success === true, 'inject without datadome did not return success=true');
      assert(noDdBody.cookiesCount === 1, 'inject without datadome returned wrong cookiesCount');
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
      const withDdBody = await withDd.json() as { success?: boolean; cookiesCount?: number; lastWarmedAt?: string | null };
      assert(withDdBody.success === true, 'inject with datadome did not return success=true');
      assert(withDdBody.cookiesCount === 2, 'inject with datadome returned wrong cookiesCount');
      assert(Boolean(withDdBody.lastWarmedAt), 'inject with datadome did not return lastWarmedAt');
    });

    const afterDd = await prisma.vfsAccount.findUniqueOrThrow({ where: { id: account.id } });
    assert(afterDd.lastWarmedAt instanceof Date, 'manual injection did not mark account fresh with datadome cookie');
    assert(afterDd.status === 'ACTIVE', 'manual injection did not mark account ACTIVE with datadome cookie');
  } finally {
    await cleanupByEmailPrefix(prefix);
  }

});
