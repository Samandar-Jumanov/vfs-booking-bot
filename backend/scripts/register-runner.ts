/**
 * REGISTER RUNNER — hands-off account creation. The front of the pipeline:
 * runs on the operator's UZ machine, spawns nodriver-spike/register_spike.py to
 * register + activate fresh VFS accounts, then inserts each into the DB so
 * local-runner.ts (login → monitor → book) picks it up automatically.
 *
 * Registration MUST be serial + paced — VFS throttles repeated attempts (after
 * ~10 in a session it withholds the form). So this runs ONE at a time with a
 * long stagger, and bails out on a throttle signal.
 *
 * Run (on the UZ machine, needs a clean UZ IP + Python nodriver + Mailsac key):
 *   DATABASE_URL=<public> PROFILE_ENCRYPTION_KEY=<key> MAILSAC_API_KEY=<key> \
 *     npx tsx scripts/register-runner.ts
 * Env:
 *   REGISTER_LOOP=1           DASHBOARD MODE: poll the registration queue (set by
 *                             the dashboard "Create Account" button) forever and
 *                             drain it one-at-a-time. This is the normal way to
 *                             run it on the always-on UZ machine.
 *   REGISTER_COUNT=1          one-shot: how many accounts to create this run
 *   REGISTER_POOL_TARGET=0    if >0, register until #spare(ACTIVE,unlinked) == target
 *   REGISTER_STAGGER_SEC=120  wait between registrations (throttle pacing)
 *   REGISTER_POLL_SEC=30      (loop mode) how often to check the queue when idle
 *   REGISTER_DRY_RUN=1        show what it'd do, no browser, no DB write
 */
import path from 'path';
import { spawnSync } from 'child_process';
import { prisma } from '../src/config/database';
import { encrypt } from '../src/utils/crypto';

const SPIKE = path.resolve(__dirname, '..', '..', 'nodriver-spike', 'register_spike.py');
const COUNT = Number(process.env.REGISTER_COUNT ?? 1);
const POOL_TARGET = Number(process.env.REGISTER_POOL_TARGET ?? 0);
const STAGGER_SEC = Number(process.env.REGISTER_STAGGER_SEC ?? 120);
const POLL_SEC = Number(process.env.REGISTER_POLL_SEC ?? 30);
const LOOP = process.env.REGISTER_LOOP === '1';
const DRY_RUN = process.env.REGISTER_DRY_RUN === '1';

// Shared with the backend router (accounts.router.ts) — the dashboard bumps this
// Settings counter; we drain it here.
const REG_QUEUE_KEY = 'pending_registration_requests';

async function readQueue(): Promise<number> {
  const row = await prisma.settings.findUnique({ where: { key: REG_QUEUE_KEY } });
  const v = row?.value as unknown;
  if (typeof v === 'number') return Math.max(0, Math.floor(v));
  if (v && typeof v === 'object' && typeof (v as { count?: unknown }).count === 'number') {
    return Math.max(0, Math.floor((v as { count: number }).count));
  }
  return 0;
}

/** Decrement the queue by 1 (floor 0) after a successful registration. */
async function decrementQueue(): Promise<number> {
  const next = Math.max(0, (await readQueue()) - 1);
  await prisma.settings.upsert({
    where: { key: REG_QUEUE_KEY },
    update: { value: next },
    create: { key: REG_QUEUE_KEY, value: next },
  });
  return next;
}

interface RegResult {
  email: string;
  password: string;
  phone: string;
  registered: boolean;
  activated: boolean;
  error?: string;
}

