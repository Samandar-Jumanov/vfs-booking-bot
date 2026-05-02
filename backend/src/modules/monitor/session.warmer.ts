import { chromium } from 'playwright';
import { logEvent } from '@modules/logs/logger';
import { EventType } from '@prisma/client';
import { env } from '@config/env';

const BLOCK_LIST = [
  'google-analytics',
  'googletagmanager',
  'hotjar',
  'facebook',
  'doubleclick',
  'google ad',
  'analytics',
  'tracking',
  'sentry',
  'clarity',
];

export interface VfsCredentials {
  email: string;
  password: string;
}

export interface WarmerResult {
  cookies: string[];
  userAgent: string;
  secChUa: string;
}

/** Launch a stealth Chromium with optional proxy and sticky session. */
async function launchBrowser(proxy?: { host: string; port: number; auth?: { username: string; password?: string } }) {
  const proxyArgs = proxy ? [`--proxy-server=http://${proxy.host}:${proxy.port}`] : [];

  return chromium.launch({
    headless: true,
    executablePath: env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',        // Use disk instead of /dev/shm
      '--disable-gpu',                  // No GPU in Docker
      '--disable-software-rasterizer',
      '--disable-blink-features=AutomationControlled',
      '--disable-notifications',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-sync',
      '--disable-translate',
      '--hide-scrollbars',
      '--mute-audio',
      '--disable-features=IsolateOrigins,site-per-process',
      '--js-flags=--max-old-space-size=512',
      '--window-size=1280,720',
      ...proxyArgs,
    ],
  });
}

const UA   = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';
const CHDR = '"Google Chrome";v="134", "Chromium";v="134", "Not:A-Brand";v="24"';

async function loginAndNavigate(
  page: any,
  sourceCode: string,
  destinationCode: string,
  credentials: VfsCredentials,
): Promise<void> {
  const loginUrl = `https://visa.vfsglobal.com/${sourceCode}/${destinationCode}/en/login`;
  const scheduleUrl = `https://visa.vfsglobal.com/${sourceCode}/${destinationCode}/en/schedule-appointment`;

  await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 180000 });
  if (page.url().includes('403')) throw new Error('VFS 403 Forbidden - Proxy blocked');

  // Tiered Resilience: Wait for basic markers first, then Angular root
  await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => null);

  // Look for any VFS marker (Logo, ng-version, or the loading spinner)
  await Promise.race([
    page.waitForSelector('[ng-version]', { timeout: 90000 }),
    page.waitForSelector('img[alt*="VFS"]', { timeout: 90000 }),
    page.waitForSelector('input[formcontrolname="username"]', { timeout: 90000 }),
  ]).catch(() => {
    logEvent('warn', EventType.BOOKING_FAILED, `[Warmer] VFS markers missing after 90s. Continuing with caution...`);
  });

  // ── CRITICAL: Check page is still alive before proceeding ──────────────────
  if (page.isClosed()) {
    throw new Error('VFS closed the browser tab (bot detection). Will retry with new proxy.');
  }

  // Dismiss OneTrust
  const oneTrustSelectors = ['#onetrust-accept-btn-handler', 'button:has-text("Accept All")'];
  for (const sel of oneTrustSelectors) {
    try { await page.locator(sel).first().click({ timeout: 5000 }); break; } catch {}
  }

  // Guard again after cookie banner dismissal
  if (page.isClosed()) {
    throw new Error('VFS closed the browser tab after cookie banner. Will retry with new proxy.');
  }

  // Wait explicitly for the login form to be ready before filling
  await page.waitForSelector('input[formcontrolname="username"]', { timeout: 60000, state: 'visible' });
  await page.locator('input[formcontrolname="username"]').first().fill(credentials.email);
  await page.locator('input[formcontrolname="password"]').first().fill(credentials.password);
  await page.locator('button[type="submit"]').first().click({ timeout: 10000 });

  await page.waitForTimeout(10000);
  await page.goto(scheduleUrl, { waitUntil: 'domcontentloaded', timeout: 180000 });
}

export async function warmSessionWithBrowser(
  sourceCode: string,
  destinationCode: string,
  credentials: VfsCredentials,
  proxy?: { host: string; port: number; auth?: { username: string; password?: string } },
): Promise<WarmerResult> {
  logEvent('info', EventType.MONITOR_STARTED, `[Warmer] Bypassing security via Browser for ${destinationCode}...`);

  let browser;
  try {
    browser = await launchBrowser(proxy);
    const context = await browser.newContext({
      userAgent: UA,
      viewport: { width: 1280, height: 720 },
      ...(proxy && {
        proxy: {
          server: `http://${proxy.host}:${proxy.port}`,
          username: env.PROXY_USERNAME ? `${env.PROXY_USERNAME}-session-${Math.random().toString(36).substring(7)}` : proxy.auth?.username,
          password: proxy.auth?.password,
        },
      }),
    });

    const page = await context.newPage();
    await loginAndNavigate(page, sourceCode, destinationCode, credentials);

    const playwrightCookies = await context.cookies();
    const cookieStrings = playwrightCookies.map(c => `${c.name}=${c.value}`);

    return {
      cookies: cookieStrings,
      userAgent: UA,
      secChUa: CHDR,
    };

  } catch (err: any) {
    if (browser) {
      try {
        const contexts = browser.contexts();
        const pages = contexts.length > 0 ? contexts[0].pages() : [];
        if (pages.length > 0) {
          await pages[0].screenshot({ path: 'recordings/latest_failure.png', fullPage: true });
          logEvent('warn', EventType.BOOKING_FAILED, `[Warmer] Failure screenshot saved to recordings/latest_failure.png`);
        }
      } catch (screenshotErr) {
        // Ignore screenshot errors to prevent masking original error
      }
    }
    logEvent('error', EventType.BOOKING_FAILED, `[Warmer] Browser bypass failed: ${err.message}`);
    throw err;
  } finally {
    if (browser) await browser.close();
  }
}

export async function fetchSlotsWithBrowser(
  sourceCode: string,
  destCode: string,
  visaCategory: string,
  proxy?: { host: string; port: number; auth?: { username: string; password?: string } },
  _cookies?: string[],
  _retried = false,
  credentials?: VfsCredentials,
): Promise<any> {
  const slotsApiUrl  = `https://visa.vfsglobal.com/${sourceCode}/${destCode}/en/schedule-appointment/get-slots`;

  let browser;
  try {
    browser = await launchBrowser(proxy);
    const context = await browser.newContext({
      userAgent: UA,
      ...(proxy && {
        proxy: {
          server: `http://${proxy.host}:${proxy.port}`,
          username: env.PROXY_USERNAME ? `${env.PROXY_USERNAME}-session-${Math.random().toString(36).substring(7)}` : proxy.auth?.username,
          password: proxy.auth?.password,
        },
      }),
    });

    const page = await context.newPage();
    if (credentials) {
      await loginAndNavigate(page, sourceCode, destCode, credentials);
    } else {
      await page.goto(`https://visa.vfsglobal.com/${sourceCode}/${destCode}/en/schedule-appointment`, { waitUntil: 'domcontentloaded', timeout: 180000 });
    }

    const response = await page.waitForResponse(r => r.url().includes('get-slots') && r.status() === 200, { timeout: 60000 });
    return await response.json();

  } catch (err: any) {
    if (!_retried && credentials) {
        return fetchSlotsWithBrowser(sourceCode, destCode, visaCategory, proxy, _cookies, true, credentials);
    }
    throw err;
  } finally {
    if (browser) await browser.close();
  }
}
