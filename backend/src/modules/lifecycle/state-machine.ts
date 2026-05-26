import type { LifecycleState, LifecycleEvent } from './types';

export interface TransitionCtx { attemptCount: number; maxAttempts: number; }
export interface Transition {
  state: LifecycleState;
  cooldownMs?: number;
  resetAttempts?: boolean;
  bumpAttempts?: boolean;
  rotate?: boolean;
}

export function nextState(current: LifecycleState, event: LifecycleEvent, ctx: TransitionCtx): Transition {
  if (event.kind === 'STEP_RESULT' && event.step === 'register') {
    const r = event.result;
    if (r.ok) return { state: 'PENDING_ACTIVATION', resetAttempts: true };
    if (ctx.attemptCount >= ctx.maxAttempts) return { state: 'BLOCKED' };
    return { state: 'REGISTER_FAILED', bumpAttempts: true };
  }
  return { state: current };
}
