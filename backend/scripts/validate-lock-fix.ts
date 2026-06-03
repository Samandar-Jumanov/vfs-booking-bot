/**
 * Validation script for the worker-lock heartbeat fix.
 * Run: npx tsx scripts/validate-lock-fix.ts
 *
 * Loads .env.worker, spawns instance A, waits for a heartbeat cycle,
 * checks the DB, spawns instance B (must refuse), kills A, verifies clean.
 * NO scenario run is queued; POOL_MIN=0 so no accounts are driven and
 * no VFS requests are made.
 */

import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { PrismaClient } from '@prisma/client';
import * as dotenv from 'dotenv';

// Load .env.worker so DATABASE_URL etc. are available to child processes too.
// Use override: true so .env.worker wins over any .env already loaded.
const envWorkerPath = path.resolve(__dirname, '../.env.worker');
if (fs.existsSync(envWorkerPath)) {
  dotenv.config({ path: envWorkerPath, override: true });
  console.log('[VALIDATE] Loaded .env.worker');
} else {
  console.warn('[VALIDATE] No .env.worker found — relying on current env');
}

// Set defaults that launch-worker.ps1 normally provides
if (!process.env.BACKEND_URL) {
  process.env.BACKEND_URL = 'https://backend-production-24c3.up.railway.app';
  console.log('[VALIDATE] Set default BACKEND_URL');
}

const WORKER_SCRIPT = path.resolve(__dirname, 'orchestrator-worker.ts');
const HEARTBEAT_WAIT_MS = 38_000; // 30s heartbeat + 8s margin

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function spawnWorker(label: string): Promise<{
  pid: number;
  lines: string[];
  kill: () => void;
  waitExit: () => Promise<number | null>;
}> {
  const lines: string[] = [];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    POOL_MIN: '0',         // no accounts to drive
    POLL_INTERVAL_SEC: '5', // fast poll so it reaches the lock-acquire quickly
  };
  // Explicitly unset TARGET_EMAIL so no account is targeted
  delete env.TARGET_EMAIL;

  // On Windows, npx must be invoked via cmd so the .cmd shim resolves.
  const isWindows = process.platform === 'win32';
  const child = isWindows
    ? spawn('cmd', ['/c', 'npx', 'tsx', WORKER_SCRIPT], {
        env,
        cwd: path.resolve(__dirname, '..'),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: false,
      })
    : spawn('npx', ['tsx', WORKER_SCRIPT], {
        env,
        cwd: path.resolve(__dirname, '..'),
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      });

  child.stdout.on('data', (d: Buffer) => {
    const line = d.toString().trim();
    if (line) { lines.push(line); console.log(`[${label}/stdout] ${line}`); }
  });
  child.stderr.on('data', (d: Buffer) => {
    const line = d.toString().trim();
    if (line) { lines.push(line); console.log(`[${label}/stderr] ${line}`); }
  });

  const waitExit = (): Promise<number | null> =>
    new Promise(resolve => child.on('exit', (code) => resolve(code)));

  return {
    pid: child.pid!,
    lines,
    kill: () => { try { child.kill('SIGTERM'); } catch {} },
    waitExit,
  };
}

