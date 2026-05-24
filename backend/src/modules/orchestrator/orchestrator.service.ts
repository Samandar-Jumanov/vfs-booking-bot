/**
 * Orchestrator — the auto-pilot that walks every VfsAccount through its
 * lifecycle so the pool stays ready to detect + book slots without a human
 * clicking. It ties together the proven parts (activate → login → keep-alive)
 * on a schedule, spread gently across accounts to respect VFS rate limits.
 *
 * SAFETY: execution is OFF by default (ORCHESTRATOR_ENABLED=false). When off,
 * each tick only DERIVES + LOGS the plan (so you can see what it *would* do)
 * and never touches VFS. Turn it on only once the live flows are verified and
 * you're on distributed UZ IPs — otherwise it would hammer VFS like our
 * manual testing did and trigger 429001 bans.
 */
import cron from 'node-cron';
import { AccountStatus } from '@prisma/client';
import { prisma } from '@config/database';
import { env } from '@config/env';
import { logEvent } from '@modules/logs/logger';
import { EventType } from '@prisma/client';
import { loginAccount } from '@modules/accounts/accountLoginService';

const WARM_THRESHOLD_MS = 8 * 60 * 60 * 1000; // cookies older than 8h = stale
const MAX_ACTIONS_PER_TICK = 3;                // gentle: at most 3 logins/tick
const SPACING_MS = 90_000;                     // ≥90s between actions (rate-limit safe)
const TICK_CRON = '*/10 * * * *';              // every 10 minutes

type LifecycleState = 'BLOCKED' | 'COOLING' | 'NEEDS_ACTIVATION' | 'NEEDS_LOGIN' | 'WARM';

interface AccountSnapshot {
  id: string;
  email: string;
  status: AccountStatus;
  lastWarmedAt: Date | null;
  cooldownUntil: Date | null;
}

export function deriveState(a: AccountSnapshot, now = Date.now()): LifecycleState {
  if (a.status === AccountStatus.BLOCKED) return 'BLOCKED';
  if (a.cooldownUntil && a.cooldownUntil.getTime() > now) return 'COOLING';
  if (a.status === ('PENDING' as AccountStatus)) return 'NEEDS_ACTIVATION';
  // ACTIVE: warm if cookies refreshed within the threshold, else needs login.
  const warmedAge = a.lastWarmedAt ? now - a.lastWarmedAt.getTime() : Infinity;
  return warmedAge <= WARM_THRESHOLD_MS ? 'WARM' : 'NEEDS_LOGIN';
}

let ticking = false;

export async function runOrchestratorTick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const accounts = await prisma.vfsAccount.findMany({
      select: { id: true, email: true, status: true, lastWarmedAt: true, cooldownUntil: true },
    });
    const now = Date.now();
    const byState: Record<LifecycleState, AccountSnapshot[]> = {
      BLOCKED: [], COOLING: [], NEEDS_ACTIVATION: [], NEEDS_LOGIN: [], WARM: [],
    };
    for (const a of accounts) byState[deriveState(a as AccountSnapshot, now)].push(a as AccountSnapshot);

    const summary = Object.fromEntries(
      (Object.keys(byState) as LifecycleState[]).map((s) => [s, byState[s].length]),
    );
    logEvent('info', EventType.MONITOR_STARTED,
      `[ORCHESTRATOR] tick enabled=${env.ORCHESTRATOR_ENABLED} states=${JSON.stringify(summary)}`);

    if (!env.ORCHESTRATOR_ENABLED) return; // plan-only mode; never touches VFS

    // Execute: prioritise accounts that need activation, then stale logins.
    const queue = [...byState.NEEDS_ACTIVATION, ...byState.NEEDS_LOGIN].slice(0, MAX_ACTIONS_PER_TICK);
    for (let i = 0; i < queue.length; i += 1) {
      const acc = queue[i];
      try {
        const result = await loginAccount(acc.id); // handles PENDING→activate→login + ACTIVE→login
        logEvent(result.success ? 'info' : 'warn', EventType.BOOKING_ATTEMPT,
          `[ORCHESTRATOR] ${acc.email} → ${result.success ? 'warmed' : 'failed: ' + result.reason}`);
      } catch (err) {
        logEvent('error', EventType.BOOKING_FAILED, `[ORCHESTRATOR] ${acc.email} threw: ${(err as Error).message}`);
      }
      if (i < queue.length - 1) await new Promise((r) => setTimeout(r, SPACING_MS));
    }
  } finally {
    ticking = false;
  }
}

let started = false;

export function startOrchestrator(): void {
  if (started) return;
  started = true;
  cron.schedule(TICK_CRON, () => {
    void runOrchestratorTick().catch((err) =>
      logEvent('error', EventType.BOOKING_FAILED, `[ORCHESTRATOR] tick crashed: ${(err as Error).message}`));
  });
}
