import { runE2e, assert, liveOnly, withTestServer } from './common';

runE2e('11. Notification preferences (Telegram, SMTP, web push)', async () => {
  const { getSetting, setSetting } = await import('../../src/modules/settings/settings.service');
  const keys = [
    'notifications.telegram.enabled',
    'notifications.email.enabled',
    'notifications.push.enabled',
  ] as const;
  const previous = new Map<string, unknown>();
  for (const key of keys) previous.set(key, await getSetting(key));

  try {
    await withTestServer(async ({ baseUrl, authHeader }) => {
      const patch = await fetch(`${baseUrl}/api/settings`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', ...authHeader },
        body: JSON.stringify({
          'notifications.telegram.enabled': false,
          'notifications.email.enabled': false,
          'notifications.push.enabled': false,
        }),
      });
      assert(patch.ok, `settings patch returned HTTP ${patch.status}`);
      const patchBody = await patch.json() as { success?: boolean; updated?: number };
      assert(patchBody.success === true && patchBody.updated === 3, 'settings patch returned unexpected summary');

      const get = await fetch(`${baseUrl}/api/settings`, { headers: authHeader });
      assert(get.ok, `settings get returned HTTP ${get.status}`);
      const settings = await get.json() as Record<string, unknown>;
      assert(settings['notifications.telegram.enabled'] === false, 'telegram preference did not persist');
      assert(settings['notifications.email.enabled'] === false, 'email preference did not persist');
      assert(settings['notifications.push.enabled'] === false, 'push preference did not persist');
    });

    liveOnly('E2E_LIVE_NOTIFICATIONS', 'local preference persistence passed; live notification delivery requires Telegram/SMTP/web-push credentials');
    const { dispatchNotification } = await import('../../src/modules/notifications/notification.service');
    await dispatchNotification({ event: 'BOOKING_FAILED', destination: 'lva', reason: 'e2e notification test' });
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === null) {
        const { prisma } = await import('../../src/config/database');
        await prisma.settings.deleteMany({ where: { key } });
      } else {
        await setSetting(key, value);
      }
    }
  }
});
