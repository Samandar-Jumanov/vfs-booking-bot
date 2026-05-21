import { runE2e, assert, cleanupByEmailPrefix, createTestAccount } from './common';

runE2e('9. Cooldown after 429 from VFS', async () => {
  const prefix = 'e2e-cooldown';
  await cleanupByEmailPrefix(prefix);
  const account = await createTestAccount(prefix, { email: `${prefix}-${Date.now()}@e2e.local` });
  const { prisma } = await import('../../src/config/database');
  const { accountPoolService } = await import('../../src/modules/accounts/accountPool.service');
  await accountPoolService.markCooldown(account.id, 5);
  const updated = await prisma.vfsAccount.findUniqueOrThrow({ where: { id: account.id } });
  assert(updated.status === 'COOLDOWN', 'account was not marked COOLDOWN');
  assert(updated.cooldownUntil && updated.cooldownUntil.getTime() > Date.now(), 'cooldownUntil was not set in the future');
  await cleanupByEmailPrefix(prefix);
});
