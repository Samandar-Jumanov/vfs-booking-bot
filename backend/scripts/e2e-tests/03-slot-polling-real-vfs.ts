import { runE2e, liveOnly, assert, sleep, withTestServer } from './common';

runE2e('3. Slot polling against real VFS lift-api with stored cookies', async () => {
  liveOnly('E2E_LIVE_VFS', 'this test hits the real VFS lift-api with live fresh cookies');
  const { prisma } = await import('../../src/config/database');
  const startedAt = new Date();
  let monitorId: string | undefined;

  const staleCutoff = new Date(Date.now() - 12 * 60 * 60 * 1000);
  const account = await prisma.vfsAccount.findFirst({
    where: {
      status: 'ACTIVE',
      lastWarmedAt: { gte: staleCutoff },
      cookieStore: { not: undefined as never },
    },
    orderBy: { lastWarmedAt: 'desc' },
  });
  assert(Boolean(account), 'no ACTIVE cookieFresh account is available; run 15-cookie-sync-on-login first');
  assert(/datadome/i.test(JSON.stringify(account!.cookieStore)), 'selected account cookieStore does not contain datadome');

  try {
    await withTestServer(async ({ baseUrl, authHeader }) => {
      const res = await fetch(`${baseUrl}/api/monitor/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeader },
        body: JSON.stringify({
          id: `e2e-slot-poll-${Date.now()}`,
          sourceCountry: 'uzb',
          destination: 'lva',
          visaType: process.env.E2E_VFS_VISA_CATEGORY_CODE ?? 'SCH',
          intervalMs: 30_000,
          profileIds: [],
          mode: 'manual',
        }),
      });
      assert(res.ok, `monitor start returned HTTP ${res.status}`);
      const body = await res.json() as { monitorId?: string };
      assert(Boolean(body.monitorId), 'monitor start did not return monitorId');
      monitorId = body.monitorId;

      const { getLogs } = await import('../../src/modules/logs/logs.service');
      const waitMs = Number(process.env.E2E_SLOT_POLL_WAIT_MS ?? 60_000);
      const deadline = Date.now() + waitMs;
      let pollLog: Awaited<ReturnType<typeof getLogs>>['items'][number] | undefined;
      while (Date.now() < deadline && !pollLog) {
        const logs = await getLogs({ eventType: 'MONITOR_STARTED', limit: 100 });
        pollLog = logs.items.find((row) =>
          row.timestamp >= startedAt
          && /\[EXT_POLL_RESULT\]/.test(row.message)
          && /status=200/.test(row.message)
        );
        if (!pollLog) await sleep(2_000);
      }
      assert(Boolean(pollLog), 'no EXT_POLL_RESULT status=200 log was recorded within the poll window');

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
  }
});
