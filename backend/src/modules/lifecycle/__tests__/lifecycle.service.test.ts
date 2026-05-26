import { LifecycleService } from '../lifecycle.service';
import { MockBrowserDriver } from '../mock-browser-driver';
import { MockAccountRepo } from '../account-repo';
import type { AccountTiming, PacerConfig } from '../types';

const cfg: PacerConfig = {
  globalMinGapMs: 1_000,
  perAccountMinIntervalMs: 2_000,
  cooldown429202Ms: 7_200_000,
  cooldown429001Ms: 21_600_000,
  jitterFraction: 0,
  sessionFreshnessMs: 12 * 60 * 60 * 1000,
};

function makeAccount(over: Partial<AccountTiming>): AccountTiming {
  return {
    id: 'acc1',
    lifecycleState: 'ACTIVE',
    lastAttemptAt: null,
    cooldownUntil: null,
    warmedAt: null,
    attemptCount: 0,
    ...over,
  };
}

describe('LifecycleService.tick()', () => {
  it('does nothing when no accounts are due', async () => {
    const repo = new MockAccountRepo();
    repo.accounts = [makeAccount({ lastAttemptAt: Date.now() })]; // too recent
    const driver = new MockBrowserDriver();
    const svc = new LifecycleService(repo, driver, cfg);
    const result = await svc.tick();
    expect(result.acted).toBe(false);
    expect(repo.saved).toHaveLength(0);
  });

  it('does nothing when global limiter blocks', async () => {
    const repo = new MockAccountRepo();
    repo.accounts = [makeAccount()];
    await repo.setLastGlobalActionAt(Date.now()); // just acted
    const driver = new MockBrowserDriver();
    const svc = new LifecycleService(repo, driver, cfg);
    const result = await svc.tick();
    expect(result.acted).toBe(false);
  });

  it('drives login for ACTIVE account → persists WARM on OK', async () => {
    const repo = new MockAccountRepo();
    repo.accounts = [makeAccount({ lifecycleState: 'ACTIVE' })];
    const driver = new MockBrowserDriver().enqueueLogin({ ok: true, code: 'OK' });
    const svc = new LifecycleService(repo, driver, cfg);
    const result = await svc.tick();
    expect(result.acted).toBe(true);
    expect(repo.saved[0]!.transition.state).toBe('WARM');
  });

  it('drives register for NEW account → persists PENDING_ACTIVATION on OK', async () => {
    const repo = new MockAccountRepo();
    repo.accounts = [makeAccount({ lifecycleState: 'NEW' })];
    const driver = new MockBrowserDriver().enqueueRegister({ ok: true, code: 'OK' });
    const svc = new LifecycleService(repo, driver, cfg);
    const result = await svc.tick();
    expect(result.acted).toBe(true);
    expect(repo.saved[0]!.transition.state).toBe('PENDING_ACTIVATION');
  });

  it('drives activate for PENDING_ACTIVATION → persists ACTIVE on OK', async () => {
    const repo = new MockAccountRepo();
    repo.accounts = [makeAccount({ lifecycleState: 'PENDING_ACTIVATION' })];
    const driver = new MockBrowserDriver();
    const activatorOk = async (_id: string) => ({ ok: true as const, code: 'OK' as const });
    const svc = new LifecycleService(repo, driver, cfg, activatorOk);
    const result = await svc.tick();
    expect(result.acted).toBe(true);
    expect(repo.saved[0]!.transition.state).toBe('ACTIVE');
  });

  it('on 429001 → persists RESTRICTED with rotate=true', async () => {
    const repo = new MockAccountRepo();
    repo.accounts = [makeAccount({ lifecycleState: 'ACTIVE' })];
    const driver = new MockBrowserDriver().enqueueLogin({ ok: false, code: '429001' });
    const svc = new LifecycleService(repo, driver, cfg);
    const result = await svc.tick();
    expect(result.acted).toBe(true);
    expect(repo.saved[0]!.transition.state).toBe('RESTRICTED');
    expect(repo.saved[0]!.transition.rotate).toBe(true);
  });

  it('RESTRICTED account with elapsed cooldown → ACTIVE via COOLDOWN_ELAPSED (no driver call)', async () => {
    const repo = new MockAccountRepo();
    repo.accounts = [makeAccount({
      lifecycleState: 'RESTRICTED',
      cooldownUntil: Date.now() - 1, // elapsed
    })];
    const driver = new MockBrowserDriver(); // no enqueued responses
    const svc = new LifecycleService(repo, driver, cfg);
    const result = await svc.tick();
    expect(result.acted).toBe(true);
    expect(repo.saved[0]!.transition.state).toBe('ACTIVE');
  });

  it('WARM account with stale session → ACTIVE via SESSION_STALE (no driver call)', async () => {
    const repo = new MockAccountRepo();
    repo.accounts = [makeAccount({
      lifecycleState: 'WARM',
      warmedAt: Date.now() - cfg.sessionFreshnessMs - 1,
    })];
    const driver = new MockBrowserDriver();
    const svc = new LifecycleService(repo, driver, cfg);
    const result = await svc.tick();
    expect(result.acted).toBe(true);
    expect(repo.saved[0]!.transition.state).toBe('ACTIVE');
  });

  it('WARM account with fresh session → no action', async () => {
    const repo = new MockAccountRepo();
    repo.accounts = [makeAccount({
      lifecycleState: 'WARM',
      warmedAt: Date.now() - 1000, // very recent
    })];
    const driver = new MockBrowserDriver();
    const svc = new LifecycleService(repo, driver, cfg);
    const result = await svc.tick();
    expect(result.acted).toBe(false);
  });
});
