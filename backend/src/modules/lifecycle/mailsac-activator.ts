import type { DriverResult } from './types';
import type { ActivatorFn } from './lifecycle.service';
import { fetchEmailVerificationLink, visitActivationLink } from '@modules/accounts/accountAutoRegister.service';
import { prisma } from '@config/database';

/**
 * ActivatorFn implementation for the Mailsac-based activation step.
 * Fetches the activation link from the account's Mailsac inbox and visits it.
 * Returns code=NO_EMAIL_LINK when the link hasn't arrived yet (caller retries later).
 */
export const mailsacActivator: ActivatorFn = async (accountId: string): Promise<DriverResult> => {
  const account = await prisma.vfsAccount.findUnique({
    where: { id: accountId },
    select: { email: true },
  });
  if (!account) return { ok: false, code: 'UNKNOWN', reason: 'Account not found' };

  const link = await fetchEmailVerificationLink(account.email);
  if (!link) {
    return { ok: false, code: 'NO_EMAIL_LINK', reason: 'Activation link not found in Mailsac inbox' };
  }

  try {
    const resp = await visitActivationLink(link);
    if (resp.status >= 400) {
      return { ok: false, code: 'UNKNOWN', reason: `Activation link visit returned ${resp.status}` };
    }
    return { ok: true, code: 'OK' };
  } catch (err) {
    return { ok: false, code: 'UNKNOWN', reason: `Activation link visit failed: ${(err as Error).message}` };
  }
};
