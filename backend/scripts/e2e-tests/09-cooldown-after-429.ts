import { runE2e, assert, cleanupByEmailPrefix, createTestAccount, withTestServer } from './common';

runE2e('9. Cooldown after 429 from VFS', async () => {
  const prefix = 'e2e-cooldown';
  await cleanupByEmailPrefix(prefix);
  try {
    const account = await createTestAccount(prefix, { email: `${prefix}-${Date.now()}@e2e.local` });
    const { prisma } = await import('../../src/config/database');
    await withTestServer(async ({ baseUrl, authHeader }) => {
      const res = await fetch(`${baseUrl}/api/accounts/${account.id}/cooldown`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', ...authHeader },
        body: JSON.stringify({ minutes: 5 }),
      });
      assert(res.ok, `account cooldown returned HTTP ${res.status}`);
      const body = await res.json() as { message?: string };
      assert(body.message === 'Account put into COOLDOWN for 5 minute(s)', `unexpected cooldown response "${body.message}"`);
    });
    const updated = await prisma.vfsAccount.findUniqueOrThrow({ where: { id: account.id } });
    assert(updated.status === 'COOLDOWN', 'account was not marked COOLDOWN');
    assert(updated.cooldownUntil && updated.cooldownUntil.getTime() > Date.now(), 'cooldownUntil was not set in the future');
  } finally {
    await cleanupByEmailPrefix(prefix);
  }
});
