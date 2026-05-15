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
import { chromium, BrowserContext, Page } from 'rebrowser-playwright';
import { getBrowserProfileDir, resolveChromeExecutablePath } from '@modules/engine/browser.factory';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';

interface CtxBundle {
  context: BrowserContext;
  page: Page;
  destinationCode: string;
  cookieFingerprint: string; // hash of cookies — re-create context if cookies change
  createdAt: number;
}

const contexts = new Map<string, CtxBundle>();

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
  const context = await chromium.launchPersistentContext(getBrowserProfileDir(destinationCode), {
    headless,
    executablePath: resolveChromeExecutablePath(),
    userAgent: userAgent || UA,
    viewport: { width: 1280, height: 720 },
    locale: 'uz-UZ',
    timezoneId: 'Asia/Tashkent',
    geolocation: { latitude: 41.2995, longitude: 69.2401 },
    permissions: ['geolocation'],
    ignoreHTTPSErrors: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-notifications',
      '--mute-audio',
      '--window-size=1280,720',
    ],
  });

  // Block heavy resources to save bandwidth
  await context.route('**/*', (route) => {
    const type = route.request().resourceType();
    if (type === 'image' || type === 'font' || type === 'media') return route.abort();
    return route.continue();
  });

  const playwrightCookies = parseSetCookieArrayToPlaywright(cookies);
  if (playwrightCookies.length) {
    await context.addCookies(playwrightCookies);
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
  opts: { vacCode?: string; loginUser?: string; roleName?: string } = {},
): Promise<{ status: number; data: SlotCheckResponse | null; rawText: string }> {
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

/**
 * Force tear-down of a destination's context. Call on monitor stop or
 * when cookies are explicitly invalidated.
 */
export async function disposeContextFor(destinationCode: string): Promise<void> {
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
