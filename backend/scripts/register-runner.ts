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
 *   REGISTER_COUNT=1          how many accounts to create this run (default 1)
 *   REGISTER_POOL_TARGET=0    if >0, register until #spare(ACTIVE,unlinked) == target
 *   REGISTER_STAGGER_SEC=120  wait between registrations (throttle pacing)
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
const DRY_RUN = process.env.REGISTER_DRY_RUN === '1';

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

async function main() {
  const n = await howMany();
  log(`starting. to-create=${n} stagger=${STAGGER_SEC}s spike=${SPIKE} dryRun=${DRY_RUN}`);
  if (n <= 0) {
    log('nothing to do');
    process.exit(0);
  }

  let created = 0;
  for (let i = 0; i < n; i++) {
    if (DRY_RUN) {
      log(`DRY-RUN would register account #${i + 1}/${n} via ${path.basename(SPIKE)}`);
      created++;
    } else {
      log(`registering account #${i + 1}/${n}…`);
      const r = runSpike();
      if (!r || (!r.registered && r.error === 'form_not_rendered')) {
        log('THROTTLED or failed — VFS withheld the form. Stopping batch; retry after a 30-60min cooldown.');
        break;
      }
      if (!r.registered) {
        log(`account #${i + 1} did NOT register (no POST). Stopping to avoid hammering. result=${JSON.stringify(r)}`);
        break;
      }
      await persist(r);
      created++;
    }
    // pace the next one (skip the wait after the last)
    if (i < n - 1) {
      const jitter = Math.floor(Math.random() * 30);
      log(`waiting ${STAGGER_SEC + jitter}s before next registration (throttle pacing)…`);
      await sleep((STAGGER_SEC + jitter) * 1000);
    }
  }

  log(`done. created=${created}/${n}`);
  process.exit(0);
}

main().catch((e) => {
  console.error('register-runner crashed:', e);
  process.exit(1);
});
