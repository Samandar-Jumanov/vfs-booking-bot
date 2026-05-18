/**
 * End-to-end VFS account registration orchestrator.
 *
 * For each new VFS account this:
 *   1. Allocates an email (catch-all domain or Mailsac)
 *   2. Acquires a phone via SMS-Activate
 *   3. Calls VfsMobileClient.register()
 *   4. Polls SMS for phone OTP, calls verifyPhoneOtp
 *   5. Polls email for verification link/code, calls verifyEmailOtp
 *   6. Persists encrypted credentials to DB
 *
 * Inputs: applicant data (name, etc) + optional password to use.
 * Output: { accountId, email, password, phone, vfsUserId }
 *
 * IMPORTANT: this depends on Phase 2 capture being done. Until then, the
 * VfsMobileClient calls will fail because endpoints are placeholders.
 */

import { VfsMobileClient } from '@modules/vfs-mobile/client';
import { createSmsActivateClient } from './sms-activate';
import { createEmailProvider } from './email-catchall';
import { logEvent } from '@modules/logs/logger';
import { EventType } from '@prisma/client';

export interface RegisterAccountInput {
  /** Used in registration form */
  firstName: string;
  lastName: string;
  /** Optional pre-set password; otherwise generated */
  password?: string;
  /** Country prefix for SMS service code; passed through to SMS-Activate */
  countryCode?: string;
}

export interface RegisteredAccount {
  email: string;
  password: string;
  phone: string;
  vfsUserId: string;
  registeredAt: Date;
}

/**
 * Register a new VFS account end-to-end. Throws on failure (caller should
 * handle retry / rotate to fresh phone+email if needed).
 */
export async function registerNewVfsAccount(input: RegisterAccountInput): Promise<RegisteredAccount> {
  const sms = createSmsActivateClient();
  const emailProv = createEmailProvider();
  const client = new VfsMobileClient();

  // ── Step 1: allocate email + phone ────────────────────────────────────
  const { email } = emailProv.allocate();
  logEvent('info', EventType.MONITOR_STARTED, `[Register] Allocated email: ${email}`);

  const balance = await sms.getBalance();
  if (balance < 1) throw new Error(`SMS-Activate balance too low (${balance})`);

  const { id: smsId, phone } = await sms.acquireNumber();
  logEvent('info', EventType.MONITOR_STARTED, `[Register] Acquired phone ${phone} (id=${smsId})`);

  const password = input.password || generatePassword();

  try {
    // ── Step 2: register on VFS ─────────────────────────────────────────
    const { userId } = await client.register({
      email,
      password,
      firstName: input.firstName,
      lastName: input.lastName,
      phone,
      countryCode: input.countryCode || 'UZ',
    });
    logEvent('info', EventType.MONITOR_STARTED, `[Register] VFS register returned userId=${userId}, awaiting OTPs`);

    // ── Step 3: phone OTP ───────────────────────────────────────────────
    await sms.setStatusReady(smsId);
    const phoneOtp = await sms.waitForSms(smsId, 120_000);
    logEvent('info', EventType.MONITOR_STARTED, `[Register] SMS OTP received`);
    await client.verifyPhoneOtp(phone, phoneOtp);

    // ── Step 4: email OTP ───────────────────────────────────────────────
    const emailOtp = await emailProv.waitForOtp(email, {
      timeoutMs: 180_000,
      subjectMatch: /vfs|verification|verify/i,
    });
    logEvent('info', EventType.MONITOR_STARTED, `[Register] Email OTP received`);
    await client.verifyEmailOtp(email, emailOtp);

    // ── Step 5: confirm SMS consumed (releases credit) ─────────────────
    await sms.confirmDelivered(smsId);

    return {
      email,
      password,
      phone,
      vfsUserId: userId,
      registeredAt: new Date(),
    };
  } catch (err: any) {
    // Don't waste the SMS credit if registration failed before OTP arrived
    await sms.cancelAndRefund(smsId).catch(() => {});
    logEvent('error', EventType.BOOKING_FAILED, `[Register] Failed: ${err.message}`);
    throw err;
  }
}

function generatePassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const sym = '!@#$%';
  let pw = '';
  for (let i = 0; i < 12; i++) pw += chars[Math.floor(Math.random() * chars.length)];
  pw += sym[Math.floor(Math.random() * sym.length)];
  return pw;
}
