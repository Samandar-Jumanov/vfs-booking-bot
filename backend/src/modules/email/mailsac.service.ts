import crypto from 'crypto';
import axios from 'axios';
import { env } from '@config/env';
import { sleep } from '@utils/retry';

const BASE_URL = 'https://mailsac.com/api';
const POLL_INTERVAL_MS = 5_000;

// Matches 4–8 consecutive digits that are either standalone or following
// common OTP label words ("code", "otp", "pin", "is", ":", etc.).
// The two-pass approach first tries to find a labelled code, then falls back
// to any standalone digit sequence of the right length.
const OTP_LABELLED_RE = /(?:code|otp|pin|verification|is)[^\d]{0,10}(\d{4,8})/i;
const OTP_STANDALONE_RE = /\b(\d{4,8})\b/;

interface MailsacMessage {
  _id: string;
  subject?: string;
  from?: Array<{ address: string }>;
  received?: string; // ISO-8601 timestamp, e.g. "2024-05-01T12:00:00.000Z"
}

type MailsacMessagesResponse = MailsacMessage[];

export interface MailsacMessageWithBody extends MailsacMessage {
  body: string;
}

export class MailsacService {
  private get apiKey(): string {
    if (!env.MAILSAC_API_KEY) {
      throw new Error('MAILSAC_API_KEY is not configured in environment variables');
    }
    return env.MAILSAC_API_KEY;
  }

  private get authHeaders(): Record<string, string> {
    return { 'Mailsac-Key': this.apiKey };
  }

  createInbox(): string {
    const domain = env.EMAIL_DOMAIN ?? 'mailsac.com';
    const localPart = `vfs-${crypto.randomBytes(6).toString('hex')}`;
    return `${localPart}@${domain}`;
  }

  async listInbox(address: string): Promise<MailsacMessageWithBody[]> {
    if (!address || !address.includes('@')) {
      throw new Error(`Invalid email address: "${address}"`);
    }

    const messages = await this.listMessages(address);
    const withBody: MailsacMessageWithBody[] = [];
    for (const message of messages) {
      const body = await this.fetchMessageText(address, message._id);
      withBody.push({ ...message, body });
    }
    return withBody;
  }

  /**
   * Poll the inbox for `address` every 5 seconds until a message arrives
   * **after** this method was called, then extract and return the 4–8 digit
   * OTP from the message body.
   *
   * Only messages whose `received` timestamp is >= `startedAt` are considered.
   * This prevents stale messages from a prior session being mistaken for a
   * fresh OTP.
   *
   * @throws {Error} if `address` is empty/invalid
   * @throws {Error} if no message containing an OTP arrives within `timeoutMs`
   */
  async waitForOtp(address: string, timeoutMs: number): Promise<string> {
    if (!address || !address.includes('@')) {
      throw new Error(`Invalid email address: "${address}"`);
    }

    const startedAt = new Date();
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const messages = await this.listMessages(address);

      // Filter to only messages received after this call started.
      const freshMessages = messages.filter((m) => {
        if (!m.received) return true; // unknown timestamp — include it
        return new Date(m.received) >= startedAt;
      });

      if (freshMessages.length > 0) {
        // Use the most recently received fresh message (first in the list).
        const messageId = freshMessages[0]._id;
        const body = await this.fetchMessageText(address, messageId);
        const otp = this.extractOtp(body);

        if (otp !== null) {
          return otp;
        }

        // Message arrived but contained no recognisable OTP — keep waiting.
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) break;

      await sleep(Math.min(POLL_INTERVAL_MS, remaining));
    }

    throw new Error(
      `waitForOtp timed out after ${timeoutMs}ms waiting for an OTP at ${address}`,
    );
  }

  /**
   * Delete all messages in the inbox for `address`.
   *
   * @throws {Error} if `address` is empty/invalid
   */
  async deleteMessages(address: string): Promise<void> {
    if (!address || !address.includes('@')) {
      throw new Error(`Invalid email address: "${address}"`);
    }

    await axios.delete(`${BASE_URL}/addresses/${encodeURIComponent(address)}/messages`, {
      headers: this.authHeaders,
    });
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async listMessages(address: string): Promise<MailsacMessage[]> {
    const response = await axios.get<unknown>(
      `${BASE_URL}/addresses/${encodeURIComponent(address)}/messages`,
      { headers: this.authHeaders },
    );
    // Guard against unexpected API responses (e.g. error objects instead of arrays)
    if (!Array.isArray(response.data)) {
      throw new Error(
        `Mailsac listMessages returned unexpected response type: ${typeof response.data}`,
      );
    }
    return response.data as MailsacMessage[];
  }

  private async fetchMessageText(address: string, messageId: string): Promise<string> {
    const response = await axios.get<string>(
      `${BASE_URL}/text/${encodeURIComponent(address)}/${encodeURIComponent(messageId)}`,
      {
        headers: this.authHeaders,
        responseType: 'text',
      },
    );
    // axios may parse the body automatically; coerce to string to be safe.
    return String(response.data);
  }

  private extractOtp(text: string): string | null {
    const labelledMatch = OTP_LABELLED_RE.exec(text);
    if (labelledMatch !== null) {
      return labelledMatch[1];
    }

    const standaloneMatch = OTP_STANDALONE_RE.exec(text);
    if (standaloneMatch !== null) {
      return standaloneMatch[1];
    }

    return null;
  }
}

export const mailsacService = new MailsacService();
