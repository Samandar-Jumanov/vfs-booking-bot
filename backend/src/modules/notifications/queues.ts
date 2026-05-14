import { Queue, Worker } from 'bullmq';
import { env } from '@config/env';
import { getRedis } from '@config/redis';
import { prisma } from '@config/database';
import { dispatchNotification } from './notification.service';
import { getMonitor, restartMonitor, stopMonitor } from '@modules/monitor/monitor.service';
import { logEvent } from '@modules/logs/logger';
import { EventType } from '@prisma/client';

const COOKIE_QUEUE = 'cookie-watcher';
const SUPERVISOR_QUEUE = 'monitor-supervisor';
const LT_SN_ALERT_MINUTES = 30;

let cookieQueue: Queue | null = null;
let supervisorQueue: Queue | null = null;
let cookieWorker: Worker | null = null;
let supervisorWorker: Worker | null = null;

function connection() {
  return { url: env.REDIS_URL };
}

function decodeJwtExp(value: string): Date | null {
  const parts = value.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return typeof payload.exp === 'number' ? new Date(payload.exp * 1000) : null;
  } catch {
    return null;
  }
}

function cookieExpiryFromStoredValue(value: unknown): Date | null {
  if (!value) return null;
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== 'object') return null;
  const record = parsed as { raw?: string; expiresAt?: string; savedAt?: string };

  if (record.expiresAt) return new Date(record.expiresAt);

  const raw = record.raw ?? '';
  if (raw.trim().startsWith('[')) {
    const cookies = JSON.parse(raw) as Array<{ name?: string; value?: string; expires?: number; expiresAt?: string }>;
    const ltSn = cookies.find((cookie) => cookie.name === 'lt_sn');
    if (ltSn?.expiresAt) return new Date(ltSn.expiresAt);
    if (typeof ltSn?.expires === 'number' && ltSn.expires > 0) return new Date(ltSn.expires * 1000);
    if (ltSn?.value) return decodeJwtExp(ltSn.value);
  }

  const match = raw.match(/(?:^|;\s*)lt_sn=([^;]+)/);
  if (match?.[1]) return decodeJwtExp(decodeURIComponent(match[1]));

  return record.savedAt ? new Date(new Date(record.savedAt).getTime() + 8 * 60 * 60 * 1000) : null;
}

async function runCookieWatcher(): Promise<void> {
  const redis = getRedis();
  const rows = await prisma.settings.findMany({
    where: { key: { startsWith: 'cookies.' } },
    select: { key: true, value: true },
  });

  for (const row of rows) {
    const destination = row.key.replace(/^cookies\./, '');
    let expiresAt: Date | null = null;
    try {
      expiresAt = cookieExpiryFromStoredValue(row.value);
    } catch (err: any) {
      logEvent('warn', EventType.SESSION_EXPIRED, `Failed to parse cookies for ${destination}: ${err.message}`);
      continue;
    }
    if (!expiresAt) continue;

    const minutesRemaining = Math.floor((expiresAt.getTime() - Date.now()) / 60_000);
    if (minutesRemaining >= 0 && minutesRemaining < LT_SN_ALERT_MINUTES) {
      const lock = await redis.set(`cookie-alerted:${destination}`, '1', 'EX', 1500, 'NX');
      if (lock === 'OK') {
        await dispatchNotification({
          event: 'COOKIE_EXPIRING_SOON',
          destination,
          minutesRemaining,
        });
      }
    }
  }
}

async function runMonitorSupervisor(): Promise<void> {
  const redis = getRedis();
  const monitorIds = await redis.smembers('monitors:running');

  for (const id of monitorIds) {
    const heartbeat = await redis.get(`monitor:${id}:heartbeat`);
    if (heartbeat) continue;

    const crashKey = `monitor:${id}:crash-count`;
    const attempt = await redis.incr(crashKey);
    await redis.expire(crashKey, 600);

    if (attempt >= 3) {
      await redis.srem('monitors:running', id);
      stopMonitor(id);
      await dispatchNotification({ event: 'MONITOR_DEAD', monitorId: id });
      logEvent('error', EventType.MONITOR_STOPPED, `Monitor ${id} dead after 3 restart attempts`);
      continue;
    }

    const state = getMonitor(id);
    if (!state) {
      await redis.srem('monitors:running', id);
      continue;
    }

    await restartMonitor(id);
    await dispatchNotification({ event: 'MONITOR_CRASHED', monitorId: id, attempt });
    logEvent('warn', EventType.MONITOR_STARTED, `Monitor ${id} restarted by supervisor (attempt ${attempt}/3)`);
  }
}

export async function startNotificationQueues(): Promise<void> {
  cookieQueue = new Queue(COOKIE_QUEUE, { connection: connection() });
  supervisorQueue = new Queue(SUPERVISOR_QUEUE, { connection: connection() });

  await cookieQueue.add('scan-cookies', {}, {
    repeat: { every: 60_000 },
    jobId: 'cookie-watcher-repeat',
    removeOnComplete: true,
    removeOnFail: 100,
  });

  await supervisorQueue.add('supervise-monitors', {}, {
    repeat: { every: 60_000 },
    jobId: 'monitor-supervisor-repeat',
    removeOnComplete: true,
    removeOnFail: 100,
  });

  cookieWorker = new Worker(COOKIE_QUEUE, runCookieWatcher, { connection: connection() });
  supervisorWorker = new Worker(SUPERVISOR_QUEUE, runMonitorSupervisor, { connection: connection() });
}

export async function stopNotificationQueues(): Promise<void> {
  await Promise.all([
    cookieWorker?.close(),
    supervisorWorker?.close(),
    cookieQueue?.close(),
    supervisorQueue?.close(),
  ]);
  cookieWorker = null;
  supervisorWorker = null;
  cookieQueue = null;
  supervisorQueue = null;
}
