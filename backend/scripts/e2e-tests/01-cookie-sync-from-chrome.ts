import { runE2e, assert, cleanupByEmailPrefix, createTestAccount, datadomeCookie, sessionCookie } from './common';

runE2e('1. Cookie sync from logged-in Chrome to backend DB', async () => {
  const prefix = 'e2e-cookie-sync';
  await cleanupByEmailPrefix(prefix);
  try {
    const account = await createTestAccount(prefix, { email: `${prefix}-${Date.now()}@e2e.local`, status: 'BLOCKED', lastWarmedAt: null });
    const { prisma } = await import('../../src/config/database');
    const { handleExtensionEvent } = await import('../../src/modules/extension/extension.state');

    await handleExtensionEvent('e2e-operator', {
      type: 'EXT_SESSION_SYNC',
      email: account.email,
      url: 'https://visa.vfsglobal.com/uzb/en/lva/dashboard',
      cookies: 'session=without-dd',
      cookieJar: [sessionCookie('without-dd')],
    });
    const withoutDd = await prisma.vfsAccount.findUniqueOrThrow({ where: { id: account.id } });
    assert(withoutDd.lastWarmedAt === null, 'account was marked warm without a datadome cookie');
    assert(withoutDd.status === 'BLOCKED', 'account status changed without a datadome cookie');

    await handleExtensionEvent('e2e-operator', {
      type: 'EXT_SESSION_SYNC',
      email: account.email,
      url: 'https://visa.vfsglobal.com/uzb/en/lva/dashboard',
      cookies: 'datadome=ok; session=with-dd',
      cookieJar: [datadomeCookie(), sessionCookie('with-dd')],
    });
    const withDd = await prisma.vfsAccount.findUniqueOrThrow({ where: { id: account.id } });
    assert(withDd.lastWarmedAt instanceof Date, 'account was not marked warm with datadome cookie');
    assert(withDd.status === 'ACTIVE', 'account did not flip to ACTIVE with datadome cookie');

  } finally {
    await cleanupByEmailPrefix(prefix);
  }
});
