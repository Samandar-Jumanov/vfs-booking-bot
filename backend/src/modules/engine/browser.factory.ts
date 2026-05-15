import { chromium, BrowserContext } from 'rebrowser-playwright';
import fs from 'fs';
import path from 'path';
import { ProxyConfig } from '@t/index';
import { env } from '@config/env';
import { logger } from '@modules/logs/logger';

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
];

function randomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

export function resolveChromeExecutablePath(): string | undefined {
  const configured = env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  const defaultPath = process.platform === 'win32'
    ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
    : '/usr/bin/google-chrome';

  for (const candidate of [configured, defaultPath]) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }

  logger.warn('Falling back to bundled Chromium - stealth degraded');
  return undefined;
}

export function getBrowserProfileDir(destination = 'default'): string {
  const safeDestination = destination.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
  const dir = path.join(process.cwd(), '.browser-profiles', safeDestination);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Same fingerprint patching used by the session warmer — must stay in sync
const FINGERPRINT_SCRIPT = `
(function () {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
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
        makePlugin('Chrome PDF Plugin',  'internal-pdf-viewer',            'Portable Document Format'),
        makePlugin('Chrome PDF Viewer',  'mhjfbmdgcfjbbpaeojofohoefgiehjai', ''),
        makePlugin('Native Client',      'internal-nacl-plugin',            ''),
      ];
      Object.defineProperty(arr, 'item',      { value: (i) => arr[i] });
      Object.defineProperty(arr, 'namedItem', { value: (n) => arr.find(p => p.name === n) || null });
      return arr;
    },
  });
  if (!window.chrome) {
    window.chrome = { app: { isInstalled: false }, csi: () => {}, loadTimes: () => ({}), runtime: {} };
  }
  if (navigator.permissions && navigator.permissions.query) {
    const orig = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = (params) => {
      if (params && params.name === 'notifications') return Promise.resolve({ state: Notification.permission, onchange: null });
      return orig(params);
    };
  }
  const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function (type, ...args) {
    const ctx = this.getContext('2d');
    if (ctx) { const d = ctx.getImageData(0,0,this.width||1,this.height||1); d.data[d.data.length-1]^=Math.floor(Math.random()*10); ctx.putImageData(d,0,0); }
    return origToDataURL.call(this, type, ...args);
  };
  const gp = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function(p) {
    if (p===37445) return 'Intel Inc.'; if (p===37446) return 'Intel Iris OpenGL Engine'; return gp.call(this,p);
  };
  Object.defineProperty(navigator, 'languages',          { get: () => ['en-US','en','ru','uz'] });
  Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
  Object.defineProperty(navigator, 'deviceMemory',        { get: () => 8 });
})();
`;

export async function createBrowserContext(
  proxy?: ProxyConfig | null,
  cookieState?: string,
  destination = 'default',
): Promise<BrowserContext> {
  const userAgent = randomUserAgent();
  // VFS Global's WAF returns 403 {"code":"403201"} to headless Chrome regardless
  // of proxy/User-Agent. Set BROWSER_HEADLESS=false in env to run headed (required
  // for any real VFS interaction). Default headless=true is fine for unit tests
  // and dev tasks that don't actually hit visa.vfsglobal.com.
  const headless = process.env.BROWSER_HEADLESS !== 'false';

  const launchOptions = {
    headless,
    executablePath: resolveChromeExecutablePath(),
    userAgent,
    viewport: { width: 1280, height: 720 },
    locale: 'uz-UZ',
    timezoneId: 'Asia/Tashkent',
    geolocation: { latitude: 41.2995, longitude: 69.2401 },
    permissions: ['geolocation'],
    ignoreHTTPSErrors: true,
    ...(proxy && {
      proxy: {
        server:   `http://${proxy.server}`,
        username: proxy.username,
        password: proxy.password,
      },
    }),
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--disable-notifications',
      '--window-size=1280,720',
      '--ignore-certificate-errors',
    ],
  };

  let context: BrowserContext;

  if (env.BRIGHTDATA_WS) {
    logger.info('[browser.factory] Connecting to Bright Data Scraping Browser');
    const browser = await chromium.connectOverCDP(env.BRIGHTDATA_WS, {
      timeout: 60000,
    });
    context = browser.contexts()[0] ?? await browser.newContext({
      userAgent,
      viewport: { width: 1280, height: 720 },
      locale: 'uz-UZ',
      timezoneId: 'Asia/Tashkent',
      geolocation: { latitude: 41.2995, longitude: 69.2401 },
      permissions: ['geolocation'],
      ignoreHTTPSErrors: true,
    });
  } else {
    logger.info('[browser.factory] Launching local Chromium (no BD)');
    context = await chromium.launchPersistentContext(getBrowserProfileDir(destination), launchOptions);
  }

  await context.addInitScript(FINGERPRINT_SCRIPT);

  // Bandwidth-saver: block heavy resources that VFS doesn't need to function
  // for our automation tasks (login, form fill, slot poll). Cuts proxy traffic
  // by ~50-70% on a typical page load.
  await context.route('**/*', (route) => {
    const type = route.request().resourceType();
    if (type === 'image' || type === 'font' || type === 'media') return route.abort();
    const url = route.request().url();
    if (/google-analytics\.com|googletagmanager\.com|hotjar\.com|doubleclick\.net|facebook\.net|clarity\.ms/.test(url)) {
      return route.abort();
    }
    return route.continue();
  });

  if (cookieState) {
    try {
      const cookies = JSON.parse(cookieState);
      await context.addCookies(cookies);
    } catch {
      // Invalid cookie state — start fresh
    }
  }

  return context;
}
