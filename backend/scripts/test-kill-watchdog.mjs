/**
 * Local throwaway test — NO VFS, NO DB contact.
 * Proves that killChild + watchdog resolves the promise within the grace window
 * even when the child process ignores SIGTERM and holds its stdout pipe open.
 *
 * Run with:  node backend/scripts/test-kill-watchdog.mjs
 */

import { spawn } from 'node:child_process';
import { strict as assert } from 'node:assert';

// ---- Replicate the exact logic from spawnAndWatch (killChild + finish + settle guard) ----
function runTest({ label, childArgs, triggerMs, expectResolveWithinMs }) {
  return new Promise((testResolve) => {
    let lastError = undefined;

    let settled = false;
    let watchdogTimer;

    function finish(outcome) {
      if (settled) return;
      settled = true;
      if (watchdogTimer !== undefined) { clearTimeout(watchdogTimer); watchdogTimer = undefined; }
      testResolve({ outcome, elapsed: Date.now() - startMs });
    }

    const child = spawn(process.execPath, childArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    function killChild(reason) {
      if (settled) return;
      try { child.kill('SIGTERM'); } catch {}

      // Hard tree-kill after ~3s
      setTimeout(() => {
        if (settled) return;
        if (process.platform === 'win32' && child.pid) {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        } else {
          try { child.kill('SIGKILL'); } catch {}
        }
      }, 3_000);

      // Watchdog: force-resolve at 6s regardless
      watchdogTimer = setTimeout(() => {
        if (settled) return;
        process.stdout.write(`  [WATCHDOG] child did not close within 6s (reason=${reason}) — forcing resolve\n`);
        finish({ result: 'failed', error: lastError ?? reason });
      }, 6_000);
    }

    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (chunk) => { /* consume — don't let it block */ });
    child.stderr.on('data', (chunk) => { /* consume */ });

    child.on('exit', (code) => {
      finish({ result: code === 0 ? 'ok' : 'failed', error: lastError });
    });
    child.on('close', (code) => {
      finish({ result: code === 0 ? 'ok' : 'failed', error: lastError });
    });

    const startMs = Date.now();

    // Trigger kill after triggerMs (simulates circuit-breaker firing)
    setTimeout(() => {
      process.stdout.write(`  [TEST:${label}] triggering killChild after ${triggerMs}ms\n`);
      killChild('test_trigger');
    }, triggerMs);
  });
}

// ---- Test cases ----

async function main() {
  let passed = 0;
  let failed = 0;

  // Test 1: child that IGNORES SIGTERM and keeps pipe open (the real hang scenario)
  // On win32 we can't send real signals via kill(), but process.kill on win32 is
  // equivalent to TerminateProcess (SIGKILL), so we simulate the hang by having
  // the child sleep and relying on the watchdog / taskkill path.
  // On POSIX the child explicitly ignores SIGTERM.
  {
    const label = 'ignores-SIGTERM';
    const childScript = process.platform === 'win32'
      // On win32 node.kill() is always hard-kill so "ignore" is moot;
      // simulate the pipe-hang: keep stdout open + loop forever
      ? `setInterval(()=>{process.stdout.write('alive\\n')},500);`
      // On POSIX: actually ignore SIGTERM
      : `process.on('SIGTERM',()=>{}); setInterval(()=>{},1e9);`;

    process.stdout.write(`\n[TEST:${label}] spawning child that ignores SIGTERM...\n`);
    const t0 = Date.now();
    const { outcome, elapsed } = await runTest({
      label,
      childArgs: ['-e', childScript],
      triggerMs: 200,
      expectResolveWithinMs: 10_000,
    });
    const elapsed2 = Date.now() - t0;
    process.stdout.write(`  resolved in ${elapsed2}ms with result=${outcome.result} error=${outcome.error ?? '(none)'}\n`);

    if (elapsed2 < 10_000) {
      process.stdout.write(`  PASS: resolved within 10s grace window\n`);
      passed++;
    } else {
      process.stdout.write(`  FAIL: took ${elapsed2}ms — exceeded 10s grace window\n`);
      failed++;
    }
  }

  // Test 2: normal child that exits cleanly (no hang) — should resolve via exit event
  {
    const label = 'clean-exit';
    process.stdout.write(`\n[TEST:${label}] spawning child that exits immediately...\n`);
    const t0 = Date.now();
    const { outcome, elapsed } = await runTest({
      label,
      childArgs: ['-e', 'process.exit(0);'],
      triggerMs: 99999, // never triggers kill — child exits on its own
      expectResolveWithinMs: 2_000,
    });
    const elapsed2 = Date.now() - t0;
    process.stdout.write(`  resolved in ${elapsed2}ms with result=${outcome.result}\n`);

    if (outcome.result === 'ok' && elapsed2 < 2_000) {
      process.stdout.write(`  PASS: clean exit resolved quickly as ok\n`);
      passed++;
    } else {
      process.stdout.write(`  FAIL: expected ok within 2s, got result=${outcome.result} in ${elapsed2}ms\n`);
      failed++;
    }
  }

  // Test 3: child exits with non-zero code — should resolve as 'failed'
  {
    const label = 'nonzero-exit';
    process.stdout.write(`\n[TEST:${label}] spawning child that exits with code 1...\n`);
    const t0 = Date.now();
    const { outcome } = await runTest({
      label,
      childArgs: ['-e', 'process.exit(1);'],
      triggerMs: 99999,
      expectResolveWithinMs: 2_000,
    });
    const elapsed2 = Date.now() - t0;
    process.stdout.write(`  resolved in ${elapsed2}ms with result=${outcome.result}\n`);

    if (outcome.result === 'failed' && elapsed2 < 2_000) {
      process.stdout.write(`  PASS: non-zero exit correctly resolves as failed\n`);
      passed++;
    } else {
      process.stdout.write(`  FAIL: expected failed within 2s\n`);
      failed++;
    }
  }

  // Summary
  process.stdout.write(`\n========================================\n`);
  process.stdout.write(`Results: ${passed} passed, ${failed} failed\n`);
  process.stdout.write(failed === 0 ? 'ALL PASS\n' : 'SOME TESTS FAILED\n');
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
