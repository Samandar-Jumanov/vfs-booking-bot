import { prisma } from '@config/database';
import { selectFreshBookerAccount } from '@modules/booking/extension-dispatch.service';
import { selectFreshWatcherAccount } from '@modules/monitor/monitor.service';

async function main() {
  const suffix = Date.now();
  const emails = {
    watcher: `smoke-watcher-${suffix}@example.test`,
    booker: `smoke-booker-${suffix}@example.test`,
    both: `smoke-both-${suffix}@example.test`,
  };

  await prisma.vfsAccount.deleteMany({ where: { email: { in: Object.values(emails) } } });

  const common = {
    encryptedPassword: 'smoke',
    status: 'ACTIVE' as const,
    lastWarmedAt: new Date(),
    cookieStore: { hasDatadome: true, jar: [{ name: 'datadome', value: 'ok' }] },
    profileIds: ['smoke-profile'],
  };

  try {
    await prisma.vfsAccount.create({ data: { ...common, email: emails.watcher, pollingRole: 'WATCHER' } });
    await prisma.vfsAccount.create({ data: { ...common, email: emails.booker, pollingRole: 'BOOKER' } });
    await prisma.vfsAccount.create({ data: { ...common, email: emails.both, pollingRole: 'BOTH' } });

    const poller = await selectFreshWatcherAccount(['smoke-profile']);
    if (!poller || poller.email === emails.booker) {
      throw new Error(`Expected WATCHER/BOTH poller, got ${poller?.email ?? 'none'}`);
    }

    const booker = await selectFreshBookerAccount('smoke-profile', poller.email);
    if (!booker || booker.email === emails.watcher || booker.email === poller.email) {
      throw new Error(`Expected BOOKER/BOTH booker different from poller, got ${booker?.email ?? 'none'}`);
    }

    console.log(`poller=${poller.email}`);
    console.log(`booker=${booker.email}`);
  } finally {
    await prisma.vfsAccount.deleteMany({ where: { email: { in: Object.values(emails) } } });
    await prisma.$disconnect();
  }
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : String(err));
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
