// Run on UZ machine (clean Tashkent residential IP, no VPN):
//   BACKEND_URL=https://... WORKER_TOKEN=... DATABASE_URL=... PROFILE_ENCRYPTION_KEY=... \
//   npx tsx scripts/orchestrator-worker.ts

/**
 * ORCHESTRATOR WORKER — persistent loop that runs on the operator's UZ machine.
 *
 * Polls the Railway DB for a "scenario_run" Settings key with status='requested',
 * claims it, then drives accounts through register → activate → login → monitor → book.
 * Posts a MILESTONE to BACKEND_URL/api/pipeline/event after every step so the
 * backend can update DB state, fire Telegram alerts, and write PipelineEvent rows.
 */

import path from 'path';
import fs from 'fs';
import os from 'os';
import { spawn, spawnSync } from 'child_process';
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { isDue, permitsGlobalAction, pickNextDue } from '../src/modules/lifecycle/pacer';
import type { AccountTiming, PacerConfig } from '../src/modules/lifecycle/types';
import type { LifecycleState } from '../src/modules/lifecycle/types';
// throttleGuard: turn a register attempt's signals into a throttle classification,
// derive exponential backoff, and enforce a hard daily registration cap so a
// throttled run cools off instead of hammering VFS/Datadome (which deepens the block).
import {
  classifyThrottle,
  isThrottled,
  nextBackoffMs,
  canRegisterNow,
  recordRegistration,
  type DailyRegState,
} from '../src/modules/lifecycle/throttleGuard';

// ---------------------------------------------------------------------------
// Env — worker reads its own minimal set (NOT the full backend env schema)
// ---------------------------------------------------------------------------

const BACKEND_URL = (() => {
  const v = process.env.BACKEND_URL;
  if (!v) { console.error('[WORKER] BACKEND_URL is required'); process.exit(1); }
  return v.replace(/\/$/, '');
})();

const WORKER_TOKEN = process.env.WORKER_TOKEN ?? '';
const POLL_INTERVAL_SEC = Number(process.env.POLL_INTERVAL_SEC ?? 15);
const STAGGER_SEC = Number(process.env.STAGGER_SEC ?? 45);
const JITTER_SEC = Number(process.env.JITTER_SEC ?? 20);
const REGISTER_STAGGER_SEC = Number(process.env.REGISTER_STAGGER_SEC ?? 120);
// throttleGuard: hard cap on registrations per UTC day. Once hit, the worker
// stops registering for the rest of the day (resets at 00:00 UTC).
const MAX_REG_PER_DAY = Number(process.env.MAX_REG_PER_DAY ?? 8);
// BOOKING_ONLY=1: skip pool top-up entirely — drive only ACTIVE accounts.
// Use when the pool is pre-built and you want a light booking-only run.
const BOOKING_ONLY = process.env.BOOKING_ONLY === '1';
// WORKER_MODE: 'book' (default) | 'pool_builder'
// pool_builder: continuously top up the account pool at REG_INTERVAL_MIN minutes/account,
// never drives/books. Run separately from the booking worker.
const WORKER_MODE = (process.env.WORKER_MODE ?? 'book') as 'book' | 'pool_builder';
// REG_INTERVAL_MIN: minutes between registrations in pool_builder mode (default: 10)
const REG_INTERVAL_MIN = Number(process.env.REG_INTERVAL_MIN ?? 10);
// Per-run lift-api request budget. Default is conservative (50/run).
// On budget exhaustion the Python child is killed and the account is cooled down.
// Set higher once you've confirmed your IP has more headroom.
const MAX_LIFT_REQUESTS = Number(process.env.MAX_LIFT_REQUESTS ?? 50);
// Rolling-window request rate limit: max requests in RATE_WINDOW_MS. Default 12/60s.
const RATE_WINDOW_MS = Number(process.env.RATE_WINDOW_MS ?? 60_000);
const RATE_WINDOW_MAX = Number(process.env.RATE_WINDOW_MAX ?? 12);
const PROFILE_ENCRYPTION_KEY = (() => {
  const v = process.env.PROFILE_ENCRYPTION_KEY;
  if (!v) { console.error('[WORKER] PROFILE_ENCRYPTION_KEY is required'); process.exit(1); }
  return v;
})();
// Auto-rotate: max 429001 swaps per driveRun() call. If we hit the cap,
// multiple accounts blocked quickly = likely an IP issue, not account issue.
const MAX_SWAPS_PER_RUN = Number(process.env.MAX_SWAPS_PER_RUN ?? 2);

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

// PYTHON_BIN may be "py -3.12" — split so spawn gets cmd + args separately
const _pythonRaw = (process.env.PYTHON_BIN ?? 'python').trim().split(/\s+/);
const PYTHON_BIN = _pythonRaw[0];
const PYTHON_EXTRA_ARGS = _pythonRaw.slice(1);

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
  detail?: string;
}

