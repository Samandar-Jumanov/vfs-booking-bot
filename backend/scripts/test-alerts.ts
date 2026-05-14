import 'tsconfig-paths/register';
import { connectDatabase, disconnectDatabase } from '../src/config/database';
import { initTelegramBot } from '../src/modules/notifications/telegram.bot';
import { dispatchNotification } from '../src/modules/notifications/notification.service';

async function main() {
  await connectDatabase();
  initTelegramBot();

  const base = {
    sourceCountry: 'uzbekistan',
    destination: 'lva',
    visaType: 'SCH',
    monitorId: 'test-monitor-lva',
  };

  await Promise.all([
    dispatchNotification({ ...base, event: 'SLOT_DETECTED', slotDate: '2026-06-01' }),
    dispatchNotification({ ...base, event: 'BOOKING_SUCCESS', profileName: 'Test Profile', slotDate: '2026-06-01', confirmationNo: 'T4-TEST-001' }),
    dispatchNotification({ ...base, event: 'BOOKING_FAILED', reason: 'test retries exhausted' }),
    dispatchNotification({ ...base, event: 'CAPTCHA_MANUAL_NEEDED' }),
    dispatchNotification({ ...base, event: 'COOKIE_EXPIRING_SOON', minutesRemaining: 25 }),
    dispatchNotification({ ...base, event: 'MONITOR_CRASHED', attempt: 1 }),
    dispatchNotification({ ...base, event: 'MONITOR_DEAD' }),
  ]);

  await disconnectDatabase();
  setTimeout(() => process.exit(0), 500);
}

main().catch(async (err) => {
  console.error(err);
  await disconnectDatabase().catch(() => {});
  process.exit(1);
});
