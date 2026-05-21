import { assert, liveOnly, runE2e, sleep } from './common';

runE2e('4. Slot detection to Telegram alert pipeline', async () => {
  liveOnly('E2E_LIVE_TELEGRAM', 'this test sends a real Telegram alert to TELEGRAM_TEST_CHAT_ID');
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const testChatId = process.env.TELEGRAM_TEST_CHAT_ID;
  assert(Boolean(token), 'TELEGRAM_BOT_TOKEN is required');
  assert(Boolean(testChatId), 'TELEGRAM_TEST_CHAT_ID is required and must be different from production chat');
  assert(testChatId !== process.env.TELEGRAM_CHAT_ID, 'TELEGRAM_TEST_CHAT_ID must be different from TELEGRAM_CHAT_ID');

  const { getLastTelegramDelivery } = await import('../../src/modules/notifications/telegram.bot');
  const { dispatchNotification } = await import('../../src/modules/notifications/notification.service');

  const markerEmail = `telegram-e2e-${Date.now()}@mailsac.com`;
  const slotDate = '2026-06-15';
  await dispatchNotification({
    event: 'SLOT_DETECTED',
    destination: 'lva',
    slotDate,
    visaType: 'SCH',
    accountEmail: markerEmail,
  });
  await sleep(5_000);

  const delivery = getLastTelegramDelivery();
  assert(Boolean(delivery), 'Telegram sendMessage did not return a delivery record');
  assert(delivery.chatId === String(testChatId), 'Telegram alert was not sent to TELEGRAM_TEST_CHAT_ID');
  const text = delivery.text;
  assert(text.includes('lva'), 'Telegram message does not include destination');
  assert(text.includes(slotDate), 'Telegram message does not include slot date');
  assert(text.includes(markerEmail), 'Telegram message does not include account email');

  await fetch(`https://api.telegram.org/bot${token}/deleteMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: testChatId, message_id: delivery.messageId }),
  }).catch(() => undefined);
});
