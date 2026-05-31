/**
 * Pipeline router — receives lifecycle milestones from the UZ-machine
 * orchestrator worker and updates the DB + fires Telegram notifications.
 *
 * POST /api/pipeline/event
 *   Auth: Bearer <WORKER_TOKEN>  (if WORKER_TOKEN is not set, dev mode — all accepted)
 *
 * The endpoint is intentionally NOT gated behind SCENARIO_ENABLED so that
 * milestones from an already-started run are never silently dropped.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '@config/database';
import { env } from '@config/env';
import { AppError } from '@middleware/errorHandler';
import { createEvent } from '@modules/pipeline-events/pipeline-event.service';
import { dispatchNotification } from '@modules/notifications/notification.service';

export const pipelineRouter = Router();

// ── Validation ─────────────────────────────────────────────────────────────────

const milestoneBodySchema = z.object({
  runId: z.string().min(1),
  accountId: z.string().uuid().optional(),
  email: z.string().email().optional(),
  step: z.enum([
    'register_started',
    'form_rendered',
    'consents_ticked',
    'register_submitted',
    'registered',
    'activation_visited',
    'logged_in',
    'monitoring',
    'slot_found',
    'otp_requested',
    'otp_filled',
    'otp_timeout',
    'booking_submitted',
    'booked',
    'failed',
  ]),
  fromState: z.string().optional(),
  toState: z.string().optional(),
  status: z.enum(['ok', 'fail']),
  detail: z.string().optional(),
  slotId: z.string().optional(),
  confirmation: z.string().optional(),
  error: z.string().optional(),
  url: z.string().optional(),
  screenshotPath: z.string().optional(),
});

type MilestoneBody = z.infer<typeof milestoneBodySchema>;

// ── Bearer token auth middleware ───────────────────────────────────────────────

function workerAuth(req: Request, _res: Response, next: NextFunction): void {
  const workerToken = env.WORKER_TOKEN;

  // Dev mode: WORKER_TOKEN not set → accept all requests.
  if (!workerToken) {
    next();
    return;
  }

  const authHeader = req.headers.authorization ?? '';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

  if (!bearer || bearer !== workerToken) {
    next(new AppError(401, 'Invalid or missing worker token', 'UNAUTHORIZED'));
    return;
  }

  next();
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Derive status + cooldownUntil updates from a toState value.
 * Returns only the fields that need to change — callers spread this into
 * the prisma.vfsAccount.update({ data: ... }) call.
 */
function accountUpdatesForState(toState: string): Record<string, unknown> {
  switch (toState) {
    case 'ACTIVE':
    case 'WARM':
    case 'LOGGING_IN':
      return { lifecycleState: toState, status: 'ACTIVE' };
    case 'BLOCKED':
      return { lifecycleState: toState, status: 'BLOCKED' };
    case 'PENDING_ACTIVATION':
    case 'ACTIVATING':
      return { lifecycleState: toState, status: 'PENDING' };
    case 'RESTRICTED':
      return {
        lifecycleState: toState,
        cooldownUntil: new Date(Date.now() + 2 * 60 * 60 * 1000), // 2 h
      };
    default:
      return { lifecycleState: toState };
  }
}

// ── POST /api/pipeline/event ───────────────────────────────────────────────────

