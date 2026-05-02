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

export function createApp() {
  const app = express();

  // ── Security / parsing middleware ──────────────────────────────────────────
  app.use(helmet());
  app.use(cors({
    origin: env.FRONTEND_URL,
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

  // ── Error handler (must be last) ─────────────────────────────────────────
  app.use(errorHandler);

  return app;
}
