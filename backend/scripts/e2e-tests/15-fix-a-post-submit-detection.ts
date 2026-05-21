import { assert, liveOnly, readResponseBody, runE2e, sleep } from './common';

runE2e('15. Fix A post-submit auto-create persists ACTIVE account', async () => {
  liveOnly('E2E_LIVE_AUTO_CREATE', 'auto-create requires live vendor credentials, a live backend, and the operator extension connected');

  const baseUrl = process.env.E2E_BASE_URL?.replace(/\/$/, '');
  const token = process.env.E2E_AUTH_TOKEN;
  assert(Boolean(baseUrl), 'E2E_BASE_URL is required for the live auto-create route');
  assert(Boolean(token), 'E2E_AUTH_TOKEN is required for the live auto-create route');

  const { prisma } = await import('../../src/config/database');
  const startedAt = new Date();
  const beforeActiveIds = new Set((await prisma.vfsAccount.findMany({
    where: { status: 'ACTIVE' },
    select: { id: true },
  })).map((account) => account.id));

  const controller = new AbortController();
  let completed: { ok: boolean; status: number; body: unknown } | undefined;
  let dispatchError: unknown;
  const dispatch = fetch(`${baseUrl}/api/accounts/auto-create`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: token.startsWith('Bearer ') ? token : `Bearer ${token}`,
    },
    body: JSON.stringify({
      source: process.env.E2E_AUTO_CREATE_SOURCE ?? 'uzb',
      destination: process.env.E2E_AUTO_CREATE_DESTINATION ?? 'lva',
      countryCode: process.env.E2E_AUTO_CREATE_COUNTRY_CODE ?? '171',
    }),
    signal: controller.signal,
  }).then(async (res) => {
    completed = { ok: res.ok, status: res.status, body: await readResponseBody(res) };
  }).catch((err) => {
    if (!(err instanceof Error) || err.name !== 'AbortError') dispatchError = err;
  });

  try {
    await sleep(90_000);

    if (dispatchError) {
      throw dispatchError;
    }
    if (completed && !completed.ok) {
      throw new Error(`auto-create returned HTTP ${completed.status}: ${JSON.stringify(completed.body)}`);
    }

    const created = await prisma.vfsAccount.findFirst({
      where: {
        status: 'ACTIVE',
        createdAt: { gte: startedAt },
        id: { notIn: Array.from(beforeActiveIds) },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, email: true, createdAt: true },
    });
    assert(Boolean(created), 'no new ACTIVE VfsAccount was persisted within 90s after auto-create dispatch');
  } finally {
    controller.abort();
    await dispatch.catch(() => undefined);
  }
});
