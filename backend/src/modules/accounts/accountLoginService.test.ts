jest.mock('@config/database', () => ({
  prisma: {
    vfsAccount: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
    },
    user: {
      findFirst: jest.fn(),
    },
  },
}));

jest.mock('@modules/websocket/ws.server', () => ({
  sendToExtension: jest.fn(),
}));

jest.mock('@utils/crypto', () => ({
  decrypt: jest.fn(() => 'plain-password'),
}));

jest.mock('@modules/logs/logger', () => ({
  logEvent: jest.fn(),
}));

jest.mock('@modules/captcha/twoCaptcha', () => ({
  solveTurnstile: jest.fn(),
}));

jest.mock('node-cron', () => ({
  schedule: jest.fn(),
}));

import { prisma } from '@config/database';
import { sendToExtension } from '@modules/websocket/ws.server';
import { loginAccount, resolveLoginSuccess } from './accountLoginService';

async function waitFor(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 1000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  throw lastError;
}

describe('accountLoginService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.OPERATOR_USER_ID = 'operator-1';
  });

  afterEach(() => {
    delete process.env.OPERATOR_USER_ID;
  });

  it('dispatches BG_LOGIN_VFS_ACCOUNT and resolves on EXT_LOGIN_SUCCESS', async () => {
    const warmedAt = new Date('2026-05-22T06:00:00.000Z');
    (prisma.vfsAccount.findUnique as jest.Mock)
      .mockResolvedValueOnce({
        id: 'acc-1',
        email: 'account@example.com',
        encryptedPassword: 'encrypted-password',
        status: 'ACTIVE',
      })
      .mockResolvedValueOnce({ lastWarmedAt: warmedAt });
    (sendToExtension as jest.Mock).mockReturnValue(true);

    const pending = loginAccount('acc-1');

    await waitFor(() => {
      expect(sendToExtension).toHaveBeenCalledWith('operator-1', expect.objectContaining({
        type: 'BG_LOGIN_VFS_ACCOUNT',
        email: 'account@example.com',
        password: 'plain-password',
        loginUrl: 'https://visa.vfsglobal.com/uzb/en/lva/login',
        correlationId: expect.any(String),
      }));
    });

    const message = (sendToExtension as jest.Mock).mock.calls[0][1] as { correlationId: string };
    await resolveLoginSuccess(message.correlationId);

    await expect(pending).resolves.toEqual({
      success: true,
      accountId: 'acc-1',
      email: 'account@example.com',
      lastWarmedAt: warmedAt,
    });
  });
});
