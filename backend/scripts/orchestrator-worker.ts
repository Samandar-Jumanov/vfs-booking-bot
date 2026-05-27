// Run on UZ machine:
//   BACKEND_URL=https://... WORKER_TOKEN=... DATABASE_URL=... PROFILE_ENCRYPTION_KEY=... \
//   npx tsx scripts/orchestrator-worker.ts
// Test with SIMULATE=1:
//   SIMULATE=1 BACKEND_URL=... WORKER_TOKEN=... DATABASE_URL=... PROFILE_ENCRYPTION_KEY=... \
//   npx tsx scripts/orchestrator-worker.ts

/**
 * ORCHESTRATOR WORKER — persistent loop that runs on the operator's UZ machine.
 *
 * Polls the Railway DB for a "scenario_run" Settings key with status='requested',
 * claims it, then drives accounts through register → activate → login → monitor → book.
 * Posts a MILESTONE to BACKEND_URL/api/pipeline/event after every step so the
 * backend can update DB state, fire Telegram alerts, and write PipelineEvent rows.
 *
 * SIMULATE=1 disables ALL VFS browser hits — walks accounts through the state
 * sequence with short delays and posts real milestones. Safe to run from any IP.
 * SIMULATE_FAIL=1 (only in SIMULATE=1 mode) forces a failure after the monitoring step.
 */

import path from 'path';
import { spawn, spawnSync } from 'child_process';
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { isDue, permitsGlobalAction, pickNextDue } from '../src/modules/lifecycle/pacer';
import type { AccountTiming, PacerConfig } from '../src/modules/lifecycle/types';
import type { LifecycleState } from '../src/modules/lifecycle/types';

// ---------------------------------------------------------------------------
// Env — worker reads its own minimal set (NOT the full backend env schema)
// ---------------------------------------------------------------------------

const BACKEND_URL = (() => {
  const v = process.env.BACKEND_URL;
  if (!v) { console.error('[WORKER] BACKEND_URL is required'); process.exit(1); }
  return v.replace(/\/$/, '');
})();

const WORKER_TOKEN = process.env.WORKER_TOKEN ?? '';
const SIMULATE = process.env.SIMULATE === '1';
const SIMULATE_FAIL = process.env.SIMULATE_FAIL === '1';
const POLL_INTERVAL_SEC = Number(process.env.POLL_INTERVAL_SEC ?? 15);
const STAGGER_SEC = Number(process.env.STAGGER_SEC ?? 45);
const JITTER_SEC = Number(process.env.JITTER_SEC ?? 20);
const REGISTER_STAGGER_SEC = Number(process.env.REGISTER_STAGGER_SEC ?? 120);
const PROFILE_ENCRYPTION_KEY = (() => {
  const v = process.env.PROFILE_ENCRYPTION_KEY;
  if (!v) { console.error('[WORKER] PROFILE_ENCRYPTION_KEY is required'); process.exit(1); }
  return v;
})();

// ---------------------------------------------------------------------------
// Inline AES-256-GCM decrypt (avoids importing backend env chain)
// ---------------------------------------------------------------------------

const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function decryptField(ciphertext: string): string {
  const key = Buffer.from(PROFILE_ENCRYPTION_KEY, 'hex');
  const buf = Buffer.from(ciphertext, 'base64');
  const iv = buf.subarray(0, IV_LENGTH);
  const authTag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const encrypted = buf.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LENGTH });
  decipher.setAuthTag(authTag);
  return decipher.update(encrypted) + decipher.final('utf8');
}

// ---------------------------------------------------------------------------
// Prisma — use the same DATABASE_URL env var (set by caller)
// ---------------------------------------------------------------------------

const prisma = new PrismaClient({
  log: ['warn', 'error'],
});

// ---------------------------------------------------------------------------
// Pacer config
// ---------------------------------------------------------------------------

const PACER_CFG: PacerConfig = {
  globalMinGapMs: (STAGGER_SEC + JITTER_SEC) * 1000,
  perAccountMinIntervalMs: 30_000,
  cooldown429202Ms: 2 * 60 * 60 * 1000,
  cooldown429001Ms: 6 * 60 * 60 * 1000,
  jitterFraction: 0.3,
  sessionFreshnessMs: 6 * 60 * 60 * 1000,
};

// ---------------------------------------------------------------------------
// Spike paths (same resolution as local-runner.ts / register-runner.ts)
// ---------------------------------------------------------------------------

