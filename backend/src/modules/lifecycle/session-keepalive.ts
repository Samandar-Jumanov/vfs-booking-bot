// TODO (live validation required): Confirm which endpoint the dropdown refresh hits.
// If it is the rate-limited slot endpoint (lift-api/appointment/slots), increase
// the default interval above the 429 threshold (60–90s + jitter per VFS rate limits).
// The intervalMs option is intentionally configurable for this reason.
export interface KeepaliveResult {
  landed: 'dashboard' | 'login' | 'unknown';
}

export interface SessionKeepaliveOptions {
  keepaliveFn: () => Promise<KeepaliveResult>;
  /** Interval in ms between keepalive pings. Config-tunable — do NOT hardcode. */
  intervalMs: number;
  accountId?: string;
  onSessionExpired?: (accountId?: string) => void;
}

export class SessionKeepalive {
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: SessionKeepaliveOptions) {
    this.intervalMs = opts.intervalMs;
  }

  start(): void {
    if (this.timer != null) return;
    this.timer = setInterval(() => {
      void this.opts.keepaliveFn().then((result) => {
        if (result.landed === 'login') {
          this.opts.onSessionExpired?.(this.opts.accountId);
        }
      });
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer != null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
