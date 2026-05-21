import { runE2e, skip } from './common';

runE2e('4. Slot detection to Telegram alert pipeline', async () => {
  if (process.env.E2E_LIVE_TELEGRAM !== '1') {
    skip('E2E_LIVE_TELEGRAM=1 is required to send a real Telegram alert to a test chat');
  }
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
    skip('TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required for the live Telegram assertion');
  }
  const { initTelegramBot } = await import('../../src/modules/notifications/telegram.bot');
  const { dispatchNotification } = await import('../../src/modules/notifications/notification.service');
  initTelegramBot();
  await dispatchNotification({ event: 'SLOT_DETECTED', destination: 'lva', slotDate: '2026-06-15', visaType: 'SCH' });
});
