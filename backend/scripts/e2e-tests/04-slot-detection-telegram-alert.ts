import { runE2e, liveOnly, assert, withTestServer } from './common';

runE2e('4. Slot detection to Telegram alert pipeline', async () => {
  liveOnly('E2E_LIVE_TELEGRAM', 'this test sends a real Telegram alert to a test chat');
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
    throw new Error('TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required for the live Telegram assertion');
  }
  await withTestServer(async ({ baseUrl, authHeader }) => {
    const res = await fetch(`${baseUrl}/api/monitor/_test/emit-slot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader },
      body: JSON.stringify({ destination: 'lva', date: '2026-06-15', time: '10:00' }),
    });
    assert(res.ok, `test emit slot returned HTTP ${res.status}`);
    const body = await res.json() as { ok?: boolean; emitted?: boolean; destination?: string };
    assert(body.ok === true && body.emitted === true, 'test emit slot did not report emitted=true');
    assert(body.destination === 'lva', 'test emit slot returned wrong destination');
  });
});
