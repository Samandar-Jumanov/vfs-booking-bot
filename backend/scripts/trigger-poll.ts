/**
 * Verifies that slot polling returns real data once an account is logged in.
 *
 * The monitor module exposes NO dedicated "poll now and return slots" HTTP
 * route. Polling is started via `POST /api/monitor/start` (which returns
 * immediately with just a monitorId — the actual VFS fetch happens async in the
 * poll loop, and on prod EXTENSION_BOOKING=true delegates the fetch to the
 * operator's Chrome extension over WS). The slot results land in the monitor
 * state and are read back via `GET /api/monitor/status`
 * (slotDetectedCount / lastPollStatus / lastPollError / recentPolls).
 *
 * So this script: (1) starts a monitor for the uzb->lva route, (2) waits for a
 * poll cycle, (3) reads `/api/monitor/status` and prints the HTTP status + raw
 * body so we can see real slot data or a valid "no slots / blocked" response.
 *
 * DB-free: mints the admin token from env and uses the prod HTTP API for
 * everything, exactly like trigger-auto-login.ts. Run with `railway run` so
 * JWT_ACCESS_SECRET is injected.
 *
 *   ACCOUNT_ID  optional VFS account id to bind the monitor to (profileIds)
 *   SOURCE      source country code, default 'uzb'
 *   DEST        destination code, default 'lva'
 *   VISA_TYPE   visa category code, default 'SCH'
 *   INTERVAL_MS poll interval, default 30000
 *   WAIT_MS     how long to wait for a poll cycle before reading status (default 35000)
 */
import axios from 'axios';
import { signAccessToken } from '../src/utils/jwt';

const BACKEND = process.env.SELF_URL || 'https://backend-production-24c3.up.railway.app';
const OPERATOR_ID = process.env.OPERATOR_USER_ID || 'cmpc6drkn0000f2z1s3n6ngcv';
const OPERATOR_EMAIL = 'jumanovsamandar005@gmail.com';

const SOURCE = process.env.SOURCE || 'uzb';
const DEST = process.env.DEST || 'lva';
const VISA_TYPE = process.env.VISA_TYPE || 'SCH';
const INTERVAL_MS = Number(process.env.INTERVAL_MS || 30000);
const WAIT_MS = Number(process.env.WAIT_MS || 35000);
const ACCOUNT_ID = process.env.ACCOUNT_ID; // optional — binds the monitor to a profile/account

function logResponse(label: string, resp: { status: number; data: unknown }): void {
  console.log(`\n${label} -> HTTP ${resp.status}`);
  console.log('body:', typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data, null, 2));
}

async function main(): Promise<void> {
  const token = signAccessToken({ sub: OPERATOR_ID, email: OPERATOR_EMAIL, role: 'ADMIN' as never });
  const auth = { headers: { Authorization: `Bearer ${token}` }, validateStatus: () => true } as const;

  // 1. Start a monitor for the target route — this triggers a poll cycle.
  const startUrl = `${BACKEND}/api/monitor/start`;
  const startBody: Record<string, unknown> = {
    sourceCountry: SOURCE,
    destination: DEST,
    visaType: VISA_TYPE,
    intervalMs: INTERVAL_MS,
    mode: 'manual', // manual = poll/detect only, don't auto-enqueue a booking
    profileIds: ACCOUNT_ID ? [ACCOUNT_ID] : [],
  };
  console.log('POST', startUrl);
  console.log('payload:', JSON.stringify(startBody));
  const startResp = await axios.post(startUrl, startBody, { ...auth, timeout: 120_000 });
  logResponse('POST /api/monitor/start', startResp);

  if (startResp.status >= 400) {
    console.log('\nMonitor failed to start — aborting before status read.');
    process.exit(1);
  }

  // 2. Give the async poll loop (and, on prod, the extension round-trip) time to
  //    run at least one cycle before we read the result back.
  console.log(`\nWaiting ${Math.round(WAIT_MS / 1000)}s for a poll cycle...`);
  await new Promise((r) => setTimeout(r, WAIT_MS));

  // 3. Read the monitor status — this is where slot counts / poll outcomes surface.
  const statusUrl = `${BACKEND}/api/monitor/status`;
  console.log('\nGET', statusUrl);
  const statusResp = await axios.get(statusUrl, { ...auth, timeout: 60_000 });
  logResponse('GET /api/monitor/status', statusResp);

  if (statusResp.status >= 400) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('crashed:', err?.response?.status, err?.message);
  if (err?.response?.data !== undefined) {
    console.error('error body:', typeof err.response.data === 'string'
      ? err.response.data
      : JSON.stringify(err.response.data));
  }
  process.exit(1);
});
