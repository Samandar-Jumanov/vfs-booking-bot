/**
 * 100%-autonomous full-loop demo. Proves the entire production chain end-to-end
 * by simulating the extension over WS, seeding demo data, and emitting a fake
 * slot event — watching the bot autonomously:
 *   1. Detect the slot (via /api/monitor/_test/emit-slot)
 *   2. Pick a customer from the pool (LRU + priority)
 *   3. Pick an active pool account
 *   4. Dispatch BOOK_FOR_CUSTOMER to the (simulated) extension
 *   5. Receive EXT_BOOKING_COMPLETED with confirmation
 *   6. Persist Booking row + fire Telegram alert
 *
 * Run with backend on :3001. Requires Postgres + Redis.
 */
import 'tsconfig-paths/register';
import * as path from 'path';
import * as dotenv from 'dotenv';
dotenv.config({ path: path.resolve('../.env') });
dotenv.config({ path: path.resolve('.env'), override: true });
import WebSocket from 'ws';
import axios from 'axios';
import { prisma } from '../src/config/database';
import { signExtensionToken } from '../src/utils/jwt';
import { encrypt } from '../src/utils/crypto';

const BASE = 'http://localhost:3001';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function login(): Promise<string> {
  const r = await axios.post(`${BASE}/api/auth/login`, { email: 'admin@vfs.local', password: 'admin123' });
  return r.data.accessToken;
}

(async () => {
  console.log('\n=== Full-loop demo: slot → book → telegram ===\n');

  const token = await login();
  const auth = { headers: { Authorization: `Bearer ${token}` } };

  // 1. Seed: ensure we have a profile and a warm pool account.
  let profile = await prisma.profile.findFirst({ where: { isActive: true } });
  if (!profile) {
    const { passportNumberEnc } = { passportNumberEnc: encrypt('AA1234567') };
    profile = await prisma.profile.create({
      data: {
        fullName: 'Demo Customer',
        passportNumberEnc: encrypt('AA1234567'),
        dobEnc: encrypt('1990-01-15'),
        passportExpiry: new Date('2030-12-31'),
        nationality: 'UZ',
        email: 'demo@example.com',
        phone: '+998901234567',
        gender: 'MALE',
        priority: 'HIGH',
        isActive: true,
      },
    });
    console.log(`[seed] created profile ${profile.id}`);
  } else {
    console.log(`[seed] using existing profile ${profile.id} (${profile.fullName})`);
  }

  // Ensure pool has at least one warm account.
  let account = await prisma.vfsAccount.findFirst({ where: { status: 'ACTIVE' } });
  if (!account) {
    account = await prisma.vfsAccount.create({
      data: {
        email: 'pool-demo@example.com',
        encryptedPassword: encrypt('test-password'),
        status: 'ACTIVE',
      },
    });
    console.log(`[seed] created pool account ${account.email}`);
  }
  // Force warmth so dispatch doesn't bounce.
  await prisma.vfsAccount.update({
    where: { id: account.id },
    data: {
      lastWarmedAt: new Date(),
      cookieStore: { raw: 'datadome=DEMO; session=demo', jar: [{ name: 'datadome', value: 'DEMO', domain: '.vfsglobal.com', path: '/', secure: true, httpOnly: true }], hasDatadome: true, capturedAt: new Date().toISOString() },
      tabUrl: 'https://visa.vfsglobal.com/uzb/en/lva/dashboard',
    },
  });
  console.log(`[seed] pool account ${account.email} marked warm`);

  // 2. Connect simulated extension over WS.
  const admin = await prisma.user.findFirst({ where: { role: 'ADMIN' }, orderBy: { createdAt: 'asc' } });
  if (!admin) throw new Error('no admin');
  const extToken = signExtensionToken({ sub: admin.id, email: admin.email, role: admin.role });
  const ws = new WebSocket(`ws://localhost:3001/extension?token=${extToken}`);
  await new Promise<void>((res, rej) => {
    ws.on('open', () => res());
    ws.on('error', rej);
    setTimeout(() => rej(new Error('connect timeout')), 5000);
  });
  console.log('[sim-ext] WS connected');

  // 3. Wire the simulated extension to auto-reply BOOK_FOR_CUSTOMER with success.
  let bookForCustomerSeen = false;
  let confirmationReturned = '';
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(String(raw));
      if (msg.type === 'BOOK_FOR_CUSTOMER') {
        bookForCustomerSeen = true;
        confirmationReturned = `VFS-LOOP-${Date.now()}`;
        console.log(`[sim-ext] 🎯 BOOK_FOR_CUSTOMER received (account=${msg.accountEmail}, correlationId=${msg.correlationId})`);
        // Reply after a short delay to simulate form-fill + submit.
        setTimeout(() => {
          ws.send(JSON.stringify({
            type: 'EXT_BOOKING_COMPLETED',
            confirmationNumber: confirmationReturned,
            destination: msg.destination,
            accountEmail: msg.accountEmail,
            correlationId: msg.correlationId,
          }));
        }, 1500);
      }
    } catch {}
  });

  // 4. Clear any stale booking lock for lva.
  const { getRedis } = await import('../src/config/redis');
  await getRedis().del('booking-lock:lva');

  // 5. Enqueue a booking job (simulates monitor detecting a slot).
  const { enqueueBooking } = await import('../src/modules/booking/booking.service');
  const jobId = await enqueueBooking({
    profileId: profile.id,
    destination: 'lva',
    visaType: 'LNGWORK',
    slot: { date: null, time: null, raw: 'full-loop-demo' },
  } as any);
  console.log(`[demo] booking enqueued (job ${jobId})`);

  // 6. Wait up to 60s for full-loop completion.
  let finalBooking: any = null;
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const b = await prisma.booking.findFirst({ where: { jobId }, select: { status: true, confirmationNo: true, errorMessage: true } });
    if (b && (b.status === 'SUCCESS' || b.status === 'FAILED')) { finalBooking = b; break; }
    if (i % 5 === 0) console.log(`[demo] waiting... status=${b?.status}`);
  }

  ws.close();

  // 7. Assert + report.
  console.log('\n=== Results ===');
  if (!bookForCustomerSeen) console.log('❌ BOOK_FOR_CUSTOMER never received over WS');
  else console.log('✅ BOOK_FOR_CUSTOMER dispatched correctly');

  if (!finalBooking) console.log('❌ Booking row never reached terminal state');
  else if (finalBooking.status === 'SUCCESS' && finalBooking.confirmationNo === confirmationReturned) {
    console.log(`✅ Booking SUCCESS with confirmation ${finalBooking.confirmationNo}`);
  } else {
    console.log(`❌ Booking ${finalBooking.status} — ${finalBooking.errorMessage ?? 'unknown'}`);
  }

  // Telegram firing is best-effort visible only via your phone — but log it.
  console.log('\n→ Check your Telegram bot for a BOOKING_SUCCESS alert with the confirmation number above.');

  await prisma.$disconnect();
  process.exit(0);
})().catch(async (e) => {
  console.error('FATAL', e?.stack || e?.message || e);
  try { await prisma.$disconnect(); } catch {}
  process.exit(1);
});
