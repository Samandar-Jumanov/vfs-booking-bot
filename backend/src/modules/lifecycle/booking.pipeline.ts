import { nextState } from './state-machine';
import type { AccountRepo } from './account-repo';
import type { BrowserDriver, BookInput } from './browser-driver';
import type { AccountTiming, DriverResult } from './types';

const MAX_ATTEMPTS = 3;

function selectBookableAccount(accounts: AccountTiming[], now: number): AccountTiming | null {
  const warm = accounts.filter(
    (a) =>
      a.lifecycleState === 'WARM' &&
      (a.cooldownUntil == null || a.cooldownUntil <= now),
  );
  if (warm.length === 0) return null;
  warm.sort((a, b) => (a.lastAttemptAt ?? -1) - (b.lastAttemptAt ?? -1));
  return warm[0]!;
}

/**
 * Executes one booking attempt using the LRU WARM account.
 * Feeds 429 results into the shared state machine so accounts are properly
 * restricted and never re-hit from the booking path.
 */
export class BookingPipeline {
  constructor(
    private readonly repo: AccountRepo,
    private readonly driver: BrowserDriver,
  ) {}

  async book(input: BookInput): Promise<DriverResult> {
    const now = Date.now();
    const accounts = await this.repo.findAllTiming();
    const account = selectBookableAccount(accounts, now);
    if (!account) return { ok: false, code: 'NO_WARM_TAB', reason: 'No bookable WARM account available' };

    const result = await this.driver.book(input);

    if (result.code === '429001' || result.code === '429202') {
      const ctx = { attemptCount: account.attemptCount, maxAttempts: MAX_ATTEMPTS };
      const event = { kind: 'STEP_RESULT' as const, step: 'login' as const, result };
      const transition = nextState(account.lifecycleState, event, ctx);
      await this.repo.saveTransition(account.id, transition, account.attemptCount, now);
    } else if (result.ok) {
      // On booking success, record last attempt time (no state change).
      await this.repo.saveTransition(account.id, { state: account.lifecycleState }, account.attemptCount, now);
    }

    return result;
  }
}
