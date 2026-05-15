import { BrowserContext, chromium } from 'rebrowser-playwright';
import { logEvent } from '@modules/logs/logger';
import { EventType } from '@prisma/client';
import { env } from '@config/env';
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { solveCaptcha } from '@modules/captcha/captcha.service';
import { getBrowserProfileDir, resolveChromeExecutablePath } from '@modules/engine/browser.factory';
import { attachDiagnostics, dumpLoginFailureDiagnostics } from '@modules/engine/vfs/vfs.diagnostics';

export interface VfsCredentials {
  email: string;
  password: string;
}

export interface WarmerResult {
  cookies: string[];
  userAgent: string;
  secChUa: string;
  ltSnExpiresAt?: string;
}

const UA   = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';
const CHDR = '"Google Chrome";v="134", "Chromium";v="134", "Not:A-Brand";v="24"';

// Injected into every page before any scripts run.
// Patches the fingerprint signals that VFS's bot detection reads.
const FINGERPRINT_SCRIPT = `
(function () {
  // 1. Hide webdriver flag
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

  // 2. Realistic plugin list (real Chrome has these)
  Object.defineProperty(navigator, 'plugins', {
    get: () => {
      const makePlugin = (name, fn, desc) => {
        const p = Object.create(Plugin.prototype);
        Object.defineProperty(p, 'name',        { value: name });
        Object.defineProperty(p, 'filename',    { value: fn });
        Object.defineProperty(p, 'description', { value: desc });
        Object.defineProperty(p, 'length',      { value: 0 });
        return p;
      };
      const arr = [
        makePlugin('Chrome PDF Plugin',         'internal-pdf-viewer',   'Portable Document Format'),
        makePlugin('Chrome PDF Viewer',          'mhjfbmdgcfjbbpaeojofohoefgiehjai', ''),
        makePlugin('Native Client',              'internal-nacl-plugin',  ''),
      ];
      Object.defineProperty(arr, 'item',   { value: (i) => arr[i] });
      Object.defineProperty(arr, 'namedItem', { value: (n) => arr.find(p => p.name === n) || null });
      return arr;
    },
  });

  // 3. Populate window.chrome to look like real Chrome
  if (!window.chrome) {
    window.chrome = {
      app: { isInstalled: false, InstallState: {}, RunningState: {} },
      csi: () => {},
      loadTimes: () => ({}),
      runtime: {},
    };
  }

  // 4. Permissions API — real Chrome returns 'granted' for notifications query
  if (navigator.permissions && navigator.permissions.query) {
    const orig = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = (params) => {
      if (params && params.name === 'notifications') {
        return Promise.resolve({ state: Notification.permission, onchange: null });
      }
      return orig(params);
    };
  }

  // 5. Canvas noise — randomise last byte of each pixel so fingerprint differs each session
  const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function (type, ...args) {
    const ctx = this.getContext('2d');
    if (ctx) {
      const imgData = ctx.getImageData(0, 0, this.width || 1, this.height || 1);
      imgData.data[imgData.data.length - 1] ^= Math.floor(Math.random() * 10);
      ctx.putImageData(imgData, 0, 0);
    }
    return origToDataURL.call(this, type, ...args);
  };

  // 6. WebGL renderer string — report a common real GPU
  const getParam = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function (param) {
    if (param === 37445) return 'Intel Inc.';
    if (param === 37446) return 'Intel Iris OpenGL Engine';
    return getParam.call(this, param);
  };
  if (typeof WebGL2RenderingContext !== 'undefined') {
    const getParam2 = WebGL2RenderingContext.prototype.getParameter;
    WebGL2RenderingContext.prototype.getParameter = function (param) {
      if (param === 37445) return 'Intel Inc.';
      if (param === 37446) return 'Intel Iris OpenGL Engine';
      return getParam2.call(this, param);
    };
  }

  // 7. Languages
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en', 'ru', 'uz'] });

  // 8. Hardware concurrency + device memory (common laptop values)
  Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
  Object.defineProperty(navigator, 'deviceMemory',        { get: () => 8 });
})();
`;

