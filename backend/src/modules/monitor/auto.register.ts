import { Page } from 'rebrowser-playwright';
import { getRedis } from '@config/redis';
import { solveTurnstile } from '@modules/captcha/twoCaptcha';
import { logEvent } from '@modules/logs/logger';
import { sendTelegram } from '@modules/notifications/telegram.bot';
import { EventType } from '@prisma/client';
import { sleep } from '@utils/retry';

const DEFAULT_SITEKEY = '0x4AAAAAABhlz7Ei4byodYjs';
const OTP_WAIT_MS = 5 * 60_000;

function routeBaseFromUrl(currentUrl: string): string {
  try {
    const parsed = new URL(currentUrl);
    const match = parsed.pathname.match(/^\/([a-z]{3})\/en\/([a-z]{3})\//i);
    if (match) return `${parsed.origin}/${match[1].toLowerCase()}/en/${match[2].toLowerCase()}`;
  } catch {}
  return 'https://visa.vfsglobal.com/uzb/en/lva';
}

async function fillBestGuess(page: Page, label: string, selectors: string[], value: string): Promise<boolean> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if ((await locator.count().catch(() => 0)) === 0) continue;
    if (!(await locator.isVisible().catch(() => false))) continue;
    await locator.fill(value, { timeout: 10_000 });
    return true;
  }
  logEvent('warn', EventType.MONITOR_STARTED, `[AutoRegister] No selector matched ${label}: ${selectors.join(', ')}`);
  return false;
}

async function clickBestGuess(page: Page, label: string, selectors: string[]): Promise<boolean> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if ((await locator.count().catch(() => 0)) === 0) continue;
    if (!(await locator.isVisible().catch(() => false))) continue;
    await locator.click({ timeout: 10_000 });
    return true;
  }
  logEvent('warn', EventType.MONITOR_STARTED, `[AutoRegister] No selector matched ${label}: ${selectors.join(', ')}`);
  return false;
}

