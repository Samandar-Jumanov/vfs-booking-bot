import 'dotenv/config';
import fs from 'fs';
import http from 'http';
import { env } from '@config/env';

// Ensure session and recordings directories exist
fs.mkdirSync(env.SESSION_DIR, { recursive: true });
fs.mkdirSync('recordings', { recursive: true });
import { connectDatabase, disconnectDatabase } from '@config/database';
import { connectRedis, disconnectRedis } from '@config/redis';
import { createApp } from './app';
import { initWebSocket } from '@modules/websocket/ws.server';
import { startBookingWorker, stopBookingWorker } from '@modules/booking/booking.worker';
import { initTelegramBot } from '@modules/notifications/telegram.bot';
import { autoStartMonitors } from '@modules/monitor/monitor.service';


async function bootstrap() {
  // Connect to dependencies
  await connectDatabase();
  console.info('✅ Database connected');

  await connectRedis();
  console.info('✅ Redis connected');

  const app = createApp();
  const server = http.createServer(app);

  // WebSocket
  initWebSocket(server);
  console.info('✅ WebSocket server initialized');

  // Start BullMQ booking worker
  startBookingWorker();
  console.info('✅ Booking worker started');

  // Interactive Telegram Bot
  initTelegramBot();
  
  // Auto-Start active monitors from DB state
  const { autoStartMonitors } = require('@modules/monitor/monitor.service');
  await autoStartMonitors();
  console.info('✅ Monitor Service auto-started');

  server.listen(env.PORT, () => {
    console.info(`✅ Server running on port ${env.PORT} [${env.NODE_ENV}]`);
  });

  // ── Graceful shutdown ────────────────────────────────────────────────────
  async function shutdown(signal: string) {
    console.info(`\n${signal} received — shutting down gracefully…`);
    await stopBookingWorker();
    server.close(async () => {
      await disconnectDatabase();
      await disconnectRedis();
      console.info('Shutdown complete');
      process.exit(0);
    });
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

bootstrap().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
