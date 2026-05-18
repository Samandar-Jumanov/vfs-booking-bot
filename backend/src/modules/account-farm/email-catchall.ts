/**
 * Email-catchall + Mailsac integration.
 *
 * Two strategies:
 *
 *   STRATEGY A — Catch-all domain (cheapest, recommended)
 *      Buy a domain (e.g. visa-bot-mail.com, $10/year)
 *      Point MX to Cloudflare Email Routing (free) with catch-all rule
 *         *@visa-bot-mail.com -> your-real-inbox@gmail.com
 *      Generate user001@visa-bot-mail.com, user002@..., etc.
 *      Read inbox via IMAP or via Gmail API on the destination inbox.
 *
 *   STRATEGY B — Mailsac API (zero ops, $5/mo)
 *      Use api.mailsac.com - generate temporary inboxes on demand
 *      Pull mail via REST.
 *      Already wired into env.ts as MAILSAC_API_KEY + EMAIL_DOMAIN.
 *
 * This module supports both. Driver picked by env vars.
 */

import axios from 'axios';
import { env } from '@config/env';

export interface EmailProvider {
  /** Generate a unique email address that will receive mail */
  allocate(): { email: string; readToken?: string };
  /** Poll for an OTP code in a recently-received message. Returns the code or throws. */
  waitForOtp(email: string, opts?: { timeoutMs?: number; pollMs?: number; subjectMatch?: RegExp; bodyMatch?: RegExp }): Promise<string>;
}

// ── STRATEGY A: Catch-all domain via IMAP ──────────────────────────────────

export class CatchAllEmailProvider implements EmailProvider {
  constructor(
    private domain: string,
    private imapConfig: { host: string; port: number; user: string; pass: string; tls: boolean },
  ) {}

  allocate(): { email: string } {
    const id = Math.random().toString(36).slice(2, 10);
    return { email: `user-${id}@${this.domain}` };
  }

  async waitForOtp(email: string, opts: { timeoutMs?: number; pollMs?: number; subjectMatch?: RegExp; bodyMatch?: RegExp } = {}): Promise<string> {
    // IMAP polling implementation. For brevity, this scaffold leaves the IMAP
    // connection details to a follow-up — add `imapflow` package and poll the
    // INBOX for messages whose To: matches `email`. Extract OTP via bodyMatch.
    throw new Error('CatchAllEmailProvider.waitForOtp: implement IMAP polling (use imapflow)');
  }
}

// ── STRATEGY B: Mailsac REST API ───────────────────────────────────────────

export class MailsacEmailProvider implements EmailProvider {
  private apiBase = 'https://mailsac.com/api';

  constructor(private apiKey: string, private domain: string) {}

  allocate(): { email: string; readToken: string } {
    const id = Math.random().toString(36).slice(2, 12);
    return { email: `user-${id}@${this.domain}`, readToken: this.apiKey };
  }

  async waitForOtp(
    email: string,
    opts: { timeoutMs?: number; pollMs?: number; subjectMatch?: RegExp; bodyMatch?: RegExp } = {},
  ): Promise<string> {
    const deadline = Date.now() + (opts.timeoutMs ?? 120_000);
    const pollMs = opts.pollMs ?? 4_000;
    const bodyMatch = opts.bodyMatch ?? /\b(\d{4,8})\b/;

    while (Date.now() < deadline) {
      const list = await axios.get(`${this.apiBase}/addresses/${encodeURIComponent(email)}/messages`, {
        headers: { 'Mailsac-Key': this.apiKey },
        timeout: 15_000,
      });
      for (const msg of list.data || []) {
        if (opts.subjectMatch && !opts.subjectMatch.test(msg.subject || '')) continue;
        const full = await axios.get(`${this.apiBase}/text/${encodeURIComponent(email)}/${msg._id}`, {
          headers: { 'Mailsac-Key': this.apiKey },
          timeout: 15_000,
        });
        const text = String(full.data || '');
        const m = text.match(bodyMatch);
        if (m) return m[1];
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    throw new Error(`No matching email received within ${opts.timeoutMs ?? 120_000}ms`);
  }
}

// ── Factory ────────────────────────────────────────────────────────────────

export function createEmailProvider(): EmailProvider {
  const domain = env.EMAIL_DOMAIN;
  if (!domain) throw new Error('EMAIL_DOMAIN not configured');
  if (env.MAILSAC_API_KEY) {
    return new MailsacEmailProvider(env.MAILSAC_API_KEY, domain);
  }
  // Catch-all fallback — requires IMAP creds in env (add to env.ts when ready)
  const imapHost = process.env.CATCHALL_IMAP_HOST;
  const imapUser = process.env.CATCHALL_IMAP_USER;
  const imapPass = process.env.CATCHALL_IMAP_PASS;
  if (!imapHost || !imapUser || !imapPass) {
    throw new Error(
      'No email provider configured. Set MAILSAC_API_KEY for Strategy B, ' +
        'or CATCHALL_IMAP_{HOST,USER,PASS} for Strategy A.',
    );
  }
  return new CatchAllEmailProvider(domain, {
    host: imapHost,
    port: parseInt(process.env.CATCHALL_IMAP_PORT || '993', 10),
    user: imapUser,
    pass: imapPass,
    tls: process.env.CATCHALL_IMAP_TLS !== 'false',
  });
}