async function solveTurnstileIfPresent(page: Page): Promise<void> {
  const siteKey = await page.evaluate((fallback) => {
    const widget = document.querySelector('[data-sitekey]') as HTMLElement | null;
    return widget?.dataset.sitekey || fallback;
  }, DEFAULT_SITEKEY).catch(() => DEFAULT_SITEKEY);
  const hasWidget = await page.locator('[data-sitekey], iframe[src*="turnstile"], input[name="cf-turnstile-response"]').count().catch(() => 0);
  if (!hasWidget && !siteKey) return;

  const token = await solveTurnstile(siteKey || DEFAULT_SITEKEY, page.url());
  await page.evaluate((captchaToken) => {
    let input = document.querySelector('[name="cf-turnstile-response"]') as HTMLInputElement | null;
    if (!input) {
      input = document.createElement('input');
      input.type = 'hidden';
      input.name = 'cf-turnstile-response';
      document.body.appendChild(input);
    }
    input.value = captchaToken;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, token);
  logEvent('info', EventType.CAPTCHA_SOLVED, '[AutoRegister] Turnstile token injected');
}

async function waitForOtp(email: string): Promise<string | null> {
  const redis = getRedis();
  const key = `otp:${email}`;
  const deadline = Date.now() + OTP_WAIT_MS;

  while (Date.now() < deadline) {
    const otp = await redis.get(key);
    if (otp) {
      await redis.del(key);
      return otp;
    }
    await sleep(5_000);
  }
  return null;
}

export async function autoRegister(page: Page, data: { email: string; phone: string; password: string; firstName: string; lastName: string; dob: string; passportNumber: string }): Promise<{ ok: boolean; vfsAccountEmail?: string }> {
  const registerUrl = `${routeBaseFromUrl(page.url())}/register`;
  logEvent('info', EventType.MONITOR_STARTED, `[AutoRegister] Registration started for ${data.email}`);

  await page.goto(registerUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
  await page.waitForSelector('input[name="email"], input[type="email"], input[formcontrolname="email"]', { timeout: 30_000 });

  await fillBestGuess(page, 'email', ['input[name="email"]', 'input[type="email"]', 'input[formcontrolname="email"]', 'input[id*="email" i]'], data.email);
  await fillBestGuess(page, 'phone', ['input[name="phone"]', 'input[type="tel"]', 'input[formcontrolname="phone"]', 'input[id*="phone" i]'], data.phone);
  await fillBestGuess(page, 'password', ['input[name="password"]', 'input[type="password"]', 'input[formcontrolname="password"]', 'input[id*="password" i]'], data.password);
  await fillBestGuess(page, 'firstName', ['input[name="firstName"]', 'input[formcontrolname="firstName"]', 'input[id*="first" i]'], data.firstName);
  await fillBestGuess(page, 'lastName', ['input[name="lastName"]', 'input[formcontrolname="lastName"]', 'input[id*="last" i]'], data.lastName);
  await fillBestGuess(page, 'dob', ['input[name="dob"]', 'input[formcontrolname="dateOfBirth"]', 'input[formcontrolname="dob"]', 'input[id*="birth" i]'], data.dob);
  await fillBestGuess(page, 'passportNumber', ['input[name="passportNumber"]', 'input[formcontrolname="passportNumber"]', 'input[id*="passport" i]'], data.passportNumber);

  await solveTurnstileIfPresent(page);
  const submitted = await clickBestGuess(page, 'register submit', [
    'button:has-text("Register")',
    'button:has-text("Create")',
    'button:has-text("Submit")',
    'button[type="submit"]',
  ]);
  if (!submitted) return { ok: false };

  const otpSelector = 'input[name="otp"], input[formcontrolname="otp"], input[id*="otp" i], input[maxlength="6"]';
  const otpVisible = await page.waitForSelector(otpSelector, { timeout: 90_000 }).then(() => true).catch(() => false);
  if (!otpVisible) {
    logEvent('warn', EventType.CAPTCHA_REQUIRED, `[AutoRegister] OTP field was not detected for ${data.email}`);
    return { ok: false };
  }

  const message = `OTP needed for ${data.email} - paste 6-digit code in dashboard or POST /api/profiles/:id/submit-otp`;
  logEvent('warn', EventType.CAPTCHA_REQUIRED, `[AutoRegister] ${message}`);
  await sendTelegram(message).catch((err: Error) => {
    logEvent('warn', EventType.CAPTCHA_REQUIRED, `[AutoRegister] Telegram OTP alert failed: ${err.message}`);
  });

  const otp = await waitForOtp(data.email);
  if (!otp) {
    logEvent('warn', EventType.CAPTCHA_REQUIRED, `[AutoRegister] OTP wait timed out for ${data.email}`);
    return { ok: false };
  }

  await fillBestGuess(page, 'otp', ['input[name="otp"]', 'input[formcontrolname="otp"]', 'input[id*="otp" i]', 'input[maxlength="6"]'], otp);
  await clickBestGuess(page, 'otp submit', [
    'button:has-text("Verify")',
    'button:has-text("Submit")',
    'button:has-text("Continue")',
    'button[type="submit"]',
  ]);

  await page.waitForURL((url) => !url.pathname.toLowerCase().includes('/register'), { timeout: 60_000 }).catch(() => {});
  const finalUrl = page.url().toLowerCase();
  const ok = !finalUrl.includes('/register') && !finalUrl.includes('/error') && !finalUrl.includes('/page-not-found');
  logEvent(ok ? 'info' : 'warn', ok ? EventType.MONITOR_STARTED : EventType.BOOKING_FAILED, `[AutoRegister] Registration ${ok ? 'succeeded' : 'failed'} for ${data.email}: ${page.url()}`);
  return ok ? { ok, vfsAccountEmail: data.email } : { ok };
}