async function launchBrowser(proxy?: { host: string; port: number; auth?: { username: string; password?: string } }) {
  const proxyArgs = proxy ? [`--proxy-server=http://${proxy.host}:${proxy.port}`] : [];

  // VFS Global's WAF returns 403 {"code":"403201"} to headless Chrome.
  // Set BROWSER_HEADLESS=false in env to run headed (required for VFS).
  // DISPLAY (Xvfb in Docker) is the legacy headed-detection path — kept for
  // compatibility, but BROWSER_HEADLESS is the explicit override.
  const headless = process.env.BROWSER_HEADLESS === 'false'
    ? false
    : !Boolean(process.env.DISPLAY);

  return chromium.launch({
    headless,
    executablePath: resolveChromeExecutablePath(),
    proxy: { server: 'per-context' },
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--disable-notifications',
      '--disable-background-networking',
      '--disable-sync',
      '--disable-translate',
      '--mute-audio',
      '--window-size=1280,720',
      '--ignore-certificate-errors',
      ...proxyArgs,
    ],
  });
}

async function loginAndNavigate(
  page: any,
  sourceCode: string,
  destinationCode: string,
  credentials: VfsCredentials,
): Promise<void> {
  const homeUrl     = `https://visa.vfsglobal.com/${sourceCode}/en/${destinationCode}/`;
  const loginUrl    = `https://visa.vfsglobal.com/${sourceCode}/en/${destinationCode}/login`;
  const scheduleUrl = `https://visa.vfsglobal.com/${sourceCode}/en/${destinationCode}/schedule-appointment`;

  // Log auth-related API responses for diagnostics
  page.on('response', async (res: any) => {
    const url = res.url();
    if (url.includes('/login') || url.includes('/auth') || url.includes('/user') || url.includes('/token') || url.includes('/session')) {
      const status = res.status();
      let body = '';
      try { body = await res.text(); } catch {}
      logEvent('info', EventType.MONITOR_STARTED,
        `[Warmer] API: ${status} ${url.substring(url.lastIndexOf('/'))} | ${body.substring(0, 200)}`);
    }
  });

  // ── Step 1: Visit country homepage to seed session cookies + handle cookie consent.
  // VFS rejects direct /login navigation with "Session Expired or Invalid" if no
  // session cookie was set by a prior page view.
  await page.goto(homeUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  if (page.url().includes('/page-not-found')) {
    throw new Error(`VFS_HOME_BLOCKED: homepage redirected to ${page.url()}`);
  }
  await page.waitForTimeout(1200);

  const cookieSelectors = [
    'button:has-text("Accept All Cookies")',
    'button:has-text("Accept All")',
    'button:has-text("Accept all")',
    'button:has-text("Accept Only Necessary")',
    '#onetrust-accept-btn-handler',
    '[aria-label*="Accept"]',
  ];
  for (const sel of cookieSelectors) {
    try {
      const btn = await page.$(sel);
      if (btn && await btn.isVisible()) {
        await btn.click();
        logEvent('info', EventType.MONITOR_STARTED, `[Warmer] Cookie consent dismissed via ${sel}`);
        await page.waitForTimeout(800);
        break;
      }
    } catch { /* try next */ }
  }
  await page.waitForTimeout(1000);

  // ── Step 2: Now navigate to the login page with cookies seeded.
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  if (page.url().includes('403')) throw new Error('VFS 403 Forbidden - Proxy blocked');
  if (page.isClosed()) throw new Error('VFS closed the tab (bot detection).');

  const urlAfterGoto = page.url();
  if (urlAfterGoto.includes('/page-not-found') || urlAfterGoto.includes('/session-expired')) {
    throw new Error(`VFS_BOT_DETECTED: immediate redirect to ${urlAfterGoto}`);
  }

  await Promise.race([
    page.waitForSelector('button[type="submit"]',       { timeout: 60000, state: 'visible' }),
    page.waitForSelector('button:has-text("Sign in")',  { timeout: 60000, state: 'visible' }),
    page.waitForSelector('button:has-text("Sign In")',  { timeout: 60000, state: 'visible' }),
  ]);

  const currentUrl = page.url();
  if (currentUrl.includes('/page-not-found') || currentUrl.includes('/error') || currentUrl.includes('/session-expired')) {
    throw new Error(`VFS_BOT_DETECTED: redirected to ${currentUrl} during form wait`);
  }
  logEvent('info', EventType.MONITOR_STARTED, `[Warmer] Login form ready at ${currentUrl}`);
  if (page.isClosed()) throw new Error('VFS closed the tab before login.');

  await page.evaluate(([email, password]: string[]) => {
    const trigger = (el: HTMLInputElement, val: string) => {
      el.focus();
      el.value = val;
      el.dispatchEvent(new Event('input',  { bubbles: true, cancelable: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur',   { bubbles: true }));
    };
    const u = document.querySelector('input[formcontrolname="username"]') as HTMLInputElement;
    const p = document.querySelector('input[formcontrolname="password"]') as HTMLInputElement;
    if (u) trigger(u, email);
    if (p) trigger(p, password);
  }, [credentials.email, credentials.password]);

  // VFS shows Cloudflare Turnstile on /login. solveCaptcha() detects it,
  // calls 2Captcha for a token (if CAPTCHA_SOLVER=twocaptcha + TWOCAPTCHA_API_KEY),
  // and injects it into cf-turnstile-response. No-op if no captcha is present.
  try {
    await solveCaptcha(page, `warmer:${sourceCode}-${destinationCode}`);
    logEvent('info', EventType.MONITOR_STARTED, `[Warmer] Captcha step complete`);
  } catch (e: any) {
    if (e?.message?.includes('CAPTCHA_MANUAL_NEEDED')) throw e;
    logEvent('warn', EventType.MONITOR_STARTED, `[Warmer] Captcha solve failed: ${e?.message?.slice(0, 200)}`);
  }

  // Wait briefly for the submit button to enable (Turnstile token lands → form valid).
  await page.waitForFunction(() => {
    const btn = document.querySelector('button[type="submit"]') as HTMLButtonElement | null;
    return btn && !btn.disabled;
  }, { timeout: 15_000 }).catch(() => {/* submit may still work via force-click */});

  await page.locator('button[type="submit"], button:has-text("Sign in"), button:has-text("Sign In")').first().click({ timeout: 10000, force: true });
  await page.waitForURL((url: string) => !url.includes('/login'), { timeout: 30000 }).catch(() => null);
  await page.waitForTimeout(3000);

  const postLoginUrl = page.url();
  if (postLoginUrl.includes('/page-not-found') || postLoginUrl.includes('/error') || postLoginUrl.includes('session-expired')) {
    const h1 = await page.locator('h1').first().textContent({ timeout: 2000 }).catch(() => '');
    throw new Error(`VFS_BOT_DETECTED: login redirected to ${postLoginUrl}: ${h1?.trim()}`);
  }

  await page.goto(scheduleUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
}

export async function warmSessionWithBrowser(
  sourceCode: string,
  destinationCode: string,
  credentials: VfsCredentials,
  proxy?: { host: string; port: number; auth?: { username: string; password?: string } },
): Promise<WarmerResult> {
  logEvent('info', EventType.MONITOR_STARTED, `[Warmer] Launching browser for ${destinationCode} (headed=${Boolean(process.env.DISPLAY)})...`);

  let context: BrowserContext | undefined;
  try {
    const proxyArgs = proxy ? [`--proxy-server=http://${proxy.host}:${proxy.port}`] : [];
    context = await chromium.launchPersistentContext(getBrowserProfileDir(destinationCode), {
      headless: process.env.BROWSER_HEADLESS === 'false' ? false : !Boolean(process.env.DISPLAY),
      executablePath: resolveChromeExecutablePath(),
      userAgent: UA,
      viewport: { width: 1280, height: 720 },
      locale: 'uz-UZ',
      timezoneId: 'Asia/Tashkent',
      geolocation: { latitude: 41.2995, longitude: 69.2401 },
      permissions: ['geolocation'],
      ignoreHTTPSErrors: true,
      extraHTTPHeaders: {
        'sec-ch-ua': CHDR,
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
      },
      ...(proxy && {
        proxy: {
          server:   `http://${proxy.host}:${proxy.port}`,
          username: proxy.auth?.username,
          password: proxy.auth?.password,
        },
      }),
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--disable-notifications',
        '--disable-background-networking',
        '--disable-sync',
        '--disable-translate',
        '--mute-audio',
        '--window-size=1280,720',
        '--ignore-certificate-errors',
        ...proxyArgs,
      ],
    });

    // Inject fingerprint patches into every page before any site scripts run
    await context.addInitScript(FINGERPRINT_SCRIPT);

    // Bandwidth-saver: block heavy resources to extend proxy GB budget.
    await context.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (type === 'image' || type === 'font' || type === 'media') return route.abort();
      const url = route.request().url();
      if (/google-analytics\.com|googletagmanager\.com|hotjar\.com|doubleclick\.net|facebook\.net|clarity\.ms/.test(url)) {
        return route.abort();
      }
      return route.continue();
    });

    const page = await context.newPage();
    attachDiagnostics(page);
    await loginAndNavigate(page, sourceCode, destinationCode, credentials);

    const playwrightCookies = await context.cookies();
    const cookieStrings = playwrightCookies.map(c => `${c.name}=${c.value}`);
    const ltSn = playwrightCookies.find(c => c.name === 'lt_sn');
    const ltSnExpiresAt = ltSn?.expires && ltSn.expires > 0
      ? new Date(ltSn.expires * 1000).toISOString()
      : undefined;

    return { cookies: cookieStrings, userAgent: UA, secChUa: CHDR, ltSnExpiresAt };

  } catch (err: any) {
    if (context) {
      try {
        const pages = context.pages() ?? [];
        if (pages.length > 0) {
          const diag = await dumpLoginFailureDiagnostics(pages[0], err.message, `warmer-${sourceCode}-${destinationCode}`);
          logEvent('error', EventType.BOOKING_FAILED, `[Warmer] Login diagnostics saved`, {
            correlationId: `warmer-${sourceCode}-${destinationCode}`,
            diagnostics: diag,
          });
        }
      } catch {}
    }
    logEvent('error', EventType.BOOKING_FAILED, `[Warmer] Browser failed: ${err.message}`);
    throw err;
  } finally {
    if (context) await context.close();
  }
}

/**
 * Keeps a VFS session alive by pinging the schedule-appointment page every 15 minutes.
 * Returns a cancel function — call it when the monitor stops.
 */
export function keepSessionAlive(
  sourceCode: string,
  destCode: string,
  getCookies: () => string[] | undefined,
  proxy?: { url: string },
): () => void {
  const INTERVAL = 15 * 60 * 1000;
  const url = `https://visa.vfsglobal.com/${sourceCode}/en/${destCode}/schedule-appointment`;

  const tick = async () => {
    const cookies = getCookies();
    if (!cookies || cookies.length === 0) return;
    try {
      const agent = proxy?.url ? new HttpsProxyAgent(proxy.url) as any : undefined;
      await axios.get(url, {
        timeout: 30000,
        headers: {
          'Cookie':     cookies.map(c => c.split(';')[0]).join('; '),
          'User-Agent': UA,
        },
        httpsAgent: agent,
        proxy: false,
        maxRedirects: 3,
        validateStatus: () => true,
      });
      logEvent('info', EventType.MONITOR_STARTED, `[KeepAlive] Session pinged for ${destCode}`);
    } catch (e: any) {
      logEvent('warn', EventType.MONITOR_STARTED, `[KeepAlive] Ping failed for ${destCode}: ${e.message}`);
    }
  };

  const handle = setInterval(tick, INTERVAL);
  return () => clearInterval(handle);
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
  let browser;
  try {
    browser = await launchBrowser(proxy);
    const context = await browser.newContext({
      userAgent: UA,
      locale: 'en-US',
      timezoneId: 'Asia/Tashkent',
      ignoreHTTPSErrors: true,
      ...(proxy && {
        proxy: {
          server:   `http://${proxy.host}:${proxy.port}`,
          username: proxy.auth?.username,
          password: proxy.auth?.password,
        },
      }),
    });
    await context.addInitScript(FINGERPRINT_SCRIPT);

    // Bandwidth-saver: block heavy resources to extend proxy GB budget.
    await context.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (type === 'image' || type === 'font' || type === 'media') return route.abort();
      const url = route.request().url();
      if (/google-analytics\.com|googletagmanager\.com|hotjar\.com|doubleclick\.net|facebook\.net|clarity\.ms/.test(url)) {
        return route.abort();
      }
      return route.continue();
    });

    const page = await context.newPage();
    if (credentials) {
      await loginAndNavigate(page, sourceCode, destCode, credentials);
    } else {
      await page.goto(`https://visa.vfsglobal.com/${sourceCode}/en/${destCode}/schedule-appointment`, { waitUntil: 'domcontentloaded', timeout: 180000 });
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
