/** Lists all VfsAccounts with status + cookie freshness, via the prod API. */
import axios from 'axios';
import { signAccessToken } from '../src/utils/jwt';

const BACKEND = process.env.SELF_URL || 'https://backend-production-24c3.up.railway.app';
const OPERATOR_ID = process.env.OPERATOR_USER_ID || 'cmpc6drkn0000f2z1s3n6ngcv';

async function main(): Promise<void> {
  const token = signAccessToken({ sub: OPERATOR_ID, email: 'jumanovsamandar005@gmail.com', role: 'ADMIN' as never });
  const list = await axios.get(`${BACKEND}/api/accounts`, {
    headers: { Authorization: `Bearer ${token}` },
    validateStatus: () => true,
  });
  const items: Array<Record<string, unknown>> = list.data?.items ?? list.data ?? [];
  const byStatus: Record<string, number> = {};
  for (const a of items) {
    const s = String(a.status);
    byStatus[s] = (byStatus[s] ?? 0) + 1;
    console.log(`${String(a.status).padEnd(8)} ${String(a.email).padEnd(34)} ${a.id}`);
  }
  console.log('\nTotals:', JSON.stringify(byStatus));
}

main().catch((e) => { console.error(e?.response?.status, e?.message); process.exit(1); });
