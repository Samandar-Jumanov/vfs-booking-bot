/**
 * DRY SCHEDULE — reads VfsAccount rows from the DB and prints the planned
 * pacing schedule for the lifecycle ticker WITHOUT touching VFS at all.
 *
 * Run (Railway or local with a live DB):
 *   DATABASE_URL=<url>  PROFILE_ENCRYPTION_KEY=<key>  npx tsx scripts/dry-schedule.ts
 *
 * Env:
 *   RUNNER_DRY_RUN=1   (implicit — this script is always dry)
 */

import 'dotenv/config';
import { prisma } from '../src/config/database';

// --------------------------------------------------------------------------
// Pacing constants — must stay in sync with lifecycle.scheduler.ts / pacer.ts
// --------------------------------------------------------------------------
const TICK_INTERVAL_MS = 30_000;          // one account driven per 30s cycle
const GLOBAL_MIN_GAP_MS = 30_000;         // min gap between any two VFS actions
const PER_ACCOUNT_MIN_INTERVAL_MS = 90_000; // min gap between attempts on same account
const COOLDOWN_429001_MS = 6 * 60 * 60 * 1000;  // 6h account restriction
const COOLDOWN_429202_MS = 2 * 60 * 60 * 1000;  // 2h IP/session throttle
const SESSION_FRESHNESS_MS = 12 * 60 * 60 * 1000; // 12h WARM session freshness

