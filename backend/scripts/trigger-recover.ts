/**
 * Activates a PENDING account by fetching its Mailsac verification link and
 * visiting it (POST /api/accounts/recover-from-mailsac). Pass ACCOUNT_ID env.
 *   railway run --service backend npx tsx scripts/trigger-recover.ts
 */
import axios from 'axios';
import { signAccessToken } from '../src/utils/jwt';

const BACKEND = process.env.SELF_URL || 'https://backend-production-24c3.up.railway.app';
const OPERATOR_ID = process.env.OPERATOR_USER_ID || 'cmpc6drkn0000f2z1s3n6ngcv';
const ACCOUNT_ID = process.env.ACCOUNT_ID || '19b07aa6-62f4-4297-93d5-7a509229f89b';

async function main(): Promise<void> {
  const token = signAccessToken({ sub: OPERATOR_ID, email: 'jumanovsamandar005@gmail.com', role: 'ADMIN' as never });
  console.log('POST /api/accounts/recover-from-mailsac', ACCOUNT_ID);
  const t0 = Date.now();
  const resp = await axios.post(`${BACKEND}/api/accounts/recover-from-mailsac`, { accountId: ACCOUNT_ID }, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: 180_000,
    validateStatus: () => true,
  });
  console.log(`HTTP ${resp.status} after ${Math.round((Date.now() - t0) / 1000)}s`);
  console.log('result:', JSON.stringify(resp.data));
}

main().catch((e) => { console.error('crashed:', e?.response?.status, e?.message); process.exit(1); });
