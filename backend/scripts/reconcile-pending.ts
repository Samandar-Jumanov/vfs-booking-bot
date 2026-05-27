/**
 * One-shot operator script to reconcile PENDING accounts via Mailsac activation.
 *
 * Usage:
 *   DATABASE_URL=... PROFILE_ENCRYPTION_KEY=... npx tsx scripts/reconcile-pending.ts [--dry-run]
 *
 * With --dry-run, candidates are listed but NO activation is attempted.
 * Without --dry-run, each PENDING Mailsac account is activated sequentially
 * (2-second gap between attempts).
 *
 * Railway:
 *   railway run --service backend npx tsx scripts/reconcile-pending.ts [--dry-run]
 */

import 'dotenv/config';
import { reconcilePending, findPendingCandidates } from '../src/modules/accounts/reconciliation.service';
import { prisma } from '../src/config/database';

const isDryRun = process.argv.includes('--dry-run');

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

async function main(): Promise<void> {
  console.log('');
  console.log(`=== VFS Account Reconciliation${isDryRun ? ' [DRY-RUN]' : ''} ===`);
  console.log(`  Mode   : ${isDryRun ? 'DRY-RUN (no activations will be attempted)' : 'LIVE'}`);
  console.log(`  Time   : ${new Date().toISOString()}`);
  console.log('');

  // In dry-run we list candidates first for the table, then call reconcilePending.
  // In live mode reconcilePending drives activation and we just print results.

  if (isDryRun) {
    const candidates = await findPendingCandidates();

    if (candidates.length === 0) {
      console.log('  No PENDING Mailsac accounts found. Nothing to do.');
      console.log('');
      await prisma.$disconnect();
      return;
    }

    const COL = { email: 34, created: 26, result: 30 };
    const header =
      pad('EMAIL', COL.email) + ' | ' +
      pad('CREATED AT', COL.created) + ' | ' +
      'RESULT';
    const sep = '-'.repeat(header.length);

    console.log(sep);
    console.log(header);
    console.log(sep);

    for (const c of candidates) {
      const row =
        pad(c.email, COL.email) + ' | ' +
        pad(c.createdAt.toISOString(), COL.created) + ' | ' +
        'DRY-RUN: would activate';
      console.log(row);
    }

    console.log(sep);
    console.log('');
    console.log(`SUMMARY: total ${candidates.length} candidate(s). No activations attempted.`);
    console.log('');

    await prisma.$disconnect();
    return;
  }

  // Live mode: collect candidates first for the table header, then run.
  const candidates = await findPendingCandidates();

  if (candidates.length === 0) {
    console.log('  No PENDING Mailsac accounts found. Nothing to do.');
    console.log('');
    await prisma.$disconnect();
    return;
  }

  const COL = { email: 34, created: 26, result: 20 };
  const header =
    pad('EMAIL', COL.email) + ' | ' +
    pad('CREATED AT', COL.created) + ' | ' +
    'RESULT';
  const sep = '-'.repeat(header.length);

  console.log(sep);
  console.log(header);
  console.log(sep);

  // Track per-account results by running reconcilePending in live mode.
  // We re-use the service but capture per-candidate output by running
  // tryActivate individually here so we can print the table inline.
  const { tryActivate } = await import('../src/modules/accounts/reconciliation.service');

  const results: Array<{ email: string; createdAt: Date; result: string }> = [];

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!;
    const outcome = await tryActivate(c.id);
    results.push({ email: c.email, createdAt: c.createdAt, result: outcome });

    const row =
      pad(c.email, COL.email) + ' | ' +
      pad(c.createdAt.toISOString(), COL.created) + ' | ' +
      outcome;
    console.log(row);

    // Pacing: 2-second gap between attempts.
    if (i < candidates.length - 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
    }
  }

  console.log(sep);
  console.log('');

  const activated = results.filter((r) => r.result === 'activated').length;
  const linkMissing = results.filter((r) => r.result === 'link_missing').length;
  const failed = results.filter((r) => r.result === 'failed').length;

  console.log('SUMMARY:');
  console.log(`  total        : ${candidates.length}`);
  console.log(`  activated    : ${activated}`);
  console.log(`  link_missing : ${linkMissing}`);
  console.log(`  failed       : ${failed}`);
  console.log('');

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('[reconcile-pending] fatal error:', (err as Error).message);
  process.exit(1);
});
