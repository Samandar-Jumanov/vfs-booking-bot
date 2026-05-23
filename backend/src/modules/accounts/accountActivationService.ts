import crypto from 'crypto';
import { AccountStatus, EventType } from '@prisma/client';
import { prisma } from '@config/database';
import { sendToExtension } from '@modules/websocket/ws.server';
import { logEvent } from '@modules/logs/logger';
import { fetchEmailVerificationLink, visitActivationLink } from './accountAutoRegister.service';

const ACTIVATION_TIMEOUT_MS = 180_000;

type ActivationResult = { ok: true } | { ok: false; reason: string };

const submittedWaiters = new Map<string, {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}>();

export async function runActivation(
  accountId: string,
  email: string,
  operatorUserId: string,
): Promise<ActivationResult> {
  const correlationId = crypto.randomUUID();

  const loginUrl = 'https://visa.vfsglobal.com/uzb/en/lva/login';
  const accepted = sendToExtension(operatorUserId, {
    type: 'BG_ACTIVATE_VFS_ACCOUNT',
    email,
    loginUrl,
    correlationId,
  });
  if (!accepted) return { ok: false, reason: 'OPERATOR_EXTENSION_OFFLINE' };

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        submittedWaiters.delete(correlationId);
        reject(new Error('ACTIVATION_FORM_NOT_SUBMITTED'));
      }, ACTIVATION_TIMEOUT_MS);
      submittedWaiters.set(correlationId, { resolve, reject, timer });
    });
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }

  const link = await fetchEmailVerificationLink(email);
  if (!link) {
    logEvent('warn', EventType.BOOKING_FAILED, `[ACTIVATE] email link never arrived for ${email}`, {
      accountId,
      result: 'EMAIL_LINK_NOT_RECEIVED',
      correlationId,
    });
    return { ok: false, reason: 'EMAIL_LINK_NOT_RECEIVED' };
  }
  logEvent('info', EventType.BOOKING_ATTEMPT, `[ACTIVATE] activation email link found for ${email}`, {
    accountId,
    correlationId,
  });

  try {
    const resp = await visitActivationLink(link);
    logEvent('info', EventType.BOOKING_ATTEMPT, `[ACTIVATE] activation link visit status=${resp.status} for ${email}`, {
      accountId,
      result: String(resp.status),
      correlationId,
    });
    if (resp.status >= 400) {
      logEvent('warn', EventType.BOOKING_FAILED, `[ACTIVATE] activation link visit failed status=${resp.status} for ${email}`, {
        accountId,
        result: `EMAIL_LINK_VISIT_FAILED_${resp.status}`,
        correlationId,
      });
      return { ok: false, reason: `EMAIL_LINK_VISIT_FAILED_${resp.status}` };
    }
  } catch (err) {
    logEvent('error', EventType.BOOKING_FAILED, `[ACTIVATE] activation link visit threw for ${email}: ${(err as Error).message}`, {
      accountId,
      result: `EMAIL_LINK_VISIT_ERROR_${(err as Error).message}`,
      correlationId,
    });
    return { ok: false, reason: `EMAIL_LINK_VISIT_ERROR_${(err as Error).message}` };
  }

  await prisma.vfsAccount.update({
    where: { id: accountId },
    data: { status: AccountStatus.ACTIVE },
  });

  logEvent('info', EventType.BOOKING_SUCCESS, `[ACTIVATE] account flipped to ACTIVE for ${email}`, {
    accountId,
    result: 'ACTIVE',
    correlationId,
  });

  sendToExtension(operatorUserId, {
    type: 'BG_ACTIVATION_DONE',
    correlationId,
    ok: true,
  });

  return { ok: true };
}

export function resolveActivationSubmitted(correlationId: string): void {
  const entry = submittedWaiters.get(correlationId);
  if (!entry) return;
  submittedWaiters.delete(correlationId);
  clearTimeout(entry.timer);
  entry.resolve();
}

export function resolveActivationSuccess(correlationId: string): void {
  // Extension confirmed activation visible in DOM — treat as submitted signal
  // if the submitted waiter hasn't fired yet.
  resolveActivationSubmitted(correlationId);
}

export function resolveActivationFailed(correlationId: string, reason: string): void {
  const entry = submittedWaiters.get(correlationId);
  if (!entry) return;
  submittedWaiters.delete(correlationId);
  clearTimeout(entry.timer);
  entry.reject(new Error(reason));
}
