import { chromium, BrowserContext } from 'playwright';
import { ProxyConfig } from '@t/index';
import { env } from '@config/env';

// Realistic user agents (Chrome 121 on Windows)
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0',
];

function randomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

export async function createBrowserContext(
  proxy?: ProxyConfig | null,
  cookieState?: string
): Promise<BrowserContext> {
  const userAgent = randomUserAgent();

  const context = await chromium.launchPersistentContext('', {
    headless: true,
    executablePath: env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    userAgent,
    viewport: { width: 1366, height: 768 },
    locale: 'en-GB',
    timezoneId: 'Africa/Luanda',
    ...(proxy && {
      proxy: {
        server: `http://${proxy.server}`,
        username: proxy.username,
        password: proxy.password,
      },
    }),
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-infobars',
      '--window-size=1366,768',
    ],
  });

  // Stealth patches
  await context.addInitScript(() => {
    // Mask webdriver flag
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

    // Mock plugins
    Object.defineProperty(navigator, 'plugins', {
      get: () => [{ name: 'Chrome PDF Plugin' }, { name: 'Chrome PDF Viewer' }],
    });

    // Mock languages
    Object.defineProperty(navigator, 'languages', { get: () => ['en-GB', 'en', 'pt'] });

    // Mask automation chrome
    // @ts-expect-error runtime patching
    delete window.chrome?.runtime?.connect;
  });

  // Restore cookies if available
  if (cookieState) {
    try {
      const cookies = JSON.parse(cookieState);
      await context.addCookies(cookies);
    } catch {
      // Invalid cookie state — ignore and start fresh
    }
  }

  return context;
}
