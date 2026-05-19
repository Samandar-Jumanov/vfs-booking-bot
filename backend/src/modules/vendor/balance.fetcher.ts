import axios from 'axios';
import { logger } from '@modules/logs/logger';

export interface VendorBalance {
  vendor: string;
  balanceUsd: number | null; // null = configured but unable to fetch
  currency: string;
  configured: boolean;
  error?: string;
}

const TIMEOUT_MS = 8_000;

async function onlinesimBalance(): Promise<VendorBalance> {
  const key = process.env.ONLINESIM_API_KEY;
  if (!key) return { vendor: 'onlinesim', balanceUsd: null, currency: 'USD', configured: false };
  try {
    const r = await axios.get('https://onlinesim.io/api/getBalance.php', {
      params: { apikey: key },
      timeout: TIMEOUT_MS,
    });
    // Response: { response: 1, balance: "4.30" } or similar
    const raw = r.data?.balance ?? r.data?.amount;
    const bal = typeof raw === 'string' ? parseFloat(raw) : Number(raw);
    return { vendor: 'onlinesim', balanceUsd: Number.isFinite(bal) ? bal : null, currency: 'USD', configured: true };
  } catch (err) {
    return { vendor: 'onlinesim', balanceUsd: null, currency: 'USD', configured: true, error: (err as Error).message };
  }
}

async function vaksmsBalance(): Promise<VendorBalance> {
  const key = process.env.VAKSMS_API_KEY;
  if (!key) return { vendor: 'vaksms', balanceUsd: null, currency: 'RUB', configured: false };
  try {
    const r = await axios.get('https://vak-sms.com/api/getBalance', {
      params: { apiKey: key },
      timeout: TIMEOUT_MS,
    });
    const bal = parseFloat(String(r.data?.balance ?? '0'));
    // Vak-SMS reports in RUB; rough conversion 1 USD ≈ 90 RUB
    const usd = Number.isFinite(bal) ? bal / 90 : null;
    return { vendor: 'vaksms', balanceUsd: usd, currency: 'RUB', configured: true };
  } catch (err) {
    return { vendor: 'vaksms', balanceUsd: null, currency: 'RUB', configured: true, error: (err as Error).message };
  }
}

async function twocaptchaBalance(): Promise<VendorBalance> {
  const key = process.env.TWOCAPTCHA_API_KEY;
  if (!key) return { vendor: '2captcha', balanceUsd: null, currency: 'USD', configured: false };
  try {
    const r = await axios.get('https://2captcha.com/res.php', {
      params: { key, action: 'getbalance', json: 1 },
      timeout: TIMEOUT_MS,
    });
    const bal = parseFloat(String(r.data?.request ?? '0'));
    return { vendor: '2captcha', balanceUsd: Number.isFinite(bal) ? bal : null, currency: 'USD', configured: true };
  } catch (err) {
    return { vendor: '2captcha', balanceUsd: null, currency: 'USD', configured: true, error: (err as Error).message };
  }
}

async function mailsacBalance(): Promise<VendorBalance> {
  const key = process.env.MAILSAC_API_KEY;
  if (!key) return { vendor: 'mailsac', balanceUsd: null, currency: 'USD', configured: false };
  // Mailsac is a flat subscription, not pay-per-use; report quota usage if available.
  try {
    const r = await axios.get('https://mailsac.com/api/me', {
      headers: { 'Mailsac-Key': key },
      timeout: TIMEOUT_MS,
    });
    const opsRemaining = r.data?.user?.opsRemaining;
    return {
      vendor: 'mailsac',
      balanceUsd: typeof opsRemaining === 'number' ? opsRemaining / 100 : null, // crude: ops as proxy
      currency: 'OPS',
      configured: true,
    };
  } catch (err) {
    return { vendor: 'mailsac', balanceUsd: null, currency: 'OPS', configured: true, error: (err as Error).message };
  }
}

export async function fetchAllBalances(): Promise<VendorBalance[]> {
  const results = await Promise.all([
    onlinesimBalance(),
    vaksmsBalance(),
    twocaptchaBalance(),
    mailsacBalance(),
  ]);
  results.forEach((b) => {
    if (b.error) logger.warn(`vendor balance fetch failed: ${b.vendor} ${b.error}`);
  });
  return results;
}
