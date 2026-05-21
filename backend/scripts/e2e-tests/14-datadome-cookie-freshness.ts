import { runE2e, assert, cleanupByEmailPrefix, createTestAccount, datadomeCookie, sessionCookie } from './common';

runE2e('14. Datadome cookie freshness detection', async () => {
  const prefix = 'e2e-datadome';
  await cleanupByEmailPrefix(prefix);
  const account = await createTestAccount(prefix, { email: `${prefix}-${Date.now()}@e2e.local`, status: 'BLOCKED', lastWarmedAt: null });
  const { prisma } = await import('../../src/config/database');
  const { handleExtensionEvent } = await import('../../src/modules/extension/extension.state');

  await handleExtensionEvent('e2e-operator', {
    type: 'EXT_SESSION_SYNC',
    email: account.email,
    url: 'https://visa.vfsglobal.com/uzb/en/lva/dashboard',
    cookies: 'session=no-dd',
    cookieJar: [sessionCookie('no-dd')],
  });
  const stale = await prisma.vfsAccount.findUniqueOrThrow({ where: { id: account.id } });
  assert(stale.status === 'BLOCKED', 'account status changed without datadome');
  assert(stale.lastWarmedAt === null, 'lastWarmedAt changed without datadome');

  await handleExtensionEvent('e2e-operator', {
    type: 'EXT_SESSION_SYNC',
    email: account.email,
    url: 'https://visa.vfsglobal.com/uzb/en/lva/dashboard',
    cookies: 'datadome=yes; session=yes',
    cookieJar: [datadomeCookie('yes'), sessionCookie('yes')],
  });
  const fresh = await prisma.vfsAccount.findUniqueOrThrow({ where: { id: account.id } });
  assert(fresh.status === 'ACTIVE', 'account did not become ACTIVE with datadome');
  assert(fresh.lastWarmedAt instanceof Date, 'lastWarmedAt was not set with datadome');
  await cleanupByEmailPrefix(prefix);
});
