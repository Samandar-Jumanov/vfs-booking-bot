/**
 * Fires the SPA logout flow on prod (POST /api/accounts/logout-test →
 * BG_LOGOUT_VFS → LOGOUT_VIA_SPA avatar-menu click in the operator's
 * extension). No page.goto — pure SPA UI clicks. Run with `railway run` so
 * JWT_ACCESS_SECRET is injected. Requires a logged-in VFS tab open in the
 * bot Chrome instance.
 */
import axios from 'axios';
import { signAccessToken } from '../src/utils/jwt';

const BACKEND = process.env.SELF_URL || 'https://backend-production-24c3.up.railway.app';
const OPERATOR_ID = process.env.OPERATOR_USER_ID || 'cmpc6drkn0000f2z1s3n6ngcv';
const OPERATOR_EMAIL = 'jumanovsamandar005@gmail.com';

async function main(): Promise<void> {
  const token = signAccessToken({ sub: OPERATOR_ID, email: OPERATOR_EMAIL, role: 'ADMIN' as never });
  const url = `${BACKEND}/api/accounts/logout-test`;
  console.log('POST', url);
  const t0 = Date.now();
  const resp = await axios.post(url, {}, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: 70_000,
    validateStatus: () => true,
  });
  console.log(`HTTP ${resp.status} after ${Math.round((Date.now() - t0) / 1000)}s`);
  console.log('result:', JSON.stringify(resp.data));
}

main().catch((e) => { console.error('crashed:', e?.response?.status, e?.message); process.exit(1); });