async function postMilestone(body: MilestoneBody): Promise<void> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (WORKER_TOKEN) headers['Authorization'] = `Bearer ${WORKER_TOKEN}`;
  // Retry on transient network failure (flaky worker↔backend link) so a blip
  // doesn't silently drop a state update. 3 attempts, 1s/2s/4s backoff.
  const MAX = 3;
  for (let attempt = 1; attempt <= MAX; attempt++) {
    try {
      const resp = await fetch(`${BACKEND_URL}/api/pipeline/event`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      if (resp.ok) return;
      // non-2xx (e.g. 401/400) won't fix on retry — log and stop
      log(`milestone POST ${body.step} → HTTP ${resp.status} (not retrying)`);
      return;
    } catch (e) {
      const last = attempt === MAX;
      log(`milestone POST ${body.step} failed (attempt ${attempt}/${MAX})${last ? ' — giving up' : ', retrying'}: ${(e as Error).message}`);
      if (last) return;
      await sleep(2 ** (attempt - 1) * 1000);
    }
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

// Outcome of a driven run: exit-derived result + the last milestone error (if any)
// so the caller can quarantine the account on rate-limit/block.
interface DriveOutcome {
  result: 'ok' | 'failed';
  error?: string;
}

interface DriveAccount {
  id: string;
  email: string;
  encryptedPassword: string;
  lifecycleState: string;
  profileIds: string[];
  pollingRole: string;
}

function spawnAndWatch(
  cmd: string,
  args: string[],
  env: Record<string, string>,
  ctx: SpawnCtx,
  budget?: { remaining: () => number; spend: () => void; rateOk: () => boolean },
): Promise<DriveOutcome> {
  return new Promise((resolve) => {
    // Track the last milestone error seen on stdout so the caller can classify
    // the run's failure mode (429001 / 429202 / block) and set a cooldown.
    let lastError: string | undefined;

    // --- settle guard: ensures we resolve exactly once even if pipes hang ------
    let settled = false;
    let watchdogTimer: ReturnType<typeof setTimeout> | undefined;

    function finish(outcome: DriveOutcome): void {
      if (settled) return;
      settled = true;
      if (watchdogTimer !== undefined) { clearTimeout(watchdogTimer); watchdogTimer = undefined; }
      clearInterval(stopPoller);
      resolve(outcome);
    }

    const child = spawn(cmd, args, {
      env: { ...process.env, ...env },
      // stdio must be pipe so we can parse stdout for MILESTONE lines
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // --- killChild: SIGTERM → hard tree-kill after 3s → watchdog at 6s ----------
    // Used by budget-rate, budget-exhausted, circuit-breaker, and stop paths.
    // On win32 taskkill /T kills inherited Chrome children, freeing the stdio pipe.
    function killChild(reason: string): void {
      if (settled) return; // already done, nothing to kill
      try { child.kill('SIGTERM'); } catch { /* already dead */ }

      // Hard tree-kill after ~3s if child is still alive
      setTimeout(() => {
        if (settled) return;
        if (process.platform === 'win32' && child.pid) {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        } else {
          try { child.kill('SIGKILL'); } catch { /* already dead */ }
        }
      }, 3_000);

      // Watchdog: if still not settled after 6s, force-resolve so the caller never hangs
      watchdogTimer = setTimeout(() => {
        if (settled) return;
        process.stdout.write(`  [WATCHDOG] child did not close within 6s (reason=${reason}) — forcing resolve\n`);
        finish({ result: 'failed', error: lastError ?? reason });
      }, 6_000);
    }

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
            if (ms['error']) lastError = ms['error'];
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
              detail: ms['detail'],
            });
          } catch { /* ignore parse errors */ }
        }
        // Count lift-api requests for budget tracking
        if (line.includes('LIFT-URL:') && budget) {
          budget.spend();
          const rem = budget.remaining();
          if (rem % 10 === 0 || rem <= 5) {
            process.stdout.write(`  [BUDGET] lift-api requests remaining: ${rem}\n`);
          }
          if (!budget.rateOk()) {
            process.stdout.write('  [BUDGET] rate limit reached — killing child\n');
            killChild('budget_rate_limit');
          } else if (rem <= 0) {
            process.stdout.write('  [BUDGET] per-run budget exhausted — killing child\n');
            killChild('budget_exhausted');
          }
        }
        // Circuit breaker: on first page-not-found / rate-limit milestone, kill immediately
        if (line.includes('MILESTONE') && (line.includes('rate_limit') || line.includes('datadome_block') || line.includes('login_failed'))) {
          process.stdout.write('  [CIRCUIT-BREAKER] block/rate-limit detected — killing child immediately\n');
          killChild(lastError ?? 'circuit_breaker');
        }
      }
    });

    child.stderr.on('data', (chunk: string) => process.stderr.write(String(chunk)));

    // Poll DB every 9s for a 'stopping' signal from the operator; kill the child when found.
    const stopPoller = setInterval(() => {
      prisma.settings.findUnique({ where: { key: 'scenario_run' } }).then((row) => {
        const r = row?.value as ScenarioRun | null;
        if (r && (r.status === 'stopping' || r.status === 'stopped')) {
          log(`[stop] signal for run ${ctx.runId} — sending SIGTERM to Python child`);
          clearInterval(stopPoller);
          killChild('operator_stop');
        }
      }).catch(() => { /* DB blip — keep polling */ });
    }, 9_000);

    // Resolve as soon as the process exits — exit fires even if stdio pipes are
    // still held open by grandchildren (e.g. Chrome inheriting the stdout pipe).
    child.on('exit', (code) => {
      finish({ result: code === 0 ? 'ok' : 'failed', error: lastError });
    });

    // close fires after all stdio streams are flushed — also resolves (idempotent).
    child.on('close', (code) => {
      finish({ result: code === 0 ? 'ok' : 'failed', error: lastError });
    });
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
// driveAccountReal — spawns auto_pipeline.py (exact env from local-runner.ts)
// ---------------------------------------------------------------------------

async function driveAccountReal(
  runId: string,
  acct: DriveAccount,
): Promise<DriveOutcome> {
  let password = '';
  try {
    password = decryptField(acct.encryptedPassword);
  } catch (e) {
    log(`skip ${acct.email}: password decrypt failed — ${(e as Error).message}`);
    return { result: 'failed', error: 'password_decrypt_failed' };
  }
  if (!password) {
    log(`skip ${acct.email}: empty password after decrypt`);
    return { result: 'failed', error: 'password_empty' };
  }

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
    MONITOR_INTERVAL: process.env.MONITOR_INTERVAL ?? '30',
    // API_MONITOR_INTERVAL: interval for the cheap in-browser API path. Hard-pinned
    // to 30s here so a large MONITOR_INTERVAL in the Railway env (used for the slow
    // UI path) does not stall the fast API poll cycle. Override via env if needed.
    API_MONITOR_INTERVAL: process.env.API_MONITOR_INTERVAL ?? '30',
    BOOK_ENABLED: bookEnabled,
    BOOK_DRY_RUN: process.env.BOOK_DRY_RUN ?? '',
    WORKER_BRIDGED: '1',
    // Explicit pass-through so Python subprocess gets these even if process.env
    // inheritance is somehow stripped (e.g. stripped-env shells, Docker).
    MAILSAC_API_KEY: process.env.MAILSAC_API_KEY ?? '',
  };

  // Only pass SUBCAT when explicitly set — an empty value makes Python's
  // re.compile('') match EVERY subcategory. Unset = Python's Work-D default.
  if (process.env.SUBCAT && process.env.SUBCAT.trim()) {
    spawnEnv['SUBCAT'] = process.env.SUBCAT.trim();
  }
  if (process.env.PROVE_OCMA) {
    spawnEnv['PROVE_OCMA'] = process.env.PROVE_OCMA;
  }

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

    // Write decrypted passport BIO-page image to a temp file so Python uploads the correct scan.
    if (profile.passportImageEnc) {
      try {
        const imageBase64 = decryptField(profile.passportImageEnc);
        const cacheDir = path.join(__dirname, '..', '.passport-cache');
        if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
        const imagePath = path.join(cacheDir, `${profile.id}.png`);
        fs.writeFileSync(imagePath, Buffer.from(imageBase64, 'base64'));
        spawnEnv['PASSPORT_IMAGE'] = imagePath;
        log(`passport image written to ${imagePath}`);
      } catch (imgErr) {
        log(`WARN: failed to write passport image for profile ${profile.id}: ${(imgErr as Error).message}`);
        // PASSPORT_IMAGE left unset — Python falls back to its default hardcoded path
      }
    }
  }

  log(`driving ${acct.email} (role=${acct.pollingRole}, profile=${profile?.fullName ?? 'NONE'}, book=${bookEnabled === '1'})`);

  const budget = makeBudget();
  log(`request budget: max=${MAX_LIFT_REQUESTS}/run, rate=${RATE_WINDOW_MAX}/${RATE_WINDOW_MS / 1000}s`);
  return spawnAndWatch(PYTHON_BIN, [...PYTHON_EXTRA_ARGS, PIPELINE_SPIKE], spawnEnv, {
    runId,
    email: acct.email,
    accountId: acct.id,
    fromState: acct.lifecycleState,
  }, budget);
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

