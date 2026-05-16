import { Page } from 'rebrowser-playwright';
import { solveTurnstile } from '@modules/captcha/twoCaptcha';
import { logEvent } from '@modules/logs/logger';
import { EventType } from '@prisma/client';

const DEFAULT_SITEKEY = '0x4AAAAAABhlz7Ei4byodYjs';

function routeBaseFromUrl(currentUrl: string): string {
  try {
    const parsed = new URL(currentUrl);
    const match = parsed.pathname.match(/^\/([a-z]{3})\/en\/([a-z]{3})\//i);
    if (match) return `${parsed.origin}/${match[1].toLowerCase()}/en/${match[2].toLowerCase()}`;
  } catch {}
  return 'https://visa.vfsglobal.com/uzb/en/lva';
}

async function fillFirstVisible(page: Page, selectors: string[], value: string, label: string): Promise<boolean> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if ((await locator.count().catch(() => 0)) === 0) continue;
    if (!(await locator.isVisible().catch(() => false))) continue;
    await locator.fill(value, { timeout: 10_000 });
    return true;
  }
  logEvent('warn', EventType.MONITOR_STARTED, `[AutoLogin] No selector matched ${label}: ${selectors.join(', ')}`);
  return false;
}

async function clickFirstVisible(page: Page, selectors: string[], label: string): Promise<boolean> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if ((await locator.count().catch(() => 0)) === 0) continue;
    if (!(await locator.isVisible().catch(() => false))) continue;
    await locator.click({ timeout: 10_000 });
    return true;
  }
  logEvent('warn', EventType.MONITOR_STARTED, `[AutoLogin] No selector matched ${label}: ${selectors.join(', ')}`);
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
  logEvent('info', EventType.CAPTCHA_SOLVED, '[AutoLogin] Turnstile token injected');
}

export async function autoReLogin(page: Page, profile: { email: string; password: string }): Promise<boolean> {
  const loginUrl = `${routeBaseFromUrl(page.url())}/login`;
  logEvent('info', EventType.SESSION_EXPIRED, `[AutoLogin] Re-login started for ${profile.email}`);

  await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
  await page.waitForSelector('input[type="email"], input[name="email"], input[formcontrolname="username"], input[formcontrolname="email"]', { timeout: 30_000 });

  const emailOk = await fillFirstVisible(page, [
    'input[type="email"]',
    'input[name="email"]',
    'input[formcontrolname="username"]',
    'input[formcontrolname="email"]',
    'input[id*="email" i]',
  ], profile.email, 'email');
  const passwordOk = await fillFirstVisible(page, [
    'input[type="password"]',
    'input[name="password"]',
    'input[formcontrolname="password"]',
    'input[id*="password" i]',
  ], profile.password, 'password');
  if (!emailOk || !passwordOk) return false;

  await solveTurnstileIfPresent(page);

  const clicked = await clickFirstVisible(page, [
    'button:has-text("Sign In")',
    'button:has-text("Login")',
    'button:has-text("Log In")',
    'button[type="submit"]',
  ], 'submit');
  if (!clicked) return false;

  await page.waitForURL((url) => !url.pathname.toLowerCase().includes('/login'), { timeout: 60_000 }).catch(() => {});
  const finalUrl = page.url().toLowerCase();
  const ok = !finalUrl.includes('/login') && !finalUrl.includes('/error') && !finalUrl.includes('/page-not-found');
  logEvent(ok ? 'info' : 'warn', ok ? EventType.MONITOR_STARTED : EventType.BOOKING_FAILED, `[AutoLogin] Re-login ${ok ? 'succeeded' : 'failed'} for ${profile.email}: ${page.url()}`);
  return ok;
}
