import { runE2e, liveOnly, assert, cleanupByEmailPrefix, createTestAccount, createTestProfile, datadomeCookie, sessionCookie } from './common';

runE2e('5. Auto-booking dispatch when slot detected', async () => {
  liveOnly('E2E_LIVE_EXTENSION', 'booking dispatch needs the operator Chrome extension connected');
  const prefix = 'e2e-book-dispatch';
  await cleanupByEmailPrefix(prefix);
  try {
    const profile = await createTestProfile(prefix);
    await createTestAccount(prefix, {
      email: `${prefix}-${Date.now()}@e2e.local`,
      cookieStore: [datadomeCookie(), sessionCookie()],
      lastWarmedAt: new Date(),
    });
    const { bookViaExtension } = await import('../../src/modules/booking/extension-dispatch.service');
    const result = await bookViaExtension({
      profileId: profile.id,
      destination: 'lva',
      visaType: process.env.E2E_VFS_VISA_CATEGORY_CODE ?? 'SCH',
      slot: { date: '2026-06-15', time: '10:00', destination: 'lva', visaType: 'SCH' },
    });
    assert(result.success, `extension booking dispatch failed: ${result.reason ?? 'unknown'}`);
  } finally {
    await cleanupByEmailPrefix(prefix);
  }
});