// throttleGuard: registerOne's outcome. `ok` carries the created account; on
// failure it carries the raw signals (final URL / body / error) so the caller
// can classify the throttle and back off accordingly.
interface RegisterOutcome {
  ok: { email: string; status: string } | null;
  signals: { url?: string; bodyText?: string; error?: string };
}

/** Returns the created account (ok) on success plus the raw throttle signals for the caller to classify. */
async function registerOne(runId: string): Promise<RegisterOutcome> {
  if (!process.env.MAILSAC_API_KEY) {
    log('WARN MAILSAC_API_KEY not set — account will register but not auto-activate (status PENDING)');
  }

  // Notify operator in real-time BEFORE the synchronous 5-minute blocking call.
  const { sendTelegram: tg } = await import('../src/modules/notifications/telegram.bot');
  await tg('🔄 Registering new Mailsac account...').catch(() => {});

  log('spawning register_spike.py…');
  const res = spawnSync(PYTHON_BIN, [...PYTHON_EXTRA_ARGS, REGISTER_SPIKE], {
    env: { ...process.env, PYTHONUTF8: '1', WORKER_BRIDGED: '1' },
    encoding: 'utf-8',
    timeout: 5 * 60 * 1000,
  });

  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  out.split(/\r?\n/).filter(Boolean).forEach((l) => console.log('  ' + l));

  // Parse [REG] RESULT: {...} line and persist to DB FIRST — milestone forwarding
  // must happen AFTER account creation so the pipeline endpoint can resolve the email.
  const crashed = /Traceback \(most recent call last\)|SyntaxError|ModuleNotFoundError/.test(out);
  const rm = out.match(/\[REG\]\s+RESULT:\s+(\{.*\})\s*$/m);
  if (!rm) {
    const reason = crashed ? 'register_spike CRASHED' : 'no RESULT line — throttled or failed';
    log(reason);
    await tg(`❌ Registration failed: ${reason}`).catch(() => {});
    // throttleGuard: a missing RESULT line usually means a page-not-found bounce
    // or throttle — pass the raw spike output as bodyText so the caller can classify.
    return { ok: null, signals: { bodyText: out } };
  }

  let result: RegResult;
  try {
    result = JSON.parse(rm[1]) as RegResult;
  } catch (e) {
    log('could not parse RESULT json:', (e as Error).message);
    await tg(`❌ Registration failed: RESULT parse error`).catch(() => {});
    return { ok: null, signals: { error: 'result_parse_error' } };
  }

  if (!result.registered) {
    log(`did NOT register. result=${JSON.stringify(result)}`);
    await tg(`❌ Registration not confirmed: ${result.error ?? 'unknown'}`).catch(() => {});
    // throttleGuard: surface the spike's error (e.g. "form_not_rendered") for classification.
    return { ok: null, signals: { error: result.error, bodyText: out } };
  }

  const status = result.activated ? 'ACTIVE' : 'PENDING';
  let outcome: { email: string; status: string } | null = null;
  try {
    await prisma.vfsAccount.create({
      data: {
        email: result.email,
        encryptedPassword: encryptField(result.password),
        phone: result.phone,
        status,
        profileIds: [],
      },
    });
    log(`persisted ${result.email} → status=${status} (activated=${result.activated})`);
    outcome = { email: result.email, status };

    // Now that the account exists, forward progress milestones from the spike output.
    // Skip 'registered' and 'activation_visited' — those are posted explicitly below
    // (with toState for proper lifecycle state updates).
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^MILESTONE\s+(\{.*\})\s*$/);
      if (m) {
        try {
          const ms = JSON.parse(m[1]) as Record<string, string>;
          if (ms['step'] === 'registered' || ms['step'] === 'activation_visited') continue;
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

    // Post the authoritative registered milestone (with toState for lifecycle).
    await postMilestone({
      runId,
      email: result.email,
      step: 'registered',
      toState: result.activated ? 'ACTIVE' : 'PENDING_ACTIVATION',
      status: 'ok',
    });

    // Activate it via the backend+extension (the worker has no extension WS).
    // On success the backend flips it to ACTIVE in the DB → the login phase
    // below picks it up → create → activate → login flows in one run.
    if (status === 'PENDING') {
      try {
        log(`requesting activation for ${result.email} via backend/extension…`);
        const resp = await fetch(`${BACKEND_URL}/api/pipeline/reconcile`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(WORKER_TOKEN ? { Authorization: `Bearer ${WORKER_TOKEN}` } : {}) },
          body: JSON.stringify({ email: result.email }),
        });
        const j = (await resp.json().catch(() => ({}))) as { ok?: boolean; result?: string };
        log(`activation result for ${result.email}: ${JSON.stringify(j)}`);
        if (j.ok) {
          await postMilestone({ runId, email: result.email, step: 'activation_visited', toState: 'ACTIVE', status: 'ok' });
        } else {
          await postMilestone({ runId, email: result.email, step: 'failed', toState: 'PENDING_ACTIVATION', status: 'fail', error: `activation_failed:${j.result ?? 'unknown'}` });
        }
      } catch (e) {
        log(`activation request failed for ${result.email}:`, (e as Error).message);
      }
    }
  } catch (e) {
    log(`DB persist failed for ${result.email}:`, (e as Error).message);
    outcome = null;
  }
  // throttleGuard: persist/DB failure is NOT a throttle — return ok with no signals.
  return { ok: outcome, signals: {} };
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
// findReadySpare — returns the best unlinked ACTIVE spare account for rotation.
// "Ready" = ACTIVE, not BLOCKED/BOOKED lifecycle, no active cooldown, no client linked.
// Orders by lastAttemptAt asc (least recently touched = freshest).
// ---------------------------------------------------------------------------

