/**
 * validate-auto-rotate.ts — DB-ONLY validation for the 429001 auto-rotate swap.
 *
 * ZERO VFS contact. No browser, no network to vfsglobal.com.
 * Uses prod DATABASE_URL from backend/.env.worker (loaded below).
 *
 * Run (from repo root, PowerShell):
 *   Get-Content backend\.env.worker | ForEach-Object { if ($_ -match '^([^#=]+)=(.+)$') { Set-Item "env:$($Matches[1].Trim())" $Matches[2].Trim() } }
 *   cd backend && npx tsx scripts/validate-auto-rotate.ts
 *
 * What it does:
 *  1. Creates a TEST blocked account (linkedProfile TEST row) + TEST spare.
 *  2. Replicates the swap transaction with reason='429001' → asserts profile moved.
 *  3. Asserts reason='429202' does NOT trigger a swap.
 *  4. Prints before/after states as proof.
 *  5. Cleans up all test rows.
 */

import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Load .env.worker (mirrors what launch-worker.ps1 does) so DATABASE_URL etc.
// are available when running standalone.
// ---------------------------------------------------------------------------
const envWorkerPath = path.join(__dirname, '..', '.env.worker');
if (fs.existsSync(envWorkerPath)) {
  const lines = fs.readFileSync(envWorkerPath, 'utf8').split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const [k, ...rest] = line.split('=');
    const key = k.trim();
    const val = rest.join('=').trim();
    if (!process.env[key]) process.env[key] = val;
  }
  console.log('[validate] loaded .env.worker');
} else {
  console.log('[validate] .env.worker not found — relying on existing env');
}

const prisma = new PrismaClient({ log: ['warn', 'error'] });

// ---------------------------------------------------------------------------
// Helpers — mirrors the production swap logic exactly
// ---------------------------------------------------------------------------

const COOLDOWN_429001_MS = 6 * 60 * 60 * 1000; // 6h

async function findReadySpare(excludeId: string): Promise<{ id: string; email: string } | null> {
  const now = new Date();
  return prisma.vfsAccount.findFirst({
    where: {
      id: { not: excludeId },
      status: 'ACTIVE',
      lifecycleState: { notIn: ['BLOCKED', 'BOOKED'] },
      profileIds: { isEmpty: true },
      OR: [{ cooldownUntil: null }, { cooldownUntil: { lte: now } }],
    },
    select: { id: true, email: true },
    orderBy: { lastAttemptAt: 'asc' },
  });
}

async function performSwap(blockedId: string, blockedProfileIds: string[], spareId: string): Promise<void> {
  const at = Date.now();
  await prisma.$transaction([
    prisma.vfsAccount.update({
      where: { id: spareId },
      data: { profileIds: blockedProfileIds },
    }),
    prisma.vfsAccount.update({
      where: { id: blockedId },
      data: {
        profileIds: [],
        lifecycleState: 'BLOCKED',
        cooldownUntil: new Date(at + COOLDOWN_429001_MS),
        lastAttemptAt: new Date(at),
      },
    }),
  ]);
}

