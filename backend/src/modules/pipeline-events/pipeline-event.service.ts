/**
 * PipelineEvent service — structured before/after logging for every pipeline
 * action. Captures state transitions, errors, URLs, and screenshots so ops can
 * reconstruct exactly what happened on a failure. CRITICAL severity automatically
 * fires a Telegram alert.
 *
 * IMPORTANT: createEvent() never throws — log failures must not kill the pipeline.
 */

import { prisma } from '@config/database';
import { sendTelegram } from '../notifications/telegram.bot';

export interface PipelineEventInput {
  action: string;
  accountId?: string;
  profileId?: string;
  beforeState?: string;
  afterState?: string;
  error?: string;
  url?: string;
  screenshotPath?: string;
  lastNetwork?: string;
  severity?: 'INFO' | 'WARN' | 'CRITICAL';
}

/**
 * Write a pipeline event to the DB. Never throws — a logging failure must not
 * kill the pipeline. On CRITICAL severity, fires a Telegram alert after the
 * DB write (also swallowed if Telegram is not configured).
 */
export async function createEvent(input: PipelineEventInput): Promise<void> {
  const severity = input.severity ?? 'INFO';

  try {
    await (prisma as any).pipelineEvent.create({
      data: {
        action: input.action,
        accountId: input.accountId ?? null,
        profileId: input.profileId ?? null,
        beforeState: input.beforeState ?? null,
        afterState: input.afterState ?? null,
        error: input.error ?? null,
        url: input.url ?? null,
        screenshotPath: input.screenshotPath ?? null,
        lastNetwork: input.lastNetwork ?? null,
        severity,
      },
    });
  } catch (dbErr) {
    console.warn(
      '[PipelineEvent] DB write failed (migration not applied yet?):',
      (dbErr as Error).message,
    );
  }

  if (severity === 'CRITICAL') {
    if (!process.env.TELEGRAM_BOT_TOKEN) return;
    const message =
      `🚨 CRITICAL pipeline event\n` +
      `Action: ${input.action}\n` +
      `Error: ${input.error ?? 'N/A'}\n` +
      `Account: ${input.accountId ?? 'N/A'}`;
    try {
      await sendTelegram(message);
    } catch (telegramErr) {
      console.warn(
        '[PipelineEvent] Telegram alert failed:',
        (telegramErr as Error).message,
      );
    }
  }
}

/**
 * Wraps an async action with automatic before/after pipeline event logging.
 * On success, logs an INFO event (with afterState if the result exposes it).
 * On error, logs a CRITICAL event and re-throws so the caller's error handling
 * is not bypassed.
 *
 * @param input  Base event fields (without afterState/error/severity — those are set automatically)
 * @param fn     The async action to run
 * @returns      The result of fn()
 */
export async function wrapAction<T>(
  input: Omit<PipelineEventInput, 'afterState' | 'error' | 'severity'>,
  fn: () => Promise<T>,
): Promise<T> {
  let result: T;
  try {
    result = await fn();
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    await createEvent({
      ...input,
      severity: 'CRITICAL',
      error: errorMessage,
    });
    throw err;
  }

  // Extract afterState from the result if it exposes a lifecycleState or afterState field
  const afterState =
    result != null && typeof result === 'object'
      ? ((result as Record<string, unknown>).afterState as string | undefined) ??
        ((result as Record<string, unknown>).lifecycleState as string | undefined)
      : undefined;

  await createEvent({
    ...input,
    severity: 'INFO',
    afterState,
  });

  return result;
}

export const pipelineEvents = { createEvent, wrapAction };
