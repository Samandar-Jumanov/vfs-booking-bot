import { randomBytes, randomUUID } from 'crypto';
import { prisma } from '@config/database';
import { solveTurnstile } from '@modules/captcha/twoCaptcha';
import { mailsacService } from '@modules/email/mailsac.service';
import { smsActivateService } from '@modules/phone/smsActivate.service';
import { sendToExtension } from '@modules/websocket/ws.server';
import { encrypt } from '@utils/crypto';

interface AutoRegisterOptions {
  source: string;
  destination: string;
  countryCode: string;
  operatorUserId: string;
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

export async function autoRegisterAccount(opts: AutoRegisterOptions): Promise<AutoRegisterResult> {
  const phone = await smsActivateService.buyNumber('vfs', opts.countryCode);
  const email = mailsacService.createInbox();
  const password = `Vfs-${randomBytes(8).toString('base64url')}1!`;
  const firstName = 'Akmal';
  const lastName = 'Saliyev';
  const dob = '1995-06-15';
  const correlationId = randomUUID();
  const registerUrl = `https://visa.vfsglobal.com/${opts.source}/en/${opts.destination}/register`;

  try {
    const accepted = sendToExtension(opts.operatorUserId, {
      type: 'BG_REGISTER_VFS_ACCOUNT',
      email,
      phone: phone.number,
      smsActivateId: phone.id,
      password,
      firstName,
      lastName,
      dob,
      registerUrl,
      correlationId,
    });

    if (!accepted) {
      await smsActivateService.releaseNumber(phone.id);
      throw new Error('OPERATOR_EXTENSION_OFFLINE');
    }

    const result = await new Promise<PendingResult>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(correlationId);
        smsActivateService.releaseNumber(phone.id).catch(() => undefined);
        resolve({ ok: false, reason: 'EXTENSION_TIMEOUT' });
      }, 5 * 60 * 1000);
      pending.set(correlationId, { resolve, timer, smsActivateId: phone.id, email });
    });

    if (!result.ok) {
      await smsActivateService.releaseNumber(phone.id).catch(() => undefined);
      return result;
    }

    const account = await prisma.vfsAccount.create({
      data: {
        email,
        encryptedPassword: encrypt(password),
        phone: phone.number,
        status: 'ACTIVE',
      },
      select: { id: true, email: true },
    });

    return { ok: true, accountId: account.id, email: account.email };
  } catch (error) {
    pending.delete(correlationId);
    await smsActivateService.releaseNumber(phone.id).catch(() => undefined);
    throw error;
  }
}

export function resolveAutoRegister(correlationId: string, result: PendingResult): void {
  const entry = pending.get(correlationId);
  if (!entry) return;
  pending.delete(correlationId);
  clearTimeout(entry.timer);
  if (!result.ok && entry.smsActivateId) {
    smsActivateService.releaseNumber(entry.smsActivateId).catch(() => undefined);
  }
  entry.resolve(result);
}

export async function fetchEmailVerificationLink(email: string): Promise<string | null> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const messages = await mailsacService.listInbox(email).catch(() => []);
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
    return await smsActivateService.getOtp(smsActivateId);
  } catch {
    return null;
  }
}

export async function fetchRegisterCaptchaToken(siteKey: string, pageUrl: string): Promise<string | null> {
  if (!siteKey || !pageUrl) return null;
  try {
    return await solveTurnstile(siteKey, pageUrl);
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
