/**
 * Heartbeat scheduler: sends a single batched "watching" Telegram message
 * every ~20 min when the pipeline is active but no slot has been found yet.
 * Fires at most once per HEARTBEAT_INTERVAL_MS — never on every slot check.
 * Gated: only runs if TELEGRAM_BOT_TOKEN is configured.
 */

import { env } from '@config/env';
import { sendTelegram } from './telegram.bot';

/**
 * Format HH:MM from a Date in local time.
 */
function formatHHMM(date: Date): string {
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

export class HeartbeatScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastCheckAt: Date | null = null;
  private lastCheckFoundSlot = false;

  constructor(
    private readonly intervalMs: number,
    private readonly getActiveCount: () => Promise<number>,
  ) {}

  /** Start the recurring heartbeat timer. Idempotent — safe to call multiple times. */
  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      this.fireNow().catch((err) => {
        console.warn('[heartbeat] send failed:', err?.message ?? String(err));
      });
    }, this.intervalMs);
    // Allow the process to exit even if this timer is still running.
    if (typeof this.timer === 'object' && this.timer !== null && 'unref' in this.timer) {
      (this.timer as any).unref();
    }
  }

  /** Stop the recurring timer. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Called on each slot-check iteration by the polling loop.
   * Updates the "last check" timestamp. If foundSlot is true the next heartbeat
   * shows "Slot found — booking in progress" instead of "no slots".
   */
  recordCheck(foundSlot: boolean): void {
    this.lastCheckAt = new Date();
    this.lastCheckFoundSlot = foundSlot;
  }

  /** Immediately send a heartbeat message (exposed for testing and the manual test script). */
  async fireNow(): Promise<void> {
    if (!env.TELEGRAM_BOT_TOKEN) {
      // Log to console only — no error thrown.
      const count = await this.getActiveCount().catch(() => 0);
      const timeStr = this.lastCheckAt ? formatHHMM(this.lastCheckAt) : '--:--';
      const statusPart = this.lastCheckFoundSlot
        ? `Slot found — booking in progress · ${count} accounts`
        : `Watching · ${count} accounts active · no slots · last check ${timeStr}`;
      console.info(`[heartbeat] ${statusPart}`);
      return;
    }

    const count = await this.getActiveCount().catch(() => 0);
    const timeStr = this.lastCheckAt ? formatHHMM(this.lastCheckAt) : '--:--';

    const message = this.lastCheckFoundSlot
      ? `Slot found — booking in progress · ${count} accounts`
      : `Watching · ${count} accounts active · no slots · last check ${timeStr}`;

    await sendTelegram(message);
  }
}

/**
 * Default active-account count callback.
 * Imports prisma lazily to avoid circular dependency issues at module load time.
 */
async function defaultGetActiveCount(): Promise<number> {
  const { prisma } = await import('@config/database');
  return prisma.vfsAccount.count({ where: { status: 'ACTIVE' } });
}

/** Singleton heartbeat instance wired to the default Prisma callback. */
export const heartbeat = new HeartbeatScheduler(env.HEARTBEAT_INTERVAL_MS, defaultGetActiveCount);
