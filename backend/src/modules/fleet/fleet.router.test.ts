import express from 'express';
import type { Server } from 'http';
import { AddressInfo } from 'net';
import { errorHandler } from '@middleware/errorHandler';

jest.mock('@config/env', () => ({
  env: { WORKER_TOKEN: 'worker-token' },
}));

jest.mock('@middleware/auth.middleware', () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock('@prisma/client', () => ({
  WorkerBoxRole: {
    CREATOR: 'CREATOR',
    WATCHER: 'WATCHER',
    BOOKER: 'BOOKER',
    COOLDOWN: 'COOLDOWN',
    OFFLINE: 'OFFLINE',
  },
  WorkerBoxStatus: {
    ONLINE: 'ONLINE',
    WORKING: 'WORKING',
    COOLDOWN: 'COOLDOWN',
    OFFLINE: 'OFFLINE',
  },
}));

jest.mock('@config/database', () => ({
  prisma: {
    workerBox: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      upsert: jest.fn(),
    },
    accountLease: {
      deleteMany: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      upsert: jest.fn(),
    },
    settings: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
    },
    $transaction: jest.fn(),
  },
}));

import { prisma } from '@config/database';
import { fleetRouter } from './fleet.router';

const mockPrisma = prisma as unknown as {
  workerBox: {
    findMany: jest.Mock;
    findUnique: jest.Mock;
    upsert: jest.Mock;
  };
  accountLease: {
    deleteMany: jest.Mock;
    findMany: jest.Mock;
    findUnique: jest.Mock;
    upsert: jest.Mock;
  };
  settings: {
    findUnique: jest.Mock;
    upsert: jest.Mock;
  };
  $transaction: jest.Mock;
};

async function withApp<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const app = express();
  app.use(express.json());
  app.use('/api/fleet', fleetRouter);
  app.use(errorHandler);

  const server: Server = await new Promise((resolve) => {
    const listener = app.listen(0, () => resolve(listener));
  });

  const { port } = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

