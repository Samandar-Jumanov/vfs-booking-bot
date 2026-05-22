import { randomUUID } from 'crypto';
import { autoRegisterAccount } from './accountAutoRegister.service';
import { emitToUser } from '@modules/websocket/ws.server';
import { WS_EVENTS } from '@modules/websocket/ws.events';

export interface AutoCreateBatchInput {
  count: number;
  source: string;
  destination: string;
  countryCode: string;
  spacingSeconds: number;
  operatorUserId: string;
}

export interface AutoCreateBatchSnapshot {
  batchId: string;
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'CANCELLED';
  total: number;
  completed: number;
  succeeded: number;
  failed: number;
  spacingSeconds: number;
  nextSpacingSeconds: number;
  lastResult?: BatchAccountResult;
  cancelRequested: boolean;
  startedAt?: string;
  finishedAt?: string;
}

export interface BatchAccountResult {
  index: number;
  ok: boolean;
  accountId?: string;
  email?: string;
  reason?: string;
}

type AutoRegisterFn = typeof autoRegisterAccount;
type EmitFn = typeof emitToUser;
type SleepFn = (ms: number) => Promise<void>;

const MAX_SPACING_SECONDS = 1800;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitFailure(reason: string): boolean {
  return /429201|429|rate.?limit|too.?many/i.test(reason);
}

export class AccountBatchService {
  private batches = new Map<string, AutoCreateBatchSnapshot & { operatorUserId: string }>();
  private queueTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly runAutoRegister: AutoRegisterFn = autoRegisterAccount,
    private readonly emit: EmitFn = emitToUser,
    private readonly sleep: SleepFn = defaultSleep,
  ) {}

  startBatch(input: AutoCreateBatchInput): AutoCreateBatchSnapshot {
    const batchId = randomUUID();
    const batch: AutoCreateBatchSnapshot & { operatorUserId: string } = {
      batchId,
      status: 'QUEUED',
      total: input.count,
      completed: 0,
      succeeded: 0,
      failed: 0,
      spacingSeconds: input.spacingSeconds,
      nextSpacingSeconds: input.spacingSeconds,
      cancelRequested: false,
      operatorUserId: input.operatorUserId,
    };

    this.batches.set(batchId, batch);
    this.queueTail = this.queueTail
      .then(() => this.processBatch(batchId, input))
      .catch(() => undefined);

    return this.snapshot(batch);
  }

  getBatch(batchId: string): AutoCreateBatchSnapshot | null {
    const batch = this.batches.get(batchId);
    return batch ? this.snapshot(batch) : null;
  }

  cancelBatch(batchId: string, operatorUserId: string): AutoCreateBatchSnapshot | null {
    const batch = this.batches.get(batchId);
    if (!batch || batch.operatorUserId !== operatorUserId) return null;
    batch.cancelRequested = true;
    if (batch.status === 'QUEUED') {
      batch.status = 'CANCELLED';
      batch.finishedAt = new Date().toISOString();
      this.emitProgress(batch);
    }
    return this.snapshot(batch);
  }

  private async processBatch(batchId: string, input: AutoCreateBatchInput): Promise<void> {
    const batch = this.batches.get(batchId);
    if (!batch || batch.status === 'CANCELLED') return;

    batch.status = 'RUNNING';
    batch.startedAt = new Date().toISOString();
    let currentSpacingSeconds = input.spacingSeconds;

    for (let index = 1; index <= input.count; index += 1) {
      if (batch.cancelRequested) break;

      let result: BatchAccountResult;
      try {
        const account = await this.runAutoRegister({
          source: input.source,
          destination: input.destination,
          countryCode: input.countryCode,
          operatorUserId: input.operatorUserId,
        });

        if (account.ok) {
          batch.succeeded += 1;
          result = { index, ok: true, accountId: account.accountId, email: account.email };
        } else {
          batch.failed += 1;
          result = { index, ok: false, reason: account.reason };
        }
      } catch (err) {
        batch.failed += 1;
        result = { index, ok: false, reason: err instanceof Error ? err.message : String(err) };
      }

      if (!result.ok && isRateLimitFailure(result.reason ?? '')) {
        currentSpacingSeconds = Math.min(MAX_SPACING_SECONDS, currentSpacingSeconds * 2);
      }

      batch.completed += 1;
      batch.lastResult = result;
      batch.nextSpacingSeconds = currentSpacingSeconds;
      this.emitProgress(batch);

      if (index < input.count && !batch.cancelRequested) {
        await this.sleep(currentSpacingSeconds * 1000);
      }
    }

    batch.status = batch.cancelRequested ? 'CANCELLED' : 'COMPLETED';
    batch.finishedAt = new Date().toISOString();
    this.emitProgress(batch);
  }

  private emitProgress(batch: AutoCreateBatchSnapshot & { operatorUserId: string }): void {
    try {
      this.emit(batch.operatorUserId, WS_EVENTS.BATCH_PROGRESS, this.snapshot(batch));
    } catch {
      // Batch execution must continue even if the operator dashboard is offline.
    }
  }

  private snapshot(batch: AutoCreateBatchSnapshot & { operatorUserId?: string }): AutoCreateBatchSnapshot {
    const { operatorUserId: _operatorUserId, ...snapshot } = batch;
    return { ...snapshot };
  }
}

export const accountBatchService = new AccountBatchService();
