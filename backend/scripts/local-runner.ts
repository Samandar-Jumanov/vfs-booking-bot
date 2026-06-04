/**
 * LOCAL RUNNER — the bridge between activated accounts and the hands-off nodriver
 * pipeline. Runs on the operator's UZ machine. Polls the DB for ACTIVE accounts
 * that have a linked active profile, and spawns nodriver-spike/auto_pipeline.py
 * per account (staggered, deduped, capped) so each one logs in + monitors
 * Work-D-visa slots by itself. MONITOR-only unless RUNNER_BOOK_ENABLED=1.
 *
 * Run (on the UZ machine):
 *   DATABASE_URL=<public>  PROFILE_ENCRYPTION_KEY=<key>  npx tsx scripts/local-runner.ts
 * Env:
 *   RUNNER_BOOK_ENABLED=1     actually book on a slot (default: monitor only)
 *   RUNNER_MAX_CONCURRENT=3   max simultaneous browsers
 *   RUNNER_STAGGER_SEC=30     gap between launches (login pacing)
 *   RUNNER_POLL_SEC=120       how often to look for newly-activated accounts
 *   MONITOR_INTERVAL=30       passed to each pipeline (default 30s; use 60 for conservative)
 *   TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID  optional alerts (passed through)
 */
import path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { prisma } from '../src/config/database';
import { decrypt } from '../src/utils/crypto';

const MAX_CONCURRENT = Number(process.env.RUNNER_MAX_CONCURRENT ?? 3);
const STAGGER_SEC = Number(process.env.RUNNER_STAGGER_SEC ?? 30);
const POLL_SEC = Number(process.env.RUNNER_POLL_SEC ?? 120);
const PIPELINE = path.resolve(__dirname, '..', '..', 'nodriver-spike', 'auto_pipeline.py');

const running = new Map<string, ChildProcess>(); // accountId -> pipeline process
let lastLaunch = 0;

function log(...a: unknown[]) {
  console.log('[RUNNER]', new Date().toISOString(), ...a);
}

function safeDecrypt(enc?: string | null): string {
  if (!enc) return '';
  try { return decrypt(enc); } catch { return ''; }
}

async function launchForAccount(account: { id: string; email: string; encryptedPassword: string; profileIds: string[]; pollingRole: string }) {
  const profile = await prisma.profile.findFirst({
    where: { id: { in: account.profileIds }, isActive: true },
  });
  const password = safeDecrypt(account.encryptedPassword);
  if (!password) { log(`skip ${account.email}: password decrypt failed`); return; }

  // WATCHER accounts monitor only — never book, regardless of RUNNER_BOOK_ENABLED.
  // BOOKER or BOTH accounts respect the RUNNER_BOOK_ENABLED env flag.
  const bookEnabled =
    account.pollingRole === 'WATCHER'
      ? ''
      : process.env.RUNNER_BOOK_ENABLED === '1' ? '1' : '';
  log(`account ${account.email} pollingRole=${account.pollingRole} → BOOK_ENABLED=${bookEnabled || 'off'}`);

  const [firstName, ...rest] = (profile?.fullName ?? 'Test User').trim().split(/\s+/);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PYTHONUTF8: '1',
    VFS_EMAIL: account.email,
    VFS_PASSWORD: password,
    MONITOR_INTERVAL: process.env.MONITOR_INTERVAL ?? '30',
    BOOK_ENABLED: bookEnabled,
  };
  if (profile) {
    env.PROFILE_FIRSTNAME = firstName;
    env.PROFILE_LASTNAME = rest.join(' ').trim() || firstName;
    env.PROFILE_NATIONALITY = profile.nationality;
    env.PROFILE_PASSPORT = safeDecrypt(profile.passportNumberEnc);
    env.PROFILE_EMAIL = profile.email;
    env.PROFILE_CONTACT = profile.phone;
  }

  if (process.env.RUNNER_DRY_RUN === '1') {
    log(`DRY-RUN would launch ${account.email} (role=${account.pollingRole}, profile=${profile?.fullName ?? 'NONE'}, passportLen=${(env.PROFILE_PASSPORT ?? '').length}, pwLen=${password.length}, book=${bookEnabled === '1'})`);
    running.set(account.id, { on: () => {}, kill: () => {} } as unknown as ChildProcess); // mark so we don't re-pick in this run
    return;
  }
  log(`launching pipeline for ${account.email} (role=${account.pollingRole}, profile: ${profile?.fullName ?? 'NONE — monitor only'}, book=${bookEnabled === '1'})`);
  const child = spawn('python', [PIPELINE], { env, stdio: 'inherit' });
  running.set(account.id, child);
  child.on('exit', (code) => {
    log(`pipeline for ${account.email} exited (code ${code})`);
    running.delete(account.id);
  });
}

async function tick() {
  if (running.size >= MAX_CONCURRENT) return;
  const candidates = await prisma.vfsAccount.findMany({
    where: { status: 'ACTIVE', NOT: { profileIds: { isEmpty: true } } },
    select: { id: true, email: true, encryptedPassword: true, profileIds: true, pollingRole: true },
    orderBy: { lastWarmedAt: 'asc' },
    take: 20,
  });
  for (const acc of candidates) {
    if (running.size >= MAX_CONCURRENT) break;
    if (running.has(acc.id)) continue;
    if (Date.now() - lastLaunch < STAGGER_SEC * 1000) break; // pace logins
    lastLaunch = Date.now();
    await launchForAccount(acc);
  }
  log(`active pipelines: ${running.size}/${MAX_CONCURRENT}`);
}

async function main() {
  log(`starting. pipeline=${PIPELINE} maxConcurrent=${MAX_CONCURRENT} book=${process.env.RUNNER_BOOK_ENABLED === '1'}`);
  // graceful shutdown
  const stop = () => { for (const c of running.values()) c.kill(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  if (process.env.RUNNER_ONCE === '1') {
    await tick();
    log('RUNNER_ONCE — single tick done, exiting');
    process.exit(0);
  }
  // poll loop
  for (;;) {
    try { await tick(); } catch (e) { log('tick error:', (e as Error).message); }
    await new Promise((r) => setTimeout(r, POLL_SEC * 1000));
  }
}

main().catch((e) => { console.error('runner crashed:', e); process.exit(1); });
