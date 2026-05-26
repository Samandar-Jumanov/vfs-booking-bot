// backend/src/modules/lifecycle/types.ts

/** The single authoritative lifecycle state of a VFS account. */
export type LifecycleState =
  | 'NEW'
  | 'REGISTERING'
  | 'REGISTER_FAILED'
  | 'PENDING_ACTIVATION'
  | 'ACTIVATING'
  | 'ACTIVE'
  | 'LOGGING_IN'
  | 'WARM'
  | 'RESTRICTED'
  | 'BLOCKED';

/** Outcome codes a BrowserDriver/activator/poller can report. */
export type ResultCode =
  | 'OK'
  | '429001'        // account-scoped Access Restricted (persistent)
  | '429202'        // IP/session throttle (~2h)
  | 'TURNSTILE_FAILED'
  | 'INVALID_CREDS'
  | 'NO_WARM_TAB'
  | 'OPERATOR_OFFLINE'
  | 'NO_EMAIL_LINK'  // Mailsac activation link not found yet
  | 'TIMEOUT'
  | 'UNKNOWN';

export interface DriverResult {
  ok: boolean;
  code: ResultCode;
  reason?: string;
  data?: Record<string, unknown>;
}

/** Events that drive a transition. A step result, or a timed trigger. */
export type LifecycleEvent =
  | { kind: 'STEP_RESULT'; step: 'register' | 'activate' | 'login'; result: DriverResult }
  | { kind: 'COOLDOWN_ELAPSED' }
  | { kind: 'SESSION_STALE' };       // WARM session aged past freshness threshold

export interface PacerConfig {
  /** Min ms between any two VFS-touching actions globally. */
  globalMinGapMs: number;
  /** Min ms before the same account may be driven again. */
  perAccountMinIntervalMs: number;
  /** Cooldown applied on 429202 (IP/session). */
  cooldown429202Ms: number;
  /** Cooldown applied on 429001 (account). */
  cooldown429001Ms: number;
  /** +/- fraction of jitter applied to gaps (0.3 = ±30%). */
  jitterFraction: number;
}

export interface AccountTiming {
  id: string;
  lifecycleState: LifecycleState;
  /** ms epoch of last action against this account, or null. */
  lastAttemptAt: number | null;
  /** ms epoch until which the account is in cooldown, or null. */
  cooldownUntil: number | null;
  /** ms epoch the WARM session was established, or null. */
  warmedAt: number | null;
}
