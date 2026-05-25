/**
 * Fires the autonomous booking flow on prod (POST /api/accounts/book-test →
 * BG_BOOK_VFS → runBookingSteps in the operator's extension). Run with
 * `railway run` so JWT_ACCESS_SECRET is injected.
 *
 * Override applicant fields via env: FIRST, LAST, PASSPORT, CONTACT, EMAIL,
 * NATIONALITY, SUBCATEGORY. Defaults to the p1.png test passport.
 */
import axios from 'axios';
import { signAccessToken } from '../src/utils/jwt';

const BACKEND = process.env.SELF_URL || 'https://backend-production-24c3.up.railway.app';
const OPERATOR_ID = process.env.OPERATOR_USER_ID || 'cmpc6drkn0000f2z1s3n6ngcv';

async function main(): Promise<void> {
  const token = signAccessToken({ sub: OPERATOR_ID, email: 'jumanovsamandar005@gmail.com', role: 'ADMIN' as never });
  const body = {
    firstName: process.env.FIRST || 'ELBEK',
    lastName: process.env.LAST || 'OLIMOV',
    nationality: process.env.NATIONALITY || 'Uzbekistan',
    passportNumber: process.env.PASSPORT || 'FA8308090',
    contact: process.env.CONTACT || '901234567',
    email: process.env.EMAIL || 'jumanovsamandar84@gmail.com',
    subCategory: process.env.SUBCATEGORY || 'Uzbek',
  };
  console.log('POST /api/accounts/book-test', JSON.stringify(body));
  const t0 = Date.now();
  const resp = await axios.post(`${BACKEND}/api/accounts/book-test`, body, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: 260_000,
    validateStatus: () => true,
  });
  console.log(`HTTP ${resp.status} after ${Math.round((Date.now() - t0) / 1000)}s`);
  console.log('result:', JSON.stringify(resp.data));
}

main().catch((e) => { console.error('crashed:', e?.response?.status, e?.message); process.exit(1); });