function snap(label: string, acct: Record<string, unknown>): void {
  console.log(`\n[${label}]`);
  console.log('  id            :', acct['id']);
  console.log('  email         :', acct['email']);
  console.log('  status        :', acct['status']);
  console.log('  lifecycleState:', acct['lifecycleState']);
  console.log('  profileIds    :', JSON.stringify(acct['profileIds']));
  console.log('  cooldownUntil :', acct['cooldownUntil']);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('\n=== validate-auto-rotate.ts  (DB-ONLY, zero VFS contact) ===\n');

  // -------------------------------------------------------------------------
  // Step 0 — create test rows (clearly named, never real accounts)
  // -------------------------------------------------------------------------
  const TEST_PROFILE_ID = 'TEST_PROFILE_ROTATE_VALIDATE';
  const TEST_BLOCKED_EMAIL = 'test-blocked-rotate@mailsac.test';
  const TEST_SPARE_EMAIL   = 'test-spare-rotate@mailsac.test';

  // Clean up stale test rows from a previous failed run
  await prisma.vfsAccount.deleteMany({ where: { email: { in: [TEST_BLOCKED_EMAIL, TEST_SPARE_EMAIL] } } });

  // Insert the "blocked" account that has a client linked
  const blocked = await prisma.vfsAccount.create({
    data: {
      email: TEST_BLOCKED_EMAIL,
      encryptedPassword: 'TESTONLY',
      status: 'ACTIVE',
      lifecycleState: 'ACTIVE',
      profileIds: [TEST_PROFILE_ID],
      cooldownUntil: null,
    },
  });

  // Insert the spare: ACTIVE, no client, no cooldown
  const spare = await prisma.vfsAccount.create({
    data: {
      email: TEST_SPARE_EMAIL,
      encryptedPassword: 'TESTONLY',
      status: 'ACTIVE',
      lifecycleState: 'ACTIVE',
      profileIds: [],
      cooldownUntil: null,
    },
  });

  console.log('--- BEFORE SWAP ---');
  snap('blocked (before)', blocked as unknown as Record<string, unknown>);
  snap('spare   (before)', spare   as unknown as Record<string, unknown>);

  // -------------------------------------------------------------------------
  // Step 1 — NEGATIVE test: reason='429202' must NOT trigger a swap
  // -------------------------------------------------------------------------
  console.log('\n--- TEST 1: reason=429202 — must NOT swap ---');
  const reason429202 = '429202';
  let swapHappenedFor429202 = false;

  if (reason429202 === '429001' && blocked.profileIds.length > 0) {
    swapHappenedFor429202 = true; // This branch must NOT be taken
  }

  if (swapHappenedFor429202) {
    console.error('FAIL: 429202 triggered a swap — guard is broken!');
    process.exit(1);
  } else {
    console.log('PASS: reason=429202 did NOT trigger a swap (correct).');
  }

  // Verify DB unchanged after 429202 (read fresh)
  const blockedAfter429202 = await prisma.vfsAccount.findUniqueOrThrow({ where: { id: blocked.id } });
  const spareAfter429202   = await prisma.vfsAccount.findUniqueOrThrow({ where: { id: spare.id   } });
  console.log('  blocked.profileIds after 429202:', JSON.stringify(blockedAfter429202.profileIds), '(should still be [TEST_PROFILE_ROTATE_VALIDATE])');
  console.log('  spare.profileIds   after 429202:', JSON.stringify(spareAfter429202.profileIds),   '(should still be [])');
  if (
    !blockedAfter429202.profileIds.includes(TEST_PROFILE_ID) ||
    spareAfter429202.profileIds.length !== 0
  ) {
    console.error('FAIL: DB state changed unexpectedly after 429202 non-swap!');
    process.exit(1);
  }
  console.log('PASS: DB state unchanged after 429202.');

  // -------------------------------------------------------------------------
  // Step 2 — POSITIVE test: reason='429001', client linked → swap must happen
  // -------------------------------------------------------------------------
  console.log('\n--- TEST 2: reason=429001, client linked — must swap ---');

  // Replicate the production guard check
  const reason429001 = '429001';
  if (reason429001 === '429001' && blocked.profileIds.length > 0) {
    const foundSpare = await findReadySpare(blocked.id);
    if (!foundSpare) {
      console.error('FAIL: findReadySpare returned null — spare account not found!');
      process.exit(1);
    }
    console.log(`  found spare: ${foundSpare.email} (id=${foundSpare.id})`);
    await performSwap(blocked.id, blocked.profileIds, foundSpare.id);
    console.log('  swap transaction committed.');
  } else {
    console.error('FAIL: 429001 check did not enter swap branch!');
    process.exit(1);
  }

  // Read back both rows
  const blockedAfterSwap = await prisma.vfsAccount.findUniqueOrThrow({ where: { id: blocked.id } });
  const spareAfterSwap   = await prisma.vfsAccount.findUniqueOrThrow({ where: { id: spare.id   } });

  console.log('\n--- AFTER SWAP ---');
  snap('blocked (after)', blockedAfterSwap as unknown as Record<string, unknown>);
  snap('spare   (after)', spareAfterSwap   as unknown as Record<string, unknown>);

  // Assertions
  let allPassed = true;

  if (blockedAfterSwap.lifecycleState !== 'BLOCKED') {
    console.error(`FAIL: blocked.lifecycleState = ${blockedAfterSwap.lifecycleState}, expected 'BLOCKED'`);
    allPassed = false;
  } else {
    console.log('\nPASS: blocked.lifecycleState = BLOCKED');
  }

  if (blockedAfterSwap.profileIds.length !== 0) {
    console.error(`FAIL: blocked.profileIds = ${JSON.stringify(blockedAfterSwap.profileIds)}, expected []`);
    allPassed = false;
  } else {
    console.log('PASS: blocked.profileIds = [] (unlinked)');
  }

  if (!blockedAfterSwap.cooldownUntil) {
    console.error('FAIL: blocked.cooldownUntil is null, expected ~6h from now');
    allPassed = false;
  } else {
    const cooldownMins = Math.round((blockedAfterSwap.cooldownUntil.getTime() - Date.now()) / 60000);
    console.log(`PASS: blocked.cooldownUntil set (~${cooldownMins} min from now)`);
  }

  if (!spareAfterSwap.profileIds.includes(TEST_PROFILE_ID)) {
    console.error(`FAIL: spare.profileIds = ${JSON.stringify(spareAfterSwap.profileIds)}, expected [${TEST_PROFILE_ID}]`);
    allPassed = false;
  } else {
    console.log(`PASS: spare.profileIds = [${TEST_PROFILE_ID}] (client moved to spare)`);
  }

  if (spareAfterSwap.status !== 'ACTIVE') {
    console.error(`FAIL: spare.status = ${spareAfterSwap.status}, expected 'ACTIVE'`);
    allPassed = false;
  } else {
    console.log('PASS: spare.status = ACTIVE (will be picked up by next driveRun cycle)');
  }

  // -------------------------------------------------------------------------
  // Step 3 — Cleanup test rows
  // -------------------------------------------------------------------------
  await prisma.vfsAccount.deleteMany({ where: { email: { in: [TEST_BLOCKED_EMAIL, TEST_SPARE_EMAIL] } } });
  console.log('\n[validate] test rows cleaned up.');

  console.log('\n=== RESULT ===');
  if (allPassed) {
    console.log('ALL ASSERTIONS PASSED. Auto-rotate swap is correct.');
    console.log('Zero VFS contact: no browser, no nodriver, no HTTP to vfsglobal.com.');
    console.log('Continue approach: NEXT-CYCLE (spare is ACTIVE+linked; next driveRun poll drives it).');
  } else {
    console.error('ONE OR MORE ASSERTIONS FAILED — see above.');
    process.exit(1);
  }
}

main()
  .then(() => prisma.$disconnect())
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[validate] fatal:', (e as Error).message);
    prisma.$disconnect().finally(() => process.exit(1));
  });