function log(...a: unknown[]) {
  console.log('[REG-RUNNER]', new Date().toISOString(), ...a);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Spawn register_spike.py, capture stdout, parse the final `[REG] RESULT: {...}` line. */
function runSpike(): RegResult | null {
  if (!process.env.MAILSAC_API_KEY) {
    log('WARN MAILSAC_API_KEY not set — account will register but not auto-activate (status PENDING)');
  }
  const res = spawnSync('python', [SPIKE], {
    env: { ...process.env, PYTHONUTF8: '1' },
    encoding: 'utf-8',
    timeout: 5 * 60 * 1000,
  });
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  // echo the spike's own log lines so the operator sees progress
  out.split(/\r?\n/).filter(Boolean).forEach((l) => console.log('  ' + l));
  const m = out.match(/\[REG\]\s+RESULT:\s+(\{.*\})\s*$/m);
  if (!m) {
    log('no RESULT line from register_spike — treating as failure');
    return null;
  }
  try {
    return JSON.parse(m[1]) as RegResult;
  } catch (e) {
    log('could not parse RESULT json:', (e as Error).message);
    return null;
  }
}

/** Insert a freshly-registered account. status ACTIVE only if activation confirmed. */
async function persist(r: RegResult): Promise<void> {
  const status = r.activated ? 'ACTIVE' : 'PENDING';
  await prisma.vfsAccount.create({
    data: {
      email: r.email,
      encryptedPassword: encrypt(r.password),
      phone: r.phone,
      status,
    },
  });
  log(`persisted ${r.email} -> status=${status} (activated=${r.activated})`);
}

async function spareCount(): Promise<number> {
  return prisma.vfsAccount.count({
    where: { status: 'ACTIVE', profileIds: { isEmpty: true } },
  });
}

async function howMany(): Promise<number> {
  if (POOL_TARGET > 0) {
    const have = await spareCount();
    const need = Math.max(0, POOL_TARGET - have);
    log(`pool target=${POOL_TARGET}, spare ACTIVE+unlinked=${have}, need=${need}`);
    return need;
  }
  return COUNT;
}

type RegOutcome = 'ok' | 'throttled' | 'failed';

/** Register one account (or dry-run). Persists on success. Returns the outcome. */
async function registerOne(label: string): Promise<RegOutcome> {
  if (DRY_RUN) {
    log(`DRY-RUN would register ${label} via ${path.basename(SPIKE)}`);
    return 'ok';
  }
  log(`registering ${label}…`);
  const r = runSpike();
  if (!r || (!r.registered && r.error === 'form_not_rendered')) {
    log('THROTTLED — VFS withheld the form. Backing off (retry after a 30-60min cooldown).');
    return 'throttled';
  }
  if (!r.registered) {
    log(`did NOT register (no POST). result=${JSON.stringify(r)}`);
    return 'failed';
  }
  await persist(r);
  return 'ok';
}

const pace = async () => {
  const jitter = Math.floor(Math.random() * 30);
  log(`waiting ${STAGGER_SEC + jitter}s before next registration (throttle pacing)…`);
  await sleep((STAGGER_SEC + jitter) * 1000);
};

/** One-shot batch: REGISTER_COUNT or REGISTER_POOL_TARGET. */
async function runBatch() {
  const n = await howMany();
  log(`batch mode. to-create=${n} stagger=${STAGGER_SEC}s spike=${SPIKE} dryRun=${DRY_RUN}`);
  if (n <= 0) { log('nothing to do'); return; }
  let created = 0;
  for (let i = 0; i < n; i++) {
    const outcome = await registerOne(`account #${i + 1}/${n}`);
    if (outcome === 'ok') created++;
    else break; // throttled or failed → stop, don't hammer
    if (i < n - 1) await pace();
  }
  log(`batch done. created=${created}/${n}`);
}

/** Dashboard mode: drain the registration queue forever, one-at-a-time, paced. */
async function drainLoop() {
  log(`loop mode. polling queue every ${POLL_SEC}s, stagger=${STAGGER_SEC}s spike=${SPIKE} dryRun=${DRY_RUN}`);
  let backoffUntil = 0;
  for (;;) {
    try {
      if (Date.now() < backoffUntil) {
        await sleep(POLL_SEC * 1000);
        continue;
      }
      const pending = await readQueue();
      if (pending <= 0) {
        await sleep(POLL_SEC * 1000);
        continue;
      }
      log(`queue has ${pending} pending registration(s)`);
      const outcome = await registerOne(`queued account (pending=${pending})`);
      if (outcome === 'ok') {
        const left = DRY_RUN ? pending - 1 : await decrementQueue();
        log(`registered; queue now ${left}`);
        if (left > 0) await pace();
      } else if (outcome === 'throttled') {
        backoffUntil = Date.now() + 45 * 60 * 1000; // 45-min cooldown, leave queue intact
        log('throttle backoff: pausing the queue for 45 min (requests stay queued)');
      } else {
        // hard failure (not throttle): drop this request so we don't loop forever on it
        const left = await decrementQueue();
        log(`dropping failed request; queue now ${left}`);
        await pace();
      }
    } catch (e) {
      log('loop tick error:', (e as Error).message);
      await sleep(POLL_SEC * 1000);
    }
  }
}

async function main() {
  const stop = () => process.exit(0);
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  if (LOOP) {
    await drainLoop(); // never returns
  } else {
    await runBatch();
    process.exit(0);
  }
}

main().catch((e) => {
  console.error('register-runner crashed:', e);
  process.exit(1);
});
