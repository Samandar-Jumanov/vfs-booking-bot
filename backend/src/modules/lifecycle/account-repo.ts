import type { AccountTiming } from './types';
import type { Transition } from './state-machine';

export interface AccountRepo {
  findAllTiming(): Promise<AccountTiming[]>;
  saveTransition(
    id: string,
    transition: Transition,
    newAttemptCount: number,
    now: number,
  ): Promise<void>;
  getLastGlobalActionAt(): Promise<number | null>;
  setLastGlobalActionAt(ms: number): Promise<void>;
}

/** In-memory implementation for unit tests — no DB required. */
export class MockAccountRepo implements AccountRepo {
  accounts: AccountTiming[] = [];
  saved: Array<{ id: string; transition: Transition; attemptCount: number; now: number }> = [];
  private lastGlobal: number | null = null;

  async findAllTiming(): Promise<AccountTiming[]> {
    return [...this.accounts];
  }

  async saveTransition(id: string, transition: Transition, newAttemptCount: number, now: number): Promise<void> {
    this.saved.push({ id, transition, attemptCount: newAttemptCount, now });
    const idx = this.accounts.findIndex((a) => a.id === id);
    if (idx >= 0) {
      const a = this.accounts[idx]!;
      this.accounts[idx] = {
        ...a,
        lifecycleState: transition.state,
        lastAttemptAt: now,
        attemptCount: newAttemptCount,
        cooldownUntil: transition.cooldownMs != null ? now + transition.cooldownMs : a.cooldownUntil,
      };
    }
  }

  async getLastGlobalActionAt(): Promise<number | null> {
    return this.lastGlobal;
  }

  async setLastGlobalActionAt(ms: number): Promise<void> {
    this.lastGlobal = ms;
  }
}
