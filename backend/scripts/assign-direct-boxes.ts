/**
 * Assign ACTIVE VFS accounts into direct-worker watcher/booker pairs.
 *
 * DB-only: no VFS contact.
 *
 * Default is a dry plan:
 *   npx tsx scripts/assign-direct-boxes.ts
 *
 * Apply/reset and write env patches:
 *   $env:ASSIGN_BOXES_APPLY='1'
 *   $env:ASSIGN_BOX_COUNT='10'
 *   $env:ASSIGN_PAIRS_PER_BOX='2'
 *   $env:ASSIGN_RESET='1'
 *   npx tsx scripts/assign-direct-boxes.ts
 */
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';

dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config({ path: path.resolve(__dirname, '../.env.worker'), override: true });

const prisma = new PrismaClient();

const BOX_COUNT = Number(process.env.ASSIGN_BOX_COUNT ?? process.env.BOX_COUNT ?? 10);
const PAIRS_PER_BOX = Number(process.env.ASSIGN_PAIRS_PER_BOX ?? 1);
const APPLY = process.env.ASSIGN_BOXES_APPLY === '1';
const RESET = process.env.ASSIGN_RESET === '1';
const OUT_DIR = path.resolve(__dirname, '../../ops/vps-env/assignments');

type UsableAccount = {
  id: string;
  email: string;
  profileIds: string[];
  pollingRole: string;
  createdAt: Date;
};

type ActiveProfile = {
  id: string;
  fullName: string;
  priority: string;
  createdAt: Date;
};

function usableWhere(now = new Date()) {
  return {
    status: 'ACTIVE' as const,
    lifecycleState: { notIn: ['BLOCKED', 'BOOKED', 'RESTRICTED'] as const },
    OR: [{ cooldownUntil: null }, { cooldownUntil: { lte: now } }],
  };
}

async function main() {
  if (!Number.isFinite(BOX_COUNT) || BOX_COUNT < 1) {
    throw new Error(`ASSIGN_BOX_COUNT/BOX_COUNT must be positive, got ${BOX_COUNT}`);
  }
  if (!Number.isFinite(PAIRS_PER_BOX) || PAIRS_PER_BOX < 1) {
    throw new Error(`ASSIGN_PAIRS_PER_BOX must be positive, got ${PAIRS_PER_BOX}`);
  }

  const profiles = await prisma.profile.findMany({
    where: { isActive: true },
    select: { id: true, fullName: true, priority: true, createdAt: true },
    orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
    take: BOX_COUNT,
  }) as ActiveProfile[];

  const accounts = await prisma.vfsAccount.findMany({
    where: usableWhere(),
    select: { id: true, email: true, profileIds: true, pollingRole: true, createdAt: true },
    orderBy: [{ profileIds: 'asc' }, { createdAt: 'asc' }],
  }) as UsableAccount[];

  const neededAccounts = BOX_COUNT * PAIRS_PER_BOX * 2;
  console.log(`\n=== assign-direct-boxes ===`);
  console.log(`Mode      : ${APPLY ? 'APPLY' : 'DRY-RUN'}`);
  console.log(`Reset     : ${RESET ? 'yes' : 'no'}`);
  console.log(`Boxes     : ${BOX_COUNT}`);
  console.log(`Pairs/box : ${PAIRS_PER_BOX}`);
  console.log(`Profiles  : ${profiles.length}/${BOX_COUNT}`);
  console.log(`Usable accts: ${accounts.length}/${neededAccounts}`);

  if (profiles.length < BOX_COUNT) {
    throw new Error(`Need ${BOX_COUNT} active profiles, only found ${profiles.length}`);
  }
  if (accounts.length < neededAccounts) {
    throw new Error(`Need ${neededAccounts} usable ACTIVE accounts, only found ${accounts.length}`);
  }

  const available = RESET ? accounts : accounts.filter((a) => a.profileIds.length === 0);
  if (available.length < neededAccounts) {
    throw new Error(
      `Need ${neededAccounts} ${RESET ? 'usable' : 'spare/unlinked'} accounts, found ${available.length}. ` +
      `Set ASSIGN_RESET=1 to rebalance existing linked accounts.`,
    );
  }

  const boxes = profiles.map((profile, boxIdx) => {
    const pairs = Array.from({ length: PAIRS_PER_BOX }, (_, pairIdx) => {
      const offset = (boxIdx * PAIRS_PER_BOX + pairIdx) * 2;
      const watcher = available[offset]!;
      const booker = available[offset + 1]!;
      return { pair: pairIdx + 1, watcher, booker };
    });
    return { box: boxIdx + 1, profile, pairs };
  });

  console.log('\nPLAN:');
  for (const b of boxes) {
    console.log(`box${b.box}: ${b.profile.fullName}`);
    for (const p of b.pairs) {
      console.log(`  pair${p.pair}: WATCHER=${p.watcher.email} | BOOKER=${p.booker.email}`);
    }
  }

  if (!APPLY) {
    console.log('\nDRY-RUN only. Set ASSIGN_BOXES_APPLY=1 to write DB/env patches.');
    await prisma.$disconnect();
    return;
  }

  await prisma.$transaction(async (tx) => {
    if (RESET) {
      await tx.vfsAccount.updateMany({
        where: usableWhere(),
        data: { profileIds: [], pollingRole: 'BOTH', lastAttemptAt: null },
      });
    }

    for (const b of boxes) {
      for (const p of b.pairs) {
      await tx.vfsAccount.update({
        where: { id: p.watcher.id },
        data: {
          profileIds: [b.profile.id],
          pollingRole: 'WATCHER',
          lastAttemptAt: null,
          cooldownUntil: null,
          restrictedReason: null,
          lastError: null,
        },
      });
      await tx.vfsAccount.update({
        where: { id: p.booker.id },
        data: {
          profileIds: [b.profile.id],
          pollingRole: 'BOOKER',
          lastAttemptAt: null,
          cooldownUntil: null,
          restrictedReason: null,
          lastError: null,
        },
      });
      }
    }
  }, { timeout: 30_000 });

  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const b of boxes) {
    const file = path.join(OUT_DIR, `box${b.box}.env.patch`);
    const watcherEmails = b.pairs.map((p) => p.watcher.email);
    fs.writeFileSync(
      file,
      [
        `BOX_ID=box${b.box}`,
        'WORKER_DIRECT=1',
        `TARGET_EMAIL=${watcherEmails[0]}`,
        `TARGET_EMAILS=${watcherEmails.join(',')}`,
        'AUTO_STAGGER=1',
        `BOX_COUNT=${BOX_COUNT}`,
        '',
      ].join('\n'),
    );
  }

  console.log(`\nAPPLIED. Env patch files written to ${OUT_DIR}`);
  console.log('Copy each boxN.env.patch values into that VPS backend\\.env.worker.');
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('[assign-direct-boxes] fatal:', (e as Error).message);
  await prisma.$disconnect();
  process.exit(1);
});
