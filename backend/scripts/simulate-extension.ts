/**
 * End-to-end test bypass: simulate the Chrome extension by connecting to the
 * /extension WS as a Node client, sending EXT_SESSION_SYNC + EXT_BOOKING_COMPLETED.
 * Proves the backend pipeline (cookie sync → dispatch → booking outcome) works
 * independent of Chrome/extension reliability issues.
 */
import 'tsconfig-paths/register';
import * as path from 'path';
import * as dotenv from 'dotenv';
dotenv.config({ path: path.resolve('.env') });
dotenv.config({ path: path.resolve('../.env') });
import WebSocket from 'ws';
import { prisma } from '../src/config/database';
import { signExtensionToken } from '../src/utils/jwt';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

(async () => {
  // 1. Resolve admin user → mint extension token (same one the extension uses).
  const admin = await prisma.user.findFirst({ where: { role: 'ADMIN' }, orderBy: { createdAt: 'asc' } });
  if (!admin) throw new Error('No admin user');
  const token = signExtensionToken({ sub: admin.id, email: admin.email, role: admin.role });
  console.log('[sim] admin:', admin.email, 'id:', admin.id);

  // 2. Connect to /extension WS.
  const url = `ws://localhost:3001/extension?token=${token}`;
  console.log('[sim] connecting WS:', url.slice(0, 80) + '...');
  const ws = new WebSocket(url);

  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => { console.log('[sim] WS connected'); resolve(); });
    ws.on('error', (e) => { console.error('[sim] WS error:', e.message); reject(e); });
    setTimeout(() => reject(new Error('connect timeout')), 5000);
  });

  // 3. Send EXT_HEARTBEAT first to register state.
  ws.send(JSON.stringify({ type: 'EXT_HEARTBEAT', at: new Date().toISOString(), state: {} }));

  // 4. Send EXT_SESSION_SYNC with a fake datadome cookie jar.
  const syncPayload = {
    type: 'EXT_SESSION_SYNC',
    url: 'https://visa.vfsglobal.com/uzb/en/lva/dashboard',
    cookies: 'datadome=FAKE_DATADOME_TOKEN_FOR_TEST; session=abc123',
    cookieJar: [
      { name: 'datadome', value: 'FAKE_DATADOME_TOKEN_FOR_TEST', domain: '.vfsglobal.com', path: '/', secure: true, httpOnly: true, sameSite: 'lax', expirationDate: Date.now() / 1000 + 86400 },
      { name: 'session', value: 'abc123', domain: '.vfsglobal.com', path: '/', secure: true, httpOnly: false, sameSite: 'lax' },
    ],
    email: 'jumanovsamandar84@gmail.com',
    timestamp: new Date().toISOString(),
  };
  console.log('[sim] sending EXT_SESSION_SYNC with fake datadome cookie...');
  ws.send(JSON.stringify(syncPayload));
  await sleep(2000);

  // 5. Verify backend persisted it.
  const acc = await prisma.vfsAccount.findFirst({ where: { email: 'jumanovsamandar84@gmail.com' } });
  console.log('[sim] account after sync:', {
    email: acc?.email,
    status: acc?.status,
    lastWarmedAt: acc?.lastWarmedAt,
    cookieStore: acc?.cookieStore,
  });

  if (!acc?.lastWarmedAt) {
    console.error('[sim] FAIL — account not marked warmed');
    ws.close();
    await prisma.$disconnect();
    process.exit(2);
  }
  console.log('[sim] ✅ Account warmed via sim');

  // 6. Trigger a booking job — set up listener for BOOK_FOR_CUSTOMER on WS.
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    console.log('[sim] received from backend:', JSON.stringify(msg).slice(0, 200));
    if (msg.type === 'BOOK_FOR_CUSTOMER') {
      console.log('[sim] 🎯 BOOK_FOR_CUSTOMER received! correlationId=' + msg.correlationId);
      // Simulate successful booking
      setTimeout(() => {
        ws.send(JSON.stringify({
          type: 'EXT_BOOKING_COMPLETED',
          confirmationNumber: 'VFS-SIM-' + Date.now(),
          destination: msg.destination,
          accountEmail: msg.accountEmail,
          correlationId: msg.correlationId,
        }));
      }, 1000);
    }
  });

  // 7. Enqueue booking.
  const { enqueueBooking } = await import('../src/modules/booking/booking.service');
  const profile = await prisma.profile.findFirst({ where: { isActive: true } });
  if (!profile) throw new Error('No profile');
  console.log('[sim] enqueuing booking for', profile.id);
  const jobId = await enqueueBooking({
    profileId: profile.id,
    destination: 'lva',
    visaType: 'LNGWORK',
    slot: { date: null, time: null, raw: 'sim-test' },
  } as any);
  console.log('[sim] job', jobId, 'enqueued; waiting up to 60s for completion...');

  // 8. Poll booking status.
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const b = await prisma.booking.findFirst({ where: { jobId }, select: { status: true, confirmationNo: true, errorMessage: true } });
    if (b && (b.status === 'SUCCESS' || b.status === 'FAILED')) {
      console.log('[sim] booking final state:', b);
      break;
    }
    if (i % 5 === 0) console.log(`[sim] ...still waiting (status: ${b?.status})`);
  }

  ws.close();
  await prisma.$disconnect();
  process.exit(0);
})().catch(async (e) => {
  console.error('[sim] FATAL:', e?.stack || e?.message || e);
  try { await prisma.$disconnect(); } catch {}
  process.exit(1);
});
