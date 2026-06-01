import {
  classifyThrottle,
  isThrottled,
  nextBackoffMs,
  dayKeyOf,
  canRegisterNow,
  recordRegistration,
  shouldProceed,
} from '../throttleGuard';
import type { DailyRegState } from '../throttleGuard';

describe('throttleGuard.classifyThrottle', () => {
  it('classifies a page-not-found redirect URL', () => {
    expect(classifyThrottle({ url: 'https://visa.vfsglobal.com/uzb/en/lva/page-not-found' }))
      .toBe('page_not_found');
  });

  it('classifies the spike error form_not_rendered as page_not_found', () => {
    expect(classifyThrottle({ error: 'form_not_rendered' })).toBe('page_not_found');
  });

  it('classifies "session expired" body text as session_invalid', () => {
    expect(classifyThrottle({ bodyText: 'Your session has expired, please log in again.' }))
      .toBe('session_invalid');
  });

  it('classifies "invalid session" text as session_invalid', () => {
    expect(classifyThrottle({ bodyText: 'Invalid session.' })).toBe('session_invalid');
  });

  it('classifies a 429 / "too many requests" as rate_limited', () => {
    expect(classifyThrottle({ bodyText: 'HTTP 429 Too Many Requests' })).toBe('rate_limited');
    expect(classifyThrottle({ error: 'too many attempts, try later' })).toBe('rate_limited');
  });

  it('returns ok when nothing matches', () => {
    expect(classifyThrottle({ url: 'https://visa.vfsglobal.com/uzb/en/lva/dashboard', bodyText: 'Welcome' }))
      .toBe('ok');
    expect(classifyThrottle({})).toBe('ok');
  });

  it('page_not_found takes precedence over rate_limited signals', () => {
    expect(classifyThrottle({ url: 'x/page-not-found', bodyText: '429 too many' }))
      .toBe('page_not_found');
  });

  it('isThrottled is true for any non-ok kind', () => {
    expect(isThrottled('ok')).toBe(false);
    expect(isThrottled('page_not_found')).toBe(true);
    expect(isThrottled('session_invalid')).toBe(true);
    expect(isThrottled('rate_limited')).toBe(true);
  });
});

describe('throttleGuard.nextBackoffMs', () => {
  it('grows exponentially from the base with no jitter', () => {
    // jitterFraction 0 → deterministic, no rng needed.
    expect(nextBackoffMs(0, 60_000, 3_600_000, 0)).toBe(60_000);
    expect(nextBackoffMs(1, 60_000, 3_600_000, 0)).toBe(120_000);
    expect(nextBackoffMs(2, 60_000, 3_600_000, 0)).toBe(240_000);
    expect(nextBackoffMs(3, 60_000, 3_600_000, 0)).toBe(480_000);
  });

  it('is monotonically non-decreasing as failures rise', () => {
    let prev = 0;
    for (let f = 0; f < 12; f++) {
      const v = nextBackoffMs(f, 60_000, 3_600_000, 0);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it('caps at capMs for large failure counts', () => {
    expect(nextBackoffMs(20, 60_000, 3_600_000, 0)).toBe(3_600_000);
    expect(nextBackoffMs(1000, 60_000, 3_600_000, 0)).toBe(3_600_000);
  });

  it('applies deterministic jitter via injected rng', () => {
    // rng=0   → multiplier (1 - 0.2) = 0.8
    // rng=1   → multiplier (1 + 0.2) = 1.2
    // rng=0.5 → multiplier 1.0 (default rng)
    expect(nextBackoffMs(0, 60_000, 3_600_000, 0.2, () => 0)).toBe(48_000);
    expect(nextBackoffMs(0, 60_000, 3_600_000, 0.2, () => 1)).toBe(72_000);
    expect(nextBackoffMs(0, 60_000, 3_600_000, 0.2)).toBe(60_000); // default rng=0.5
  });

  it('never exceeds the cap even with upward jitter', () => {
    expect(nextBackoffMs(20, 60_000, 3_600_000, 0.2, () => 1)).toBe(3_600_000);
  });
});

describe('throttleGuard daily cap', () => {
  const state = (over: Partial<DailyRegState> = {}): DailyRegState => ({
    dayKey: '2026-06-02', count: 0, ...over,
  });

  it('dayKeyOf returns a stable UTC YYYY-MM-DD', () => {
    expect(dayKeyOf(new Date('2026-06-02T23:59:59.000Z'))).toBe('2026-06-02');
    expect(dayKeyOf(new Date('2026-06-03T00:00:01.000Z'))).toBe('2026-06-03');
  });

  it('allows registration while under the cap on the same day', () => {
    const now = new Date('2026-06-02T10:00:00Z');
    expect(canRegisterNow(state({ count: 7 }), 8, now)).toBe(true);
    expect(canRegisterNow(state({ count: 8 }), 8, now)).toBe(false);
  });

  it('resets the cap when the day rolls over', () => {
    const tomorrow = new Date('2026-06-03T00:05:00Z');
    // Yesterday's state was at the cap, but it's a new day now → allowed.
    expect(canRegisterNow(state({ dayKey: '2026-06-02', count: 8 }), 8, tomorrow)).toBe(true);
  });

  it('maxPerDay <= 0 blocks all registration', () => {
    expect(canRegisterNow(state({ count: 0 }), 0, new Date('2026-06-02T10:00:00Z'))).toBe(false);
  });

  it('recordRegistration increments on the same day', () => {
    const next = recordRegistration(state({ count: 3 }), new Date('2026-06-02T12:00:00Z'));
    expect(next).toEqual({ dayKey: '2026-06-02', count: 4 });
  });

  it('recordRegistration rolls over to 1 on a new day', () => {
    const next = recordRegistration(state({ dayKey: '2026-06-02', count: 8 }), new Date('2026-06-03T00:01:00Z'));
    expect(next).toEqual({ dayKey: '2026-06-03', count: 1 });
  });

  it('recordRegistration does not mutate the input', () => {
    const s = state({ count: 2 });
    recordRegistration(s, new Date('2026-06-02T12:00:00Z'));
    expect(s.count).toBe(2);
  });
});

describe('throttleGuard.shouldProceed', () => {
  const now = 1_000_000_000_000;
  it('proceeds when never throttled', () => {
    expect(shouldProceed(null, 60_000, now)).toBe(true);
  });
  it('blocks while still inside the cooldown window', () => {
    expect(shouldProceed(now - 10_000, 60_000, now)).toBe(false);
  });
  it('proceeds once the cooldown has elapsed', () => {
    expect(shouldProceed(now - 60_000, 60_000, now)).toBe(true);
    expect(shouldProceed(now - 120_000, 60_000, now)).toBe(true);
  });
});
