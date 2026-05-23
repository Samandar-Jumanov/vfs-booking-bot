import { prisma } from '@config/database';
import { getLoginBatch, resetLoginBatchRunnerForSmoke, setLoginBatchRunnerForSmoke, startLoginBatch } from '@modules/accounts/loginBatch.service';

async function wait(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const suffix = Date.now();
  const ids = ['a', 'b', 'c'].map((id) => `smoke-login-${id}-${suffix}`);
  const emails = ids.map((id) => `${id}@example.test`);

  await prisma.vfsAccount.deleteMany({ where: { id: { in: ids } } });
  await prisma.vfsAccount.createMany({
    data: ids.map((id, index) => ({
      id,
      email: emails[index],
      encryptedPassword: 'smoke',
      status: 'ACTIVE',
      profileIds: [],
    })),
  });

  const seenRunning: string[] = [];
  setLoginBatchRunnerForSmoke(async (accountId) => {
    seenRunning.push(accountId);
    await wait(200);
    return { success: !accountId.includes('-b-'), reason: accountId.includes('-b-') ? 'stub failure' : undefined };
  });

  try {
    const spacingMs = 50;
    const started = Date.now();
    const jobId = await startLoginBatch(ids, spacingMs);
    let job = getLoginBatch(jobId);
    while (job?.state === 'running' && Date.now() - started < 10_000) {
      await wait(100);
      job = getLoginBatch(jobId);
    }

    if (!job) throw new Error('Batch job was not created');
    if (job.state !== 'done') throw new Error(`Expected done job, got ${job.state}`);
    if (job.items.length !== 3) throw new Error(`Expected 3 items, got ${job.items.length}`);
    if (job.items.some((item) => item.startedAt === null || item.finishedAt === null)) {
      throw new Error('Expected all items to record start and finish times');
    }
    if (job.items.every((item) => item.state !== 'failed')) {
      throw new Error('Expected one stubbed item to fail');
    }
    if (seenRunning.join(',') !== ids.join(',')) {
      throw new Error(`Expected sequential run order ${ids.join(',')}, got ${seenRunning.join(',')}`);
    }
    if (Date.now() - started < spacingMs * 2) {
      throw new Error('Batch completed too quickly; spacing was not honored');
    }

    console.log(`job=${job.jobId}`);
    console.log(`states=${job.items.map((item) => item.state).join(',')}`);
  } finally {
    resetLoginBatchRunnerForSmoke();
    await prisma.vfsAccount.deleteMany({ where: { id: { in: ids } } });
    await prisma.$disconnect();
  }
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : String(err));
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
