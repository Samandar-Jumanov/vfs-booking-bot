/**
 * Playwright-driven slot fetcher.
 *
 * Why this exists: VFS Cloudflare WAF rejects axios POSTs to the get-slots
 * endpoint with 403 even when the cookies are valid (TLS fingerprint mismatch,
 * missing browser-only headers). Running the same fetch from inside a real
 * Chromium page bypasses that — TLS fingerprint matches, sec-ch-ua headers are
 * automatic, and cookies are picked up from the context.
 *
 * Strategy: maintain one long-lived browser context per destination. Each poll
 * navigates to the schedule-appointment page (so the SPA initialises XSRF/JWT
 * tokens in localStorage), then runs the slot POST via window.fetch() inside
 * the page. We reuse the page across polls; only re-create on cookie change
 * or after errors.
 */
import { chromium, Browser, BrowserContext, Page } from 'rebrowser-playwright';
import { prisma } from '@config/database';
import { env } from '@config/env';
import { getBrowserProfileDir, resolveChromeExecutablePath } from '@modules/engine/browser.factory';
import { fetchViaScraperApi } from '@modules/proxy/scraperapi.provider';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';

interface CtxBundle {
  context: BrowserContext;
  page: Page;
  destinationCode: string;
  cookieFingerprint: string; // hash of cookies — re-create context if cookies change
  createdAt: number;
}

const contexts = new Map<string, CtxBundle>();
const cdpPageCache = new Map<string, Page>();
const profileEmailCache = new Map<string, string>();
let cdpBrowserPromise: Promise<Browser> | undefined;

const MAX_CONTEXT_AGE_MS = 30 * 60 * 1000; // recycle context every 30 min

function fingerprintCookies(setCookieArr: string[]): string {
  return setCookieArr.map((h) => h.split(';')[0].trim()).sort().join('|');
}

function parseSetCookieArrayToPlaywright(setCookieArr: string[], domain = '.vfsglobal.com'): any[] {
  return setCookieArr
    .map((raw) => {
      const parts = raw.split(';').map((p) => p.trim());
      const [nameValue, ...rest] = parts;
      const eqIdx = nameValue.indexOf('=');
      if (eqIdx < 0) return null;
      const name = nameValue.slice(0, eqIdx);
      const value = nameValue.slice(eqIdx + 1);
      const cookie: any = { name, value, domain, path: '/', secure: true, httpOnly: false, sameSite: 'None' as const };
      for (const p of rest) {
        const lower = p.toLowerCase();
        if (lower === 'httponly') cookie.httpOnly = true;
        else if (lower === 'secure') cookie.secure = true;
        else if (lower.startsWith('domain=')) cookie.domain = p.slice(7);
        else if (lower.startsWith('path=')) cookie.path = p.slice(5);
        else if (lower.startsWith('samesite=')) {
          const ss = p.slice(9).toLowerCase();
          cookie.sameSite = ss === 'strict' ? 'Strict' : ss === 'lax' ? 'Lax' : 'None';
        }
      }
      return cookie;
    })
    .filter(Boolean);
}

function getCdpBrowser(): Promise<Browser> {
  if (!env.CDP_ENDPOINT) {
    throw new Error('CDP_ENDPOINT is not configured');
  }
  cdpBrowserPromise ??= chromium.connectOverCDP(env.CDP_ENDPOINT, { timeout: 30000 });
  return cdpBrowserPromise;
}

function tabMatchesRoute(url: string, sourceCode: string, destCode: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'visa.vfsglobal.com'
      && parsed.pathname.toLowerCase().startsWith(`/${sourceCode.toLowerCase()}/en/${destCode.toLowerCase()}/`);
  } catch {
    return false;
  }
}

async function getProfileEmail(profileId: string): Promise<string | undefined> {
  const cached = profileEmailCache.get(profileId);
  if (cached) return cached;
  if (profileId === '*') return undefined;

  try {
    const profile = await prisma.profile.findUnique({
      where: { id: profileId },
      select: { email: true },
    });
    if (profile?.email) {
      profileEmailCache.set(profileId, profile.email);
      return profile.email;
    }
  } catch {
    // If the DB is unavailable, tab matching can still fall back to route-only.
  }

  return undefined;
}