async function findReadySpare(excludeId: string): Promise<DriveAccount | null> {
  const now = new Date();
  return prisma.vfsAccount.findFirst({
    where: {
      id: { not: excludeId },
      status: 'ACTIVE',
      lifecycleState: { notIn: ['BLOCKED', 'BOOKED'] },
      profileIds: { isEmpty: true },
      OR: [{ cooldownUntil: null }, { cooldownUntil: { lte: now } }],
    },
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
}

// ---------------------------------------------------------------------------
// writeSpareCredentials — write ACTIVE+unlinked account credentials to
// nodriver-spike/.spare-credentials.json so auto_pipeline.py can log in a
// spare account inline when the pool has no pre-authed token available.
// Called after every pool top-up check so the file is always fresh.
// ---------------------------------------------------------------------------

const SPARE_CREDS_FILE = path.resolve(__dirname, '..', '..', 'nodriver-spike', '.spare-credentials.json');

async function writeSpareCredentials(): Promise<void> {
  try {
    const rows = await prisma.vfsAccount.findMany({
      where: {
        status: 'ACTIVE',
        profileIds: { isEmpty: true },
        lifecycleState: { notIn: ['BLOCKED', 'BOOKED', 'RESTRICTED'] },
      },
      select: { email: true, encryptedPassword: true },
      orderBy: { lastAttemptAt: 'asc' },
    });

    const creds: Array<{ email: string; password: string }> = [];
    for (const row of rows) {
      try {
        const password = decryptField(row.encryptedPassword);
        if (password) creds.push({ email: row.email, password });
      } catch {
        // Skip accounts whose password can't be decrypted — Python can't use them.
      }
    }

    const tmp = SPARE_CREDS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(creds, null, 2), 'utf-8');
    fs.renameSync(tmp, SPARE_CREDS_FILE);
    log(`spare-creds: wrote ${creds.length} ACTIVE+unlinked credential(s) to .spare-credentials.json`);
  } catch (e) {
    log(`WARN: writeSpareCredentials failed (non-fatal): ${(e as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Per-run request budget factory
// ---------------------------------------------------------------------------

function makeBudget(): { remaining: () => number; spend: () => void; rateOk: () => boolean } {
  let spent = 0;
  const windowTimestamps: number[] = [];
  return {
    remaining: () => Math.max(0, MAX_LIFT_REQUESTS - spent),
    spend: () => {
      spent++;
      const now = Date.now();
      windowTimestamps.push(now);
      // Trim timestamps outside the rolling window
      while (windowTimestamps.length > 0 && now - windowTimestamps[0] > RATE_WINDOW_MS) {
        windowTimestamps.shift();
      }
    },
    rateOk: () => {
      const now = Date.now();
      const recentCount = windowTimestamps.filter(t => now - t <= RATE_WINDOW_MS).length;
      return recentCount < RATE_WINDOW_MAX;
    },
  };
}

// ---------------------------------------------------------------------------
// driveRun — main run orchestration
// ---------------------------------------------------------------------------

async function driveRun(runId: string): Promise<void> {
  log(`driveRun start. runId=${runId}`);

  // Let previously cooled accounts recover without relying on a separate backend
  // sweep; the live VPS worker owns this path.
  await prisma.vfsAccount.updateMany({
    where: {
      status: 'COOLDOWN',
      cooldownUntil: { lte: new Date() },
    },
    data: {
      status: 'ACTIVE',
      lifecycleState: 'ACTIVE',
      cooldownUntil: null,
      restrictedReason: null,
    },
  });

  // 1. Pool top-up. POOL_MIN=0 disables registration entirely (e.g. when the
  // extension isn't up to activate new ones and only existing accounts are used).
  // BOOKING_ONLY still enforces a minimum of 1 spare so the auto-rotate path
  // always has a replacement ready when an account hits a 429001 block.
  const poolMin = BOOKING_ONLY ? Math.max(1, Number(process.env.POOL_MIN ?? 1)) : Number(process.env.POOL_MIN ?? 2);
  if (BOOKING_ONLY) log(`BOOKING_ONLY mode — pool top-up limited to POOL_MIN=${poolMin} spare(s) (rotate-ready buffer)`);
  const registered: Array<{ email: string; status: string }> = [];
  if (poolMin > 0) {
    const spare = await spareCount();
    if (spare < poolMin) {
      const need = poolMin - spare;
      log(`pool top-up: spare=${spare} < min=${poolMin}, registering ${need} account(s)`);

      // throttleGuard: in-run daily-cap + backoff state. dailyReg persists only
      // for the life of this run (good enough — runs are short and the cap mainly
      // protects a single hammering loop). consecutiveThrottles drives backoff.
      let dailyReg: DailyRegState = { dayKey: new Date().toISOString().slice(0, 10), count: 0 };
      let consecutiveThrottles = 0;

      for (let i = 0; i < need; i++) {
        // throttleGuard: stop registering once the daily cap is hit.
        if (!canRegisterNow(dailyReg, MAX_REG_PER_DAY, new Date())) {
          log(`register: daily cap ${MAX_REG_PER_DAY} reached (count=${dailyReg.count}) — skipping remaining ${need - i} registration(s)`);
          break;
        }

        const reg = await registerOne(runId);
        if (reg.ok) {
          registered.push(reg.ok);
          dailyReg = recordRegistration(dailyReg, new Date());
          consecutiveThrottles = 0; // success resets the backoff ramp
        }

        // throttleGuard: classify the attempt's signals. On a throttle, back off
        // exponentially (instead of the fixed stagger) so we stop deepening the block.
        const kind = classifyThrottle(reg.signals);
        if (isThrottled(kind)) {
          consecutiveThrottles += 1;
          const backoff = nextBackoffMs(consecutiveThrottles - 1, 60_000, 3_600_000, 0.2, Math.random);
          log(`register: THROTTLED (${kind}, streak=${consecutiveThrottles}) — backing off ${Math.ceil(backoff / 1000)}s before next attempt`);
          await sleep(backoff);
          continue; // skip the fixed stagger; backoff already waited
        }

        // Normal (non-throttled) stagger between registrations.
        if (i < need - 1) {
          const jitter = Math.floor(Math.random() * 30);
          log(`register stagger: waiting ${REGISTER_STAGGER_SEC + jitter}s`);
          await sleep((REGISTER_STAGGER_SEC + jitter) * 1000);
        }
      }
    } else {
      log(`pool ok: spare=${spare} ACTIVE+unlinked accounts`);
    }
    // Always refresh .spare-credentials.json after pool check so auto_pipeline.py
    // can log in an unlinked spare inline when the pool has no pre-authed token.
    await writeSpareCredentials();
  }

  // 1b. Wait for any just-registered PENDING accounts to flip ACTIVE (up to 3 min).
  //     This makes a single "Start Scenario" click drive register→activate→login→book
  //     in one run without a second click. The wait is bounded so it never hangs.
  const pendingRegistered = registered.filter((r) => r.status === 'PENDING');
  if (pendingRegistered.length > 0) {
    const WAIT_CAP_MS = 3 * 60 * 1000; // 3-minute cap
    const POLL_MS = 12_000;             // poll every 12s
    const deadline = Date.now() + WAIT_CAP_MS;
    log(`waiting up to ${WAIT_CAP_MS / 1000}s for ${pendingRegistered.length} PENDING account(s) to activate…`);
    const stillPending = new Set(pendingRegistered.map((r) => r.email));

    while (stillPending.size > 0 && Date.now() < deadline) {
      // Respect stop signal — abort if operator clicked Stop.
      const stopRow = await prisma.settings.findUnique({ where: { key: 'scenario_run' } });
      const stopRun = stopRow?.value as ScenarioRun | null;
      if (stopRun && (stopRun.status === 'stopping' || stopRun.status === 'stopped')) {
        log('stop requested during activation wait — aborting');
        return;
      }

      await sleep(POLL_MS);

      for (const email of [...stillPending]) {
        const row = await prisma.vfsAccount.findUnique({ where: { email }, select: { status: true } });
        if (row?.status === 'ACTIVE') {
          log(`${email} activated ✓`);
          stillPending.delete(email);
        } else {
          log(`${email} still ${row?.status ?? 'unknown'} (${Math.ceil((deadline - Date.now()) / 1000)}s remaining)`);
        }
      }
    }

    // Emit a clear warning for any account that didn't activate in time.
    if (stillPending.size > 0) {
      const { sendTelegram: tg } = await import('../src/modules/notifications/telegram.bot');
      for (const email of stillPending) {
        log(`activation did not complete in time for ${email} — proceeding without it`);
        await postMilestone({ runId, email, step: 'failed', status: 'fail', error: 'activation_timeout' });
        await tg(`⏱ Activation timed out for ${email} — not driving this account in the current run`).catch(() => {});
      }
    }
  }

  // 2. Load timings for pacer
  const timings = await loadAccountTimings();
  const now = Date.now();

  // 3. Load ACTIVE accounts for login → monitor → book
  // RUN_LIMIT caps how many accounts a run drives — prevents touching the whole
  // pool at once. 0/unset = no cap.
  const runLimit = Number(process.env.RUN_LIMIT ?? 0);
  // TARGET_EMAIL pins the run to one specific account.
  const targetEmail = process.env.TARGET_EMAIL?.trim();
  const accounts: DriveAccount[] = await prisma.vfsAccount.findMany({
    // Exclude already-BOOKED accounts so a successful booking is never re-driven
    // (no double-book, no wasted requests on a client that's already done).
    // Default mode: only drive accounts that hold a client profile (profileIds non-empty).
    // This keeps idle unlinked spares resting, and auto-rotate continues seamlessly —
    // when a blocked account's profileIds are moved to a spare (rotate logic above),
    // the spare is queued into this same run after the normal stagger.
    where: targetEmail
      ? { status: 'ACTIVE', email: targetEmail, lifecycleState: { not: 'BOOKED' } }
      : { status: 'ACTIVE', lifecycleState: { not: 'BOOKED' }, profileIds: { isEmpty: false } },
    select: {
      id: true,
      email: true,
      encryptedPassword: true,
      lifecycleState: true,
      profileIds: true,
      pollingRole: true,
    },
    orderBy: { lastAttemptAt: 'asc' },
    ...(runLimit > 0 ? { take: runLimit } : {}),
  });

  log(`account selection: mode=${targetEmail ? `pinned(${targetEmail})` : 'linked-profile'} found=${accounts.length}`);

  if (accounts.length === 0) {
    log('no ACTIVE accounts to drive — run complete');
    return;
  }

  log(`driving ${accounts.length} ACTIVE account(s) (paced, staggered)`);

  let lastAction = 0;
  let lastGlobalAction: number | null = null;
  // Auto-rotate guardrail: count 429001 swaps in this run.
  // If we exceed MAX_SWAPS_PER_RUN, stop swapping (likely an IP problem).
  let swapCount = 0;

  for (let accountIndex = 0; accountIndex < accounts.length; accountIndex++) {
    const acct = accounts[accountIndex];
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

    // Check stop signal before driving each account (catches stop between accounts).
    {
      const stopRow = await prisma.settings.findUnique({ where: { key: 'scenario_run' } });
      const stopRun = stopRow?.value as ScenarioRun | null;
      if (stopRun && (stopRun.status === 'stopping' || stopRun.status === 'stopped')) {
        log(`stop requested — aborting run before driving ${acct.email}`);
        return;
      }
    }

    const outcome = await driveAccountReal(runId, {
      id: acct.id,
      email: acct.email,
      encryptedPassword: acct.encryptedPassword,
      lifecycleState: acct.lifecycleState as string,
      profileIds: acct.profileIds,
      pollingRole: acct.pollingRole,
    });

    // Auto-quarantine: record the run outcome on the account so the pacer and
    // account selection skip it until cooldownUntil passes. No manual TARGET_EMAIL
    // swapping needed: the worker rotates to other due accounts.
    try {
      const at = Date.now();
      const err = outcome.error ?? '';
      let cooldownUntil: Date | null = null;
      let reason = '';
      if (/429001/.test(err)) {
        cooldownUntil = new Date(at + PACER_CFG.cooldown429001Ms);
        reason = '429001';
      } else if (/429202/.test(err)) {
        cooldownUntil = new Date(at + PACER_CFG.cooldown429202Ms);
        reason = '429202';
      } else if (err && /session_expired|datadome|turnstile|login_failed|page_not_found|block/i.test(err)) {
        cooldownUntil = new Date(at + 30 * 60 * 1000); // short 30-min backoff, recovers soon
        reason = err;
      }

      // ---------------------------------------------------------------------------
      // Auto-rotate on 429001 (account block) — ONLY on 429001.
      // 429202 / datadome / IP blocks must NOT trigger a swap because swapping
      // accounts cannot fix an IP-level problem and only adds more requests.
      // ---------------------------------------------------------------------------
      if (reason === '429001' && acct.profileIds.length > 0) {
        const { sendTelegram: tg } = await import('../src/modules/notifications/telegram.bot');

        if (swapCount >= MAX_SWAPS_PER_RUN) {
          // Cap hit — multiple account blocks in one run signals an IP-level issue.
          const msg = `⚠️ Auto-rotate cap (${MAX_SWAPS_PER_RUN}) reached in one run — multiple 429001 blocks. Likely an IP issue. Stopping rotation, pausing all accounts.`;
          log(msg);
          await tg(msg).catch(() => {});
        } else {
          const spare = await findReadySpare(acct.id);

          if (spare) {
            // Single atomic transaction: move profileIds to spare, quarantine blocked.
            await prisma.$transaction([
              prisma.vfsAccount.update({
                where: { id: spare.id },
                data: { profileIds: acct.profileIds, lastAttemptAt: null },
              }),
              prisma.vfsAccount.update({
                where: { id: acct.id },
                data: {
                  status: 'COOLDOWN',
                  profileIds: [],
                  lifecycleState: 'RESTRICTED',
                  restrictedReason: '429001',
                  cooldownUntil: new Date(at + PACER_CFG.cooldown429001Ms),
                  lastAttemptAt: new Date(at),
                },
              }),
            ]);

            swapCount += 1;
            const msg = `♻️ Account ${acct.email} blocked (429001) — client moved to spare ${spare.email}, booking continues (swap ${swapCount}/${MAX_SWAPS_PER_RUN}).`;
            log(msg);
            await tg(msg).catch(() => {});

            // Re-drive approach: the spare is now ACTIVE + linked. Queue it for
            // this same driveRun(); the normal global gap/stagger above still
            // applies before the next spawn, so rotation is not immediate.
            accounts.push({ ...spare, profileIds: acct.profileIds, lifecycleState: 'ACTIVE' });
            log(`spare ${spare.email} is now linked — queued for this run`);

            // Update cooldownUntil is already set in the transaction above; skip the
            // normal update below to avoid overwriting it.
            continue;
          } else {
            // No spare available — keep old behavior + alert.
            const profileDesc = acct.profileIds.join(', ');
            const msg = `⚠️ Account ${acct.email} blocked (429001), NO ready spare for client [${profileDesc}] — registering replacement in background (pool top-up).`;
            log(msg);
            await tg(msg).catch(() => {});
            // Fall through to normal cooldown update below.
          }
        }
      }

      await prisma.vfsAccount.update({
        where: { id: acct.id },
        data: reason === '429001'
          ? {
              status: 'COOLDOWN',
              lifecycleState: 'RESTRICTED',
              restrictedReason: '429001',
              lastAttemptAt: new Date(at),
              cooldownUntil,
            }
          : { lastAttemptAt: new Date(at), cooldownUntil },
      });

      if (cooldownUntil) {
        const mins = Math.round((cooldownUntil.getTime() - at) / 60000);
        log(`quarantine ${acct.email}: cooldown ${mins}m (reason=${reason})`);
      } else {
        log(`${acct.email}: ok, cooldown cleared`);
      }
    } catch (e) {
      log(`WARN: failed to record outcome for ${acct.email}: ${(e as Error).message}`);
    }
  }

  log(`driveRun complete. runId=${runId}`);
}

// ---------------------------------------------------------------------------
// runPoolBuilder — paced account registration loop (WORKER_MODE=pool_builder)
// Tops up the pool slowly, one account every REG_INTERVAL_MIN minutes.
// Never drives or books — keeps registration traffic well under the IP limit.
// ---------------------------------------------------------------------------

async function runPoolBuilder(): Promise<void> {
  log(`Pool-builder mode: target POOL_MIN=${process.env.POOL_MIN ?? 2}, interval=${REG_INTERVAL_MIN}min/account`);
  const poolMin = Number(process.env.POOL_MIN ?? 2);
  let dailyReg: DailyRegState = { dayKey: new Date().toISOString().slice(0, 10), count: 0 };
  for (;;) {
    const spare = await spareCount();
    log(`pool-builder: spare=${spare} ACTIVE+unlinked (target=${poolMin})`);
    if (spare >= poolMin) {
      log(`pool-builder: pool is full — sleeping ${REG_INTERVAL_MIN}min`);
      await sleep(REG_INTERVAL_MIN * 60 * 1000);
      continue;
    }
    if (!canRegisterNow(dailyReg, MAX_REG_PER_DAY, new Date())) {
      log(`pool-builder: daily cap ${MAX_REG_PER_DAY} reached — sleeping until next UTC day`);
      const msUntilMidnight = new Date(new Date().toISOString().slice(0, 10) + 'T24:00:00Z').getTime() - Date.now();
      await sleep(Math.max(msUntilMidnight, 60_000));
      dailyReg = { dayKey: new Date().toISOString().slice(0, 10), count: 0 };
      continue;
    }
    const reg = await registerOne('pool-builder');
    if (reg.ok) {
      dailyReg = recordRegistration(dailyReg, new Date());
      log(`pool-builder: registered ${reg.ok.email} (status=${reg.ok.status})`);
    } else {
      log(`pool-builder: registration failed — backing off 5min`);
      await sleep(5 * 60 * 1000);
      continue;
    }
    log(`pool-builder: waiting ${REG_INTERVAL_MIN}min before next registration`);
    await sleep(REG_INTERVAL_MIN * 60 * 1000);
  }
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
  /** requested → running → stopping → stopped (terminal)
   *  OR requested → running → completed / failed */
  status: string;
  completedAt?: string;
  claimedAt?: string; // when a worker marked it 'running' — used for stale reclaim
  stoppingAt?: string;
}

// A 'running' run whose claimedAt is older than this with no completion is
// assumed orphaned (claimer crashed/killed) and is reclaimed by the next worker.
const STALE_RUN_MS = 90_000;

// DB-backed single-instance lock. A worker that hasn't updated its heartbeat
// within this window is assumed dead and the lock is stolen.
// Each box holds its OWN lock when BOX_ID is set, so two boxes don't refuse each other.
// Default (no BOX_ID) = 'worker_lock' — unchanged single-box behavior.
const WORKER_LOCK_KEY = process.env.BOX_ID ? `worker_lock_${process.env.BOX_ID}` : 'worker_lock';
const WORKER_LOCK_HEARTBEAT_MS = 30_000;  // write heartbeat every 30s
const WORKER_LOCK_STALE_MS = 120_000;    // 120s — 4× heartbeat interval; stale = dead
const FORCE_START = process.argv.includes('--force');

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

// Single-instance lock — prevents multiple workers racing on the same run
// (which orphaned runs into a stuck 'running' state). Returns false if another
// live worker holds the lock.
const LOCK_FILE = path.join(os.tmpdir(), 'vfs-orchestrator-worker.lock');
function acquireSingleInstanceLock(): boolean {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const otherPid = Number(fs.readFileSync(LOCK_FILE, 'utf-8').trim());
      if (otherPid && otherPid !== process.pid) {
        try { process.kill(otherPid, 0); return false; } // 0 = alive-check; no throw = alive
        catch { /* stale lock — owner is dead, take it over */ }
      }
    }
    fs.writeFileSync(LOCK_FILE, String(process.pid));
    const release = () => { try { if (fs.existsSync(LOCK_FILE) && Number(fs.readFileSync(LOCK_FILE, 'utf-8').trim()) === process.pid) fs.unlinkSync(LOCK_FILE); } catch { /* ignore */ } };
    process.on('exit', release);
    return true;
  } catch {
    return true; // lock errors shouldn't block the worker
  }
}

// On worker (re)start, finalize a stuck run left by a dead/old worker:
//  - a 'stopping' run that no live worker will ever finalize → mark 'stopped'.
//  - a stale 'running' run (claimedAt older than STALE_RUN_MS) is left for the
//    normal reclaim path below; we only hard-clear 'stopping' here.
async function clearOrphanedRunOnStartup(): Promise<void> {
  try {
    const row = await prisma.settings.findUnique({ where: { key: 'scenario_run' } });
    const run = row?.value as ScenarioRun | null;
    if (run && run.status === 'stopping') {
      log(`startup: found orphaned 'stopping' run ${run.runId} — finalizing to 'stopped'`);
      await prisma.settings.update({
        where: { key: 'scenario_run' },
        data: {
          value: {
            ...run,
            status: 'stopped',
            completedAt: new Date().toISOString(),
          } as unknown as Parameters<typeof prisma.settings.update>[0]['data']['value'],
        },
      });
    }
  } catch (e) {
    log('startup orphan-clear failed (non-fatal):', (e as Error).message);
  }
}

interface WorkerLock {
  pid: number;
  startedAt: string;
  heartbeatAt: string;
}

async function acquireWorkerLock(): Promise<boolean> {
  if (FORCE_START) {
    log('--force flag: skipping worker-lock check');
    return true;
  }
  try {
    const row = await prisma.settings.findUnique({ where: { key: WORKER_LOCK_KEY } });
    const existing = row?.value as WorkerLock | null;
    if (existing) {
      const age = Date.now() - new Date(existing.heartbeatAt).getTime();
      if (age < WORKER_LOCK_STALE_MS && existing.pid !== process.pid) {
        log(`REFUSED: another worker is running (pid=${existing.pid}, heartbeat ${Math.round(age / 1000)}s ago). Use --force to override.`);
        return false;
      }
      if (age >= WORKER_LOCK_STALE_MS) {
        log(`Stealing stale worker lock (pid=${existing.pid}, heartbeat ${Math.round(age / 1000)}s ago — stale)`);
      }
    }
    const now = new Date().toISOString();
    const lockVal: WorkerLock = { pid: process.pid, startedAt: now, heartbeatAt: now };
    await prisma.settings.upsert({
      where: { key: WORKER_LOCK_KEY },
      update: { value: lockVal as unknown as Parameters<typeof prisma.settings.upsert>[0]['update']['value'] },
      create: { key: WORKER_LOCK_KEY, value: lockVal as unknown as Parameters<typeof prisma.settings.create>[0]['data']['value'] },
    });
    log(`Worker lock acquired (pid=${process.pid})`);
    return true;
  } catch (e) {
    log('Worker lock DB error (proceeding anyway):', (e as Error).message);
    return true; // DB errors must not block the worker
  }
}

async function releaseWorkerLock(): Promise<void> {
  try {
    const row = await prisma.settings.findUnique({ where: { key: WORKER_LOCK_KEY } });
    const existing = row?.value as WorkerLock | null;
    if (existing?.pid === process.pid) {
      await prisma.settings.delete({ where: { key: WORKER_LOCK_KEY } }).catch(() => {});
      log('Worker lock released');
    }
  } catch { /* ignore — we're exiting anyway */ }
}

async function main(): Promise<void> {
  // NOTE: single-instance protection is handled by the stale-run reclaim (a
  // crashed claimer's run is auto-reclaimed) + operational discipline (run one
  // worker). The file-lock was removed: under `npx tsx` the process tree spawns
  // sibling node procs that falsely tripped the lock on each other.
  void acquireSingleInstanceLock; // retained for reference; intentionally not gating

  // DB-backed single-instance lock — prevents zombie pile-ups that burn the IP.
  const lockAcquired = await acquireWorkerLock();
  if (!lockAcquired) {
    await prisma.$disconnect();
    process.exit(1);
  }
  log(`Orchestrator worker starting. BACKEND_URL=${BACKEND_URL} POLL_INTERVAL_SEC=${POLL_INTERVAL_SEC}`);

  process.on('SIGINT', () => {
    log('SIGINT — shutting down');
    void (async () => {
      await releaseWorkerLock();
      await prisma.$disconnect();
      process.exit(0);
    })();
  });
  process.on('SIGTERM', () => {
    log('SIGTERM — shutting down');
    void (async () => {
      await releaseWorkerLock();
      await prisma.$disconnect();
      process.exit(0);
    })();
  });

  // Heartbeat: prove the engine is alive so the dashboard can show Engine 🟢/🔴.
  // Runs on its OWN interval (not in the poll loop) because the loop blocks inside
  // driveRun for long stretches during monitoring — a loop-driven heartbeat would
  // go stale (engine wrongly shows offline) for the whole active run. (Task 1.)
  const writeHeartbeat = () => prisma.settings.upsert({
    where: { key: 'worker_heartbeat' },
    update: { value: { at: new Date().toISOString() } as unknown as Parameters<typeof prisma.settings.update>[0]['data']['value'] },
    create: { key: 'worker_heartbeat', value: { at: new Date().toISOString() } as unknown as Parameters<typeof prisma.settings.create>[0]['data']['value'] },
  }).catch(() => { /* heartbeat write must never crash the worker */ });
  await writeHeartbeat();
  const heartbeatTimer = setInterval(() => { void writeHeartbeat(); }, POLL_INTERVAL_SEC * 1000);
  process.on('exit', () => clearInterval(heartbeatTimer));

  const writeLockHeartbeat = () => prisma.settings.findUnique({ where: { key: WORKER_LOCK_KEY } }).then((row) => {
    const existing = row?.value as WorkerLock | null;
    if (existing?.pid === process.pid) {
      const heartbeatAt = new Date().toISOString();
      return prisma.settings.update({
        where: { key: WORKER_LOCK_KEY },
        data: { value: { ...existing, heartbeatAt } as unknown as Parameters<typeof prisma.settings.update>[0]['data']['value'] },
      }).catch((err: unknown) => { log(`WARN: lock heartbeat write failed: ${(err as Error).message}`); });
    }
  }).catch(() => {});
  const lockHeartbeatTimer = setInterval(() => { void writeLockHeartbeat(); }, WORKER_LOCK_HEARTBEAT_MS);
  process.on('exit', () => clearInterval(lockHeartbeatTimer));

  // On startup, clear any orphaned 'stopping' run or stale 'running' run left
  // behind by a previously-killed/old worker — so a (re)started worker never
  // ignores a stuck stop. (Task 2: self-clearing stop.)
  await clearOrphanedRunOnStartup();

  if (WORKER_MODE === 'pool_builder') {
    log(`Starting in pool_builder mode (REG_INTERVAL_MIN=${REG_INTERVAL_MIN}, POOL_MIN=${process.env.POOL_MIN ?? 2}, MAX_REG_PER_DAY=${MAX_REG_PER_DAY})`);
    await runPoolBuilder(); // runs forever (or until SIGINT/SIGTERM)
    return;
  }

  for (;;) {
    try {
      // Poll Settings for scenario_run
      const row = await prisma.settings.findUnique({ where: { key: 'scenario_run' } });
      const run = row?.value as ScenarioRun | null;

      // Reclaim a stale 'running' run (claimer crashed/killed mid-drive).
      const isStaleRunning =
        run && run.status === 'running' &&
        (!run.claimedAt || Date.now() - new Date(run.claimedAt).getTime() > STALE_RUN_MS);

      // Orphaned 'stopping' run reaching the poll loop means no driveRun is
      // actively finalizing it in THIS worker (an active drive would be blocked
      // inside driveRun and never reach this line). Finalize it so the UI clears.
      if (run && run.status === 'stopping') {
        log(`poll: orphaned 'stopping' run ${run.runId} — finalizing to 'stopped'`);
        await prisma.settings.update({
          where: { key: 'scenario_run' },
          data: {
            value: {
              ...run,
              status: 'stopped',
              completedAt: new Date().toISOString(),
            } as unknown as Parameters<typeof prisma.settings.update>[0]['data']['value'],
          },
        });
        await sleep(POLL_INTERVAL_SEC * 1000);
        continue;
      }

      if (run && (run.status === 'requested' || isStaleRunning)) {
        log(isStaleRunning ? `Reclaiming stale run ${run.runId} (orphaned ${run.claimedAt ?? 'never claimed'})` : `Claiming run ${run.runId}`);

        // Mark as running + stamp claimedAt for stale detection
        await prisma.settings.update({
          where: { key: 'scenario_run' },
          data: { value: { ...run, status: 'running', claimedAt: new Date().toISOString() } as unknown as Parameters<typeof prisma.settings.update>[0]['data']['value'] },
        });

        try {
          await driveRun(run.runId);

          // Re-read status: operator may have requested a stop during the run.
          const finalRow = await prisma.settings.findUnique({ where: { key: 'scenario_run' } });
          const finalRun = finalRow?.value as ScenarioRun | null;
          if (finalRun && (finalRun.status === 'stopping' || finalRun.status === 'stopped')) {
            await prisma.settings.update({
              where: { key: 'scenario_run' },
              data: {
                value: {
                  ...run,
                  status: 'stopped',
                  completedAt: new Date().toISOString(),
                } as unknown as Parameters<typeof prisma.settings.update>[0]['data']['value'],
              },
            });
            log(`Run ${run.runId} stopped by operator`);
          } else {
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
          }
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
        // Another worker instance or a crash-restart — log and wait.
        // If this instance sees 'stopping' in the 'running' branch (shouldn't happen,
        // but defensively): the claiming worker's stop-poller handles it; just poll.
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
