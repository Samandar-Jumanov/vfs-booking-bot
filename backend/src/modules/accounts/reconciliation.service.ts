/**
 * Reconciliation service — finds PENDING accounts and attempts Mailsac activation.
 * Called by the reconciliation cron or by an operator dry-run script.
 * Uses the extension path when the operator is live; falls back to HTTP visit.
 *
 * Each account is processed sequentially (never in parallel) to avoid hammering
 * Mailsac and VFS. Rate-limited by the caller.
 */

import { prisma } from '@config/database';
import { AccountStatus, LifecycleStateEnum } from '@prisma/client';
import {
  fetchEmailVerificationLink,
} from '@modules/accounts/accountAutoRegister.service';
import {
  isExtensionLive,
} from '@modules/websocket/ws.server';
import {
  triggerActivationVisit,
} from '@modules/booking/extension-dispatch.service';

/** A PENDING account that is eligible for Mailsac activation. */
export interface ReconciliationCandidate {
  id: string;
  email: string;
  createdAt: Date;
}

/**
 * Queries all PENDING VfsAccounts that have a Mailsac email address, ordered
 * oldest-first so we clear the backlog in creation order.
 */
export async function findPendingCandidates(): Promise<ReconciliationCandidate[]> {
  const rows = await prisma.vfsAccount.findMany({
    where: {
      status: AccountStatus.PENDING,
      email: { contains: '@mailsac.com' },
    },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      email: true,
      createdAt: true,
    },
  });

  return rows;
}

/**
 * Attempts to activate a single PENDING account by:
 *   1. Fetching the activation link from Mailsac
 *   2. Visiting it via the operator's extension (if live) or HTTP fallback
 *   3. Updating the DB row to ACTIVE on success
 *
 * Returns:
 *  - 'activated'    — link found and activation succeeded
 *  - 'link_missing' — no activation email found in Mailsac
 *  - 'failed'       — link found but visit failed or an unexpected error occurred
 */
export async function tryActivate(
  accountId: string,
): Promise<'activated' | 'link_missing' | 'failed'> {
  // Retrieve the account's email so we can fetch the verification link.
  const account = await prisma.vfsAccount.findUnique({
    where: { id: accountId },
    select: { id: true, email: true },
  });

  if (!account) return 'failed';

  // Step 1: fetch activation link from Mailsac
  const link = await fetchEmailVerificationLink(account.email).catch(() => null);
  if (!link) return 'link_missing';

  // Step 2: visit the activation link — EXTENSION ONLY (fail-loud).
  // The activation link must open in the operator's real, Cloudflare-cleared Chrome.
  // The old HTTP/BrightData fallback was removed: BrightData can't reach vfsglobal
  // (returns status 0) and "succeeding" on a non-2xx produced fake activations
  // (ACTIVE in our DB, inactive at VFS). If the extension is offline we FAIL LOUDLY
  // and leave the account PENDING rather than pretend.
  const operatorUserId = process.env.OPERATOR_USER_ID;
  if (!operatorUserId || !isExtensionLive(operatorUserId)) {
    console.warn(`[reconcile] extension offline — cannot activate ${account.email}; leaving PENDING`);
    return 'failed';
  }

  let activationOk = false;
  try {
    const extResult = await triggerActivationVisit(link);
    activationOk = extResult.success === true;
  } catch (e) {
    console.warn(`[reconcile] activation visit threw for ${account.email}: ${(e as Error).message}`);
    return 'failed';
  }

  if (!activationOk) return 'failed';

  // Step 3: mark the account ACTIVE in the DB.
  try {
    await prisma.vfsAccount.update({
      where: { id: accountId },
      data: {
        status: AccountStatus.ACTIVE,
        lifecycleState: LifecycleStateEnum.ACTIVE,
      },
    });
  } catch {
    return 'failed';
  }

  return 'activated';
}

/** Summary returned by reconcilePending(). */
export interface ReconciliationReport {
  total: number;
  activated: number;
  linkMissing: number;
  failed: number;
  candidateEmails: string[];
}

/**
 * Finds all PENDING Mailsac candidates and, unless dryRun is true, activates
 * each one sequentially with a 2-second gap between attempts.
 *
 * @param dryRun - When true, candidates are logged but NO activation is attempted.
 */
export async function reconcilePending(dryRun: boolean): Promise<ReconciliationReport> {
  const candidates = await findPendingCandidates();

  const report: ReconciliationReport = {
    total: candidates.length,
    activated: 0,
    linkMissing: 0,
    failed: 0,
    candidateEmails: candidates.map((c) => c.email),
  };

  if (dryRun) {
    // Log candidates without taking any action.
    for (const c of candidates) {
      console.log(`[reconcile:dry-run] PENDING candidate: ${c.email} (id=${c.id}, created=${c.createdAt.toISOString()})`);
    }
    return report;
  }

  // Live mode: process sequentially with pacing.
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]!;
    const result = await tryActivate(candidate.id);

    switch (result) {
      case 'activated':
        report.activated++;
        console.log(`[reconcile] activated: ${candidate.email}`);
        break;
      case 'link_missing':
        report.linkMissing++;
        console.log(`[reconcile] link_missing: ${candidate.email}`);
        break;
      case 'failed':
        report.failed++;
        console.log(`[reconcile] failed: ${candidate.email}`);
        break;
    }

    // 2-second pacing gap between attempts (skip after the last one).
    if (i < candidates.length - 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
    }
  }

  return report;
}