export async function findPageForProfile(profileId: string, sourceCode: string, destCode: string): Promise<Page | null> {
  const cacheKey = `${profileId}:${sourceCode}:${destCode}`.toLowerCase();
  const cached = cdpPageCache.get(cacheKey);
  if (cached && !cached.isClosed() && tabMatchesRoute(cached.url(), sourceCode, destCode)) {
    return cached;
  }
  cdpPageCache.delete(cacheKey);

  const browser = await getCdpBrowser();
  const context = browser.contexts()[0];
  if (!context) return null;

  const email = await getProfileEmail(profileId);
  const routeMatches: Page[] = [];
  for (const page of context.pages()) {
    if (page.isClosed() || !tabMatchesRoute(page.url(), sourceCode, destCode)) continue;
    routeMatches.push(page);

    if (email) {
      const title = await page.title().catch(() => '');
      if (title.toLowerCase().includes(email.toLowerCase())) {
        cdpPageCache.set(cacheKey, page);
        return page;
      }
    }
  }

  if (!email && routeMatches.length === 1) {
    cdpPageCache.set(cacheKey, routeMatches[0]);
    return routeMatches[0];
  }

  if (email && routeMatches.length === 1) {
    const title = await routeMatches[0].title().catch(() => '');
    if (!title || routeMatches.length === 1) {
      cdpPageCache.set(cacheKey, routeMatches[0]);
      return routeMatches[0];
    }
  }

  return null;
}

async function ensureContext(destinationCode: string, sourceCode: string, cookies: string[], userAgent?: string): Promise<CtxBundle> {
  const key = destinationCode;
  const fp = fingerprintCookies(cookies);
  const existing = contexts.get(key);

  const stillFresh = existing
    && existing.cookieFingerprint === fp
    && (Date.now() - existing.createdAt) < MAX_CONTEXT_AGE_MS;

  if (stillFresh) return existing!;

  // Tear down stale context
  if (existing) {
    try { await existing.context.close(); } catch {}
    contexts.delete(key);
  }

  const headless = process.env.BROWSER_HEADLESS === 'false' ? false : true;
  const {
    PROXY_HOST,
    PROXY_PORT,
    PROXY_USERNAME,
    PROXY_PASSWORD,
  } = process.env;
  let context: BrowserContext;

  if (process.env.BRIGHTDATA_WS) {
    const browser = await chromium.connectOverCDP(process.env.BRIGHTDATA_WS);
    context = browser.contexts()[0] ?? await browser.newContext({
      userAgent: userAgent || UA,
      viewport: { width: 1280, height: 720 },
      locale: 'uz-UZ',
      timezoneId: 'Asia/Tashkent',
      geolocation: { latitude: 41.2995, longitude: 69.2401 },
      permissions: ['geolocation'],
      ignoreHTTPSErrors: true,
    });
  } else {
    context = await chromium.launchPersistentContext(getBrowserProfileDir(destinationCode), {
      headless,
      executablePath: resolveChromeExecutablePath(),
      userAgent: userAgent || UA,
      viewport: { width: 1280, height: 720 },
      locale: 'uz-UZ',
      timezoneId: 'Asia/Tashkent',
      geolocation: { latitude: 41.2995, longitude: 69.2401 },
      permissions: ['geolocation'],
      ignoreHTTPSErrors: true,
      ...(PROXY_HOST && PROXY_PORT && {
        proxy: {
          server: `http://${PROXY_HOST}:${PROXY_PORT}`,
          username: PROXY_USERNAME ?? undefined,
          password: PROXY_PASSWORD ?? undefined,
        },
      }),
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-notifications',
        '--mute-audio',
        '--window-size=1280,720',
      ],
    });
  }

  // Block heavy resources to save bandwidth
  await context.route('**/*', (route) => {
    const type = route.request().resourceType();
    if (type === 'image' || type === 'font' || type === 'media') return route.abort();
    return route.continue();
  });

  const playwrightCookies = parseSetCookieArrayToPlaywright(cookies);
  const skipNames = new Set(['__cf_bm', '_cfuvid']);
  const filteredCookies = playwrightCookies
    .filter(c => !skipNames.has(c.name))
    .map(c => ({
      name: c.name,
      value: c.value,
      url: 'https://visa.vfsglobal.com',
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite,
      expires: c.expires,
    }));

  if (filteredCookies.length) {
    try {
      await context.clearCookies();  // Wipe BrightData's pre-set cookies first
    } catch (e: any) {
      console.warn('clearCookies failed (continuing):', e.message);
    }
    try {
      await context.addCookies(filteredCookies);
    } catch (e: any) {
      console.warn('addCookies failed, trying raw CDP:', e.message);
      try {
        const tmpPage = await context.newPage();
        const cdp = await context.newCDPSession(tmpPage);
        for (const c of filteredCookies) {
          await cdp.send('Network.setCookie', {
            name: c.name,
            value: c.value,
            domain: '.vfsglobal.com',
            path: '/',
            httpOnly: c.httpOnly,
            secure: c.secure,
            sameSite: (c.sameSite === 'Strict' || c.sameSite === 'Lax' || c.sameSite === 'None') ? c.sameSite : undefined,
            expires: c.expires,
          }).catch((err: any) => console.warn('CDP setCookie failed for', c.name, ':', err.message));
        }
        await tmpPage.close();
      } catch (e2: any) {
        console.warn('Raw CDP cookie set also failed:', e2.message);
      }
    }
  }

  const page = await context.newPage();
  // Navigate to schedule-appointment page so SPA can boot, set localStorage tokens, etc.
  // If cookies are valid this lands us on the dashboard rather than /login.
  const scheduleUrl = `https://visa.vfsglobal.com/${sourceCode}/en/${destinationCode}/schedule-appointment`;
  await page.goto(scheduleUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
  // Brief pause for SPA to boot
  await page.waitForTimeout(2000);

  const bundle: CtxBundle = { context, page, destinationCode, cookieFingerprint: fp, createdAt: Date.now() };
  contexts.set(key, bundle);
  return bundle;
}

