import cron from 'node-cron';
import { env } from '@config/env';
import type { LifecycleService } from './lifecycle.service';

let started = false;

/**
 * Starts a paced lifecycle cron tick (every 30s). At most one account is driven
 * per cycle. Gated behind LIFECYCLE_ENABLED=true (default false) so the pipeline
 * never auto-runs until explicitly enabled by the operator.
 */
export function startLifecycleScheduler(service: LifecycleService): void {
  if (started) return;
  if (!env.LIFECYCLE_ENABLED) {
    console.info('[LIFECYCLE] scheduler disabled (LIFECYCLE_ENABLED=false)');
    return;
  }
  started = true;
  cron.schedule('*/30 * * * * *', () => {
    void service.tick().catch((err) => {
      console.error('[LIFECYCLE] tick error:', (err as Error).message);
    });
  });
  console.info('[LIFECYCLE] scheduler started — one account per 30s cycle');
}
