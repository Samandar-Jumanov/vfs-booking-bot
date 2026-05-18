jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn(),
  Role: { ADMIN: 'ADMIN' },
}));

jest.mock('@config/env', () => ({
  env: {
    JWT_ACCESS_SECRET: 'x'.repeat(32),
    JWT_REFRESH_SECRET: 'y'.repeat(32),
    JWT_ACCESS_EXPIRY: '15m',
    JWT_REFRESH_EXPIRY: '7d',
    FRONTEND_URL: 'http://localhost:3000',
  },
}));

jest.mock('@config/database', () => ({
  prisma: {
    profile: {
      findFirst: jest.fn().mockResolvedValue({ id: 'profile-1' }),
    },
    booking: {
      create: jest.fn().mockResolvedValue({ id: 'booking-1' }),
    },
  },
}));

const dispatchNotification = jest.fn().mockResolvedValue(undefined);
jest.mock('@modules/notifications/notification.service', () => ({
  dispatchNotification: (...args: unknown[]) => dispatchNotification(...args),
}));

import { exchangeExtensionSetupCode, mintExtensionSetup } from '@modules/auth/auth.service';
import { handleExtensionEvent, markExtensionConnected, markExtensionHeartbeat } from '@modules/extension/extension.state';
import { verifyAccessToken } from '@utils/jwt';
import { prisma } from '@config/database';

describe('extension token minting', () => {
  it('mints a 30-day extension token through a one-time setup code', async () => {
    const setup = await mintExtensionSetup({ id: 'user-1', email: 'customer@example.com', role: 'ADMIN' });
    expect(setup.setupCode).toMatch(/^\d{6}$/);

    const exchanged = await exchangeExtensionSetupCode(setup.setupCode);
    const payload = verifyAccessToken(exchanged.extensionToken);

    expect(payload).toMatchObject({ sub: 'user-1', email: 'customer@example.com', type: 'extension' });
  });
});

describe('extension connection state', () => {
  it('tracks connected and heartbeat timestamps per customer', () => {
    const connected = markExtensionConnected('user-1', 'customer@example.com');
    const heartbeat = markExtensionHeartbeat('user-1');

    expect(connected.connected).toBe(true);
    expect(heartbeat?.lastHeartbeatAt).toBeDefined();
  });
});

describe('extension event routing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('routes slot events into notifications', async () => {
    await handleExtensionEvent('user-1', { type: 'EXT_SLOT_DETECTED', destination: 'lva', date: '2026-06-01' });

    expect(dispatchNotification).toHaveBeenCalledWith(expect.objectContaining({
      event: 'SLOT_DETECTED',
      destination: 'lva',
      slotDate: '2026-06-01',
    }));
  });

  it('persists completed bookings and dispatches BOOKING_SUCCESS', async () => {
    await handleExtensionEvent('user-1', { type: 'EXT_BOOKING_COMPLETED', destination: 'lva', confirmationNumber: 'ABC123456' });

    expect((prisma as any).booking.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ confirmationNo: 'ABC123456', status: 'SUCCESS' }),
    }));
    expect(dispatchNotification).toHaveBeenCalledWith(expect.objectContaining({
      event: 'BOOKING_SUCCESS',
      confirmationNo: 'ABC123456',
    }));
  });
});
