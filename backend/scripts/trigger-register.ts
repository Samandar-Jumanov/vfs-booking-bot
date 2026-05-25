/**
 * Fires VFS auto-register on prod (POST /api/accounts/auto-create →
 * autoRegisterAccount → BG_REGISTER_VFS_ACCOUNT → extension drives /register).
 * Run with `railway run` so JWT_ACCESS_SECRET is injected.
 * Requires the operator's Chrome connected (VPN OFF, fresh UZ IP).
 */
import axios from 'axios';
import { signAccessToken } from '../src/utils/jwt';

const BACKEND = process.env.SELF_URL || 'https://backend-production-24c3.up.railway.app';
const OPERATOR_ID = process.env.OPERATOR_USER_ID || 'cmpc6drkn0000f2z1s3n6ngcv';

async function main(): Promise<void> {
  const token = signAccessToken({ sub: OPERATOR_ID, email: 'jumanovsamandar005@gmail.com', role: 'ADMIN' as never });
  const body = { source: 'uzb', destination: 'lva', countryCode: '171' };
  console.log('POST /api/accounts/auto-create', JSON.stringify(body));
  const t0 = Date.now();
  const resp = await axios.post(`${BACKEND}/api/accounts/auto-create`, body, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: 330_000,
    validateStatus: () => true,
  });
  console.log(`HTTP ${resp.status} after ${Math.round((Date.now() - t0) / 1000)}s`);
  console.log('result:', JSON.stringify(resp.data));
}

main().catch((e) => { console.error('crashed:', e?.response?.status, e?.message); process.exit(1); });
