import type { PacerConfig, AccountTiming, LifecycleState } from './types';

const TERMINAL: LifecycleState[] = ['BLOCKED'];

export function isDue(a: AccountTiming, cfg: PacerConfig, now: number): boolean {
  if (TERMINAL.includes(a.lifecycleState)) return false;
  if (a.cooldownUntil != null && a.cooldownUntil > now) return false;
  if (a.lastAttemptAt != null && now - a.lastAttemptAt < cfg.perAccountMinIntervalMs) return false;
  return true;
}

export function permitsGlobalAction(lastGlobalActionAt: number | null, cfg: PacerConfig, now: number): boolean {
  if (lastGlobalActionAt == null) return true;
  return now - lastGlobalActionAt >= cfg.globalMinGapMs;
}

/** Least-recently-attempted due account (never-attempted first). */
export function pickNextDue(accounts: AccountTiming[], cfg: PacerConfig, now: number): AccountTiming | null {
  const due = accounts.filter((a) => isDue(a, cfg, now));
  if (due.length === 0) return null;
  due.sort((x, y) => (x.lastAttemptAt ?? -1) - (y.lastAttemptAt ?? -1));
  return due[0];
}
