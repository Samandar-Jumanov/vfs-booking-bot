import type { LifecycleState, LifecycleEvent } from './types';

export interface TransitionCtx { attemptCount: number; maxAttempts: number; }
export interface Transition {
  state: LifecycleState;
  cooldownMs?: number;
  resetAttempts?: boolean;
  bumpAttempts?: boolean;
  rotate?: boolean;
}

const COOLDOWN_429001_MS = 6 * 60 * 60 * 1000; // 6h account restriction
const COOLDOWN_429202_MS = 2 * 60 * 60 * 1000; // 2h IP/session

export function nextState(current: LifecycleState, event: LifecycleEvent, ctx: TransitionCtx): Transition {
  if (event.kind === 'COOLDOWN_ELAPSED') {
    return { state: 'ACTIVE' };
  }
  if (event.kind === 'SESSION_STALE') {
    return current === 'WARM' ? { state: 'ACTIVE' } : { state: current };
  }
  const r = event.result;
  if (r.code === '429001') return { state: 'RESTRICTED', cooldownMs: COOLDOWN_429001_MS, rotate: true };
  if (r.code === '429202') return { state: 'RESTRICTED', cooldownMs: COOLDOWN_429202_MS };

  if (event.step === 'register') {
    if (r.ok) return { state: 'PENDING_ACTIVATION', resetAttempts: true };
    if (ctx.attemptCount >= ctx.maxAttempts) return { state: 'BLOCKED' };
    return { state: 'REGISTER_FAILED', bumpAttempts: true };
  }
  if (event.step === 'activate') {
    if (r.ok) return { state: 'ACTIVE', resetAttempts: true };
    if (r.code === 'NO_EMAIL_LINK' && ctx.attemptCount < ctx.maxAttempts) {
      return { state: 'PENDING_ACTIVATION', bumpAttempts: true };
    }
    return ctx.attemptCount >= ctx.maxAttempts ? { state: 'BLOCKED' } : { state: 'PENDING_ACTIVATION', bumpAttempts: true };
  }
  if (event.step === 'login') {
    if (r.ok) return { state: 'WARM', resetAttempts: true };
    return ctx.attemptCount >= ctx.maxAttempts ? { state: 'BLOCKED' } : { state: 'ACTIVE', bumpAttempts: true };
  }
  return { state: current };
}
