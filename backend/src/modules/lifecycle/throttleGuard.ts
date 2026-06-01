// backend/src/modules/lifecycle/throttleGuard.ts
//
// THROTTLE GUARD — pure, side-effect-free helpers that turn a register/login
// attempt's observable signals (final URL, body text, error code) into a
// throttle classification, then derive how long to back off and whether we're
// still allowed to register at all (daily cap + cooldown gate).
//
// Why this exists: when VFS/Datadome throttles, the page redirects to
// `.../page-not-found` or shows "session invalid/expired", and the register
// spike returns error:"form_not_rendered". The worker used to retry on a fixed
// stagger, which DEEPENS the block. These helpers replace that with
// exponential backoff + a hard daily cap so a throttled run cools off instead
// of hammering.
//
// Design rules (match pacer.ts conventions):
//  - NO DB / I/O imports. All state is passed in and returned as plain values.
//  - NO Math.random / Date.now at call sites that need determinism — jitter
//    takes an injected `rng: () => number` so tests are reproducible.

/** What kind of throttle (if any) an attempt's signals indicate. */
export type ThrottleKind = 'ok' | 'page_not_found' | 'session_invalid' | 'rate_limited';

/** Observable signals from a register/login attempt. All optional. */
export interface ThrottleInput {
  /** Final URL the page landed on (after any redirect). */
  url?: string;
  /** Visible body text / page HTML snippet. */
  bodyText?: string;
  /** Error code/string surfaced by the spike (e.g. "form_not_rendered"). */
  error?: string;
}

/**
 * Classify an attempt's signals into a throttle kind.
 *
 * Precedence (most specific first):
 *  1. page_not_found — final URL contains `page-not-found`, OR the spike
 *     reported `form_not_rendered` (the form never painted = VFS bounced us).
 *  2. rate_limited   — explicit 429 / "too many requests".
 *  3. session_invalid — "session" + ("invalid"/"expired"), or the standalone
 *     phrases "invalid session" / "session expired".
 *  4. ok             — nothing matched.
 */
export function classifyThrottle(input: ThrottleInput): ThrottleKind {
  const url = (input.url ?? '').toLowerCase();
  const body = (input.bodyText ?? '').toLowerCase();
  const error = (input.error ?? '').toLowerCase();

  // 1. page-not-found bounce (URL redirect) or form-never-rendered (spike code).
  if (url.includes('page-not-found') || url.includes('page_not_found')) return 'page_not_found';
  if (error.includes('form_not_rendered') || error.includes('page_not_found') || error.includes('page-not-found')) {
    return 'page_not_found';
  }

  // 2. explicit rate limiting.
  const haystack = `${body} ${error}`;
  if (
    haystack.includes('429') ||
    haystack.includes('too many') ||
    haystack.includes('rate limit') ||
    haystack.includes('rate_limit')
  ) {
    return 'rate_limited';
  }

  // 3. session invalid/expired (in body or error).
  if (
    haystack.includes('invalid session') ||
    haystack.includes('session expired') ||
    haystack.includes('session invalid') ||
    (haystack.includes('session') && (haystack.includes('expired') || haystack.includes('invalid')))
  ) {
    return 'session_invalid';
  }

  return 'ok';
}

/** True when a classification represents an actual throttle (anything but `ok`). */
export function isThrottled(kind: ThrottleKind): boolean {
  return kind !== 'ok';
}

/**
 * Exponential backoff with deterministic jitter.
 *
 * delay = min(capMs, baseMs * 2^failures), then jittered by ±`jitterFraction`
 * using the injected `rng` (default returns 0.5 = no jitter, so the result is
 * deterministic unless a real rng is supplied).
 *
 * `consecutiveFailures` is 0-based: 0 → baseMs, 1 → 2*baseMs, 2 → 4*baseMs, …
 */
export function nextBackoffMs(
  consecutiveFailures: number,
  baseMs = 60_000,
  capMs = 3_600_000,
  jitterFraction = 0.2,
  rng: () => number = () => 0.5,
): number {
  const failures = Math.max(0, Math.floor(consecutiveFailures));
  // Guard the exponent so 2^failures can't overflow into Infinity for huge inputs.
  const exp = Math.min(failures, 30);
  const raw = baseMs * Math.pow(2, exp);
  const capped = Math.min(capMs, raw);

  if (jitterFraction <= 0) return Math.round(capped);

  // rng() in [0,1) → jitter multiplier in [1 - f, 1 + f].
  const r = rng();
  const jitterMult = 1 - jitterFraction + r * (2 * jitterFraction);
  const jittered = capped * jitterMult;
  // Never exceed the cap even after upward jitter.
  return Math.round(Math.min(capMs, jittered));
}

// ---------------------------------------------------------------------------
// Daily registration cap
// ---------------------------------------------------------------------------

/** Persistable daily-cap state: which UTC day, and how many regs that day. */
export interface DailyRegState {
  /** UTC day key, format `YYYY-MM-DD`. */
  dayKey: string;
  /** Registrations recorded for `dayKey`. */
  count: number;
}

/** Stable UTC day key (`YYYY-MM-DD`) for a given instant. */
export function dayKeyOf(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Whether a registration is allowed right now under the daily cap.
 * Resets implicitly when `now`'s day key differs from the stored one.
 */
export function canRegisterNow(state: DailyRegState, maxPerDay: number, now: Date): boolean {
  if (maxPerDay <= 0) return false;
  const today = dayKeyOf(now);
  if (state.dayKey !== today) return true; // new day → counter is stale → allowed
  return state.count < maxPerDay;
}

/**
 * Record one registration, returning the NEXT state.
 * Rolls the counter over to 1 when the day changed since `state.dayKey`.
 * Pure — does not mutate the input.
 */
export function recordRegistration(state: DailyRegState, now: Date): DailyRegState {
  const today = dayKeyOf(now);
  if (state.dayKey !== today) return { dayKey: today, count: 1 };
  return { dayKey: today, count: state.count + 1 };
}

// ---------------------------------------------------------------------------
// Cooldown gate
// ---------------------------------------------------------------------------

/**
 * Whether enough time has passed since the last throttle to proceed.
 * `lastThrottleAt` is a ms-epoch (or null = never throttled → always proceed).
 */
export function shouldProceed(lastThrottleAt: number | null, cooldownMs: number, now: number): boolean {
  if (lastThrottleAt == null) return true;
  return now - lastThrottleAt >= cooldownMs;
}
