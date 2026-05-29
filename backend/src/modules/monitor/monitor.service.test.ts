jest.mock('@config/env', () => ({
  env: {
    MONITOR_DEFAULT_INTERVAL_MS: 5000,
    CDP_ENDPOINT: undefined,
  },
}));

const redisMock = {
  set: jest.fn().mockResolvedValue('OK'),
  del: jest.fn().mockResolvedValue(1),
  sadd: jest.fn().mockResolvedValue(1),
  srem: jest.fn().mockResolvedValue(1),
};

jest.mock('@config/redis', () => ({
  getRedis: jest.fn(() => redisMock),
}));

jest.mock('@config/database', () => ({
  prisma: {
    vfsAccount: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    profile: {
      findUnique: jest.fn(),
    },
    settings: {
      findMany: jest.fn(),
    },
    booking: {
      findMany: jest.fn(),
    },
  },
}));

jest.mock('@modules/monitor/playwright.fetch', () => ({
  fetchSlotsViaBrowser: jest.fn(),
  disposeContextFor: jest.fn(),
  findPageForProfile: jest.fn(),
}));

jest.mock('@modules/accounts/accountLoginService', () => ({
  loginAccount: jest.fn(),
}));

jest.mock('@modules/websocket/ws.server', () => ({
  emitToAll: jest.fn(),
  sendToExtension: jest.fn(),
}));

jest.mock('@modules/logs/logger', () => ({
  logEvent: jest.fn(),
}));

jest.mock('@modules/notifications/notification.service', () => ({
  dispatchNotification: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@modules/notifications/telegram.bot', () => ({
  sendTelegram: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@modules/proxy/proxy.service', () => ({
  getProxy: jest.fn().mockResolvedValue({
    server: '127.0.0.1:24000',
    username: 'proxy-user',
    password: 'proxy-pass',
  }),
}));

jest.mock('@modules/settings/settings.service', () => ({
  setSetting: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@modules/monitor/session.warmer', () => ({
  warmSessionWithBrowser: jest.fn(),
  keepSessionAlive: jest.fn(),
}));

jest.mock('@modules/monitor/auto.login', () => ({
  autoReLogin: jest.fn(),
}));

jest.mock('@modules/monitor/auto.register', () => ({
  autoRegister: jest.fn(),
}));

jest.mock('@modules/monitor/session.keepalive', () => ({
  startKeepAliveWatcher: jest.fn(),
}));

jest.mock('@modules/booking/booking.service', () => ({
  enqueueBooking: jest.fn(),
}));

import { prisma } from '@config/database';
import { fetchSlotsViaBrowser } from '@modules/monitor/playwright.fetch';
import { loginAccount } from '@modules/accounts/accountLoginService';
import { emitToAll } from '@modules/websocket/ws.server';
import { getMonitor, startMonitor, stopMonitor, setMonitor } from './monitor.service';
import type { SlotInfo } from '@t/index';

async function flushAsync(turns = 30): Promise<void> {
  for (let i = 0; i < turns; i += 1) await Promise.resolve();
}

const oldAccount = {
  id: 'acc-1',
  email: 'vfs@example.com',
  profileIds: ['profile-1'],
  lastWarmedAt: new Date('2026-05-22T06:00:00.000Z'),
  cookieStore: {
    raw: 'datadome=old; session=old',
    hasDatadome: true,
    userAgent: 'ua-old',
  },
};

const refreshedAccount = {
  id: 'acc-1',
  email: 'vfs@example.com',
  lastWarmedAt: new Date('2026-05-22T07:00:00.000Z'),
  cookieStore: {
    raw: 'datadome=new; session=new',
    hasDatadome: true,
    userAgent: 'ua-new',
  },
};

function slotKey(slot: SlotInfo): string {
  return `${slot.date}:${slot.time}`;
}

function diffSlots(prev: Set<string>, current: SlotInfo[]): SlotInfo[] {
  return current.filter((slot) => !prev.has(slotKey(slot)));
}

const makeSlot = (date: string, time: string): SlotInfo => ({
  date, time, destination: 'brazil', visaType: 'tourist',
});