const PIPELINE_SPIKE = path.resolve(__dirname, '..', '..', 'nodriver-spike', 'auto_pipeline.py');
const REGISTER_SPIKE = path.resolve(__dirname, '..', '..', 'nodriver-spike', 'register_spike.py');

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function log(...a: unknown[]): void {
  console.log('[WORKER]', new Date().toISOString(), ...a);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Milestone POST
// ---------------------------------------------------------------------------

interface MilestoneBody {
  runId: string;
  email?: string;
  accountId?: string;
  step: string;
  fromState?: string;
  toState?: string;
  status: 'ok' | 'fail';
  slotId?: string;
  confirmation?: string;
  error?: string;
}

async function postMilestone(body: MilestoneBody): Promise<void> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (WORKER_TOKEN) headers['Authorization'] = `Bearer ${WORKER_TOKEN}`;
  try {
    await fetch(`${BACKEND_URL}/api/pipeline/event`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  } catch (e) {
    log('milestone POST failed:', (e as Error).message);
  }
}

// ---------------------------------------------------------------------------
// spawnAndWatch — adopted from local-runner.ts; parses MILESTONE lines
// ---------------------------------------------------------------------------

interface SpawnCtx {
  runId: string;
  email: string;
  accountId: string;
  fromState: string;
}

function spawnAndWatch(
  cmd: string,
  args: string[],
  env: Record<string, string>,
  ctx: SpawnCtx,
): Promise<'ok' | 'failed'> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      env: { ...process.env, ...env },
      // stdio must be pipe so we can parse stdout for MILESTONE lines
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');

    child.stdout.on('data', (chunk: string) => {
      const lines = String(chunk).split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        process.stdout.write('  ' + line + '\n');
        const m = line.match(/^MILESTONE\s+(\{.*\})\s*$/);
        if (m) {
          try {
            const ms = JSON.parse(m[1]) as Record<string, string>;
            void postMilestone({
              runId: ctx.runId,
              email: ctx.email,
              accountId: ctx.accountId,
              fromState: ctx.fromState,
              status: ms['error'] ? 'fail' : 'ok',
              step: ms['step'] ?? 'unknown',
              toState: ms['toState'],
              slotId: ms['slotId'],
              confirmation: ms['confirmation'],
              error: ms['error'],
            });
          } catch { /* ignore parse errors */ }
        }
      }
    });

    child.stderr.on('data', (chunk: string) => process.stderr.write(String(chunk)));
    child.on('close', (code) => resolve(code === 0 ? 'ok' : 'failed'));
  });
}

// ---------------------------------------------------------------------------
// Account timing loader (reads directly from DB)
// ---------------------------------------------------------------------------

async function loadAccountTimings(): Promise<AccountTiming[]> {
  const rows = await prisma.vfsAccount.findMany({
    where: { status: { in: ['ACTIVE', 'PENDING'] } },
    select: {
      id: true,
      lifecycleState: true,
      lastAttemptAt: true,
      cooldownUntil: true,
      attemptCount: true,
    },
  });
  return rows.map((r) => ({
    id: r.id,
    lifecycleState: r.lifecycleState as unknown as LifecycleState,
    lastAttemptAt: r.lastAttemptAt ? r.lastAttemptAt.getTime() : null,
    cooldownUntil: r.cooldownUntil ? r.cooldownUntil.getTime() : null,
    warmedAt: null,
    attemptCount: r.attemptCount,
  }));
}

// ---------------------------------------------------------------------------
// SIMULATE mode — walk fake state sequence, post real milestones
// ---------------------------------------------------------------------------

async function simulateAccount(
  runId: string,
  account: { id: string; email: string; lifecycleState: string },
): Promise<void> {
  const steps: Array<{ step: string; toState: string; delay: number }> = [
    { step: 'logged_in',  toState: 'LOGGING_IN', delay: 2000 },
    { step: 'monitoring', toState: 'WARM',        delay: 1500 },
    { step: 'slot_found', toState: 'WARM',        delay: 1000 },
    { step: 'booked',     toState: 'WARM',        delay: 1000 },
  ];

  for (const s of steps) {
    await sleep(s.delay);

    // SIMULATE_FAIL: after monitoring, emit failure and stop
    if (SIMULATE_FAIL && s.step === 'slot_found') {
      await postMilestone({
        runId,
        email: account.email,
        accountId: account.id,
        step: 'failed',
        toState: s.toState,
        status: 'fail',
        error: 'simulated_failure',
      });
      log(`[SIMULATE][FAIL] ${account.email}: forced failure after monitoring`);
      return;
    }

    await postMilestone({
      runId,
      email: account.email,
      accountId: account.id,
      step: s.step,
      toState: s.toState,
      status: 'ok',
      slotId:
        s.step === 'slot_found' || s.step === 'booked'
          ? `sim-slot-${Date.now()}`
          : undefined,
      confirmation: s.step === 'booked' ? `SIM-CONF-${Date.now()}` : undefined,
    });
    log(`[SIMULATE] ${account.email}: ${s.step} → ${s.toState}`);
  }
}