/**
 * Real VFS slot endpoint. Discovered 2026-05-11 via HAR capture.
 *
 *   POST https://lift-api.vfsglobal.com/appointment/CheckIsSlotAvailable
 *   body: { countryCode, missionCode, vacCode, visaCategoryCode, roleName, loginUser, payCode }
 *   response:
 *     SUCCESS:  { earliestDate: "06/03/2026 00:00:00", earliestSlotLists: [{applicant, date}, ...], error: null }
 *     NO SLOTS: { earliestDate: null, earliestSlotLists: [], error: { code: 1035, description: "No slots available" } }
 *     CF BLOCK: HTML 403 cf-mitigated: challenge (transient on first request)
 */
const SLOT_API = 'https://lift-api.vfsglobal.com/appointment/CheckIsSlotAvailable';

export interface SlotCheckRequest {
  countryCode: string;       // 'uzb'
  missionCode: string;       // 'lva'
  vacCode: string;           // 'TAS' (centre code)
  visaCategoryCode: string;  // 'LSHRSDTJK' etc
  roleName: string;          // 'Individual'
  loginUser: string;         // user's email
  payCode: string;           // ''
}

export interface SlotCheckResponse {
  earliestDate: string | null;
  earliestSlotLists: Array<{ applicant: string; date: string }>;
  error: { code: number; description: string; type: string } | null;
}

/**
 * Check slot availability for a specific visa category at a specific centre.
 * Returns parsed JSON or throws a tagged error.
 */