pipelineRouter.post(
  '/event',
  workerAuth,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const body: MilestoneBody = milestoneBodySchema.parse(req.body ?? {});

      // ── Step 1: Resolve the VfsAccount ──────────────────────────────────────
      if (!body.accountId && !body.email) {
        next(new AppError(400, 'Either accountId or email is required', 'VALIDATION_ERROR'));
        return;
      }

      const account = body.accountId
        ? await prisma.vfsAccount.findUnique({
            where: { id: body.accountId },
            select: { id: true, email: true, lifecycleState: true, status: true },
          })
        : await prisma.vfsAccount.findUnique({
            where: { email: body.email },
            select: { id: true, email: true, lifecycleState: true, status: true },
          });

      if (!account) {
        next(new AppError(404, 'VfsAccount not found', 'NOT_FOUND'));
        return;
      }

      // ── Step 2: Update lifecycleState (and possibly status / cooldown) ───────
      let updatedLifecycleState = account.lifecycleState as string;

      if (body.toState) {
        const updates = accountUpdatesForState(body.toState);
        updatedLifecycleState = body.toState;

        await prisma.vfsAccount.update({
          where: { id: account.id },
          data: updates as Parameters<typeof prisma.vfsAccount.update>[0]['data'],
        });
      }

      // ── Step 3: Write PipelineEvent row ─────────────────────────────────────
      await createEvent({
        action: body.step,
        accountId: account.id,
        beforeState: body.fromState,
        afterState: body.toState,
        error: body.error,
        url: body.url,
        screenshotPath: body.screenshotPath,
        severity: body.status === 'fail' ? 'CRITICAL' : 'INFO',
      });

      // Per-check Telegram: the operator wants a message on EVERY slot check,
      // including "no slots" — not a periodic summary. A monitoring milestone
      // without a slotId is a completed check that found nothing.
      if (body.step === 'monitoring' && !body.slotId) {
        const { sendTelegram } = await import('@modules/notifications/telegram.bot');
        const when = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const detail = body.detail ? ` · ${body.detail}` : '';
        await sendTelegram(`🔍 No slots${detail} · ${account.email} · ${when}`).catch(() => {});
      }

      // ── Step 4: Fire Telegram notifications for key steps ────────────────────
      const { sendTelegram: tg } = await import('@modules/notifications/telegram.bot');
      const em = account.email;

      if (body.step === 'register_started') {
        await tg(`🔄 Registering new Mailsac account: ${em}`).catch(() => {});
      } else if (body.step === 'form_rendered') {
        await tg(`📋 Register form ready — filling fields: ${em}`).catch(() => {});
      } else if (body.step === 'consents_ticked') {
        await tg(`☑️ Consents ticked — waiting for Turnstile: ${em}`).catch(() => {});
      } else if (body.step === 'register_submitted') {
        await tg(`📤 Register submitted — waiting for activation email: ${em}`).catch(() => {});
      } else if (body.step === 'registered') {
        await tg(`✅ Registered: ${em}`).catch(() => {});
      } else if (body.step === 'activation_visited') {
        await tg(`✅ Activated: ${em}`).catch(() => {});
      } else if (body.step === 'logged_in') {
        await tg(`🔐 Logged in: ${em}`).catch(() => {});
      } else if (body.step === 'otp_requested') {
        await tg(`📨 OTP requested — polling Mailsac: ${em}`).catch(() => {});
      } else if (body.step === 'otp_filled') {
        await tg(`✅ OTP filled: ${em}`).catch(() => {});
      } else if (body.step === 'otp_timeout') {
        await tg(`⏱ OTP timeout — check MAILSAC_API_KEY: ${em}`).catch(() => {});
      } else if (body.step === 'slot_found' || (body.step === 'monitoring' && body.slotId)) {
        await dispatchNotification({
          event: 'SLOT_DETECTED',
          slotId: body.slotId,
          accountEmail: em,
        });
      } else if (body.step === 'booking_submitted') {
        if (body.detail === 'confirmed') {
          await dispatchNotification({
            event: 'BOOKING_SUCCESS',
            confirmationNo: body.confirmation,
            accountEmail: em,
          });
        } else if (body.detail === 'payment_wall') {
          await tg(`⚠️ Reached payment wall for ${em} — manual payment needed. Appointment reserved.`).catch(() => {});
        } else if (body.detail === 'dry_run') {
          await tg(`📸 DRY-RUN complete for ${em} — review screenshot saved, not submitted`).catch(() => {});
        }
      } else if (body.step === 'booked' && body.status === 'ok') {
        await dispatchNotification({
          event: 'BOOKING_SUCCESS',
          confirmationNo: body.confirmation,
          accountEmail: em,
        });
      } else if (body.step === 'failed' && body.status === 'fail') {
        // Map the specific reason code from the spike's classify_block() to a
        // clear, human-readable coded alert so the operator knows the cause at a
        // glance. The Python side ALSO sends the matching screenshot as a photo
        // (block-alert hardening). Unknown codes fall through to the raw reason.
        const REASON_LABELS: Record<string, string> = {
          rate_limit_429202: '⛔ Rate limited (429202 — IP/session). Cool down ~2h, then retry.',
          rate_limit_429001: '⛔ Rate limited (429001 — account/User-ID). Quarantine + rotate account.',
          session_expired: '🔁 Session expired — re-login needed (check VPN/proxy + cookies).',
          datadome_block: '🚧 Datadome block (page-not-found/access-denied) — IP may be flagged.',
          turnstile_wall: '🧩 Turnstile wall — captcha not passing (try fresh profile).',
          otp_timeout: '⏱ OTP timeout — check MAILSAC_API_KEY.',
          payment_wall: '⚠️ Payment wall — manual payment needed (slot reserved).',
          submit_uncertain: '❓ Submit outcome uncertain — see screenshot.',
          login_failed: '❌ Login failed — see screenshot.',
        };
        const label = body.error ? REASON_LABELS[body.error] : undefined;
        if (label) {
          await tg(`${label}\nAccount: ${em}`).catch(() => {});
        }
        // NOTIFY_BOOKING_FAILURES gate is already inside dispatchNotification.
        await dispatchNotification({
          event: 'BOOKING_FAILED',
          reason: body.error,
          accountEmail: em,
        });
      }

      // ── Step 5: Respond ──────────────────────────────────────────────────────
      res.status(200).json({
        ok: true,
        accountId: account.id,
        lifecycleState: updatedLifecycleState,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /api/pipeline/reconcile ────────────────────────────────────────────────
// Worker-triggered activation. The worker (no extension WS) calls this so the
// BACKEND (which holds the operator extension connection) activates a PENDING
// account via the real Chrome. body.email → activate that one; else all PENDING.
const reconcileSchema = z.object({ email: z.string().email().optional() });

pipelineRouter.post('/reconcile', workerAuth, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { email } = reconcileSchema.parse(req.body ?? {});
    const { reconcilePending, tryActivate } = await import('@modules/accounts/reconciliation.service');
    if (email) {
      const acct = await prisma.vfsAccount.findUnique({ where: { email }, select: { id: true, status: true } });
      if (!acct) { res.status(404).json({ ok: false, reason: 'ACCOUNT_NOT_FOUND' }); return; }
      if (acct.status === 'ACTIVE') { res.status(200).json({ ok: true, result: 'already_active' }); return; }
      const result = await tryActivate(acct.id);
      res.status(200).json({ ok: result === 'activated', result });
      return;
    }
    const report = await reconcilePending(false);
    res.status(200).json({ ok: true, report });
  } catch (err) {
    next(err);
  }
});
