import { randomUUID } from 'crypto';
import { prisma } from '@config/database';
import { loginAccount } from './accountLoginService';

export type LoginBatchItemState = 'pending' | 'running' | 'success' | 'failed';
export type LoginBatchState = 'running' | 'done' | 'cancelled';

export interface LoginBatchItem {
  accountId: string;
  email: string;
  state: LoginBatchItemState;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

export interface LoginBatchJob {
  jobId: string;
  startedAt: string;
  finishedAt: string | null;
  state: LoginBatchState;
  cancelRequested: boolean;
  items: LoginBatchItem[];
}

type LoginRunner = (accountId: string) => Promise<{ success: boolean; reason?: string }>;

const DEFAULT_SPACING_MS = 60_000;
const jobs = new Map<string, LoginBatchJob>();
let runAutoLogin: LoginRunner = loginAccount;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function setLoginBatchRunnerForSmoke(runner: LoginRunner): void {
  runAutoLogin = runner;
}

export function resetLoginBatchRunnerForSmoke(): void {
  runAutoLogin = loginAccount;
}

export async function startLoginBatch(accountIds: string[], spacingMs = DEFAULT_SPACING_MS): Promise<string> {
  const uniqueIds = Array.from(new Set(accountIds.filter(Boolean)));
  const accounts = await prisma.vfsAccount.findMany({
    where: { id: { in: uniqueIds } },
    select: { id: true, email: true },
  });
  const emailById = new Map(accounts.map((account) => [account.id, account.email]));

  const job: LoginBatchJob = {
    jobId: randomUUID(),
    startedAt: new Date().toISOString(),
    finishedAt: null,
    state: 'running',
    cancelRequested: false,
    items: uniqueIds.map((accountId) => ({
      accountId,
      email: emailById.get(accountId) ?? accountId,
      state: 'pending',
      startedAt: null,
      finishedAt: null,
      error: emailById.has(accountId) ? null : 'Account not found',
    })),
  };

  for (const item of job.items) {
    if (item.error) item.state = 'failed';
  }

  jobs.set(job.jobId, job);
  void runLoginBatch(job.jobId, Math.max(0, spacingMs));
  return job.jobId;
}

export function getLoginBatch(jobId: string): LoginBatchJob | undefined {
  const job = jobs.get(jobId);
  return job ? cloneJob(job) : undefined;
}

export function cancelLoginBatch(jobId: string): boolean {
  const job = jobs.get(jobId);
  if (!job) return false;
  job.cancelRequested = true;
  if (job.state === 'running' && !job.items.some((item) => item.state === 'running')) {
    markPendingCancelled(job);
  }
  return true;
}

async function runLoginBatch(jobId: string, spacingMs: number): Promise<void> {
  const job = jobs.get(jobId);
  if (!job) return;

  for (let index = 0; index < job.items.length; index += 1) {
    const item = job.items[index];
    if (job.cancelRequested) break;
    if (item.state === 'failed') continue;

    item.state = 'running';
    item.startedAt = new Date().toISOString();
    try {
      const result = await runAutoLogin(item.accountId);
      item.state = result.success ? 'success' : 'failed';
      item.error = result.success ? null : (result.reason ?? 'Auto-login failed');
    } catch (err) {
      item.state = 'failed';
      item.error = err instanceof Error ? err.message : String(err);
    } finally {
      item.finishedAt = new Date().toISOString();
    }

    if (!job.cancelRequested && index < job.items.length - 1) {
      await sleep(spacingMs);
    }
  }

  if (job.cancelRequested) {
    markPendingCancelled(job);
  }
  job.state = job.cancelRequested ? 'cancelled' : 'done';
  job.finishedAt = new Date().toISOString();
}

function markPendingCancelled(job: LoginBatchJob): void {
  for (const item of job.items) {
    if (item.state === 'pending') {
      item.state = 'failed';
      item.error = 'Cancelled';
      item.finishedAt = new Date().toISOString();
    }
  }
}

function cloneJob(job: LoginBatchJob): LoginBatchJob {
  return {
    ...job,
    items: job.items.map((item) => ({ ...item })),
  };
}