export async function fetchSlotsViaBrowser(
  sourceCode: string,
  destinationCode: string,
  visaCategoryCode: string,
  cookies: string[],
  userAgent?: string,
  opts: { vacCode?: string; loginUser?: string; roleName?: string; profileId?: string } = {},
): Promise<{ status: number; data: SlotCheckResponse | null; rawText: string }> {
  if (env.CDP_ENDPOINT) {
    const profileId = opts.profileId || opts.loginUser || '*';
    if (opts.loginUser) profileEmailCache.set(profileId, opts.loginUser);

    const page = await findPageForProfile(profileId, sourceCode, destinationCode);
    if (!page) {
      const expectedUrl = `https://visa.vfsglobal.com/${sourceCode}/en/${destinationCode}/login`;
      const email = await getProfileEmail(profileId);
      throw new Error(
        `No VFS tab found for profile=${profileId} destination=${destinationCode} - operator must open ${expectedUrl} in the attached Chrome and log in as ${email ?? 'the matching VFS account'}`,
      );
    }

    const body: SlotCheckRequest = {
      countryCode: sourceCode,
      missionCode: destinationCode,
      vacCode: opts.vacCode || 'TAS',
      visaCategoryCode,
      roleName: opts.roleName || 'Individual',
      loginUser: opts.loginUser || '',
      payCode: '',
    };

    const result = await page.evaluate(async ({ url, body }) => {
      try {
        const r = await fetch(url, {
          method: 'POST',
          credentials: 'include',
          mode: 'cors',
          headers: {
            'Content-Type': 'application/json;charset=UTF-8',
            'Accept': 'application/json, text/plain, */*',
          },
          body: JSON.stringify(body),
        });
        const text = await r.text();
        let parsed: any = null;
        try { parsed = JSON.parse(text); } catch {}
        return { status: r.status, text, parsed };
      } catch (e: any) {
        return { status: -1, text: String(e?.message || e), parsed: null };
      }
    }, { url: SLOT_API, body });

    return { status: result.status, data: result.parsed, rawText: result.text };
  }

  if (!process.env.BRIGHTDATA_WS && process.env.SCRAPER_API) {
    return fetchSlotsViaScraperApi(sourceCode, destinationCode, visaCategoryCode, cookies, opts);
  }

  const bundle = await ensureContext(destinationCode, sourceCode, cookies, userAgent);

  const body: SlotCheckRequest = {
    countryCode: sourceCode,
    missionCode: destinationCode,
    vacCode: opts.vacCode || 'TAS',           // Tashkent centre by default
    visaCategoryCode,                          // Required — caller picks
    roleName: opts.roleName || 'Individual',
    loginUser: opts.loginUser || '',           // VFS account email
    payCode: '',
  };

  const result = await bundle.page.evaluate(async ({ url, body }) => {
    try {
      const r = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        mode: 'cors',
        headers: {
          'Content-Type': 'application/json;charset=UTF-8',
          'Accept': 'application/json, text/plain, */*',
        },
        body: JSON.stringify(body),
      });
      const text = await r.text();
      let parsed: any = null;
      try { parsed = JSON.parse(text); } catch {}
      return { status: r.status, text, parsed };
    } catch (e: any) {
      return { status: -1, text: String(e?.message || e), parsed: null };
    }
  }, { url: SLOT_API, body });

  return { status: result.status, data: result.parsed, rawText: result.text };
}

async function fetchSlotsViaScraperApi(
  sourceCode: string,
  destinationCode: string,
  visaCategoryCode: string,
  cookies: string[],
  opts: { vacCode?: string; loginUser?: string; roleName?: string } = {},
): Promise<{ status: number; data: SlotCheckResponse | null; rawText: string }> {
  const body: SlotCheckRequest = {
    countryCode: sourceCode,
    missionCode: destinationCode,
    vacCode: opts.vacCode || 'TAS',
    visaCategoryCode,
    roleName: opts.roleName || 'Individual',
    loginUser: opts.loginUser || '',
    payCode: '',
  };

  const response = await fetchViaScraperApi({
    url: SLOT_API,
    method: 'POST',
    cookies: cookies.map((cookie) => cookie.split(';')[0].trim()).filter(Boolean).join('; '),
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      Accept: 'application/json, text/plain, */*',
      Origin: 'https://visa.vfsglobal.com',
      Referer: `https://visa.vfsglobal.com/${sourceCode}/en/${destinationCode}/schedule-appointment`,
    },
    body: JSON.stringify(body),
  });

  let parsed: SlotCheckResponse | null = null;
  try {
    parsed = JSON.parse(response.body) as SlotCheckResponse;
  } catch {}

  return { status: response.status, data: parsed, rawText: response.body };
}

export function getReusableContextFor(destinationCode: string): BrowserContext | undefined {
  return contexts.get(destinationCode)?.context;
}

/**
 * Force tear-down of a destination's context. Call on monitor stop or
 * when cookies are explicitly invalidated.
 */
export async function disposeContextFor(destinationCode: string): Promise<void> {
  if (env.CDP_ENDPOINT) {
    for (const key of Array.from(cdpPageCache.keys())) {
      if (key.endsWith(`:${destinationCode.toLowerCase()}`)) cdpPageCache.delete(key);
    }
    return;
  }

  const existing = contexts.get(destinationCode);
  if (!existing) return;
  try { await existing.context.close(); } catch {}
  contexts.delete(destinationCode);
}

export async function disposeAllContexts(): Promise<void> {
  for (const k of Array.from(contexts.keys())) {
    await disposeContextFor(k);
  }
}
