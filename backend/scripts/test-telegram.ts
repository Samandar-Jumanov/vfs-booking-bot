/**
 * Manual test-fire script for Telegram notifications.
 *
 * Usage:
 *   npx tsx scripts/test-telegram.ts [event]
 *
 * Events:
 *   slot_found      — fires SLOT_DETECTED with synthetic slot data
 *   booking_success — fires BOOKING_SUCCESS with synthetic booking data
 *   booking_failed  — fires BOOKING_FAILED (forces NOTIFY_BOOKING_FAILURES=true)
 *   heartbeat       — fires the heartbeat.fireNow() directly
 *
 * Reads TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID from backend/.env (via dotenv).
 * Exit 0 on success, exit 1 on error.
 */

import path from 'path';
import dotenv from 'dotenv';

// Load backend/.env first, then repo-root .env as fallback (same pattern as index.ts)
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

// BOOKING_FAILED is suppressed unless this flag is on — set it for this script
// so operators can test the failure alert path without editing .env.
process.env.NOTIFY_BOOKING_FAILURES = 'true';

// Import after dotenv so env.ts sees the loaded vars
import { dispatchNotification } from '../src/modules/notifications/notification.service';
import { heartbeat } from '../src/modules/notifications/heartbeat';

const EVENT = (process.argv[2] ?? 'slot_found').toLowerCase();

const VALID_EVENTS = ['slot_found', 'booking_success', 'booking_failed', 'heartbeat'];

async function main(): Promise<void> {
  if (!VALID_EVENTS.includes(EVENT)) {
    console.error(`Unknown event: "${EVENT}"`);
    console.error(`Valid options: ${VALID_EVENTS.join(' | ')}`);
    process.exit(1);
  }

  console.info(`[test-telegram] Firing "${EVENT}"…`);

  switch (EVENT) {
    case 'slot_found':
      await dispatchNotification({
        event: 'SLOT_DETECTED',
        slotDate: '2026-06-15',
        slotId: '2026-06-15@test@mailsac.com',
        accountEmail: 'test@mailsac.com',
        destination: 'lva',
      });
      break;

    case 'booking_success':
      await dispatchNotification({
        event: 'BOOKING_SUCCESS',
        profileName: 'Test User',
        confirmationNo: 'VFS-TEST-001',
        slotId: '2026-06-15@test@mailsac.com',
        slotDate: '2026-06-15',
        destination: 'lva',
      });
      break;

    case 'booking_failed':
      // NOTIFY_BOOKING_FAILURES is forced true above so this always fires.
      await dispatchNotification({
        event: 'BOOKING_FAILED',
        profileName: 'Test User',
        reason: 'NO_SLOT_AVAILABLE',
        destination: 'lva',
      });
      break;

    case 'heartbeat':
      // recordCheck(false) so the heartbeat shows "no slots" (the normal idle state)
      heartbeat.recordCheck(false);
      await heartbeat.fireNow();
      break;
  }

  console.info(`[test-telegram] Done — check Telegram for the "${EVENT}" message.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('[test-telegram] Error:', err?.message ?? String(err));
  process.exit(1);
});
