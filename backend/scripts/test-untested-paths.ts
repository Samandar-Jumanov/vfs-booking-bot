/**
 * Tests the code paths that real vendor APIs would exercise, using mocks.
 * Catches: typos, wrong DB shapes, wrong CORS, wrong webhook auth,
 * provider factory mis-routing, untracked event variants, etc.
 *
 * Run with backend already running on :3001.
 */
import 'tsconfig-paths/register';
import * as path from 'path';
import * as dotenv from 'dotenv';
dotenv.config({ path: path.resolve('../.env') });
dotenv.config({ path: path.resolve('.env'), override: true });
import axios, { AxiosError } from 'axios';
import { prisma } from '../src/config/database';
import { signExtensionToken } from '../src/utils/jwt';

const BASE = 'http://localhost:3001';
const results: { name: string; ok: boolean; note?: string }[] = [];
const note = (name: string, ok: boolean, msg?: string) => {
  results.push({ name, ok, note: msg });
  console.log(`${ok ? '✅' : '❌'} ${name}${msg ? ' — ' + msg : ''}`);
};

async function login(): Promise<string> {
  const r = await axios.post(`${BASE}/api/auth/login`, { email: 'admin@vfs.local', password: 'admin123' });
  return r.data.accessToken;
}

(async () => {
  console.log('\n=== Untested-path tests ===\n');

  // 1. Health.
  try {
    const r = await axios.get(`${BASE}/api/health`);
    note('Backend health', r.data.status === 'ok');
  } catch (e: any) {
    note('Backend health', false, e.message);
    process.exit(1);
  }

  const token = await login();
  const auth = { headers: { Authorization: `Bearer ${token}` } };

  // 2. Email webhook — auth check + persist.
  try {
    // a) Without secret → should pass if EMAIL_WEBHOOK_SECRET unset, fail if set.
    const r1 = await axios.post(`${BASE}/api/email/webhook`, {
      to: 'test-untested@example.com',
      from: 'no-reply@vfs.com',
      subject: 'Verify your VFS account',
      body: 'Click https://visa.vfsglobal.com/verify?token=abc123 to verify',
    }).catch((err: AxiosError) => err.response!);
    const expectAuthGate = !!process.env.EMAIL_WEBHOOK_SECRET;
    if (expectAuthGate) {
      note('Email webhook rejects no-secret', r1.status === 401);
    } else {
      note('Email webhook accepts (no secret configured)', r1.status === 200);
    }
  } catch (e: any) {
    note('Email webhook (no secret)', false, e.message);
  }

  // 3. Email webhook with secret if configured.
  if (process.env.EMAIL_WEBHOOK_SECRET) {
    try {
      const r = await axios.post(`${BASE}/api/email/webhook`, {
        to: 'test-untested@example.com',
        subject: 'VFS verification',
        body: 'https://visa.vfsglobal.com/verify?token=xyz',
      }, { headers: { 'X-Webhook-Secret': process.env.EMAIL_WEBHOOK_SECRET } });
      note('Email webhook accepts valid secret', r.data.ok === true);
    } catch (e: any) {
      note('Email webhook accepts valid secret', false, e.message);
    }
  }

  // 4. ReceivedEmail row persisted.
  try {
    const row = await prisma.receivedEmail.findFirst({
      where: { toAddress: 'test-untested@example.com' },
      orderBy: { receivedAt: 'desc' },
    });
    note('ReceivedEmail persisted', !!row, row ? `id=${row.id}, subject="${row.subject}"` : 'no row');
  } catch (e: any) {
    note('ReceivedEmail persisted', false, e.message);
  }

  // 5. customDomainService.createInbox + listInbox.
  try {
    const { customDomainService } = await import('../src/modules/email/customDomain.service');
    const original = process.env.CUSTOM_EMAIL_DOMAIN;
    process.env.CUSTOM_EMAIL_DOMAIN = 'test.com';
    const inbox = await customDomainService.createInbox('untested');
    process.env.CUSTOM_EMAIL_DOMAIN = original;
    note('customDomain createInbox', typeof inbox === 'string' && inbox.includes('@test.com'), inbox);
  } catch (e: any) {
    note('customDomain createInbox', false, e.message);
  }

  // 6. Provider factory routes correctly.
  try {
    const { getSmsProvider, getEmailProvider } = await import('../src/modules/accounts/providerFactory');
    const originalSms = process.env.SMS_PROVIDER;
    const originalEmail = process.env.EMAIL_PROVIDER;
    process.env.SMS_PROVIDER = 'vaksms';
    process.env.EMAIL_PROVIDER = 'custom';
    const sp = getSmsProvider();
    const ep = getEmailProvider();
    process.env.SMS_PROVIDER = originalSms;
    process.env.EMAIL_PROVIDER = originalEmail;
    note('Factory routes vaksms', !!sp && typeof sp.buyNumber === 'function');
    note('Factory routes customDomain', !!ep && typeof ep.createInbox === 'function');
  } catch (e: any) {
    note('Provider factory', false, e.message);
  }

  // 7. /api/accounts/auto-create returns clean error when no extension connected.
  try {
    const r = await axios.post(`${BASE}/api/accounts/auto-create`, { source: 'uzb', destination: 'lva' }, auth)
      .catch((err: AxiosError) => err.response!);
    // Without API keys + extension, expect 409 (operator offline) or 500 with clean reason.
    const status = r.status;
    const okShape = status === 200 || status === 201 || status === 409 || status === 500;
    note(`auto-create returns ${status}`, okShape, JSON.stringify(r.data).slice(0, 150));
  } catch (e: any) {
    note('auto-create error path', false, e.message);
  }

  // 8. CORS preflight for chrome-extension origin.
  try {
    const r = await axios.request({
      method: 'OPTIONS',
      url: `${BASE}/api/auth/login`,
      headers: {
        'Origin': 'chrome-extension://abc123',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    const allow = r.headers['access-control-allow-origin'];
    note('CORS allows chrome-extension', allow === 'chrome-extension://abc123', `allow="${allow}"`);
  } catch (e: any) {
    note('CORS chrome-extension', false, e.message);
  }

  // 9. Per-customer Telegram routing — read code path. Just verify the helper exists.
  try {
    const mod = await import('../src/modules/notifications/telegram.bot');
    note('sendTelegramTo helper exported', typeof (mod as any).sendTelegramTo === 'function');
  } catch (e: any) {
    note('sendTelegramTo helper', false, e.message);
  }

  // 10. dispatchBookingToExtension — clean failure when no extension connected.
  try {
    const { dispatchBookingToExtension } = await import('../src/modules/extension/extension.state');
    const profile = await prisma.profile.findFirst({ where: { isActive: true } });
    const account = await prisma.vfsAccount.findFirst();
    if (!profile || !account) {
      note('dispatchBookingToExtension (no offline-extension test)', false, 'need profile + account row');
    } else {
      const r = await dispatchBookingToExtension({
        customerId: profile.id,
        accountId: account.id,
        destination: 'lva',
        visaType: 'LNGWORK',
        slot: {},
      });
      // Without extension connected, expect accepted=false with a reason.
      note('dispatchBookingToExtension graceful failure', r.accepted === false && !!r.reason, `reason=${r.reason}`);
    }
  } catch (e: any) {
    note('dispatchBookingToExtension', false, e.message);
  }

  // 11. WS /extension endpoint accepts valid extension token (101 upgrade).
  try {
    const admin = await prisma.user.findFirst({ where: { role: 'ADMIN' }, orderBy: { createdAt: 'asc' } });
    if (!admin) throw new Error('no admin');
    const extToken = signExtensionToken({ sub: admin.id, email: admin.email, role: admin.role });
    const WebSocket = (await import('ws')).default;
    const ws = new WebSocket(`ws://localhost:3001/extension?token=${extToken}`);
    const opened = await new Promise<boolean>((resolve) => {
      ws.on('open', () => { ws.close(); resolve(true); });
      ws.on('error', () => resolve(false));
      setTimeout(() => resolve(false), 4000);
    });
    note('WS /extension accepts valid token', opened);
  } catch (e: any) {
    note('WS /extension', false, e.message);
  }

  // 12. WS /extension rejects bad token.
  try {
    const WebSocket = (await import('ws')).default;
    const ws = new WebSocket(`ws://localhost:3001/extension?token=junk.junk.junk`);
    const failed = await new Promise<boolean>((resolve) => {
      ws.on('open', () => { ws.close(); resolve(false); });
      ws.on('error', () => resolve(true));
      ws.on('unexpected-response', () => resolve(true));
      setTimeout(() => resolve(false), 4000);
    });
    note('WS /extension rejects bad token', failed);
  } catch (e: any) {
    note('WS /extension rejection', false, e.message);
  }

  // Summary.
  console.log('\n=== Summary ===');
  const passed = results.filter((r) => r.ok).length;
  const total = results.length;
  console.log(`${passed}/${total} passed`);
  await prisma.$disconnect();
  process.exit(passed === total ? 0 : 2);
})().catch(async (e) => {
  console.error('FATAL', e?.stack || e?.message || e);
  try { await prisma.$disconnect(); } catch {}
  process.exit(1);
});
