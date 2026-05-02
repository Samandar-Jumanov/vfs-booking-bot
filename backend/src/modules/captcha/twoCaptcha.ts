import axios from 'axios';
import { env } from '@config/env';
import { sleep } from '@utils/retry';

const BASE = 'https://2captcha.com';
const POLL_INTERVAL_MS = 5000;
const MAX_WAIT_MS = 120_000;

async function submitAndPoll(submitParams: Record<string, string | number>): Promise<string> {
  if (!env.TWOCAPTCHA_API_KEY) {
    throw new Error('TWOCAPTCHA_API_KEY is not configured');
  }

  const submitRes = await axios.post(`${BASE}/in.php`, null, {
    params: { key: env.TWOCAPTCHA_API_KEY, json: 1, ...submitParams },
  });

  if (submitRes.data.status !== 1) {
    throw new Error(`2Captcha submit failed: ${submitRes.data.request}`);
  }

  const taskId = submitRes.data.request;
  const deadline = Date.now() + MAX_WAIT_MS;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);

    const pollRes = await axios.get(`${BASE}/res.php`, {
      params: { key: env.TWOCAPTCHA_API_KEY, action: 'get', id: taskId, json: 1 },
    });

    if (pollRes.data.status === 1) {
      return pollRes.data.request as string;
    }

    if (pollRes.data.request !== 'CAPCHA_NOT_READY') {
      throw new Error(`2Captcha poll error: ${pollRes.data.request}`);
    }
  }

  throw new Error('2Captcha solve timeout after 120s');
}

export async function solveTwoCaptcha(siteKey: string, pageUrl: string): Promise<string> {
  return submitAndPoll({ method: 'userrecaptcha', googlekey: siteKey, pageurl: pageUrl });
}

export async function solveTurnstile(
  siteKey: string,
  pageUrl: string,
  action?: string,
  cdata?: string
): Promise<string> {
  const params: Record<string, string | number> = {
    method: 'turnstile',
    sitekey: siteKey,
    pageurl: pageUrl,
  };
  if (action) params.action = action;
  if (cdata) params.data = cdata;
  return submitAndPoll(params);
}
