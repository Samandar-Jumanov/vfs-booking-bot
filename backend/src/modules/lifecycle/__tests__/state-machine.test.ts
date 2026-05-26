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
