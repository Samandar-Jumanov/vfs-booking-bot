import { SessionKeepalive } from '../session-keepalive';

describe('SessionKeepalive', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('calls keepaliveFn at the configured interval', () => {
    const fn = jest.fn().mockResolvedValue({ landed: 'dashboard' });
    const k = new SessionKeepalive({ keepaliveFn: fn, intervalMs: 5_000 });
    k.start();
    jest.advanceTimersByTime(15_000);
    expect(fn).toHaveBeenCalledTimes(3);
    k.stop();
  });

  it('intervalMs is configurable — asserts it is NOT hardcoded', () => {
    const fn = jest.fn().mockResolvedValue({ landed: 'dashboard' });
    const k1 = new SessionKeepalive({ keepaliveFn: fn, intervalMs: 1_000 });
    const k2 = new SessionKeepalive({ keepaliveFn: fn, intervalMs: 30_000 });
    expect((k1 as any).intervalMs).toBe(1_000);
    expect((k2 as any).intervalMs).toBe(30_000);
  });

  it('calls onSessionExpired when keepaliveFn returns landed=login', async () => {
    const expired: string[] = [];
    const fn = jest.fn().mockResolvedValue({ landed: 'login' });
    const k = new SessionKeepalive({
      keepaliveFn: fn,
      intervalMs: 1_000,
      onSessionExpired: (accountId) => expired.push(accountId ?? 'undefined'),
      accountId: 'acc1',
    });
    k.start();
    jest.advanceTimersByTime(1_000);
    await Promise.resolve(); // flush microtasks
    expect(expired).toContain('acc1');
    k.stop();
  });

  it('does not fire onSessionExpired when keepaliveFn returns landed=dashboard', async () => {
    const expired: string[] = [];
    const fn = jest.fn().mockResolvedValue({ landed: 'dashboard' });
    const k = new SessionKeepalive({
      keepaliveFn: fn,
      intervalMs: 1_000,
      onSessionExpired: () => expired.push('expired'),
    });
    k.start();
    jest.advanceTimersByTime(1_000);
    await Promise.resolve();
    expect(expired).toHaveLength(0);
    k.stop();
  });
});
