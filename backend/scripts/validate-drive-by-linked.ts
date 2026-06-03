/**
 * validate-drive-by-linked.ts
 *
 * DB-ONLY validation for the "drive by linked profile" change.
 * Zero VFS contact — pure Prisma reads + test row writes/deletes.
 *
 * Run:
 *   cd backend
 *   npx tsx scripts/validate-drive-by-linked.ts
 *
 * Loads DATABASE_URL from backend/.env.worker (falls back to .env).
 */

import path from 'path';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';

// Load env: .env first as baseline, then .env.worker overrides (Railway DATABASE_URL).
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config({ path: path.resolve(__dirname, '../.env.worker'), override: true });

const prisma = new PrismaClient();

// The new where-clause used in driveRun (default mode, no TARGET_EMAIL).
const NEW_WHERE = {
  status: 'ACTIVE' as const,
  lifecycleState: { not: 'BOOKED' as const },
  profileIds: { isEmpty: false },
};

async function main() {
  console.log('\n=== validate-drive-by-linked.ts ===');
  console.log('Zero VFS contact — DB reads + test rows only.\n');

  // -----------------------------------------------------------------------
  // STEP 1: Run the NEW selection query against prod data and print results.
  // -----------------------------------------------------------------------
  console.log('--- STEP 1: new selection query (prod accounts) ---');

  const linkedAccounts = await prisma.vfsAccount.findMany({
    where: NEW_WHERE,
    select: { id: true, email: true, profileIds: true, status: true, lifecycleState: true },
    orderBy: { lastAttemptAt: 'asc' },
  });

  const allActive = await prisma.vfsAccount.findMany({
    where: { status: 'ACTIVE', lifecycleState: { not: 'BOOKED' } },
    select: { id: true, email: true, profileIds: true },
    orderBy: { lastAttemptAt: 'asc' },
  });

  console.log(`All ACTIVE non-BOOKED accounts (${allActive.length}):`);
  for (const a of allActive) {
    const linked = a.profileIds.length > 0;
    console.log(`  ${linked ? '[LINKED]' : '[spare ]'} ${a.email} profileIds=[${a.profileIds.join(',')}]`);
  }

  console.log(`\nNew query returns (${linkedAccounts.length}) linked accounts:`);
  for (const a of linkedAccounts) {
    console.log(`  SELECTED: ${a.email} profileIds=[${a.profileIds.join(',')}]`);
  }

  const unlinkedSpares = allActive.filter((a) => a.profileIds.length === 0);
  const unlinkedSelectedByNewQuery = linkedAccounts.filter(
    (a) => unlinkedSpares.some((u) => u.id === a.id),
  );

  if (unlinkedSelectedByNewQuery.length > 0) {
    console.error('\nFAIL: new query INCLUDES unlinked spares:');
    for (const a of unlinkedSelectedByNewQuery) {
      console.error(`  ${a.email}`);
    }
    process.exitCode = 1;
  } else {
    console.log('\nPASS: no unlinked spares selected by new query.');
  }

  if (linkedAccounts.length === 0) {
    console.log(
      'NOTE: no linked accounts found in prod DB right now (client may be unlinked/BOOKED). ' +
        'The in-memory test below still validates the query logic.',
    );
  }

  // -----------------------------------------------------------------------
  // STEP 2: In-memory / test-row simulation of a rotate swap.
  //
  // We create two test accounts:
  //   - TEST_BLOCKED: was the driving account, got 429001, rotate set profileIds=[], lifecycleState=BLOCKED
  //   - TEST_SPARE: the spare, got profileIds=[<fake-profile-id>] after rotate
  //
  // Then run the new query and verify:
  //   - TEST_BLOCKED is NOT returned (profileIds=[])
  //   - TEST_SPARE IS returned (profileIds non-empty, status ACTIVE, not BOOKED)
  // -----------------------------------------------------------------------
  console.log('\n--- STEP 2: test-row rotate simulation ---');

  const FAKE_PROFILE_ID = 'validate-drive-test-profile-0001';
  const TEST_BLOCKED_EMAIL = 'test-blocked@validate.internal';
  const TEST_SPARE_EMAIL = 'test-spare@validate.internal';

  // Clean up any leftover test rows first.
  await prisma.vfsAccount.deleteMany({
    where: { email: { in: [TEST_BLOCKED_EMAIL, TEST_SPARE_EMAIL] } },
  });

  // Create a minimal test account — only the columns the query touches.
  // Note: encryptedPassword and other required fields get dummy values.
  const dummyPass = 'VALIDATE_TEST_DUMMY_DO_NOT_USE';

  const testBlocked = await prisma.vfsAccount.create({
    data: {
      email: TEST_BLOCKED_EMAIL,
      encryptedPassword: dummyPass,
      status: 'ACTIVE',
      lifecycleState: 'BLOCKED',    // blocked account — would normally be excluded by not ACTIVE... but
      // we use lifecycleState=BLOCKED AND profileIds=[] to simulate post-rotate.
      // Actually status stays ACTIVE in the current rotate code; lifecycleState=BLOCKED.
      // The query filters lifecycleState:{not:'BOOKED'} — BLOCKED passes that filter.
      // The profileIds:{isEmpty:false} is what excludes it.
      profileIds: [],              // ← just-blocked, profile moved to spare
    },
  });

  const testSpare = await prisma.vfsAccount.create({
    data: {
      email: TEST_SPARE_EMAIL,
      encryptedPassword: dummyPass,
      status: 'ACTIVE',
      lifecycleState: 'ACTIVE',    // spare is ready
      profileIds: [FAKE_PROFILE_ID], // ← rotate moved client's profile here
    },
  });

  console.log(`Created TEST_BLOCKED (${TEST_BLOCKED_EMAIL}): profileIds=[], lifecycleState=BLOCKED`);
  console.log(`Created TEST_SPARE   (${TEST_SPARE_EMAIL}): profileIds=[${FAKE_PROFILE_ID}], lifecycleState=ACTIVE`);

  // Run the new where query.
  const simResult = await prisma.vfsAccount.findMany({
    where: NEW_WHERE,
    select: { id: true, email: true, profileIds: true },
  });

  const blockedFound = simResult.some((a) => a.id === testBlocked.id);
  const spareFound = simResult.some((a) => a.id === testSpare.id);

  console.log(`\nQuery result for test rows:`);
  console.log(`  TEST_BLOCKED selected: ${blockedFound} (expected: false)`);
  console.log(`  TEST_SPARE   selected: ${spareFound}   (expected: true)`);

  let pass = true;
  if (blockedFound) {
    console.error('FAIL: TEST_BLOCKED was selected — profileIds:{isEmpty:false} not working');
    pass = false;
    process.exitCode = 1;
  }
  if (!spareFound) {
    console.error('FAIL: TEST_SPARE was NOT selected — should be picked up after rotate');
    pass = false;
    process.exitCode = 1;
  }
  if (pass) {
    console.log('\nPASS: blocked excluded, spare selected — rotate handoff works correctly.');
  }

  // Clean up test rows.
  await prisma.vfsAccount.deleteMany({
    where: { email: { in: [TEST_BLOCKED_EMAIL, TEST_SPARE_EMAIL] } },
  });
  console.log('Test rows cleaned up.');

  // -----------------------------------------------------------------------
  // Summary
  // -----------------------------------------------------------------------
  console.log('\n--- SUMMARY ---');
  console.log(`Prod linked accounts that would be driven: ${linkedAccounts.length}`);
  console.log(`Prod unlinked spares correctly excluded:   ${unlinkedSpares.length}`);
  console.log(`Rotate simulation (blocked → spare):       ${pass ? 'PASS' : 'FAIL'}`);
  console.log(`VFS contact: ZERO (DB-only script)`);
  console.log('=== done ===\n');
}

main()
  .catch((e) => {
    console.error('FATAL:', e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
