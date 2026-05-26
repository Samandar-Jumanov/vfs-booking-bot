import { BookingPipeline } from '../booking.pipeline';
import { MockBrowserDriver } from '../mock-browser-driver';
import { MockAccountRepo } from '../account-repo';
import type { AccountTiming } from '../types';

function makeWarmAccount(over: Partial<AccountTiming> = {}): AccountTiming {
  return {
    id: 'acc1',
    lifecycleState: 'WARM',
    lastAttemptAt: null,
    cooldownUntil: null,
    warmedAt: Date.now() - 1000,
    attemptCount: 0,
    ...over,
  };
}

const testInput = {
  accountEmail: 'acc1',
  firstName: 'A', lastName: 'B',
  passportNumber: 'P1', dob: '1990-01-01',
  nationality: 'UZ', email: 'cust@e.com',
  phone: '+1', subCategory: 'D-visa',
};

describe('BookingPipeline', () => {
  it('books successfully → returns confirmation number', async () => {
    const repo = new MockAccountRepo();
    repo.accounts = [makeWarmAccount()];
    const driver = new MockBrowserDriver().enqueueBook({ ok: true, code: 'OK', data: { confirmationNumber: 'CNF001' } });
    const pipeline = new BookingPipeline(repo, driver);
    const result = await pipeline.book(testInput);
    expect(result.ok).toBe(true);
    expect(result.data?.confirmationNumber).toBe('CNF001');
  });

  it('returns NO_WARM_TAB when no WARM accounts are available', async () => {
    const repo = new MockAccountRepo();
    repo.accounts = [makeWarmAccount({ lifecycleState: 'RESTRICTED' })];
    const driver = new MockBrowserDriver();
    const pipeline = new BookingPipeline(repo, driver);
    const result = await pipeline.book(testInput);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('NO_WARM_TAB');
  });

  it('selects LRU WARM account (least-recently-used)', async () => {
    const repo = new MockAccountRepo();
    const older = makeWarmAccount({ id: 'acc-old', lastAttemptAt: Date.now() - 10_000 });
    const newer = makeWarmAccount({ id: 'acc-new', lastAttemptAt: Date.now() - 1_000 });
    repo.accounts = [newer, older];
    const driver = new MockBrowserDriver().enqueueBook({ ok: true, code: 'OK', data: { confirmationNumber: 'X' } });
    const pipeline = new BookingPipeline(repo, driver);
    const result = await pipeline.book(testInput);
    expect(result.ok).toBe(true);
    expect(repo.saved[0]?.id).toBe('acc-old');
  });

  it('on 429001 during booking → account marked RESTRICTED', async () => {
    const repo = new MockAccountRepo();
    repo.accounts = [makeWarmAccount()];
    const driver = new MockBrowserDriver().enqueueBook({ ok: false, code: '429001' });
    const pipeline = new BookingPipeline(repo, driver);
    const result = await pipeline.book(testInput);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('429001');
    expect(repo.saved[0]?.transition.state).toBe('RESTRICTED');
    expect(repo.saved[0]?.transition.rotate).toBe(true);
  });

  it('on 429202 during booking → account marked RESTRICTED (short cooldown)', async () => {
    const repo = new MockAccountRepo();
    repo.accounts = [makeWarmAccount()];
    const driver = new MockBrowserDriver().enqueueBook({ ok: false, code: '429202' });
    const pipeline = new BookingPipeline(repo, driver);
    const result = await pipeline.book(testInput);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('429202');
    expect(repo.saved[0]?.transition.state).toBe('RESTRICTED');
  });

  it('skips RESTRICTED accounts and picks next WARM', async () => {
    const repo = new MockAccountRepo();
    const restricted = makeWarmAccount({ id: 'acc-res', lifecycleState: 'RESTRICTED', cooldownUntil: Date.now() + 1_000_000 });
    const warm = makeWarmAccount({ id: 'acc-warm' });
    repo.accounts = [restricted, warm];
    const driver = new MockBrowserDriver().enqueueBook({ ok: true, code: 'OK', data: { confirmationNumber: 'C1' } });
    const pipeline = new BookingPipeline(repo, driver);
    const result = await pipeline.book(testInput);
    expect(result.ok).toBe(true);
    expect(repo.saved[0]?.id).toBe('acc-warm');
  });
});
