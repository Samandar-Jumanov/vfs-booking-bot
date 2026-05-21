import { runE2e, assert, skip } from './common';

runE2e('11. Notification preferences (Telegram, SMTP, web push)', async () => {
  const { setSetting, getSetting } = await import('../../src/modules/settings/settings.service');
  await setSetting('notifications.telegram.enabled', false);
  await setSetting('notifications.email.enabled', false);
  await setSetting('notifications.push.enabled', false);
  assert(await getSetting('notifications.telegram.enabled') === false, 'telegram preference did not persist');
  assert(await getSetting('notifications.email.enabled') === false, 'email preference did not persist');
  assert(await getSetting('notifications.push.enabled') === false, 'push preference did not persist');

  if (process.env.E2E_LIVE_NOTIFICATIONS !== '1') {
    skip('local preference persistence passed; E2E_LIVE_NOTIFICATIONS=1 is required to send Telegram/SMTP/web-push messages');
  }
  const { dispatchNotification } = await import('../../src/modules/notifications/notification.service');
  await dispatchNotification({ event: 'BOOKING_FAILED', destination: 'lva', reason: 'e2e notification test' });
});