// ---------------------------------------------------------------------------
// driveAccountReal — spawns auto_pipeline.py (exact env from local-runner.ts)
// ---------------------------------------------------------------------------

async function driveAccountReal(
  runId: string,
  acct: {
    id: string;
    email: string;
    encryptedPassword: string;
    lifecycleState: string;
    profileIds: string[];
    pollingRole: string;
  },
): Promise<void> {
  let password = '';
  try {
    password = decryptField(acct.encryptedPassword);
  } catch (e) {
    log(`skip ${acct.email}: password decrypt failed — ${(e as Error).message}`);
    return;
  }
  if (!password) { log(`skip ${acct.email}: empty password after decrypt`); return; }

  // Respect WATCHER role — never book regardless of BOOK_ENABLED
  const bookEnabled =
    acct.pollingRole === 'WATCHER'
      ? ''
      : process.env.BOOK_ENABLED ?? '';

  // Load profile if linked (same as local-runner.ts)
  const profile =
    acct.profileIds.length > 0
      ? await prisma.profile.findFirst({
          where: { id: { in: acct.profileIds }, isActive: true },
        })
      : null;

  const spawnEnv: Record<string, string> = {
    PYTHONUTF8: '1',
    VFS_EMAIL: acct.email,
    VFS_PASSWORD: password,
    MONITOR_INTERVAL: process.env.MONITOR_INTERVAL ?? '180',
    BOOK_ENABLED: bookEnabled,
    BOOK_DRY_RUN: process.env.BOOK_DRY_RUN ?? '',
    WORKER_BRIDGED: '1',
  };

  if (profile) {
    const [firstName, ...rest] = (profile.fullName ?? 'Test User').trim().split(/\s+/);
    let passportPlain = '';
    try { passportPlain = decryptField(profile.passportNumberEnc); } catch { /* leave empty */ }
    spawnEnv['PROFILE_FIRSTNAME'] = firstName;
    spawnEnv['PROFILE_LASTNAME'] = rest.join(' ').trim() || firstName;
    spawnEnv['PROFILE_NATIONALITY'] = profile.nationality;
    spawnEnv['PROFILE_PASSPORT'] = passportPlain;
    spawnEnv['PROFILE_EMAIL'] = profile.email;
    spawnEnv['PROFILE_CONTACT'] = profile.phone;
  }

  log(`driving ${acct.email} (role=${acct.pollingRole}, profile=${profile?.fullName ?? 'NONE'}, book=${bookEnabled === '1'})`);

  await spawnAndWatch('python', [PIPELINE_SPIKE], spawnEnv, {
    runId,
    email: acct.email,
    accountId: acct.id,
    fromState: acct.lifecycleState,
  });
}

// ---------------------------------------------------------------------------
// registerOne — adopted from register-runner.ts's runSpike() + persist()
// ---------------------------------------------------------------------------

interface RegResult {
  email: string;
  password: string;
  phone: string;
  registered: boolean;
  activated: boolean;
  error?: string;
}