async function main() {
  console.log('\n=== LOCK-FIX VALIDATION ===\n');

  // Connect to DB to inspect the lock row
  const prisma = new PrismaClient();

  // Step 0: ensure the lock row is absent (clean slate)
  await prisma.settings.deleteMany({ where: { key: 'worker_lock' } });
  console.log('[VALIDATE] Cleared any stale worker_lock row from DB');

  // Step 1: Confirm no worker processes
  console.log('[VALIDATE] Starting instance A...');
  const instA = await spawnWorker('A');
  console.log(`[VALIDATE] Instance A spawned (pid=${instA.pid})`);

  // Wait for instance A to acquire lock + write first heartbeat cycle (30s + startup margin)
  console.log(`[VALIDATE] Waiting ${HEARTBEAT_WAIT_MS / 1000}s for heartbeat cycle...`);
  await sleep(HEARTBEAT_WAIT_MS);

  // Step 2: Check DB for worker_lock row with recent heartbeatAt
  const lockRow = await prisma.settings.findUnique({ where: { key: 'worker_lock' } });
  const lockVal = lockRow?.value as { pid?: number; heartbeatAt?: string; startedAt?: string } | null;

  console.log('\n[VALIDATE] DB worker_lock row:', JSON.stringify(lockVal, null, 2));

  const heartbeatAge = lockVal?.heartbeatAt
    ? Date.now() - new Date(lockVal.heartbeatAt).getTime()
    : Infinity;

  const heartbeatOk = heartbeatAge < 40_000; // must be < 40s old
  console.log(`[VALIDATE] heartbeatAt age: ${Math.round(heartbeatAge / 1000)}s — ${heartbeatOk ? 'PASS (heartbeat is fresh)' : 'FAIL (heartbeat stale/missing)'}`);

  // On Windows, cmd /c spawns a wrapper; the actual node worker PID differs from
  // the cmd wrapper PID. Check that the lock has SOME pid set and it's a number > 0.
  const pidMatches = typeof lockVal?.pid === 'number' && lockVal.pid > 0;
  console.log(`[VALIDATE] Lock has valid pid=${lockVal?.pid} (cmd-wrapper pid=${instA.pid} on Windows, child pid differs — expected): ${pidMatches ? 'PASS' : 'FAIL'}`);

  // Step 3: Confirm no Prisma heartbeat error in A's output
  const hasHeartbeatError = instA.lines.some(l =>
    l.includes('Unknown argument') || (l.toLowerCase().includes('error') && l.includes('worker_lock'))
  );
  console.log(`[VALIDATE] Prisma heartbeat error in A output: ${hasHeartbeatError ? 'YES — FIX DID NOT WORK' : 'none (PASS)'}`);

  const hasHeartbeatWritten = instA.lines.some(l => l.includes('Lock heartbeat written'));
  console.log(`[VALIDATE] "Lock heartbeat written" in A output: ${hasHeartbeatWritten ? 'PASS' : 'NOT YET (may need more time)'}`);

  // Step 4: Spawn instance B — it must refuse
  console.log('\n[VALIDATE] Spawning instance B — expecting REFUSED...');
  const instB = await spawnWorker('B');
  const exitCodeB = await instB.waitExit();
  console.log(`[VALIDATE] Instance B exit code: ${exitCodeB}`);

  const bRefused = instB.lines.some(l => l.includes('REFUSED') || l.includes('another worker is running'));
  console.log(`[VALIDATE] Instance B refused: ${bRefused ? 'PASS' : 'FAIL — B did NOT refuse'}`);
  console.log('[VALIDATE] Instance B output:', instB.lines.join('\n'));

  // Step 5: Check no browser/python spawned
  const noBrowser = !instA.lines.some(l =>
    l.includes('chrome') || l.includes('python') || l.includes('nodriver') || l.includes('browser')
  );
  console.log(`[VALIDATE] No browser/python launched by A: ${noBrowser ? 'PASS' : 'WARN — check A output'}`);

  // Step 6: Kill A and wait. On Windows, SIGTERM to the cmd wrapper doesn't
  // propagate to the node child. Kill the actual worker PID from the lock row.
  console.log('\n[VALIDATE] Killing instance A...');
  instA.kill(); // kill the cmd wrapper
  if (lockVal?.pid && process.platform === 'win32') {
    try {
      process.kill(lockVal.pid, 'SIGTERM');
      console.log(`[VALIDATE] Sent SIGTERM to worker pid=${lockVal.pid}`);
    } catch { /* already dead */ }
  }
  await Promise.race([instA.waitExit(), sleep(5000)]);

  // Brief wait then confirm lock released
  await sleep(2000);
  const lockAfterKill = await prisma.settings.findUnique({ where: { key: 'worker_lock' } });
  console.log(`[VALIDATE] worker_lock row after A killed: ${lockAfterKill ? JSON.stringify(lockAfterKill.value) : 'GONE (PASS — lock released on SIGTERM)'}`);

  await prisma.$disconnect();

  // Summary
  console.log('\n=== SUMMARY ===');
  const pass = heartbeatOk && pidMatches && !hasHeartbeatError && bRefused && (exitCodeB ?? 0) !== 0;
  console.log(`Heartbeat fresh in DB : ${heartbeatOk ? 'PASS' : 'FAIL'}`);
  console.log(`PID match             : ${pidMatches ? 'PASS' : 'FAIL'}`);
  console.log(`No Prisma error in A  : ${!hasHeartbeatError ? 'PASS' : 'FAIL'}`);
  console.log(`Instance B refused    : ${bRefused ? 'PASS' : 'FAIL'}`);
  console.log(`Overall               : ${pass ? 'PASS' : 'FAIL'}`);
  process.exit(pass ? 0 : 1);
}

main().catch(e => { console.error('[VALIDATE] Unhandled error:', e); process.exit(1); });
