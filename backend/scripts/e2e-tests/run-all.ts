import { spawn } from 'child_process';
import path from 'path';

type Result = {
  name: string;
  file: string;
  status: 'PASS' | 'SKIP' | 'FAIL';
  reason?: string;
  durationMs?: number;
  exitCode?: number | null;
};

const scripts = [
  '01-cookie-sync-from-chrome.ts',
  '02-manual-cookie-injection.ts',
  '03-slot-polling-real-vfs.ts',
  '04-slot-detection-telegram-alert.ts',
  '05-auto-booking-dispatch.ts',
  '06-booking-confirmation-extraction.ts',
  '07-account-pool-warming.ts',
  '08-multi-account-rotation.ts',
  '09-cooldown-after-429.ts',
  '10-profile-crud.ts',
  '11-notification-preferences.ts',
  '12-logs-viewer-export.ts',
  '13-vendor-balance-fetching.ts',
  '14-datadome-cookie-freshness.ts',
  '15-auto-register-e2e.ts',
  '15-cookie-sync-on-login.ts',
];

const dryRun = process.argv.includes('--dry') || process.env.E2E_DRY_RUN === '1';
const concurrency = Number(process.env.E2E_CONCURRENCY ?? 1);
const root = __dirname;

async function runScript(file: string): Promise<Result> {
  const child = spawn(process.execPath, [
    '-r', 'ts-node/register/transpile-only',
    '-r', 'tsconfig-paths/register',
    path.join(root, file),
  ], {
    cwd: path.resolve(root, '../..'),
    env: { ...process.env, NODE_ENV: process.env.NODE_ENV ?? 'test', ...(dryRun ? { E2E_DRY_RUN: '1' } : {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    stdout += text;
    process.stdout.write(`[${file}] ${text}`);
  });
  child.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    stderr += text;
    process.stderr.write(`[${file}] ${text}`);
  });

  const exitCode = await new Promise<number | null>((resolve) => child.on('close', resolve));
  const resultLine = stdout.split(/\r?\n/).reverse().find((line) => line.startsWith('[E2E_RESULT] '));
  if (resultLine) {
    try {
      return { file, exitCode, ...JSON.parse(resultLine.slice('[E2E_RESULT] '.length)) };
    } catch {
      // Fall through to synthetic result below.
    }
  }
  return {
    file,
    name: file,
    status: exitCode === 0 ? 'PASS' : 'FAIL',
    reason: exitCode === 0 ? undefined : (stderr || stdout || `process exited ${exitCode}`).slice(0, 500),
    exitCode,
  };
}

async function main() {
  if (dryRun) {
    console.log('E2E dry run enabled: live-only scripts will be skipped unless they have local contract coverage.');
  }
  const queue = [...scripts];
  const results: Result[] = [];
  const workers = Array.from({ length: Math.min(concurrency, scripts.length) }, async () => {
    while (queue.length > 0) {
      const file = queue.shift();
      if (!file) return;
      results.push(await runScript(file));
    }
  });
  await Promise.all(workers);

  const ordered = scripts.map((file) => results.find((r) => r.file === file)!);
  const passed = ordered.filter((r) => r.status === 'PASS').length;
  const skipped = ordered.filter((r) => r.status === 'SKIP').length;
  const failed = ordered.filter((r) => r.status === 'FAIL').length;

  console.log('\nE2E summary');
  for (const r of ordered) {
    console.log(`${r.status.padEnd(4)} ${r.file} - ${r.name}${r.reason ? ` (${r.reason})` : ''}`);
  }
  console.log(`\n${passed} passed, ${skipped} skipped, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error(err instanceof Error && err.stack ? err.stack : err);
  process.exit(1);
});
