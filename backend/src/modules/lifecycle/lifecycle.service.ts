import { nextState } from './state-machine';
import type { Transition } from './state-machine';
import { pickNextDue, permitsGlobalAction } from './pacer';
import type { PacerConfig, AccountTiming, LifecycleEvent, DriverResult } from './types';
import type { AccountRepo } from './account-repo';
import type { BrowserDriver } from './browser-driver';

/** Callable for the activation step — wraps MailsacActivator; injectable for tests. */
export type ActivatorFn = (accountId: string) => Promise<DriverResult>;

const MAX_ATTEMPTS = 3;

export class LifecycleService {
  constructor(
    private readonly repo: AccountRepo,
    private readonly driver: BrowserDriver,
    private readonly cfg: PacerConfig,
    private readonly activator?: ActivatorFn,
  ) {}

  /**
   * Run one lifecycle tick: pick the next due account, drive its next step,
   * persist the transition. Returns immediately if the global limiter blocks
   * or nothing is due.
   */
  async tick(): Promise<{ acted: boolean; accountId?: string; transition?: Transition }> {
    const now = Date.now();

    const lastGlobal = await this.repo.getLastGlobalActionAt();
    if (!permitsGlobalAction(lastGlobal, this.cfg, now)) {
      return { acted: false };
    }

    const accounts = await this.repo.findAllTiming();

    // Stale-session check for WARM accounts (pacer alone doesn't cover this).
    const staleWarm = accounts.find(
      (a) =>
        a.lifecycleState === 'WARM' &&
        a.warmedAt != null &&
        now - a.warmedAt > this.cfg.sessionFreshnessMs,
    );
    if (staleWarm) {
      const ctx = { attemptCount: staleWarm.attemptCount, maxAttempts: MAX_ATTEMPTS };
      const transition = nextState('WARM', { kind: 'SESSION_STALE' }, ctx);
      await this.repo.saveTransition(staleWarm.id, transition, staleWarm.attemptCount, now);
      await this.repo.setLastGlobalActionAt(now);
      return { acted: true, accountId: staleWarm.id, transition };
    }

    const next = pickNextDue(accounts, this.cfg, now);
    if (!next) return { acted: false };

    // Fresh WARM accounts have no lifecycle action (stale ones already handled above).
    if (next.lifecycleState === 'WARM') {
      return { acted: false };
    }

    const ctx = { attemptCount: next.attemptCount, maxAttempts: MAX_ATTEMPTS };
    const transition = await this.driveAccount(next, ctx);
    const newAttemptCount = transition.resetAttempts
      ? 0
      : transition.bumpAttempts
        ? next.attemptCount + 1
        : next.attemptCount;

    await this.repo.saveTransition(next.id, transition, newAttemptCount, now);
    await this.repo.setLastGlobalActionAt(now);
    return { acted: true, accountId: next.id, transition };
  }

  private async driveAccount(
    account: AccountTiming,
    ctx: { attemptCount: number; maxAttempts: number },
  ): Promise<Transition> {
    // RESTRICTED with elapsed cooldown — no driver call needed.
    if (account.lifecycleState === 'RESTRICTED') {
      return nextState('RESTRICTED', { kind: 'COOLDOWN_ELAPSED' }, ctx);
    }

    const step = this.resolveStep(account.lifecycleState);
    if (!step) return { state: account.lifecycleState };

    let result: DriverResult;
    if (step === 'activate') {
      result = this.activator
        ? await this.activator(account.id)
        : { ok: false, code: 'OPERATOR_OFFLINE', reason: 'No activator configured' };
    } else if (step === 'register') {
      result = await this.driver.register({ email: account.id, password: '', phone: '' });
    } else {
      result = await this.driver.login({ email: account.id, password: '' });
    }

    const event: LifecycleEvent = { kind: 'STEP_RESULT', step, result };
    return nextState(account.lifecycleState, event, ctx);
  }

  private resolveStep(state: AccountTiming['lifecycleState']): 'register' | 'activate' | 'login' | null {
    switch (state) {
      case 'NEW':
      case 'REGISTER_FAILED':
      case 'REGISTERING':
        return 'register';
      case 'PENDING_ACTIVATION':
      case 'ACTIVATING':
        return 'activate';
      case 'ACTIVE':
      case 'LOGGING_IN':
        return 'login';
      default:
        return null;
    }
  }
}
