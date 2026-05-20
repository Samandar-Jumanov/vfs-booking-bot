import { randomBytes, randomUUID } from 'crypto';
import axios from 'axios';
import { prisma } from '@config/database';
import { solveTurnstile } from '@modules/captcha/twoCaptcha';
import { claimToken, registerPool } from '@modules/captcha/token.pool';
import { sendToExtension } from '@modules/websocket/ws.server';
import { encrypt } from '@utils/crypto';
import { recordSpend } from '@modules/vendor/spend.recorder';
import { getEmailProvider, getSmsProvider } from './providerFactory';

// Approximate per-action vendor costs in USD. These are used for the
// dashboard cost-tracking widget. They are sourced from each vendor's
// public price page and may be tuned via env later if needed.
const COST = {
  ONLINESIM_BUY_NUMBER: 0.50,
  VAKSMS_BUY_NUMBER: 0.30,
  SMSACTIVATE_BUY_NUMBER: 0.30,
  TWOCAPTCHA_TURNSTILE: 0.003,
  KOPEECHKA_EMAIL: 0.05,
  MAILSAC_INBOX: 0,
  CUSTOM_DOMAIN_INBOX: 0,
};

interface AutoRegisterOptions {
  source: string;
  destination: string;
  countryCode: string;
  operatorUserId: string;
  profileId?: string;
}

type AutoRegisterResult =
  | { ok: true; accountId: string; email: string }
  | { ok: false; reason: string };

type PendingResult = { ok: true } | { ok: false; reason: string };

const pending = new Map<string, {
  resolve: (result: PendingResult) => void;
  timer: NodeJS.Timeout;
  smsActivateId?: string;
  email?: string;
}>();

// Separate map for the SUBMITTED hand-off: extension fires this right after
// the register form is POSTed successfully and VFS shows "verification email
// sent". Backend then takes over the email-link visit server-side.
const submittedWaiters = new Map<string, {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}>();

