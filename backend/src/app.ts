import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { env } from '@config/env';
import { apiLimiter } from '@middleware/rateLimit.middleware';
import { errorHandler } from '@middleware/errorHandler';

// Routers (imported as they are built)
import { authRouter } from '@modules/auth/auth.router';
import { profilesRouter } from '@modules/profiles/profiles.router';
import { monitorRouter } from '@modules/monitor/monitor.router';
import { bookingRouter } from '@modules/booking/booking.router';
import { logsRouter } from '@modules/logs/logs.router';
import { settingsRouter } from '@modules/settings/settings.router';
import { proxyRouter } from '@modules/proxy/proxy.router';
import { accountsRouter } from '@modules/accounts/accounts.router';
import { extensionRouter } from '@modules/extension/extension.router';
import { emailRouter } from '@modules/email/email.router';
import { vendorRouter } from '@modules/vendor/vendor.router';
import { bootstrapRouter } from '@modules/auth/bootstrap.router';
import { statusRouter } from '@modules/status/status.router';
import { scenarioRouter } from '@modules/scenario/scenario.router';
import { pipelineRouter } from '@modules/pipeline/pipeline.router';
import { fleetRouter } from '@modules/fleet/fleet.router';

export function createApp() {
  const app = express();

  // Trust the first proxy hop (nginx) so X-Forwarded-For yields the real client
  // IP for express-rate-limit instead of nginx's internal address.
  app.set('trust proxy', 1);

  // ── Security / parsing middleware ──────────────────────────────────────────
  app.use(helmet());
  // Accept comma-separated origins via FRONTEND_URL ("http://localhost:3000,http://localhost:3010")
  // and also dev hosts by default so local Next.js / Vite reloads on alternate ports work.
  const allowedOrigins = new Set<string>(
    [
      ...env.FRONTEND_URL.split(',').map((s) => s.trim()).filter(Boolean),
      'http://localhost:3000',
      'http://localhost:3010',
      'http://127.0.0.1:3000',
      'http://127.0.0.1:3010',
    ],
  );
  app.use(cors({
    origin: (origin, cb) => {
      if (!origin || allowedOrigins.has(origin)) return cb(null, true);
      // Chrome extensions: chrome-extension://<id> — always allow (extension is the booking agent).
      if (origin.startsWith('chrome-extension://') || origin.startsWith('moz-extension://')) return cb(null, true);
      cb(new Error(`CORS: origin ${origin} not allowed`));
    },
    credentials: true,
  }));
  app.use(compression());
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());

  // ── Health check (no auth, no rate limit) ─────────────────────────────────
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // ── Full system health (no auth) — for ops dashboards + uptime monitors ──
  app.get('/api/health/full', async (_req, res) => {
    const startedAt = Date.now();
    const { prisma } = await import('@config/database');
    const { getRedis } = await import('@config/redis');
    const checks: Record<string, { ok: boolean; ms?: number; note?: string }> = {};

    async function check(name: string, fn: () => Promise<string | void>) {
      const t = Date.now();
      try {
        const note = await fn();
        checks[name] = { ok: true, ms: Date.now() - t, note: note || undefined };
      } catch (err: any) {
        checks[name] = { ok: false, ms: Date.now() - t, note: err?.message ?? String(err) };
      }
    }

    await check('postgres', async () => {
      const r = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT NOW() as now`;
      return `${r[0]?.now?.toISOString?.()}`;
    });
    await check('redis', async () => {
      const pong = await getRedis().ping();
      return pong;
    });
    await check('account-pool', async () => {
      const c = await prisma.vfsAccount.count();
      const active = await prisma.vfsAccount.count({ where: { status: 'ACTIVE' } });
      const fresh = await prisma.vfsAccount.count({
        where: { status: 'ACTIVE', lastWarmedAt: { gt: new Date(Date.now() - 12 * 3600 * 1000) } },
      });
      return `total=${c} active=${active} fresh=${fresh}`;
    });
    await check('profiles', async () => {
      const c = await prisma.profile.count({ where: { isActive: true } });
      return `active=${c}`;
    });
    await check('bookings-24h', async () => {
      const since = new Date(Date.now() - 24 * 3600 * 1000);
      const total = await prisma.booking.count({ where: { createdAt: { gt: since } } });
      const success = await prisma.booking.count({ where: { createdAt: { gt: since }, status: 'SUCCESS' } });
      return `total=${total} success=${success}`;
    });
    await check('env-vendor-keys', async () => {
      const keys = {
        TWOCAPTCHA: !!process.env.TWOCAPTCHA_API_KEY,
        MAILSAC: !!process.env.MAILSAC_API_KEY,
        SMS_ACTIVATE: !!process.env.SMS_ACTIVATE_API_KEY,
        VAKSMS: !!process.env.VAKSMS_API_KEY,
        CUSTOM_DOMAIN: !!process.env.CUSTOM_EMAIL_DOMAIN,
        TELEGRAM_BOT: !!process.env.TELEGRAM_BOT_TOKEN,
        CDP: !!process.env.CDP_ENDPOINT,
      };
      return Object.entries(keys).filter(([, v]) => v).map(([k]) => k).join(',') || '(none)';
    });

    const allOk = Object.values(checks).every((c) => c.ok);
    res.status(allOk ? 200 : 503).json({
      status: allOk ? 'ok' : 'degraded',
      checks,
      tookMs: Date.now() - startedAt,
      timestamp: new Date().toISOString(),
    });
  });

  app.use('/api/email', emailRouter);
  app.use('/api/status', statusRouter);
  // Bootstrap endpoint must NOT be rate-limited or require auth (it creates the first admin).
  app.use('/api/bootstrap', bootstrapRouter);

  // ── API routes ────────────────────────────────────────────────────────────
  app.use('/api', apiLimiter);
  app.use('/api/auth', authRouter);
  app.use('/api/profiles', profilesRouter);
  app.use('/api/monitor', monitorRouter);
  app.use('/api/booking', bookingRouter);
  app.use('/api/logs', logsRouter);
  app.use('/api/settings', settingsRouter);
  app.use('/api/proxy', proxyRouter);
  app.use('/api/accounts', accountsRouter);
  app.use('/api/extension', extensionRouter);
  app.use('/api/vendor', vendorRouter);
  app.use('/api/scenario', scenarioRouter);
  app.use('/api/pipeline', pipelineRouter);
  app.use('/api/fleet', fleetRouter);

  // ── Error handler (must be last) ─────────────────────────────────────────
  app.use(errorHandler);

  return app;
}
