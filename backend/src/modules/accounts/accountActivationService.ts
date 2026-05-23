import crypto from 'crypto';
import { AccountStatus } from '@prisma/client';
import { prisma } from '@config/database';
import { sendToExtension } from '@modules/websocket/ws.server';
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
  if (!link) return { ok: false, reason: 'EMAIL_LINK_NOT_RECEIVED' };

  try {
    const resp = await visitActivationLink(link);
    if (resp.status >= 400) return { ok: false, reason: `EMAIL_LINK_VISIT_FAILED_${resp.status}` };
  } catch (err) {
    return { ok: false, reason: `EMAIL_LINK_VISIT_ERROR_${(err as Error).message}` };
  }

  await prisma.vfsAccount.update({
    where: { id: accountId },
    data: { status: AccountStatus.ACTIVE },
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
