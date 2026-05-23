/**
 * Fires the real prod auto-login endpoint as the admin operator, to see
 * end-to-end (HTTP -> loginAccount -> sendToExtension -> WS -> extension)
 * where the login dispatch breaks. DB-free: mints the token from env and
 * uses the prod HTTP API for everything. Run with `railway run` so
 * JWT_ACCESS_SECRET is injected.
 */
import axios from 'axios';
import { signAccessToken } from '../src/utils/jwt';

const BACKEND = process.env.SELF_URL || 'https://backend-production-24c3.up.railway.app';
const OPERATOR_ID = process.env.OPERATOR_USER_ID || 'cmpc6drkn0000f2z1s3n6ngcv';
const OPERATOR_EMAIL = 'jumanovsamandar005@gmail.com';

async function main(): Promise<void> {
  const token = signAccessToken({ sub: OPERATOR_ID, email: OPERATOR_EMAIL, role: 'ADMIN' as never });
  const auth = { headers: { Authorization: `Bearer ${token}` } };

  // 1. List accounts, pick one ACTIVE.
  const list = await axios.get(`${BACKEND}/api/accounts`, { ...auth, validateStatus: () => true });
  console.log('GET /accounts ->', list.status);
  const items: Array<{ id: string; email: string; status: string }> =
    list.data?.items ?? list.data ?? [];
  console.log('total accounts:', items.length);
  const active = items.find((a) => a.status === 'ACTIVE') ?? items[0];
  if (!active) {
    console.log('NO accounts returned — body:', JSON.stringify(list.data).slice(0, 300));
    return;
  }
  console.log('target:', active.id, active.email, active.status);

  // 2. Fire auto-login (blocks up to 90s on the backend).
  const url = `${BACKEND}/api/accounts/${active.id}/auto-login`;
  console.log('POST', url);
  const t0 = Date.now();
  const resp = await axios.post(url, {}, { ...auth, timeout: 120_000, validateStatus: () => true });
  console.log(`HTTP ${resp.status} after ${Math.round((Date.now() - t0) / 1000)}s`);
  console.log('response:', JSON.stringify(resp.data));
}

main().catch((err) => {
  console.error('crashed:', err?.response?.status, err?.message);
  process.exit(1);
});