async function requestJson(
  baseUrl: string,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: any }> {
  const headers = {
    'content-type': 'application/json',
    ...(init.headers ?? {}),
  } as Record<string, string>;
  const res = await fetch(`${baseUrl}${path}`, { ...init, headers });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

describe('fleetRouter', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-06-11T09:00:00.000Z'));
    jest.clearAllMocks();
    mockPrisma.workerBox.findMany.mockResolvedValue([]);
    mockPrisma.workerBox.findUnique.mockResolvedValue(null);
    mockPrisma.workerBox.upsert.mockImplementation(async (args) => ({ boxId: args.where.boxId, ...args.create, ...args.update }));
    mockPrisma.accountLease.deleteMany.mockResolvedValue({ count: 0 });
    mockPrisma.accountLease.findMany.mockResolvedValue([]);
    mockPrisma.accountLease.findUnique.mockResolvedValue(null);
    mockPrisma.accountLease.upsert.mockImplementation(async (args) => ({ id: 'lease-1', ...args.create, ...args.update }));
    mockPrisma.settings.findUnique.mockResolvedValue(null);
    mockPrisma.settings.upsert.mockResolvedValue({});
    mockPrisma.$transaction.mockImplementation(async (cb) => cb({
      accountLease: mockPrisma.accountLease,
    }));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('reports public box status, removes expired leases, and summarizes online/cooldown/offline boxes', async () => {
    mockPrisma.workerBox.findMany.mockResolvedValue([
      {
        boxId: 'box1',
        role: 'WATCHER',
        status: 'WORKING',
        heartbeatAt: new Date('2026-06-11T08:59:30.000Z'),
        cooldownUntil: null,
      },
      {
        boxId: 'box2',
        role: 'COOLDOWN',
        status: 'ONLINE',
        heartbeatAt: new Date('2026-06-11T08:59:50.000Z'),
        cooldownUntil: new Date('2026-06-11T10:00:00.000Z'),
      },
      {
        boxId: 'box3',
        role: 'WATCHER',
        status: 'ONLINE',
        heartbeatAt: new Date('2026-06-11T08:55:00.000Z'),
        cooldownUntil: null,
      },
    ]);
    mockPrisma.accountLease.findMany.mockResolvedValue([{ id: 'lease-1', boxId: 'box1' }]);

    await withApp(async (baseUrl) => {
      const res = await requestJson(baseUrl, '/api/fleet/status');

      expect(res.status).toBe(200);
      expect(mockPrisma.accountLease.deleteMany).toHaveBeenCalledWith({
        where: { expiresAt: { lt: new Date('2026-06-11T09:00:00.000Z') } },
      });
      expect(res.body.summary).toEqual({ total: 3, online: 2, cooldown: 1, offline: 1 });
      expect(res.body.boxes.map((box: { boxId: string; status: string; online: boolean }) => ({
        boxId: box.boxId,
        status: box.status,
        online: box.online,
      }))).toEqual([
        { boxId: 'box1', status: 'WORKING', online: true },
        { boxId: 'box2', status: 'COOLDOWN', online: true },
        { boxId: 'box3', status: 'OFFLINE', online: false },
      ]);
    });
  });

  it('rejects worker writes without the configured bearer token', async () => {
    await withApp(async (baseUrl) => {
      const res = await requestJson(baseUrl, '/api/fleet/worker/heartbeat', {
        method: 'POST',
        body: JSON.stringify({ boxId: 'box1' }),
      });

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'Invalid or missing worker token', code: 'UNAUTHORIZED' });
      expect(mockPrisma.workerBox.upsert).not.toHaveBeenCalled();
    });
  });

  it('preserves active cooldown role/status on heartbeat instead of letting the worker leave cooldown', async () => {
    mockPrisma.workerBox.findUnique.mockResolvedValue({
      boxId: 'box2',
      role: 'COOLDOWN',
      status: 'COOLDOWN',
      currentUrl: 'https://visa.vfsglobal.com/page-not-found',
      pageState: { blocked: true },
      lastSuccessfulCheckAt: null,
      lastError: '429202',
      startedAt: new Date('2026-06-11T08:00:00.000Z'),
      cooldownUntil: new Date('2026-06-11T10:00:00.000Z'),
    });

    await withApp(async (baseUrl) => {
      const res = await requestJson(baseUrl, '/api/fleet/worker/heartbeat', {
        method: 'POST',
        headers: { authorization: 'Bearer worker-token' },
        body: JSON.stringify({ boxId: 'box2', role: 'WATCHER', status: 'WORKING', pid: 123 }),
      });

      expect(res.status).toBe(200);
      expect(mockPrisma.workerBox.upsert).toHaveBeenCalledWith(expect.objectContaining({
        where: { boxId: 'box2' },
        update: expect.objectContaining({
          role: 'COOLDOWN',
          status: 'COOLDOWN',
          pid: 123,
        }),
      }));
    });
  });

  it('marks a box cooling down and releases its active leases', async () => {
    await withApp(async (baseUrl) => {
      const res = await requestJson(baseUrl, '/api/fleet/worker/cooldown', {
        method: 'POST',
        headers: { authorization: 'Bearer worker-token' },
        body: JSON.stringify({
          boxId: 'box4',
          reason: 'form_not_rendered',
          minutes: 30,
          assignedAccountEmail: 'vfs@example.test',
          currentUrl: 'https://visa.vfsglobal.com/uzb/en/lva/page-not-found',
          pageState: { form: false },
        }),
      });

      expect(res.status).toBe(200);
      expect(mockPrisma.workerBox.upsert).toHaveBeenCalledWith(expect.objectContaining({
        where: { boxId: 'box4' },
        update: expect.objectContaining({
          role: 'COOLDOWN',
          status: 'COOLDOWN',
          lastError: 'form_not_rendered',
          lastBlockReason: 'form_not_rendered',
          cooldownUntil: new Date('2026-06-11T09:30:00.000Z'),
        }),
      }));
      expect(mockPrisma.accountLease.deleteMany).toHaveBeenCalledWith({ where: { boxId: 'box4' } });
    });
  });

  it('prevents another box from acquiring an active account lease', async () => {
    mockPrisma.accountLease.findUnique.mockResolvedValue({
      accountId: '11111111-1111-4111-8111-111111111111',
      boxId: 'box1',
      expiresAt: new Date('2026-06-11T09:10:00.000Z'),
    });

    await withApp(async (baseUrl) => {
      const res = await requestJson(baseUrl, '/api/fleet/worker/leases/acquire', {
        method: 'POST',
        headers: { authorization: 'Bearer worker-token' },
        body: JSON.stringify({
          boxId: 'box2',
          accountId: '11111111-1111-4111-8111-111111111111',
          role: 'WATCHER',
        }),
      });

      expect(res.status).toBe(409);
      expect(res.body).toEqual({ ok: false, reason: 'ACCOUNT_LEASED' });
      expect(mockPrisma.accountLease.upsert).not.toHaveBeenCalled();
    });
  });

  it('allows the owning box to refresh a lease and applies the requested TTL', async () => {
    mockPrisma.accountLease.findUnique.mockResolvedValue({
      accountId: '22222222-2222-4222-8222-222222222222',
      boxId: 'box1',
      expiresAt: new Date('2026-06-11T09:10:00.000Z'),
    });

    await withApp(async (baseUrl) => {
      const res = await requestJson(baseUrl, '/api/fleet/worker/leases/acquire', {
        method: 'POST',
        headers: { authorization: 'Bearer worker-token' },
        body: JSON.stringify({
          boxId: 'box1',
          accountId: '22222222-2222-4222-8222-222222222222',
          role: 'BOOKER',
          runId: 'run-abc',
          ttlSeconds: 60,
        }),
      });

      expect(res.status).toBe(200);
      expect(mockPrisma.accountLease.deleteMany).toHaveBeenCalledWith({
        where: { expiresAt: { lt: new Date('2026-06-11T09:00:00.000Z') } },
      });
      expect(mockPrisma.accountLease.upsert).toHaveBeenCalledWith(expect.objectContaining({
        where: { accountId: '22222222-2222-4222-8222-222222222222' },
        update: expect.objectContaining({
          boxId: 'box1',
          role: 'BOOKER',
          runId: 'run-abc',
          heartbeatAt: new Date('2026-06-11T09:00:00.000Z'),
          expiresAt: new Date('2026-06-11T09:01:00.000Z'),
        }),
      }));
    });
  });

  it('releases only the lease owned by the requesting box', async () => {
    await withApp(async (baseUrl) => {
      const res = await requestJson(baseUrl, '/api/fleet/worker/leases/release', {
        method: 'POST',
        headers: { authorization: 'Bearer worker-token' },
        body: JSON.stringify({
          boxId: 'box1',
          accountId: '33333333-3333-4333-8333-333333333333',
        }),
      });

      expect(res.status).toBe(200);
      expect(mockPrisma.accountLease.deleteMany).toHaveBeenCalledWith({
        where: {
          accountId: '33333333-3333-4333-8333-333333333333',
          boxId: 'box1',
        },
      });
    });
  });

  it('records creator success and failure counters', async () => {
    await withApp(async (baseUrl) => {
      const ok = await requestJson(baseUrl, '/api/fleet/worker/creation-event', {
        method: 'POST',
        headers: { authorization: 'Bearer worker-token' },
        body: JSON.stringify({ boxId: 'creator1', ok: true }),
      });
      const fail = await requestJson(baseUrl, '/api/fleet/worker/creation-event', {
        method: 'POST',
        headers: { authorization: 'Bearer worker-token' },
        body: JSON.stringify({ boxId: 'creator1', ok: false, reason: 'page_not_found' }),
      });

      expect(ok.status).toBe(200);
      expect(fail.status).toBe(200);
      expect(mockPrisma.workerBox.upsert).toHaveBeenNthCalledWith(1, expect.objectContaining({
        update: { creationSuccessCount: { increment: 1 }, lastError: null },
      }));
      expect(mockPrisma.workerBox.upsert).toHaveBeenNthCalledWith(2, expect.objectContaining({
        update: { creationFailureCount: { increment: 1 }, lastError: 'page_not_found' },
      }));
    });
  });

  it('returns default burst config when stored settings are missing or invalid', async () => {
    mockPrisma.settings.findUnique.mockResolvedValue({ value: { timezone: '', windows: [{ start: 'bad', end: '12:15' }] } });

    await withApp(async (baseUrl) => {
      const res = await requestJson(baseUrl, '/api/fleet/burst-config');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        timezone: 'Asia/Tashkent',
        windows: [{ start: '11:55', end: '12:15' }],
        burstIntervalSeconds: 3,
        idleIntervalSeconds: 300,
        staggerSeconds: 0,
      });
    });
  });

  it('validates and persists burst config updates', async () => {
    await withApp(async (baseUrl) => {
      const res = await requestJson(baseUrl, '/api/fleet/burst-config', {
        method: 'PUT',
        body: JSON.stringify({
          timezone: 'Asia/Tashkent',
          windows: [{ start: '18:55', end: '19:15' }],
          burstIntervalSeconds: 5,
          idleIntervalSeconds: 600,
          staggerSeconds: 2,
        }),
      });

      expect(res.status).toBe(200);
      expect(res.body.windows).toEqual([{ start: '18:55', end: '19:15' }]);
      expect(mockPrisma.settings.upsert).toHaveBeenCalledWith({
        where: { key: 'fleet_burst_config' },
        update: { value: res.body },
        create: { key: 'fleet_burst_config', value: res.body },
      });
    });
  });
});
