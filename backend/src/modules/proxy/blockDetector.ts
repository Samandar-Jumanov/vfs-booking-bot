import { Page, Response as PlaywrightResponse } from 'playwright';
import { BlockSignal } from '@t/index';

const BLOCK_URL_PATTERNS = ['/blocked', '/error', '/captcha', '/access-denied', '/rate-limit'];
const BLOCK_STATUS_CODES = [403, 429, 503];

export function detectBlockFromResponse(response: PlaywrightResponse): BlockSignal | null {
  const status = response.status();

  if (BLOCK_STATUS_CODES.includes(status)) {
    return {
      type: status === 429 ? 'rate_limit' : 'ip_block',
    };
  }

  const url = response.url().toLowerCase();
  if (BLOCK_URL_PATTERNS.some((p) => url.includes(p))) {
    return { type: 'ip_block' };
  }

  return null;
}

export async function detectBlockFromPage(page: Page): Promise<BlockSignal | null> {
  const url = page.url().toLowerCase();

  // Session expiry — redirected to login
  if (url.includes('/login') || url.includes('/signin')) {
    return { type: 'session_expired' };
  }

  // Check page text for common block indicators
  try {
    const bodyText = await page.evaluate(() => document.body?.innerText ?? '');
    const lower = bodyText.toLowerCase();

    if (lower.includes('access denied') || lower.includes('your ip')) {
      return { type: 'ip_block' };
    }
    if (lower.includes('too many requests') || lower.includes('rate limit')) {
      return { type: 'rate_limit' };
    }
  } catch {
    // Page may have navigated; ignore
  }

  return null;
}
