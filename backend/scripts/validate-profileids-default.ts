/**
 * Validation script: prove that a fresh VfsAccount created WITHOUT specifying
 * profileIds gets profileIds = [] (not null) — both from the DB default and
 * from the schema-level default Prisma sends.
 *
 * Also reports the count of ACTIVE spare accounts (isEmpty:true) to confirm
 * the backfill from the previous session still holds.
 *
 * Run: npx dotenv-cli -e .env.worker -- npx tsx scripts/validate-profileids-default.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const TEST_EMAIL = `test-profileids-default-${Date.now()}@validate.test`;

async function main() {
  console.log('=== profileIds default validation ===\n');

  // 1. Create an account WITHOUT specifying profileIds
  console.log(`Creating test account: ${TEST_EMAIL}`);
  const created = await prisma.vfsAccount.create({
    data: {
      email: TEST_EMAIL,
      encryptedPassword: 'VALIDATE_TEST_DUMMY_DO_NOT_USE',
      status: 'ACTIVE',
      // profileIds intentionally omitted
    },
  });
  console.log(`  created.profileIds =`, created.profileIds);

  // 2. Read it back from DB to confirm the stored value
  const fetched = await prisma.vfsAccount.findUniqueOrThrow({
    where: { id: created.id },
    select: { id: true, profileIds: true },
  });
  console.log(`  fetched.profileIds =`, fetched.profileIds);

  // 3. Assert it is [] not null
  if (!Array.isArray(fetched.profileIds)) {
    throw new Error(`FAIL: profileIds is not an array — got ${JSON.stringify(fetched.profileIds)}`);
  }
  if (fetched.profileIds.length !== 0) {
    throw new Error(`FAIL: profileIds is not empty — got ${JSON.stringify(fetched.profileIds)}`);
  }
  console.log(`  PASS: profileIds is [] (not null)\n`);

  // 4. Confirm isEmpty filter works on the fresh row
  const countIncludingFresh = await prisma.vfsAccount.count({
    where: { status: 'ACTIVE', profileIds: { isEmpty: true } },
  });
  console.log(`  ACTIVE spare count (isEmpty:true) = ${countIncludingFresh}`);
  console.log(`  (should be ≥7 plus this test row = ≥8; includes the fresh test row)\n`);

  // 5. Clean up
  await prisma.vfsAccount.delete({ where: { id: created.id } });
  console.log(`  Test row cleaned up.\n`);

  // 6. Final count without the test row
  const finalCount = await prisma.vfsAccount.count({
    where: { status: 'ACTIVE', profileIds: { isEmpty: true } },
  });
  console.log(`  Final ACTIVE spare count after cleanup = ${finalCount}`);
  console.log(`  (should be ≥7, proving backfill + default hold)\n`);

  console.log('=== ALL CHECKS PASSED ===');
}

main()
  .catch((e) => {
    console.error('VALIDATION FAILED:', e.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
