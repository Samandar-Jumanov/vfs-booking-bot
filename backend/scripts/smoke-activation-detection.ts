/**
 * Smoke test: verify loginAccount branches correctly based on VfsAccount.status.
 *
 * Strategy: create one PENDING + one ACTIVE dummy account with no operator
 * online. Both calls will fail at sendToExtension, but the failure REASON
 * tells us which branch ran:
 *   - PENDING account → reason is `ACTIVATION_FAILED:OPERATOR_EXTENSION_OFFLINE`
 *     (proves it entered the activation branch first)
 *   - ACTIVE account  → reason is `OPERATOR_EXTENSION_OFFLINE`
 *     (proves it skipped activation and went straight to login dispatch)
 *
 * Pass: both expectations met → exit 0.
 */
import { prisma } from '../src/config/database';
import { AccountStatus } from '@prisma/client';
import { loginAccount } from '../src/modules/accounts/accountLoginService';
import { encrypt } from '../src/utils/crypto';

const PENDING_EMAIL = `smoke-pending-${Date.now()}@example.test`;
const ACTIVE_EMAIL = `smoke-active-${Date.now()}@example.test`;

async function main(): Promise<void> {
  let exitCode = 0;
  const accountIds: string[] = [];

  try {
    // 1. Create dummy accounts.
    const pending = await prisma.vfsAccount.create({
      data: {
        email: PENDING_EMAIL,
        encryptedPassword: encrypt('dummy'),
        status: AccountStatus.PENDING,
        profileIds: [],
      },
    });
    const active = await prisma.vfsAccount.create({
      data: {
        email: ACTIVE_EMAIL,
        encryptedPassword: encrypt('dummy'),
        status: AccountStatus.ACTIVE,
        profileIds: [],
      },
    });
    accountIds.push(pending.id, active.id);

    // 2. Call loginAccount — no operator is online, so both will fail.
    //    Distinguish by reason prefix.
    const pendingResult = await loginAccount(pending.id);
    const activeResult = await loginAccount(active.id);

    console.log('pending:', JSON.stringify(pendingResult));
    console.log('active:', JSON.stringify(activeResult));

    if (pendingResult.success) {
      console.error('FAIL: PENDING account login unexpectedly succeeded');
      exitCode = 1;
    } else if (!pendingResult.reason.startsWith('ACTIVATION_FAILED:')) {
      console.error('FAIL: PENDING account did not enter activation branch — reason:', pendingResult.reason);
      exitCode = 1;
    }

    if (activeResult.success) {
      console.error('FAIL: ACTIVE account login unexpectedly succeeded');
      exitCode = 1;
    } else if (activeResult.reason.startsWith('ACTIVATION_FAILED:')) {
      console.error('FAIL: ACTIVE account entered activation branch (it should not) — reason:', activeResult.reason);
      exitCode = 1;
    }

    if (exitCode === 0) {
      console.log('PASS: branch logic correct (PENDING → activation, ACTIVE → login)');
    }
  } finally {
    // 3. Cleanup.
    if (accountIds.length) {
      await prisma.vfsAccount.deleteMany({ where: { id: { in: accountIds } } });
    }
    await prisma.$disconnect();
  }

  process.exit(exitCode);
}

main().catch((err) => {
  console.error('smoke crashed:', err);
  process.exit(1);
});
