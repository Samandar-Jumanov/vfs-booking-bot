import { isDue, pickNextDue, permitsGlobalAction } from '../pacer';
import type { PacerConfig, AccountTiming } from '../types';

const cfg: PacerConfig = {
  globalMinGapMs: 60_000, perAccountMinIntervalMs: 90_000,
  cooldown429202Ms: 7_200_000, cooldown429001Ms: 21_600_000, jitterFraction: 0,
  sessionFreshnessMs: 43_200_000,
};
const acct = (over: Partial<AccountTiming>): AccountTiming => ({
  id: 'a', lifecycleState: 'ACTIVE', lastAttemptAt: null, cooldownUntil: null, warmedAt: null, attemptCount: 0, ...over,
});

describe('pacer', () => {
  const now = 1_000_000_000_000;

  it('account in cooldown is NOT due', () => {
    expect(isDue(acct({ cooldownUntil: now + 1000 }), cfg, now)).toBe(false);
  });
  it('account past cooldown + never attempted is due', () => {
    expect(isDue(acct({ cooldownUntil: now - 1, lastAttemptAt: null }), cfg, now)).toBe(true);
  });
  it('account attempted within per-account interval is NOT due', () => {
    expect(isDue(acct({ lastAttemptAt: now - 10_000 }), cfg, now)).toBe(false);
  });
  it('BLOCKED account is never due', () => {
    expect(isDue(acct({ lifecycleState: 'BLOCKED', lastAttemptAt: null }), cfg, now)).toBe(false);
  });
  it('global limiter blocks if last global action too recent', () => {
    expect(permitsGlobalAction(now - 10_000, cfg, now)).toBe(false);
    expect(permitsGlobalAction(now - 120_000, cfg, now)).toBe(true);
    expect(permitsGlobalAction(null, cfg, now)).toBe(true);
  });
  it('pickNextDue returns the least-recently-attempted due account', () => {
    const list = [acct({ id: 'x', lastAttemptAt: now - 200_000 }), acct({ id: 'y', lastAttemptAt: null })];
    expect(pickNextDue(list, cfg, now)?.id).toBe('y'); // never-attempted sorts first
  });
});