export async function autoRegisterAccount(opts: AutoRegisterOptions): Promise<AutoRegisterResult> {
  const smsProvider = getSmsProvider();
  const emailProvider = getEmailProvider();
  const smsVendor = (process.env.SMS_PROVIDER || 'smsactivate').toLowerCase();
  const emailVendor = (process.env.EMAIL_PROVIDER || 'mailsac').toLowerCase();

  // OnlineSIM doesn't recognize "vfs" as a service. Use the configured
  // service name (default to a generic catch-all). For OnlineSIM the cheapest
  // generic is typically "other" or "mail.ru"; for Vak-SMS "vfs" works.
  const smsService = process.env.SMS_SERVICE_NAME
    || (smsVendor === 'onlinesim' ? 'facebook' : 'vfs');
  const phone = await smsProvider.buyNumber(smsService, opts.countryCode);
  await recordSpend({
    vendor: smsVendor,
    kind: 'SMS',
    action: 'buy_number',
    costUsd:
      smsVendor === 'onlinesim' ? COST.ONLINESIM_BUY_NUMBER :
      smsVendor === 'vaksms' ? COST.VAKSMS_BUY_NUMBER :
      COST.SMSACTIVATE_BUY_NUMBER,
    externalRef: phone.id,
    profileId: opts.profileId,
    meta: { country: opts.countryCode, number: phone.number },
  });

  const email = await emailProvider.createInbox();
  await recordSpend({
    vendor: emailVendor,
    kind: 'EMAIL',
    action: 'create_inbox',
    costUsd:
      emailVendor === 'custom' ? COST.CUSTOM_DOMAIN_INBOX :
      COST.MAILSAC_INBOX,
    externalRef: email,
    profileId: opts.profileId,
  });
  // VFS password rules: min 8, max 15, ≥1 upper, ≥1 lower, ≥1 digit, ≥1 special
  // from ($ @ # ! % * ?). Generate a compliant 14-char password from those
  // specifically-allowed characters only.
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // omit I,O for readability
  const lower = 'abcdefghjkmnpqrstuvwxyz';
  const digit = '23456789';
  const special = '@#!%*?'; // VFS's allowed special chars (skip $ which some validators reject)
  const pick = (s: string) => s[randomBytes(1)[0] % s.length];
  // 14 chars total, guaranteed at least one from each class
  const rest = Array.from({ length: 10 }).map(() => pick(upper + lower + digit + special)).join('');
  const password = `Q${pick(upper)}${pick(lower)}${pick(digit)}${pick(special)}${rest}`.slice(0, 14);
  const firstName = 'Akmal';
  const lastName = 'Saliyev';
  const dob = '1995-06-15';
  const correlationId = randomUUID();
  const registerUrl = `https://visa.vfsglobal.com/${opts.source}/en/${opts.destination}/register`;

  try {
    // The extension's MV3 service worker can be in an idle state when we
    // dispatch — its WS won't be in the connections map for a few seconds
    // until the next alarm wakes it. Retry the dispatch for up to 45 s.
    let accepted = false;
    const dispatchPayload = {
      type: 'BG_REGISTER_VFS_ACCOUNT' as const,
      email,
      phone: phone.number,
      smsActivateId: phone.id,
      password,
      firstName,
      lastName,
      dob,
      registerUrl,
      correlationId,
    };
    const dispatchDeadline = Date.now() + 45_000;
    while (Date.now() < dispatchDeadline) {
      accepted = sendToExtension(opts.operatorUserId, dispatchPayload);
      if (accepted) break;
      await new Promise<void>((r) => setTimeout(r, 3_000));
    }

    if (!accepted) {
      await smsProvider.releaseNumber(phone.id);
      throw new Error('OPERATOR_EXTENSION_OFFLINE_AFTER_45S');
    }

    // Step 1: wait for extension to confirm the register form was submitted
    // (90s). VFS UZ does NOT send SMS at signup — only email — so we no
    // longer block on EXT_REGISTER_COMPLETED with OTP filled.
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          submittedWaiters.delete(correlationId);
          reject(new Error('REGISTER_FORM_NOT_SUBMITTED'));
        }, 90_000);
        submittedWaiters.set(correlationId, { resolve, reject, timer });
      });
    } catch (e) {
      // Keep number — we'll need it for booking-time OTP.
      return { ok: false, reason: (e as Error).message };
    }

    // Step 2: poll inbox for the verification link (up to 120s).
    const verifyLink = await fetchEmailVerificationLink(email);
    if (!verifyLink) {
      return { ok: false, reason: 'EMAIL_LINK_NOT_RECEIVED' };
    }

    // Step 3: visit the link server-side. VFS verification links are public
    // GETs with a token param — no session/proxy needed.
    try {
      const resp = await axios.get(verifyLink, {
        maxRedirects: 5,
        validateStatus: () => true,
        timeout: 15_000,
      });
      if (resp.status >= 400) {
        return { ok: false, reason: `EMAIL_LINK_VISIT_FAILED_${resp.status}` };
      }
    } catch (err) {
      return { ok: false, reason: `EMAIL_LINK_VISIT_ERROR_${(err as Error).message}` };
    }

    // Step 4: persist the account. Keep the OnlineSIM number ACTIVE — we will
    // reuse it for the SMS OTP step at first booking time.
    const account = await prisma.vfsAccount.create({
      data: {
        email,
        encryptedPassword: encrypt(password),
        phone: phone.number,
        smsExternalId: phone.id,
        status: 'ACTIVE',
      },
      select: { id: true, email: true },
    });

    return { ok: true, accountId: account.id, email: account.email };
  } catch (error) {
    pending.delete(correlationId);
    submittedWaiters.delete(correlationId);
    await smsProvider.releaseNumber(phone.id).catch(() => undefined);
    throw error;
  }
}

export function resolveAutoRegisterSubmitted(correlationId: string): void {
  const entry = submittedWaiters.get(correlationId);
  if (!entry) return;
  submittedWaiters.delete(correlationId);
  clearTimeout(entry.timer);
  entry.resolve();
}

export function resolveAutoRegister(correlationId: string, result: PendingResult): void {
  const entry = pending.get(correlationId);
  if (!entry) return;
  pending.delete(correlationId);
  clearTimeout(entry.timer);
  if (!result.ok && entry.smsActivateId) {
    getSmsProvider().releaseNumber(entry.smsActivateId).catch(() => undefined);
  }
  entry.resolve(result);
}

export async function fetchEmailVerificationLink(email: string): Promise<string | null> {
  const emailProvider = getEmailProvider();
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const messages = await emailProvider.listInbox(email).catch(() => []);
    for (const message of messages) {
      const body = String(message.body ?? '');
      const match = body.match(/https?:\/\/[^\s"<]+(?:verify|confirm|activate)[^\s"<]*/i);
      if (match) return match[0];
    }
    await sleep(5_000);
  }
  return null;
}

export async function fetchSmsOtp(smsActivateId: string): Promise<string | null> {
  if (!smsActivateId) return null;
  try {
    return await getSmsProvider().getOtp(smsActivateId);
  } catch {
    return null;
  }
}

export async function fetchRegisterCaptchaToken(siteKey: string, pageUrl: string): Promise<string | null> {
  if (!siteKey || !pageUrl) return null;
  // Register this (siteKey, pageUrl) with the pool so future requests get a
  // pre-solved token immediately.
  registerPool(siteKey, pageUrl);
  // Try the pool first — instant if there's a fresh token.
  const pooled = claimToken(siteKey, pageUrl);
  if (pooled) return pooled;
  // Fall back to live solve (4–15s).
  try {
    return await solveTurnstile(siteKey, pageUrl);
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
