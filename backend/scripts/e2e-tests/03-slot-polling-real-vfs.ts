import { runE2e, liveOnly, assert, cleanupByEmailPrefix, createTestAccount, datadomeCookie, sessionCookie, withTestServer } from './common';

runE2e('3. Slot polling against real VFS lift-api with stored cookies', async () => {
  liveOnly('E2E_LIVE_VFS', 'this test hits the real VFS lift-api with live cookies');
  const prefix = 'e2e-slot-poll';
  await cleanupByEmailPrefix(prefix);
  let monitorId: string | undefined;
  try {
    const profile = await (await import('./common')).createTestProfile(prefix);
    await createTestAccount(prefix, {
      email: `${prefix}-${Date.now()}@e2e.local`,
      cookieStore: [datadomeCookie('live-dd'), sessionCookie('live-session')],
      lastWarmedAt: new Date(),
    });

    await withTestServer(async ({ baseUrl, authHeader }) => {
      const res = await fetch(`${baseUrl}/api/monitor/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeader },
        body: JSON.stringify({
          id: `e2e-slot-poll-${Date.now()}`,
          sourceCountry: 'uzbekistan',
          destination: 'lva',
          visaType: process.env.E2E_VFS_VISA_CATEGORY_CODE ?? 'SCH',
          intervalMs: 30_000,
          profileIds: [profile.id],
          mode: 'manual',
        }),
      });
      assert(res.ok, `monitor start returned HTTP ${res.status}`);
      const body = await res.json() as { monitorId?: string; message?: string };
      assert(Boolean(body.monitorId), 'monitor start did not return monitorId');
      assert(body.message === 'Monitor started', `monitor start returned unexpected message "${body.message}"`);
      monitorId = body.monitorId;

      const stop = await fetch(`${baseUrl}/api/monitor/stop/${encodeURIComponent(monitorId!)}`, {
        method: 'POST',
        headers: authHeader,
      });
      assert(stop.ok, `monitor stop returned HTTP ${stop.status}`);
    });
  } finally {
    if (monitorId) {
      const { stopMonitor } = await import('../../src/modules/monitor/monitor.service');
      stopMonitor(monitorId);
    }
    await cleanupByEmailPrefix(prefix);
  }
});
