/**
 * SMS-Activate.io integration.
 *
 * Used to acquire temporary phone numbers + receive SMS OTP for VFS account
 * registration at scale (300+ accounts).
 *
 * Pricing as of 2026-05: ~$0.30 per UZ number for VFS verification.
 *
 * Workflow:
 *   1. acquireNumber('vfs', 'uz') -> { id, phone }
 *   2. (Send VFS the phone number, trigger OTP)
 *   3. waitForSms(id, timeoutMs) -> 'XXXXXX'
 *   4. confirmDelivered(id) (or rejectAndRefund)
 *
 * Service code for VFS Global on SMS-Activate is typically 'vy'.
 * Check current service codes: https://sms-activate.io/getServices
 */

import axios from 'axios';

const API_BASE = 'https://api.sms-activate.io/stubs/handler_api.php';

export interface SmsActivateConfig {
  apiKey: string;
  service: string;     // 'vy' for VFS, 'go' for Google, 'fb' for Facebook
  country: string;     // SMS-Activate country code: '40' = UZ
  maxPriceUSD?: number;
}

const COUNTRY_CODES: Record<string, string> = {
  uz: '40',
  ru: '0',
  ua: '1',
  kz: '2',
  tj: '32',
  in: '22',
};

export class SmsActivateClient {
  constructor(private cfg: SmsActivateConfig) {}

  async getBalance(): Promise<number> {
    const data = await this.call({ action: 'getBalance' });
    // Response format: "ACCESS_BALANCE:12.34"
    const m = data.match(/ACCESS_BALANCE:([\d.]+)/);
    if (!m) throw new Error(`Unexpected getBalance response: ${data}`);
    return parseFloat(m[1]);
  }

  /**
   * Acquire a number for SMS receipt.
   * Returns { id, phone } where phone is in E.164 format.
   */
  async acquireNumber(): Promise<{ id: string; phone: string }> {
    const country = COUNTRY_CODES[this.cfg.country.toLowerCase()] || this.cfg.country;
    const data = await this.call({
      action: 'getNumber',
      service: this.cfg.service,
      country,
      ...(this.cfg.maxPriceUSD ? { maxPrice: String(this.cfg.maxPriceUSD) } : {}),
    });
    // Response format: "ACCESS_NUMBER:<id>:<phone>"
    const m = data.match(/ACCESS_NUMBER:(\d+):(\d+)/);
    if (!m) {
      if (data === 'NO_NUMBERS') throw new Error('No numbers available — try later or different country');
      if (data === 'NO_BALANCE') throw new Error('SMS-Activate balance too low');
      throw new Error(`Unexpected acquireNumber response: ${data}`);
    }
    return { id: m[1], phone: '+' + m[2] };
  }

  /**
   * Tell SMS-Activate the SMS has been requested by the target service.
   * Resets the SMS-receive timer.
   */
  async setStatusReady(activationId: string): Promise<void> {
    await this.call({ action: 'setStatus', id: activationId, status: '1' });
  }

  /**
   * Poll for the SMS code. Throws on timeout.
   */
  async waitForSms(activationId: string, timeoutMs = 120_000, pollMs = 4_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const data = await this.call({ action: 'getStatus', id: activationId });
      // Possible responses:
      //   STATUS_WAIT_CODE     -> still waiting
      //   STATUS_WAIT_RETRY:N  -> wrong code, allow retry
      //   STATUS_OK:CODE       -> got the code
      //   STATUS_CANCEL        -> user cancelled
      if (data.startsWith('STATUS_OK:')) return data.split(':', 2)[1];
      if (data === 'STATUS_CANCEL') throw new Error('Activation cancelled');
      await new Promise((r) => setTimeout(r, pollMs));
    }
    throw new Error(`SMS not received within ${timeoutMs}ms`);
  }

  /**
   * Mark the activation as completed (consumed). Must be called within 20 min
   * of the OTP being received, or the number is auto-released.
   */
  async confirmDelivered(activationId: string): Promise<void> {
    await this.call({ action: 'setStatus', id: activationId, status: '6' });
  }

  /** Mark unusable + refund (status 8). */
  async cancelAndRefund(activationId: string): Promise<void> {
    await this.call({ action: 'setStatus', id: activationId, status: '8' });
  }

  // ── Internal ──────────────────────────────────────────────────────────

  private async call(params: Record<string, string>): Promise<string> {
    const res = await axios.get(API_BASE, {
      params: { api_key: this.cfg.apiKey, ...params },
      timeout: 30_000,
    });
    if (typeof res.data !== 'string') {
      // Some endpoints return JSON when there's an error
      throw new Error(`Unexpected non-string response: ${JSON.stringify(res.data).slice(0, 200)}`);
    }
    return res.data.trim();
  }
}

export function createSmsActivateClient(): SmsActivateClient {
  const apiKey = process.env.SMS_ACTIVATE_API_KEY;
  if (!apiKey) throw new Error('SMS_ACTIVATE_API_KEY not configured');
  return new SmsActivateClient({
    apiKey,
    service: process.env.SMS_ACTIVATE_SERVICE || 'vy', // VFS code; verify against current SMS-Activate catalogue
    country: process.env.SMS_ACTIVATE_COUNTRY || 'uz',
    maxPriceUSD: process.env.SMS_ACTIVATE_MAX_PRICE ? parseFloat(process.env.SMS_ACTIVATE_MAX_PRICE) : 0.5,
  });
}
