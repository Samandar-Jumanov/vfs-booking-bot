import { Page } from 'rebrowser-playwright';
import { env } from '@config/env';
import { solveTwoCaptcha, solveTurnstile, solveTurnstileWithCapMonster } from './twoCaptcha';
import { solveManually } from './manualFallback';
import { emitToAll } from '@modules/websocket/ws.server';
import { logEvent } from '@modules/logs/logger';
import { EventType } from '@prisma/client';

interface CaptchaInfo {
  type: 'recaptcha' | 'turnstile' | 'cf-challenge' | 'image' | 'none';
  siteKey?: string;
  action?: string;
  cdata?: string;
}

const CF_CHALLENGE_TIMEOUT_MS = 30_000;
const VFS_TURNSTILE_SITEKEY = '0x4AAAAAABhlz7Ei4byodYjs';

export async function detectCaptcha(page: Page): Promise<CaptchaInfo> {
  try {
    const found = await page.evaluate(() => {
      const turnstileEl = document.querySelector(
        '.cf-turnstile, [data-sitekey][class*="turnstile"], iframe[src*="challenges.cloudflare.com"]'
      );
      if (turnstileEl) {
        const host =
          turnstileEl.closest('[data-sitekey]') ?? document.querySelector('[data-sitekey]');
        const sitekey = host?.getAttribute('data-sitekey') ?? null;
        const action = host?.getAttribute('data-action') ?? null;
        const cdata = host?.getAttribute('data-cdata') ?? null;
        return { type: 'turnstile', sitekey, action, cdata };
      }

      const cfChallenge = document.querySelector(
        '#challenge-form, #cf-challenge-running, iframe[src*="challenges.cloudflare.com/cdn-cgi"]'
      );
      if (cfChallenge) return { type: 'cf-challenge' };

      const recaptchaEl = document.querySelector(
        '.g-recaptcha, iframe[src*="recaptcha"], [data-sitekey]'
      );
      if (recaptchaEl) {
        const sitekey = recaptchaEl.getAttribute('data-sitekey');
        if (sitekey) return { type: 'recaptcha', sitekey };
      }

      const hasImage = ['#captcha', '.captcha', 'img[alt*="captcha" i]'].some(
        (s) => !!document.querySelector(s)
      );
      if (hasImage) return { type: 'image' };

      return { type: 'none' };
    });

    if (found.type === 'turnstile' && found.sitekey) {
      return {
        type: 'turnstile',
        siteKey: found.sitekey,
        action: found.action ?? undefined,
        cdata: found.cdata ?? undefined,
      };
    }
    // VFS Global's new Turnstile renders in Shadow DOM — DOM detection above can't
    // see the sitekey. Detect Turnstile via the hidden response input + fall back
    // to the env-configured sitekey. This is the reliable path for VFS.
    {
      const hasTurnstile = await page.evaluate(() =>
        document.querySelectorAll('input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"], .cf-turnstile, iframe[src*="challenges.cloudflare.com"]').length > 0
      ).catch(() => false);
      if (hasTurnstile) {
        return { type: 'turnstile', siteKey: process.env.TURNSTILE_SITEKEY || VFS_TURNSTILE_SITEKEY };
      }
    }
    if (found.type === 'cf-challenge') return { type: 'cf-challenge' };
    if (found.type === 'recaptcha' && found.sitekey) {
      return { type: 'recaptcha', siteKey: found.sitekey };
    }
    if (found.type === 'image') return { type: 'image' };
  } catch {
    // Page evaluation failed — assume no captcha
  }

  return { type: 'none' };
}

async function waitForCloudflareChallenge(page: Page): Promise<void> {
  const deadline = Date.now() + CF_CHALLENGE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const stillChallenging = await page
      .evaluate(() => !!document.querySelector('#challenge-form, #cf-challenge-running'))
      .catch(() => false);
    if (!stillChallenging) return;
    await page.waitForTimeout(1000);
  }
}

export async function solveCaptcha(
  page: Page,
  sessionId: string
): Promise<string | null> {
  const info = await detectCaptcha(page);
  if (info.type === 'none') return null;

  if (info.type === 'cf-challenge') {
    await waitForCloudflareChallenge(page);
    return null;
  }

  let token: string;

  if (info.type === 'turnstile' && info.siteKey) {
    try {
      token = await solveTurnstile(info.siteKey, page.url(), info.action, info.cdata);
      logEvent('info', EventType.MONITOR_STARTED, `[Captcha] Turnstile solved by 2Captcha for ${sessionId}`);
    } catch (twoCaptchaErr: any) {
      logEvent('warn', EventType.IP_BLOCKED, `[Captcha] 2Captcha Turnstile failed for ${sessionId}: ${twoCaptchaErr?.message?.slice(0, 200)}`);
      if (env.CAPMONSTER_KEY) {
        token = await solveTurnstileWithCapMonster(info.siteKey, page.url());
        logEvent('info', EventType.MONITOR_STARTED, `[Captcha] Turnstile solved by CapMonster for ${sessionId}`);
      } else {
        emitToAll('CAPTCHA_MANUAL_NEEDED', {
          sessionId,
          url: page.url(),
          provider: 'turnstile',
          reason: twoCaptchaErr?.message ?? '2Captcha unavailable',
          timestamp: Date.now(),
        });
        throw new Error(`CAPTCHA_MANUAL_NEEDED: Turnstile solve failed for ${sessionId}`);
      }
    }

    await page.evaluate((t) => {
      const callback = (window as any).cfCallback;
      if (typeof callback === 'function') {
        callback(t);
        return;
      }
      const inputs = document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
        'input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]'
      );
      inputs.forEach((input) => {
        input.value = t;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
    }, token);

    return token;
  }

  if (info.type === 'recaptcha' && info.siteKey) {
    if (env.CAPTCHA_SOLVER === 'twocaptcha') {
      token = await solveTwoCaptcha(info.siteKey, page.url());
    } else {
      token = await solveManually(page, sessionId);
    }

    await page.evaluate((t) => {
      const textarea = document.getElementById('g-recaptcha-response') as HTMLTextAreaElement;
      if (textarea) {
        textarea.style.display = 'block';
        textarea.value = t;
        textarea.dispatchEvent(new Event('change'));
      }
      const hidden = document.querySelector<HTMLInputElement>('input[name="g-recaptcha-response"]');
      if (hidden) hidden.value = t;
    }, token);

    return token;
  }

  // Image captcha — always manual
  token = await solveManually(page, sessionId);
  return token;
}