function fmt(d: Date | null): string {
  if (!d) return 'never';
  return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

function fmtCooldown(d: Date | null): string {
  if (!d) return 'none';
  const remaining = d.getTime() - Date.now();
  if (remaining <= 0) return `expired (${fmt(d)})`;
  const h = Math.floor(remaining / 3_600_000);
  const m = Math.floor((remaining % 3_600_000) / 60_000);
  return `${h}h${m}m remaining (until ${fmt(d)})`;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s.padEnd(n) : s.slice(0, n - 1) + '…';
}

type LifecycleStateEnum =
  | 'NEW' | 'REGISTERING' | 'REGISTER_FAILED'
  | 'PENDING_ACTIVATION' | 'ACTIVATING'
  | 'ACTIVE' | 'LOGGING_IN' | 'WARM'
  | 'RESTRICTED' | 'BLOCKED';

type AccountStatus = 'PENDING' | 'ACTIVE' | 'BLOCKED' | 'COOLDOWN';
type PollingRole = 'WATCHER' | 'BOOKER' | 'BOTH';

interface AccountRow {
  id: string;
  email: string;
  lifecycleState: LifecycleStateEnum;
  status: AccountStatus;
  pollingRole: PollingRole;
  attemptCount: number;
  lastAttemptAt: Date | null;
  cooldownUntil: Date | null;
}

function resolveNextAction(acc: AccountRow, now: number): string {
  const { lifecycleState, status, cooldownUntil, lastAttemptAt, attemptCount } = acc;

  if (status === 'BLOCKED' || lifecycleState === 'BLOCKED') return 'BLOCKED';

  if (cooldownUntil && cooldownUntil.getTime() > now) {
    const remaining = cooldownUntil.getTime() - now;
    const h = (remaining / 3_600_000).toFixed(1);
    return `RESTRICTED-wait ${h}h`;
  }

  if (lastAttemptAt && now - lastAttemptAt.getTime() < PER_ACCOUNT_MIN_INTERVAL_MS) {
    const waitSec = Math.ceil((PER_ACCOUNT_MIN_INTERVAL_MS - (now - lastAttemptAt.getTime())) / 1000);
    return `PACED-wait ${waitSec}s`;
  }

  switch (lifecycleState) {
    case 'NEW':
    case 'REGISTER_FAILED':
    case 'REGISTERING':
      return 'REGISTER';
    case 'PENDING_ACTIVATION':
    case 'ACTIVATING':
      return 'ACTIVATE';
    case 'ACTIVE':
    case 'LOGGING_IN':
      return 'LOGIN';
    case 'WARM': {
      // Check session freshness
      // warmedAt not in our query (would need join); indicate monitoring
      return `MONITOR (${acc.pollingRole === 'WATCHER' ? 'watch-only' : 'book-eligible'})`;
    }
    case 'RESTRICTED':
      // Cooldown already handled above — if we reach here the cooldown has elapsed
      return 'WARM-fresh (cooldown elapsed → LOGIN)';
    default:
      return 'UNKNOWN';
  }
}

function isDue(acc: AccountRow, now: number): boolean {
  if (acc.lifecycleState === 'BLOCKED' || acc.status === 'BLOCKED') return false;
  if (acc.cooldownUntil && acc.cooldownUntil.getTime() > now) return false;
  if (acc.lastAttemptAt && now - acc.lastAttemptAt.getTime() < PER_ACCOUNT_MIN_INTERVAL_MS) return false;
  return true;
}

async function main() {
  const now = Date.now();

  const accounts = await prisma.vfsAccount.findMany({
    orderBy: [{ lastAttemptAt: 'asc' }],
    select: {
      id: true,
      email: true,
      lifecycleState: true,
      status: true,
      pollingRole: true,
      attemptCount: true,
      lastAttemptAt: true,
      cooldownUntil: true,
    },
  }) as AccountRow[];

  const n = accounts.length;
  const dueAccounts = accounts.filter((a) => isDue(a, now));

  console.log('');
  console.log(`=== DRY SCHEDULE for ${n} accounts ===`);
  console.log(`    Tick interval : ${TICK_INTERVAL_MS / 1000}s`);
  console.log(`    Global gap    : ${GLOBAL_MIN_GAP_MS / 1000}s`);
  console.log(`    Per-acct gap  : ${PER_ACCOUNT_MIN_INTERVAL_MS / 1000}s`);
  console.log(`    429001 cd     : ${COOLDOWN_429001_MS / 3_600_000}h`);
  console.log(`    429202 cd     : ${COOLDOWN_429202_MS / 3_600_000}h`);
  console.log(`    Session fresh : ${SESSION_FRESHNESS_MS / 3_600_000}h`);
  console.log(`    Now           : ${new Date(now).toISOString()}`);
  console.log('');

  if (n === 0) {
    console.log('No accounts found.');
    await prisma.$disconnect();
    return;
  }

  // Header
  const COL = {
    email: 22,
    state: 20,
    status: 9,
    role: 8,
    attempts: 8,
    last: 22,
    cooldown: 28,
    action: 38,
  };

  const header =
    'EMAIL'.padEnd(COL.email) + ' | ' +
    'STATE'.padEnd(COL.state) + ' | ' +
    'STATUS'.padEnd(COL.status) + ' | ' +
    'ROLE'.padEnd(COL.role) + ' | ' +
    'ATTS'.padEnd(COL.attempts) + ' | ' +
    'LAST ATTEMPT'.padEnd(COL.last) + ' | ' +
    'COOLDOWN'.padEnd(COL.cooldown) + ' | ' +
    'NEXT ACTION';

  const sep = '-'.repeat(header.length);
  console.log(sep);
  console.log(header);
  console.log(sep);

  for (const acc of accounts) {
    const action = resolveNextAction(acc, now);
    const row =
      truncate(acc.email, COL.email) + ' | ' +
      acc.lifecycleState.padEnd(COL.state) + ' | ' +
      acc.status.padEnd(COL.status) + ' | ' +
      acc.pollingRole.padEnd(COL.role) + ' | ' +
      String(acc.attemptCount).padEnd(COL.attempts) + ' | ' +
      fmt(acc.lastAttemptAt).padEnd(COL.last) + ' | ' +
      fmtCooldown(acc.cooldownUntil).padEnd(COL.cooldown) + ' | ' +
      action;
    console.log(row);
  }

  console.log(sep);
  console.log('');

  // Pacing summary
  const ticksPerMinute = 60_000 / TICK_INTERVAL_MS;          // 2 ticks/min
  const accountsPerMinute = ticksPerMinute;                   // 1 account per tick
  const fullCycleMinutes = n > 0 ? Math.ceil(n / accountsPerMinute) : 0;

  console.log(`PACING SUMMARY:`);
  console.log(`  Total accounts       : ${n}`);
  console.log(`  Due now              : ${dueAccounts.length}`);
  console.log(`  Accounts per minute  : ~${accountsPerMinute.toFixed(1)} (1 per ${TICK_INTERVAL_MS / 1000}s tick)`);
  console.log(`  Full cycle estimate  : ~${fullCycleMinutes} min to drive all ${n} accounts once`);
  console.log('');

  if (dueAccounts.length === 0) {
    console.log('  No accounts are due right now (all in cooldown or paced interval).');
  } else {
    console.log(`  Next account to be driven: ${dueAccounts[0]!.email}`);
    console.log(`    → action: ${resolveNextAction(dueAccounts[0]!, now)}`);
  }

  console.log('');
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('[DRY-SCHEDULE] fatal error:', (err as Error).message);
  process.exit(1);
});
