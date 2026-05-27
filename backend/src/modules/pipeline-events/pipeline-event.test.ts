jest.mock('@config/database', () => ({
  prisma: {
    pipelineEvent: {
      create: jest.fn().mockResolvedValue({}),
    },
  },
}));

jest.mock('../notifications/telegram.bot', () => ({
  sendTelegram: jest.fn().mockResolvedValue(undefined),
}));

import { prisma } from '@config/database';
import { sendTelegram } from '../notifications/telegram.bot';
import { createEvent, wrapAction, PipelineEventInput } from './pipeline-event.service';

const mockCreate = (prisma as any).pipelineEvent.create as jest.Mock;
const mockSendTelegram = sendTelegram as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('createEvent()', () => {
  it('calls prisma.pipelineEvent.create with correct fields', async () => {
    const input: PipelineEventInput = {
      action: 'register',
      accountId: 'acc-123',
      profileId: 'prof-456',
      beforeState: 'NEW',
      afterState: 'REGISTERING',
      severity: 'INFO',
    };

    await createEvent(input);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledWith({
      data: {
        action: 'register',
        accountId: 'acc-123',
        profileId: 'prof-456',
        beforeState: 'NEW',
        afterState: 'REGISTERING',
        error: null,
        url: null,
        screenshotPath: null,
        lastNetwork: null,
        severity: 'INFO',
      },
    });
  });

  it('calls sendTelegram when severity is CRITICAL', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';

    const input: PipelineEventInput = {
      action: 'login',
      accountId: 'acc-999',
      error: 'Session expired',
      severity: 'CRITICAL',
    };

    await createEvent(input);

    expect(mockSendTelegram).toHaveBeenCalledTimes(1);
    const message: string = mockSendTelegram.mock.calls[0][0];
    expect(message).toContain('CRITICAL pipeline event');
    expect(message).toContain('login');
    expect(message).toContain('Session expired');
    expect(message).toContain('acc-999');

    delete process.env.TELEGRAM_BOT_TOKEN;
  });

  it('does NOT call sendTelegram when severity is INFO', async () => {
    const input: PipelineEventInput = {
      action: 'slot_check',
      severity: 'INFO',
    };

    await createEvent(input);

    expect(mockSendTelegram).not.toHaveBeenCalled();
  });

  it('does NOT call sendTelegram when TELEGRAM_BOT_TOKEN is not set', async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;

    const input: PipelineEventInput = {
      action: 'book',
      severity: 'CRITICAL',
      error: 'Booking failed',
    };

    await createEvent(input);

    expect(mockSendTelegram).not.toHaveBeenCalled();
  });

  it('never throws even if prisma.pipelineEvent.create throws', async () => {
    mockCreate.mockRejectedValueOnce(new Error('DB connection lost'));

    const input: PipelineEventInput = {
      action: 'activate',
      severity: 'WARN',
    };

    await expect(createEvent(input)).resolves.toBeUndefined();
  });
});

describe('wrapAction()', () => {
  it('logs an INFO event on success', async () => {
    const fn = jest.fn().mockResolvedValue({ lifecycleState: 'WARM' });

    const result = await wrapAction(
      { action: 'login', accountId: 'acc-1', beforeState: 'NEW' },
      fn,
    );

    expect(result).toEqual({ lifecycleState: 'WARM' });
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'login',
          severity: 'INFO',
          afterState: 'WARM',
        }),
      }),
    );
  });

  it('logs a CRITICAL event and re-throws on error', async () => {
    const boom = new Error('network timeout');
    const fn = jest.fn().mockRejectedValue(boom);
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';

    await expect(
      wrapAction({ action: 'book', accountId: 'acc-2' }, fn),
    ).rejects.toThrow('network timeout');

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'book',
          severity: 'CRITICAL',
          error: 'network timeout',
        }),
      }),
    );

    delete process.env.TELEGRAM_BOT_TOKEN;
  });
});