function encryptField(plaintext: string): string {
  const key = Buffer.from(PROFILE_ENCRYPTION_KEY, 'hex');
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

async function registerOne(runId: string): Promise<void> {
  if (!process.env.MAILSAC_API_KEY) {
    log('WARN MAILSAC_API_KEY not set — account will register but not auto-activate (status PENDING)');
  }

  log('spawning register_spike.py…');
  const res = spawnSync('python', [REGISTER_SPIKE], {
    env: { ...process.env, PYTHONUTF8: '1', WORKER_BRIDGED: '1' },
    encoding: 'utf-8',
    timeout: 5 * 60 * 1000,
  });

  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  out.split(/\r?\n/).filter(Boolean).forEach((l) => console.log('  ' + l));

  // Parse and forward MILESTONE lines from the spike output
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^MILESTONE\s+(\{.*\})\s*$/);
    if (m) {
      try {
        const ms = JSON.parse(m[1]) as Record<string, string>;
        await postMilestone({
          runId,
          email: ms['email'],
          step: ms['step'] ?? 'register',
          status: ms['error'] ? 'fail' : 'ok',
          error: ms['error'],
        });
      } catch { /* ignore */ }
    }
  }

  // Parse [REG] RESULT: {...} line and persist to DB (same as register-runner.ts)
  const crashed = /Traceback \(most recent call last\)|SyntaxError|ModuleNotFoundError/.test(out);
  const rm = out.match(/\[REG\]\s+RESULT:\s+(\{.*\})\s*$/m);
  if (!rm) {
    log(crashed ? 'register_spike CRASHED' : 'no RESULT line from register_spike — throttled or failed');
    return;
  }

  let result: RegResult;
  try {
    result = JSON.parse(rm[1]) as RegResult;
  } catch (e) {
    log('could not parse RESULT json:', (e as Error).message);
    return;
  }

  if (!result.registered) {
    log(`did NOT register. result=${JSON.stringify(result)}`);
    return;
  }

  const status = result.activated ? 'ACTIVE' : 'PENDING';
  try {
    await prisma.vfsAccount.create({
      data: {
        email: result.email,
        encryptedPassword: encryptField(result.password),
        phone: result.phone,
        status,
      },
    });
    log(`persisted ${result.email} → status=${status} (activated=${result.activated})`);

    // Post a register milestone for the newly created account
    await postMilestone({
      runId,
      email: result.email,
      step: 'registered',
      toState: result.activated ? 'ACTIVE' : 'PENDING_ACTIVATION',
      status: 'ok',
    });
  } catch (e) {
    log(`DB persist failed for ${result.email}:`, (e as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Pool top-up: count spare ACTIVE+unlinked accounts
// ---------------------------------------------------------------------------

async function spareCount(): Promise<number> {
  return prisma.vfsAccount.count({
    where: { status: 'ACTIVE', profileIds: { isEmpty: true } },
  });
}

// ---------------------------------------------------------------------------
// driveRun — main run orchestration
// ---------------------------------------------------------------------------

async function driveRun(runId: string): Promise<void> {
  log(`driveRun start. runId=${runId} SIMULATE=${SIMULATE}`);

  // 1. Pool top-up (skip in SIMULATE — no real registrations)
  if (!SIMULATE) {
    const spare = await spareCount();
    const poolMin = 2;
    if (spare < poolMin) {
      const need = poolMin - spare;
      log(`pool top-up: spare=${spare} < min=${poolMin}, registering ${need} account(s)`);
      for (let i = 0; i < need; i++) {
        await registerOne(runId);
        if (i < need - 1) {
          const jitter = Math.floor(Math.random() * 30);
          log(`register stagger: waiting ${REGISTER_STAGGER_SEC + jitter}s`);
          await sleep((REGISTER_STAGGER_SEC + jitter) * 1000);
        }
      }
    } else {
      log(`pool ok: spare=${spare} ACTIVE+unlinked accounts`);
    }
  }

  // 2. Load timings for pacer
  const timings = await loadAccountTimings();
  const now = Date.now();

  // 3. Load ACTIVE accounts for login → monitor → book
  const accounts = await prisma.vfsAccount.findMany({
    where: { status: 'ACTIVE' },
    select: {
      id: true,
      email: true,
      encryptedPassword: true,
      lifecycleState: true,
      profileIds: true,
      pollingRole: true,
    },
    orderBy: { lastAttemptAt: 'asc' },
  });

  if (accounts.length === 0) {
    log('no ACTIVE accounts to drive — run complete');
    return;
  }

  log(`driving ${accounts.length} ACTIVE account(s) (paced, staggered)`);

  let lastAction = 0;
  let lastGlobalAction: number | null = null;

  for (const acct of accounts) {
    // Per-account pacer check
    const timing = timings.find((t) => t.id === acct.id);
    if (timing && !isDue(timing, PACER_CFG, now)) {
      log(`skip ${acct.email}: not due yet (cooldown or too recent)`);
      continue;
    }

    // Global gap enforcement (STAGGER_SEC + random JITTER_SEC)
    if (!permitsGlobalAction(lastGlobalAction, PACER_CFG, Date.now())) {
      const remaining = PACER_CFG.globalMinGapMs - (Date.now() - (lastGlobalAction ?? 0));
      if (remaining > 0) {
        log(`global gap: waiting ${Math.ceil(remaining / 1000)}s before next login`);
        await sleep(remaining);
      }
    }

    // Additional stagger with jitter on top of the global gap
    const nowTs = Date.now();
    const gapMs = (STAGGER_SEC + Math.random() * JITTER_SEC) * 1000;
    const sinceLast = nowTs - lastAction;
    if (lastAction > 0 && sinceLast < gapMs) {
      const wait = gapMs - sinceLast;
      log(`stagger: waiting ${Math.ceil(wait / 1000)}s before next account`);
      await sleep(wait);
    }

    lastAction = Date.now();
    lastGlobalAction = Date.now();

    if (SIMULATE) {
      await simulateAccount(runId, { id: acct.id, email: acct.email, lifecycleState: acct.lifecycleState as string });
    } else {
      await driveAccountReal(runId, {
        id: acct.id,
        email: acct.email,
        encryptedPassword: acct.encryptedPassword,
        lifecycleState: acct.lifecycleState as string,
        profileIds: acct.profileIds,
        pollingRole: acct.pollingRole,
      });
    }
  }

  log(`driveRun complete. runId=${runId}`);
}

// ---------------------------------------------------------------------------
// pickNextDue usage — exported from pacer, used to log the next candidate
// ---------------------------------------------------------------------------

function logNextDue(timings: AccountTiming[]): void {
  const candidate = pickNextDue(timings, PACER_CFG, Date.now());
  if (candidate) {
    log(`next due account id=${candidate.id} lifecycleState=${candidate.lifecycleState}`);
  } else {
    log('no accounts due right now');
  }
}

// ---------------------------------------------------------------------------
// Settings key type
// ---------------------------------------------------------------------------

interface ScenarioRun {
  runId: string;
  requestedAt: string;
  status: string;
  completedAt?: string;
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  log(`Orchestrator worker starting. SIMULATE=${SIMULATE} BACKEND_URL=${BACKEND_URL} POLL_INTERVAL_SEC=${POLL_INTERVAL_SEC}`);
  if (SIMULATE) log('SIMULATE=1 — no VFS browser hits will occur');
  if (SIMULATE && SIMULATE_FAIL) log('SIMULATE_FAIL=1 — accounts will fail after monitoring step');

  process.on('SIGINT', () => {
    log('SIGINT — shutting down');
    void prisma.$disconnect().then(() => process.exit(0));
  });
  process.on('SIGTERM', () => {
    log('SIGTERM — shutting down');
    void prisma.$disconnect().then(() => process.exit(0));
  });

  for (;;) {
    try {
      // Poll Settings for scenario_run
      const row = await prisma.settings.findUnique({ where: { key: 'scenario_run' } });
      const run = row?.value as ScenarioRun | null;

      if (run && run.status === 'requested') {
        log(`Claiming run ${run.runId}`);

        // Mark as running
        await prisma.settings.update({
          where: { key: 'scenario_run' },
          data: { value: { ...run, status: 'running' } as unknown as Parameters<typeof prisma.settings.update>[0]['data']['value'] },
        });

        try {
          await driveRun(run.runId);

          // Mark complete
          await prisma.settings.update({
            where: { key: 'scenario_run' },
            data: {
              value: {
                ...run,
                status: 'completed',
                completedAt: new Date().toISOString(),
              } as unknown as Parameters<typeof prisma.settings.update>[0]['data']['value'],
            },
          });
          log(`Run ${run.runId} complete`);
        } catch (runErr) {
          log(`Run ${run.runId} failed:`, (runErr as Error).message);
          // Mark as failed so the operator can re-request
          await prisma.settings.update({
            where: { key: 'scenario_run' },
            data: {
              value: {
                ...run,
                status: 'failed',
                error: (runErr as Error).message,
                completedAt: new Date().toISOString(),
              } as unknown as Parameters<typeof prisma.settings.update>[0]['data']['value'],
            },
          });
        }
      } else if (run && run.status === 'running') {
        // Another worker instance or a crash-restart — log and wait
        log(`Run ${run.runId} is already running (by another process or from before crash) — polling`);

        // Log which accounts are due (diagnostic only)
        try {
          const timings = await loadAccountTimings();
          logNextDue(timings);
        } catch { /* non-fatal */ }

        await sleep(POLL_INTERVAL_SEC * 1000);
      } else {
        // No active run — quiet poll
        await sleep(POLL_INTERVAL_SEC * 1000);
      }
    } catch (e) {
      log('loop error:', (e as Error).message);
      await sleep(POLL_INTERVAL_SEC * 1000);
    }
  }
}

main().catch((e) => {
  console.error('[WORKER] crashed:', e);
  void prisma.$disconnect();
  process.exit(1);
});