describe('monitor.service stored-account poll retry', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    process.env.EXTENSION_BOOKING = 'false';
    (prisma.profile.findUnique as jest.Mock).mockResolvedValue(null);
    (prisma.vfsAccount.findMany as jest.Mock).mockResolvedValue([oldAccount]);
    (prisma.vfsAccount.findUnique as jest.Mock).mockResolvedValue(refreshedAccount);
    (prisma.vfsAccount.update as jest.Mock).mockResolvedValue({});
  });

  afterEach(() => {
    stopMonitor('mon-1');
    jest.clearAllTimers();
    jest.useRealTimers();
    delete process.env.EXTENSION_BOOKING;
  });

  it('logs in the stored VFS account and retries once after a 403 poll response', async () => {
    (loginAccount as jest.Mock).mockResolvedValue({
      success: true,
      accountId: 'acc-1',
      email: 'vfs@example.com',
      lastWarmedAt: refreshedAccount.lastWarmedAt,
    });
    (fetchSlotsViaBrowser as jest.Mock)
      .mockResolvedValueOnce({ status: 403, rawText: 'forbidden', data: null })
      .mockResolvedValueOnce({ status: 200, rawText: '[]', data: [] });

    setMonitor('mon-1', {
      id: 'mon-1',
      sourceCountry: 'uzbekistan',
      destination: 'latvia',
      visaType: 'tourism',
      intervalMs: 5000,
      profileIds: ['profile-1'],
      isRunning: false,
      slotDetectedCount: 0,
      logs: [],
    });

    await startMonitor('mon-1');
    await flushAsync();

    expect(loginAccount).toHaveBeenCalledWith('acc-1');
    expect(fetchSlotsViaBrowser).toHaveBeenCalledTimes(2);
    expect(fetchSlotsViaBrowser).toHaveBeenNthCalledWith(
      2,
      'uzb',
      'lva',
      'tourism',
      ['datadome=new', 'session=new'],
      'ua-new',
      expect.objectContaining({ loginUser: 'vfs@example.com' }),
    );
    expect(getMonitor('mon-1')).toEqual(expect.objectContaining({
      vfsAccountId: 'acc-1',
      cookies: ['datadome=new', 'session=new'],
      userAgent: 'ua-new',
      lastHttpStatus: 200,
    }));
    // selectFreshWatcherAccount touches lastUsedAt on selection (round-robin pacing).
    // It should NOT also write lastWarmedAt:null (that would only happen if the retry also 403d).
    expect(prisma.vfsAccount.update).toHaveBeenCalledTimes(1);
    expect(prisma.vfsAccount.update).toHaveBeenCalledWith({
      where: { id: 'acc-1' },
      data: { lastUsedAt: expect.any(Date) },
    });
  });

  it('marks the stored VFS account stale and keeps 403 cooldown when retry also fails', async () => {
    (loginAccount as jest.Mock).mockResolvedValue({
      success: true,
      accountId: 'acc-1',
      email: 'vfs@example.com',
      lastWarmedAt: refreshedAccount.lastWarmedAt,
    });
    (fetchSlotsViaBrowser as jest.Mock)
      .mockResolvedValueOnce({ status: 403, rawText: 'forbidden', data: null })
      .mockResolvedValueOnce({ status: 403, rawText: 'still forbidden', data: null });

    setMonitor('mon-1', {
      id: 'mon-1',
      sourceCountry: 'uzbekistan',
      destination: 'latvia',
      visaType: 'tourism',
      intervalMs: 5000,
      profileIds: ['profile-1'],
      isRunning: false,
      slotDetectedCount: 0,
      logs: [],
    });

    await startMonitor('mon-1');
    await flushAsync();

    expect(loginAccount).toHaveBeenCalledWith('acc-1');
    expect(fetchSlotsViaBrowser).toHaveBeenCalledTimes(2);
    expect(prisma.vfsAccount.update).toHaveBeenCalledWith({
      where: { id: 'acc-1' },
      data: { lastWarmedAt: null },
    });
    expect(emitToAll).toHaveBeenCalledWith('VFS_ACCOUNT_SESSION_STALE', expect.objectContaining({
      accountId: 'acc-1',
      destination: 'lva',
      reason: 'retry poll failed with HTTP 403',
    }));
    expect(getMonitor('mon-1')).toEqual(expect.objectContaining({
      isRunning: false,
      isCoolingDown: true,
      lastHttpStatus: 403,
    }));
  });
});

describe('monitor slot diffing', () => {
  it('returns all slots when prev is empty', () => {
    const slots = [makeSlot('2024-06-01', '09:00'), makeSlot('2024-06-01', '10:00')];
    const result = diffSlots(new Set(), slots);
    expect(result).toHaveLength(2);
  });

  it('returns only new slots', () => {
    const existing = new Set(['2024-06-01:09:00']);
    const slots = [makeSlot('2024-06-01', '09:00'), makeSlot('2024-06-01', '10:00')];
    const result = diffSlots(existing, slots);
    expect(result).toHaveLength(1);
    expect(result[0].time).toBe('10:00');
  });

  it('returns empty array when no new slots', () => {
    const slots = [makeSlot('2024-06-01', '09:00')];
    const existing = new Set(slots.map(slotKey));
    const result = diffSlots(existing, slots);
    expect(result).toHaveLength(0);
  });

  it('handles empty current slots', () => {
    const existing = new Set(['2024-06-01:09:00']);
    const result = diffSlots(existing, []);
    expect(result).toHaveLength(0);
  });
});
