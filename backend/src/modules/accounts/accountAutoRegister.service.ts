import { randomBytes, randomUUID } from 'crypto';
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { prisma } from '@config/database';
import { solveTurnstile } from '@modules/captcha/twoCaptcha';
import { claimToken, registerPool } from '@modules/captcha/token.pool';
import { sendToExtension } from '@modules/websocket/ws.server';
import { encrypt } from '@utils/crypto';
import { recordSpend } from '@modules/vendor/spend.recorder';
import { getEmailProvider, getSmsProvider } from './providerFactory';
import { AccountStatus } from '@prisma/client';

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

const PENDING_STATUS = 'PENDING' as AccountStatus;

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
  const account = await prisma.vfsAccount.create({
    data: {
      email,
      encryptedPassword: encrypt(password),
      phone: phone.number,
      smsExternalId: phone.id,
      status: PENDING_STATUS,
    },
    select: { id: true, email: true },
  });

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
      return { ok: false, reason: 'OPERATOR_EXTENSION_OFFLINE_AFTER_45S' };
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

    // Step 3: visit the link server-side. VFS checks visitor country — must
    // come from a UZ IP. Route through BrightData if configured.
    try {
      const resp = await visitActivationLink(verifyLink);
      if (resp.status >= 400) {
        return { ok: false, reason: `EMAIL_LINK_VISIT_FAILED_${resp.status}` };
      }
    } catch (err) {
      return { ok: false, reason: `EMAIL_LINK_VISIT_ERROR_${(err as Error).message}` };
    }

    // Step 4: activate the already-persisted row. Keep the OnlineSIM number
    // active for the SMS OTP step at first booking time.
    const activatedAccount = await prisma.vfsAccount.update({
      where: { id: account.id },
      data: {
        status: AccountStatus.ACTIVE,
      },
      select: { id: true, email: true },
    });

    return { ok: true, accountId: activatedAccount.id, email: activatedAccount.email };
  } catch (error) {
    pending.delete(correlationId);
    submittedWaiters.delete(correlationId);
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

// Visit VFS activation link through BrightData UZ proxy (if configured).
// VFS rejects non-UZ traffic with /page-not-found. Backend lives in EU/US
// so direct axios.get from Railway would fail. The proxy makes the
// activation request appear to come from Uzbekistan.
export async function visitActivationLink(link: string): Promise<{ status: number }> {
  const proxyUrl = buildBrightDataProxyUrl();
  const config: Parameters<typeof axios.get>[1] = {
    maxRedirects: 5,
    validateStatus: () => true,
    timeout: 30_000,
  };
  if (proxyUrl) {
    const agent = new HttpsProxyAgent(proxyUrl);
    config.httpsAgent = agent;
    config.httpAgent = agent;
    config.proxy = false; // Disable axios's built-in proxy handling, use agent.
  }
  const resp = await axios.get(link, config);
  return { status: resp.status };
}

// Strip any existing -session-XYZ suffix and append a fresh random one.
// VFS rate-limits per residential IP. Sticky session = same IP for ~30 min.
// Per-request rotation = different IP each call = no rate accumulation.
function rotateSession(username: string): string {
  // Match "-session-XXX" up to the next non-alphanumeric or end of string.
  const stripped = username.replace(/-session-[A-Za-z0-9]+/g, '');
  const fresh = 'auto' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  return `${stripped}-session-${fresh}`;
}

function buildBrightDataProxyUrl(): string | null {
  const host = process.env.PROXY_HOST || process.env.BRIGHTDATA_HOST;
  const port = process.env.PROXY_PORT || process.env.BRIGHTDATA_PORT;
  const user = process.env.PROXY_USERNAME || process.env.BRIGHTDATA_USERNAME;
  const pass = process.env.PROXY_PASSWORD || process.env.BRIGHTDATA_PASSWORD;
  if (!host || !port || !user || !pass) return null;
  // Auto-rotate session on every call. Each backend request (activation
  // link visit, slot poll) goes through a different residential IP, so
  // VFS never sees enough traffic from one IP to trigger 429201.
  const rotatedUser = rotateSession(user);
  return `http://${encodeURIComponent(rotatedUser)}:${encodeURIComponent(pass)}@${host}:${port}`;
}

export async function fetchEmailVerificationLink(email: string): Promise<string | null> {
  const emailProvider = getEmailProvider();
  const deadline = Date.now() + 240_000; // bumped from 120s
  while (Date.now() < deadline) {
    const messages = await emailProvider.listInbox(email).catch(() => []);
    for (const message of messages) {
      // The VFS activation token is a long base64 string (contains + / =) and the
      // email WRAPS it across lines with whitespace (observed 2026-05-26:
      // "…KDSIwNiLR hWy1szYpGf…"). The old regex stopped at the first space →
      // truncated token → invalid link → VFS bounced to /login without activating.
      let body = String(message.body ?? '');
      body = body.replace(/=\r?\n/g, '');   // quoted-printable soft breaks
      body = body.replace(/&amp;/g, '&');   // entity decode
      const LINK_RE = /activateemail|activate|verify|confirm/i;
      // 1) Prefer the clean <a href="..."> URL — a single attribute value, so no
      //    line-wrap whitespace. Strip any stray whitespace just in case.
      const hrefs = body.match(/href\s*=\s*["']([^"']+)["']/gi) ?? [];
      for (const h of hrefs) {
        const url = h.replace(/^href\s*=\s*["']/i, '').replace(/["']$/, '').replace(/\s+/g, '');
        if (/^https?:\/\//i.test(url) && LINK_RE.test(url)) return url;
      }
      // 2) Fallback: the plain-text link. Find its start, take a generous span,
      //    cut at a hard delimiter, then strip ALL internal whitespace (base64
      //    tokens never contain real spaces — any are email line-wrapping).
      const start = body.search(/https?:\/\/\S*(?:activateemail|activate|verify|confirm)/i);
      if (start >= 0) {
        const cut = body.slice(start, start + 800).split(/["'<>]|\r?\n\s*\r?\n|Thank you|Regards/i)[0];
        const url = cut.replace(/\s+/g, '');
        if (/^https?:\/\//i.test(url)) return url;
      }
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
