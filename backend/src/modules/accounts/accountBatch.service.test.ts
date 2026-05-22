jest.mock('./accountAutoRegister.service', () => ({
  autoRegisterAccount: jest.fn(),
}));

jest.mock('@modules/websocket/ws.server', () => ({
  emitToUser: jest.fn(),
}));

import { AccountBatchService } from './accountBatch.service';

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

describe('AccountBatchService', () => {
  it('returns immediately, runs accounts sequentially, and doubles spacing after 429201-like failures', async () => {
    const runAutoRegister = jest.fn()
      .mockResolvedValueOnce({ ok: true, accountId: 'acc-1', email: 'one@example.com' })
      .mockResolvedValueOnce({ ok: false, reason: 'VFS returned 429201' })
      .mockResolvedValueOnce({ ok: true, accountId: 'acc-3', email: 'three@example.com' });
    const emitted: Array<{ userId: string; event: string; data: any }> = [];
    const sleeps: number[] = [];

    const service = new AccountBatchService(
      runAutoRegister as any,
      (userId, event, data) => emitted.push({ userId, event, data }),
      async (ms) => { sleeps.push(ms); },
    );

    const initial = service.startBatch({
      count: 3,
      source: 'uzb',
      destination: 'lva',
      countryCode: '171',
      spacingSeconds: 300,
      operatorUserId: 'user-1',
    });

    expect(initial).toMatchObject({
      status: 'QUEUED',
      total: 3,
      completed: 0,
      spacingSeconds: 300,
    });

    await waitFor(() => {
      expect(emitted.some((entry) => entry.data.status === 'COMPLETED')).toBe(true);
    });

    expect(runAutoRegister).toHaveBeenCalledTimes(3);
    expect(runAutoRegister.mock.invocationCallOrder[0]).toBeLessThan(runAutoRegister.mock.invocationCallOrder[1]);
    expect(runAutoRegister.mock.invocationCallOrder[1]).toBeLessThan(runAutoRegister.mock.invocationCallOrder[2]);
    expect(sleeps).toEqual([300_000, 600_000]);

    const accountProgress = emitted.filter((entry) => entry.event === 'BATCH_PROGRESS' && entry.data.completed > 0);
    expect(accountProgress).toEqual(expect.arrayContaining([
      expect.objectContaining({ userId: 'user-1', data: expect.objectContaining({ completed: 1, succeeded: 1, failed: 0 }) }),
      expect.objectContaining({ userId: 'user-1', data: expect.objectContaining({ completed: 2, succeeded: 1, failed: 1, nextSpacingSeconds: 600 }) }),
      expect.objectContaining({ userId: 'user-1', data: expect.objectContaining({ completed: 3, succeeded: 2, failed: 1 }) }),
    ]));
  });

  it('cancels before starting the next account when cancel is requested during spacing', async () => {
    const runAutoRegister = jest.fn()
      .mockResolvedValueOnce({ ok: true, accountId: 'acc-1', email: 'one@example.com' })
      .mockResolvedValueOnce({ ok: true, accountId: 'acc-2', email: 'two@example.com' });
    const emitted: Array<{ data: any }> = [];
    let batchId = '';

    const service = new AccountBatchService(
      runAutoRegister as any,
      (_userId, _event, data) => emitted.push({ data }),
      async () => { service.cancelBatch(batchId, 'user-1'); },
    );

    batchId = service.startBatch({
      count: 2,
      source: 'uzb',
      destination: 'lva',
      countryCode: '171',
      spacingSeconds: 300,
      operatorUserId: 'user-1',
    }).batchId;

    await waitFor(() => {
      expect(emitted.some((entry) => entry.data.status === 'CANCELLED')).toBe(true);
    });

    expect(runAutoRegister).toHaveBeenCalledTimes(1);
    expect(service.getBatch(batchId)).toMatchObject({
      status: 'CANCELLED',
      completed: 1,
      succeeded: 1,
    });
  });
});
