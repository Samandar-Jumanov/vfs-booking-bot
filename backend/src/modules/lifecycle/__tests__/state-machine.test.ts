import { nextState } from '../state-machine';
import type { DriverResult } from '../types';

const ok = (data?: Record<string, unknown>): DriverResult => ({ ok: true, code: 'OK', data });
const fail = (code: any): DriverResult => ({ ok: false, code });

describe('nextState — register path', () => {
  it('NEW + register OK → PENDING_ACTIVATION, attempt reset', () => {
    const t = nextState('NEW', { kind: 'STEP_RESULT', step: 'register', result: ok() }, { attemptCount: 0, maxAttempts: 3 });
    expect(t.state).toBe('PENDING_ACTIVATION');
    expect(t.resetAttempts).toBe(true);
  });

  it('NEW + register fail (retries left) → REGISTER_FAILED, no cooldown', () => {
    const t = nextState('NEW', { kind: 'STEP_RESULT', step: 'register', result: fail('TIMEOUT') }, { attemptCount: 1, maxAttempts: 3 });
    expect(t.state).toBe('REGISTER_FAILED');
    expect(t.cooldownMs).toBeUndefined();
  });

  it('NEW + register fail (retries exhausted) → BLOCKED', () => {
    const t = nextState('NEW', { kind: 'STEP_RESULT', step: 'register', result: fail('TIMEOUT') }, { attemptCount: 3, maxAttempts: 3 });
    expect(t.state).toBe('BLOCKED');
  });
});

describe('nextState — activate/login/429/cooldown', () => {
  it('PENDING_ACTIVATION + activate OK → ACTIVE', () => {
    expect(nextState('PENDING_ACTIVATION', { kind: 'STEP_RESULT', step: 'activate', result: ok() }, { attemptCount: 0, maxAttempts: 3 }).state).toBe('ACTIVE');
  });
  it('PENDING_ACTIVATION + activate NO_EMAIL_LINK → stays PENDING_ACTIVATION (retry later)', () => {
    expect(nextState('PENDING_ACTIVATION', { kind: 'STEP_RESULT', step: 'activate', result: fail('NO_EMAIL_LINK') }, { attemptCount: 1, maxAttempts: 5 }).state).toBe('PENDING_ACTIVATION');
  });
  it('ACTIVE + login OK → WARM', () => {
    expect(nextState('ACTIVE', { kind: 'STEP_RESULT', step: 'login', result: ok() }, { attemptCount: 0, maxAttempts: 3 }).state).toBe('WARM');
  });
  it('login 429001 → RESTRICTED, long cooldown, rotate flagged', () => {
    const t = nextState('ACTIVE', { kind: 'STEP_RESULT', step: 'login', result: fail('429001') }, { attemptCount: 0, maxAttempts: 3 });
    expect(t.state).toBe('RESTRICTED');
    expect(t.rotate).toBe(true);
    expect(t.cooldownMs).toBeGreaterThan(0);
  });
  it('login 429202 → RESTRICTED, short cooldown, no rotate', () => {
    const t = nextState('ACTIVE', { kind: 'STEP_RESULT', step: 'login', result: fail('429202') }, { attemptCount: 0, maxAttempts: 3 });
    expect(t.state).toBe('RESTRICTED');
    expect(t.rotate).toBeFalsy();
  });
  it('RESTRICTED + COOLDOWN_ELAPSED → ACTIVE (resume)', () => {
    expect(nextState('RESTRICTED', { kind: 'COOLDOWN_ELAPSED' }, { attemptCount: 0, maxAttempts: 3 }).state).toBe('ACTIVE');
  });
  it('WARM + SESSION_STALE → ACTIVE (needs re-login)', () => {
    expect(nextState('WARM', { kind: 'SESSION_STALE' }, { attemptCount: 0, maxAttempts: 3 }).state).toBe('ACTIVE');
  });
});
