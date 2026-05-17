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

  // ── Error handler (must be last) ─────────────────────────────────────────
  app.use(errorHandler);

  return app;
}
