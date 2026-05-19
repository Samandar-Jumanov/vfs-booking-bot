import os from 'os';
import axios from 'axios';
import https from 'https';
import { randomBytes } from 'crypto';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { prisma } from '@config/database';
import { env } from '@config/env';
import { logEvent } from '@modules/logs/logger';
import { EventType } from '@prisma/client';
import { decrypt, encrypt } from '@utils/crypto';
import { warmSessionWithBrowser, keepSessionAlive, VfsCredentials } from './session.warmer';
import { fetchSlotsViaBrowser, disposeContextFor, findPageForProfile } from './playwright.fetch';
import { autoReLogin } from './auto.login';
import { autoRegister } from './auto.register';
import { startKeepAliveWatcher } from './session.keepalive';
import { enqueueBooking } from '@modules/booking/booking.service';
import { emitToAll } from '@modules/websocket/ws.server';
import { dispatchNotification } from '@modules/notifications/notification.service';
import { sendTelegram } from '@modules/notifications/telegram.bot';
import { getProxy } from '@modules/proxy/proxy.service';
import { setSetting } from '@modules/settings/settings.service';
import { getRedis } from '@config/redis';

// --- Types & Constants ---

export interface SlotInfo {
  date: string;
  count: number;
}

export interface MonitorConfig {
  id: string;
  sourceCountry: string;
  destination: string;
  visaType: string;
  intervalMs: number;
  profileIds: string[];
  mode?: 'auto' | 'manual';
}

export interface MonitorState extends MonitorConfig {
  isRunning: boolean;
  lastCheckedAt?: Date;
  slotDetectedCount: number;
  logs: string[];
  cookies?: string[];
  cookiesSetAt?: Date;
  cookiesValid?: boolean;
  userAgent?: string;
  secChUa?: string;
  lastHttpStatus?: number;
  isCoolingDown?: boolean;
  lastEnqueuedAt?: number;
  lastSlotSignature?: string;
}

const monitors = new Map<string, MonitorState>();
const monitorTimeouts = new Map<string, NodeJS.Timeout>();

// Internal Proxy Cache to prevent DB bottlenecks
const proxyCache = new Map<string, { config: any, expiresAt: number }>();
const CACHE_TTL = 300000; // 5 minutes

// Manual cookie injection store — keyed by destCode (e.g. 'prt', 'tjk', 'lva')
// TTL: 8 hours (session keep-alive extends VFS sessions this long)
const MANUAL_COOKIE_TTL = 28800000;

// Keep-alive cancel functions — one per destCode
const keepAliveHandles = new Map<string, () => void>();
interface InjectedCookies { cookies: string[]; setAt: Date; userAgent?: string }
const injectedCookiesStore = new Map<string, InjectedCookies>();

function getCookieStoreKey(profileId: string, destCode: string): string {
  return profileId === '*' ? destCode : `${profileId}:${destCode}`;
}

function getPersistedCookieKey(profileId: string, destCode: string): string {
  return profileId === '*' ? `cookies.${destCode}` : `cookies.${profileId}.${destCode}`;
}

function parsePersistedCookieKey(key: string): { profileId: string; destCode: string } | undefined {
  const parts = key.split('.');
  if (parts[0] !== 'cookies') return undefined;
  if (parts.length === 2) return { profileId: '*', destCode: parts[1] };
  if (parts.length === 3) return { profileId: parts[1], destCode: parts[2] };
  return undefined;
}

function parseCookieStoreKey(key: string): { profileId: string; destCode: string } {
  const separatorIndex = key.indexOf(':');
  if (separatorIndex < 0) return { profileId: '*', destCode: key };
  return {
    profileId: key.slice(0, separatorIndex),
    destCode: key.slice(separatorIndex + 1),
  };
}

function parseCookieString(cookieStr: string): string[] {
  const trimmed = cookieStr.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as Array<{ name: string; value: string }>;
      return parsed.filter(c => c.name && c.value !== undefined).map(c => `${c.name}=${c.value}`);
    } catch {
      return trimmed.split(';').map(c => c.trim()).filter(Boolean);
    }
  }
  return trimmed.split(';').map(c => c.trim()).filter(Boolean);
}

function extractLtSnExpiresAt(rawCookieStr: string, fallback?: string): string | undefined {
  if (fallback) return fallback;
  const trimmed = rawCookieStr.trim();
  if (!trimmed.startsWith('[')) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as Array<{ name?: string; expirationDate?: number; expires?: number }>;
    const ltSn = parsed.find((c) => c.name === 'lt_sn');
    const expires = ltSn?.expirationDate ?? ltSn?.expires;
    return expires && expires > 0 ? new Date(expires * 1000).toISOString() : undefined;
  } catch {
    return undefined;
  }
}

async function savePersistedCookies(profileId: string, destCode: string, rawCookieStr: string, userAgent?: string, ltSnExpiresAt?: string): Promise<void> {
  const storeKey = getCookieStoreKey(profileId, destCode);
  const persistedKey = getPersistedCookieKey(profileId, destCode);
  try {
    await setSetting(persistedKey, JSON.stringify({
      raw: rawCookieStr,
      userAgent,
      savedAt: new Date().toISOString(),
      ltSnExpiresAt: extractLtSnExpiresAt(rawCookieStr, ltSnExpiresAt),
    }));
    await getRedis().del(`cookie-alerted:${storeKey}`);
  } catch (e: any) {
    logEvent('warn', EventType.MONITOR_STARTED, `[Cookies] Failed to persist cookies for ${profileId}/${destCode}: ${e.message}`);
  }
}

export async function loadPersistedCookies(): Promise<void> {
  const rows = await prisma.settings.findMany({
    where: { key: { startsWith: 'cookies.' } },
  });
  for (const row of rows) {
    const parsedKey = parsePersistedCookieKey(row.key);
    if (!parsedKey) continue;
    const { profileId, destCode } = parsedKey;
    const storeKey = getCookieStoreKey(profileId, destCode);
    try {
      const { raw, userAgent, savedAt } = JSON.parse(row.value as string);
      const savedMs = new Date(savedAt).getTime();
      if ((Date.now() - savedMs) >= MANUAL_COOKIE_TTL) {
        logEvent('info', EventType.MONITOR_STARTED, `[Cookies] Persisted cookies for ${destCode} expired — skipping`);
        continue;
      }
      // Re-use the same parsing logic as injectManualCookies
      const cookies = parseCookieString(raw as string);
      injectedCookiesStore.set(storeKey, { cookies, setAt: new Date(savedAt), userAgent });
      logEvent('info', EventType.MONITOR_STARTED,
        `[Cookies] Restored ${cookies.length} persisted cookies for ${profileId}/${destCode} (saved ${savedAt})`);
    } catch (e: any) {
      logEvent('warn', EventType.MONITOR_STARTED, `[Cookies] Failed to load persisted cookies for ${profileId}/${destCode}: ${e.message}`);
    }
  }
}

export function injectManualCookies(profileId: string, destination: string, cookieStr: string, userAgent?: string): void {
  const destCode = getDestinationCode(destination);
  const storeKey = getCookieStoreKey(profileId, destCode);

  if (env.CDP_ENDPOINT) {
    logEvent('warn', EventType.MONITOR_STARTED,
      '[Warmer] CDP mode active - manual cookie injection is a no-op; operator must log in via Chrome instead');
    return;
  }

  // Accept either JSON array from EditThisCookie/Cookie-Editor or raw "name=value; ..." header string
  const cookies = parseCookieString(cookieStr);
  injectedCookiesStore.set(storeKey, { cookies, setAt: new Date(), userAgent });
  savePersistedCookies(profileId, destCode, cookieStr, userAgent).catch(() => {});
  getRedis().del(`cookie-alerted:${storeKey}`).catch(() => {});
  logEvent('info', EventType.MONITOR_STARTED,
    `[Warmer] Manual cookies injected for ${profileId}/${destCode} (${cookies.length} cookies, valid 8h)`);
  // Propagate to any running monitor for this destination so it picks them up immediately
  for (const [id, state] of monitors.entries()) {
    const stateDest = getDestinationCode(state.destination);
    const stateProfileId = state.profileIds[0] ?? '*';
    if (stateDest === destCode && (profileId === '*' || stateProfileId === profileId)) {
      setMonitor(id, {
        ...state,
        cookies,
        cookiesSetAt: new Date(),
        cookiesValid: true,
        userAgent: userAgent || state.userAgent,
      });
    }
  }
  // Start keep-alive for manually injected cookies too
  const prev = keepAliveHandles.get(storeKey);
  if (prev) prev();
  keepAliveHandles.set(storeKey, keepSessionAlive(
    'uzb', destCode,
    () => injectedCookiesStore.get(storeKey)?.cookies,
    undefined,
  ));
}

export function getInjectedCookiesStatus(): Array<{ profileId: string; destination: string; setAt: Date; expiresAt: Date; cookieCount: number; valid: boolean }> {
  return Array.from(injectedCookiesStore.entries()).map(([key, v]) => {
    const { profileId, destCode } = parseCookieStoreKey(key);
    return {
      profileId,
      destination: destCode,
      setAt: v.setAt,
      expiresAt: new Date(v.setAt.getTime() + MANUAL_COOKIE_TTL),
      cookieCount: v.cookies.length,
      valid: (Date.now() - v.setAt.getTime()) < MANUAL_COOKIE_TTL,
    };
  });
}

// --- Helper Functions ---

function getSourceCode(name: string): string {
  const map: Record<string, string> = {
    uzbekistan: 'uzb',
    tajikistan: 'tjk',
    latvia: 'lva',
    turkmenistan: 'tkm',
  };
  return map[name.toLowerCase()] || 'uzb';
}

function getDestinationCode(name: string): string {
  const map: Record<string, string> = {
    portugal: 'prt',
    brazil: 'bra',
    tajikistan: 'tjk',
    latvia: 'lva',
    // pass-through 3-letter codes
    prt: 'prt', bra: 'bra', tjk: 'tjk', lva: 'lva',
  };
  return map[name.toLowerCase()] ?? name.toLowerCase().slice(0, 3);
}

const ENQUEUE_THROTTLE_MS = 5 * 60 * 1000;

function buildSlotSignature(slots: any[]): string {
  if (!Array.isArray(slots) || slots.length === 0) return '';
  const first = slots[0] ?? {};
  const date = first.date || first.slotDate || first.AppointmentDate || JSON.stringify(first).slice(0, 64);
  return `${slots.length}:${date}`;
}

function pickFirstSlot(slots: any[]): { date?: string; time?: string } {
  if (!Array.isArray(slots) || slots.length === 0) return {};
  const s = slots[0];
  return {
    date: s.date || s.slotDate || s.AppointmentDate || undefined,
    time: s.time || s.slotTime || s.AppointmentTime || undefined,
  };
}

function buildAvailabilityUrl(source: string, dest: string): string {
  return `https://visa.vfsglobal.com/${source}/en/${dest}/schedule-appointment/get-slots`;
}

function getScrapingProviderMode(): 'local' | 'brightdata' | 'scraperapi' {
  if (env.CDP_ENDPOINT) return 'local';
  if (process.env.BRIGHTDATA_WS) return 'brightdata';
  if (process.env.SCRAPER_API) return 'scraperapi';
  return 'local';
}

async function getProxyConfig(id: string) {
    const cached = proxyCache.get(id);
    if (cached && cached.expiresAt > Date.now()) return cached.config;

    // Prefer DB proxy pool (Global Settings / added via API) over env vars
    try {
        const dbProxy = await getProxy();
        if (dbProxy) {
            const auth = `${dbProxy.username}:${dbProxy.password}@`;
            const config = {
                host: dbProxy.server.split(':')[0],
                port: Number(dbProxy.server.split(':')[1]),
                auth: { username: dbProxy.username, password: dbProxy.password },
                url: `http://${auth}${dbProxy.server}`,
            };
            proxyCache.set(id, { config, expiresAt: Date.now() + CACHE_TTL });
            return config;
        }
    } catch {}

    // Fall back to env vars
    if (env.PROXY_HOST && env.PROXY_PORT) {
        const auth = env.PROXY_USERNAME ? `${env.PROXY_USERNAME}:${env.PROXY_PASSWORD}@` : '';
        const config = {
            host: env.PROXY_HOST,
            port: Number(env.PROXY_PORT),
            auth: env.PROXY_USERNAME ? { username: env.PROXY_USERNAME, password: env.PROXY_PASSWORD } : undefined,
            url: `http://${auth}${env.PROXY_HOST}:${env.PROXY_PORT}`,
        };
        proxyCache.set(id, { config, expiresAt: Date.now() + CACHE_TTL });
        return config;
    }
    return null;
}

function splitFullName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  return {
    firstName: parts[0] || 'TEST_FIRSTNAME',
    lastName: parts.slice(1).join(' ') || 'TEST_LASTNAME',
  };
}

async function prepareCdpSession(profileId: string, sourceCode: string, destinationCode: string, credentials?: VfsCredentials): Promise<void> {
  if (!env.CDP_ENDPOINT) return;

  const page = await findPageForProfile(profileId, sourceCode, destinationCode);
  if (!page) {
    logEvent('warn', EventType.MONITOR_STARTED, `[Warmer] CDP tab not found for ${profileId}/${destinationCode}`);
    return;
  }

  startKeepAliveWatcher(page, profileId);
  const currentUrl = page.url().toLowerCase();
  const profile = profileId === '*' ? null : await prisma.profile.findUnique({
    where: { id: profileId },
    select: { id: true, fullName: true, email: true, phone: true, dobEnc: true, passportNumberEnc: true, vfsPasswordEnc: true },
  });

  if (!profile) return;

  const hasPassword = !!profile.vfsPasswordEnc;
  const loginUrl = `https://visa.vfsglobal.com/${sourceCode}/en/${destinationCode}/login`;

  if (hasPassword && credentials) {
    if (!currentUrl.includes('/login') && !currentUrl.includes('/dashboard')) {
      await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
      await page.waitForTimeout(2000);
    }

    const ok = await autoReLogin(page, credentials, loginUrl);
    if (ok) {
      emitToAll('SESSION_REFRESHED', { profileId, destination: destinationCode, timestamp: Date.now() });
      await sendTelegram(`SESSION_REFRESHED - ${profileId}/${destinationCode}`).catch(() => {});
    } else {
      logEvent('warn', EventType.SESSION_EXPIRED, `[AutoLogin] Failed for ${profileId}`);
    }
    return;
  }

  if (hasPassword && !credentials) {
    logEvent('warn', EventType.SESSION_EXPIRED, `[AutoLogin] No VFS credentials available for ${profileId}`);
    return;
  }

  const generatedPassword = `VfsDemo-${randomBytes(9).toString('base64url')}1!`;
  if (!hasPassword) {
    await prisma.profile.update({
      where: { id: profile.id },
      data: { vfsPasswordEnc: encrypt(generatedPassword) },
    });
  }

  const names = splitFullName(profile.fullName);
  const result = await autoRegister(page, {
    email: profile.email,
    phone: profile.phone,
    password: generatedPassword,
    firstName: names.firstName || 'TEST_FIRSTNAME',
    lastName: names.lastName || 'TEST_LASTNAME',
    dob: '1990-01-15',
    passportNumber: 'AA0000000',
  });

  if (result.ok) {
    logEvent('info', EventType.MONITOR_STARTED, `[AutoRegister] VFS account ready for ${result.vfsAccountEmail ?? profile.email}`);
  } else {
    logEvent('warn', EventType.CAPTCHA_REQUIRED, `[AutoRegister] Failed for ${profile.email} - VFS web register may be blocked by Datadome`);
  }
}

function makeHttpsAgent(proxyConfig: any): https.Agent {
    if (proxyConfig?.url) return new HttpsProxyAgent(proxyConfig.url) as any;
    return new https.Agent({ rejectUnauthorized: false });
}

/**
 * Ensures we have valid VFS session cookies. If standard Axios warming fails (403),
 * we fall back to a full stealth browser warming cycle.
 */
async function warmSession(id: string, sourceCode: string, destinationCode: string, visaType: string, credentials?: VfsCredentials): Promise<string[] | undefined> {
  if (env.CDP_ENDPOINT) {
    logEvent('info', EventType.MONITOR_STARTED, `[Warmer] CDP mode active - using operator Chrome session for ${destinationCode}`);
    const state = getMonitor(id);
    const profileId = state?.profileIds[0] ?? '*';
    await prepareCdpSession(profileId, sourceCode, destinationCode, credentials);
    return [];
  }

  const state = getMonitor(id);
  if (state?.cookiesValid && state.cookies && state.cookiesSetAt && (Date.now() - state.cookiesSetAt.getTime() < 28800000)) {
    return state.cookies;
  }
  const sessionProfileId = state?.profileIds[0] ?? '*';
  const storeKey = getCookieStoreKey(sessionProfileId, destinationCode);

  // Check manual injection store — user's real-browser cookies bypass headless detection entirely
  const injected = injectedCookiesStore.get(storeKey);
  if (injected && (Date.now() - injected.setAt.getTime()) < MANUAL_COOKIE_TTL) {
    logEvent('info', EventType.MONITOR_STARTED, `[Warmer] Using manually injected cookies for ${sessionProfileId}/${destinationCode}`);
    setMonitor(id, {
      ...getMonitor(id)!,
      cookies: injected.cookies,
      cookiesSetAt: injected.setAt,
      cookiesValid: true,
      userAgent: injected.userAgent || state?.userAgent,
    });
    return injected.cookies;
  }

  // If credentials are available, always use browser warming — plain HTTP GET only gets
  // Cloudflare tracking cookies, not an authenticated VFS session (slot API returns 402).
  if (credentials) {
    logEvent('info', EventType.MONITOR_STARTED, `[Warmer] Browser login warm for ${destinationCode}...`);
    const proxyConfig = await getProxyConfig(id);
    const result = await warmSessionWithBrowser(sourceCode, destinationCode, credentials, proxyConfig as any);
    if (result?.cookies) {
      setMonitor(id, { ...getMonitor(id)!, cookies: result.cookies, cookiesSetAt: new Date(), cookiesValid: true, userAgent: result.userAgent, secChUa: result.secChUa, lastHttpStatus: 200 });
      await savePersistedCookies(sessionProfileId, destinationCode, result.cookies.join('; '), result.userAgent, result.ltSnExpiresAt);
      // Start keep-alive so one login lasts ~8 hours
      const prev = keepAliveHandles.get(storeKey);
      if (prev) prev();
      keepAliveHandles.set(storeKey, keepSessionAlive(
        sourceCode, destinationCode,
        () => getMonitor(id)?.cookies,
        proxyConfig?.url ? { url: proxyConfig.url } : undefined,
      ));
      return result.cookies;
    }
    throw new Error('Browser session warming returned no cookies');
  }

  // No credentials — fall back to plain HTTP warm (public endpoints only)
  const agent = {
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
    ch: '"Google Chrome";v="134", "Chromium";v="134", "Not:A-Brand";v="24"'
  };

  try {
    const proxyConfig = await getProxyConfig(id);
    const response = await axios.get(`https://visa.vfsglobal.com/${sourceCode}/en/${destinationCode}/login`, {
      timeout: 180000,
      headers: { 'User-Agent': agent.ua, 'sec-ch-ua': agent.ch },
      httpsAgent: makeHttpsAgent(proxyConfig),
      proxy: false,
    });

    const cookies = response.headers['set-cookie'];
    if (cookies) {
      setMonitor(id, { ...getMonitor(id)!, cookies, cookiesSetAt: new Date(), cookiesValid: true, userAgent: agent.ua, secChUa: agent.ch, lastHttpStatus: 200 });
      return cookies;
    }
  } catch (err: any) {
    throw err;
  }
  return undefined;
}

function parseSetCookieToCookieHeader(setCookieHeaders: string[]): string {
  return setCookieHeaders.map((h) => h.split(';')[0].trim()).join('; ');
}

async function getVfsCredentials(profileIds: string[]): Promise<VfsCredentials | undefined> {
  // Try per-profile VFS credentials first
  if (profileIds.length) {
    try {
      const profile = await prisma.profile.findUnique({ where: { id: profileIds[0] }, select: { email: true, vfsPasswordEnc: true } });
      if (profile?.email && profile?.vfsPasswordEnc) {
        return { email: profile.email, password: decrypt(profile.vfsPasswordEnc) };
      }
    } catch {}
  }

  // Fall back to global VFS account from .env (agent booking on behalf of clients)
  if (env.VFS_EMAIL && env.VFS_PASSWORD) {
    return { email: env.VFS_EMAIL, password: env.VFS_PASSWORD };
  }

  return undefined;
}

// --- Main Service Logic ---

export function getMonitor(id: string): MonitorState | undefined {
  return monitors.get(id);
}

export function setMonitor(id: string, state: MonitorState): void {
  monitors.set(id, state);
}

export function getMonitorStatus() {
  return Array.from(monitors.values()).map(m => ({
    id: m.id,
    sourceCountry: m.sourceCountry,
    destination: m.destination,
    visaType: m.visaType,
    isRunning: m.isRunning,
    isCoolingDown: m.isCoolingDown || false,
    slotDetectedCount: m.slotDetectedCount,
    lastCheckedAt: m.lastCheckedAt
  }));
}

export async function createOrStartMonitor(config: MonitorConfig): Promise<string> {
  const id = config.id || `mon-${Date.now()}`;
  if (!getMonitor(id)) {
    setMonitor(id, {
      ...config,
      id,
      isRunning: false,
      slotDetectedCount: 0,
      logs: [],
    });
  }
  await startMonitor(id);
  return id;
}

export async function startMonitor(id: string): Promise<void> {
  const current = getMonitor(id);
  if (!current || current.isRunning) return;

  setMonitor(id, { ...current, isRunning: true, isCoolingDown: false });
  await getRedis().sadd('monitors:running', id);
  await getRedis().set(`monitor:${id}:heartbeat`, Date.now().toString(), 'EX', 90);
  logEvent('info', EventType.MONITOR_STARTED, `Monitor started for ${current.sourceCountry.toUpperCase()} -> ${current.destination.toUpperCase()}`);
  logEvent('info', EventType.MONITOR_STARTED, `[Monitor] Provider: ${getScrapingProviderMode()}`);

  // In the operator-extension architecture (EXTENSION_BOOKING=true on prod),
  // the BACKEND does NOT poll VFS itself — Playwright on Railway would (a)
  // crash because no Chromium binary in the image, and (b) get Datadome-blocked
  // from datacenter IPs anyway. Instead we delegate polling to the operator's
  // Chrome extension: send START_MONITOR over WS, extension's pollActiveMonitor
  // alarm runs every 30s inside the operator's trusted VFS tab, and reports
  // back via EXT_POLL_RESULT / EXT_SLOT_DETECTED events.
  if (process.env.EXTENSION_BOOKING === 'true') {
    const operatorUserId = process.env.OPERATOR_USER_ID;
    if (operatorUserId) {
      const { sendToExtension } = await import('@modules/websocket/ws.server');
      // Translate dashboard-friendly names ("uzbekistan", "latvia") into the
      // 3-letter codes the VFS lift-api expects ("uzb", "lva"). The content
      // script POSTs these directly to /Slot/Get.
      const sourceCode = getSourceCode(current.sourceCountry);
      const destCode = getDestinationCode(current.destination);
      const dispatched = sendToExtension(operatorUserId, {
        type: 'START_MONITOR',
        monitor: {
          sourceCountry: sourceCode,
          destination: destCode,
          visaCategoryCode: current.visaType,
          vacCode: process.env.VFS_DEFAULT_VAC_CODE || 'TASUZB',
          loginUser: process.env.VFS_EMAIL || '',
          roleName: 'Individual',
        },
      });
      logEvent('info', EventType.MONITOR_STARTED,
        dispatched
          ? `[Monitor] Polling delegated to operator extension (UZ residential IP, trusted VFS tab)`
          : `[Monitor] EXTENSION_BOOKING=true but operator extension is offline — slots will not be detected until extension reconnects`);
    } else {
      logEvent('warn', EventType.MONITOR_STARTED, `[Monitor] EXTENSION_BOOKING=true but OPERATOR_USER_ID not set in env`);
    }
    // Stay "running" so the dashboard reflects it; extension drives the poll.
    return;
  }

  const poll = async () => {
    const config = getMonitor(id);
    if (!config || !config.isRunning) return;

    try {
      await getRedis().set(`monitor:${id}:heartbeat`, Date.now().toString(), 'EX', 90);
      const sourceCode = getSourceCode(config.sourceCountry);
      const destCode = getDestinationCode(config.destination);
      const creds = await getVfsCredentials(config.profileIds);
      
      const cookies = await warmSession(id, sourceCode, destCode, config.visaType, creds);
      if (!cookies) throw new Error('Failed to acquire VFS session.');

      // Fetch slots through a real Chromium context (bypasses Cloudflare WAF
      // that rejects raw axios). The context is reused across polls and only
      // re-created when cookies change or after 30 min.
      let browserResult = await fetchSlotsViaBrowser(
        sourceCode,
        destCode,
        config.visaType,
        cookies,
        config.userAgent,
        {
          profileId: config.profileIds[0] ?? '*',
          loginUser: creds?.email,
        },
      );

      if (env.CDP_ENDPOINT && browserResult.status === 401 && creds) {
        const profileId = config.profileIds[0] ?? '*';
        const page = await findPageForProfile(profileId, sourceCode, destCode);
        const loginUrl = `https://visa.vfsglobal.com/${sourceCode}/en/${destCode}/login`;
        const refreshed = page ? await autoReLogin(page, creds, loginUrl) : false;
        if (refreshed) {
          emitToAll('SESSION_REFRESHED', { profileId, destination: destCode, timestamp: Date.now() });
          await sendTelegram(`SESSION_REFRESHED - ${profileId}/${destCode}`).catch(() => {});
          browserResult = await fetchSlotsViaBrowser(
            sourceCode,
            destCode,
            config.visaType,
            cookies,
            config.userAgent,
            {
              profileId,
              loginUser: creds.email,
            },
          );
        } else {
          emitToAll('CAPTCHA_MANUAL_NEEDED', {
            monitorId: id,
            destination: config.destination,
            reason: 'Auto re-login failed after HTTP 401',
            timestamp: Date.now(),
          });
          await sendTelegram(`CAPTCHA_MANUAL_NEEDED - auto re-login failed for ${profileId}/${destCode}`).catch(() => {});
        }
      }

      if (browserResult.status >= 400) {
        const err: any = new Error(`Slot fetch HTTP ${browserResult.status}: ${browserResult.rawText.slice(0, 200)}`);
        err.response = { status: browserResult.status };
        throw err;
      }

      const slots = Array.isArray(browserResult.data) ? browserResult.data : [];
      const count = slots.length;
      const signature = buildSlotSignature(slots);
      const previousSignature = config.lastSlotSignature || '';

      setMonitor(id, {
        ...config,
        slotDetectedCount: count,
        lastCheckedAt: new Date(),
        lastHttpStatus: 200,
        lastSlotSignature: signature,
      });

      if (count > 0 && signature !== previousSignature) {
        const firstSlot = pickFirstSlot(slots);
        logEvent('info', EventType.SLOT_DETECTED,
          `Found ${count} slots for ${destCode} (first: ${firstSlot.date ?? 'unknown'} ${firstSlot.time ?? ''})`);

        emitToAll('SLOT_DETECTED', {
          monitorId: id,
          sourceCountry: config.sourceCountry,
          destination: config.destination,
          visaType: config.visaType,
          count,
          firstSlot,
        });

        // Fire notification (best-effort, don't block polling)
        dispatchNotification({
          event: 'SLOT_DETECTED',
          monitorId: id,
          profileId: config.profileIds[0],
          sourceCountry: config.sourceCountry,
          destination: config.destination,
          visaType: config.visaType,
          slotDate: firstSlot.date,
        }).catch(() => {});

        // Auto-mode: enqueue a booking job for each profile (throttled)
        const now = Date.now();
        const lastEnqueued = config.lastEnqueuedAt || 0;
        const mode = config.mode || 'auto';
        if (mode === 'auto' && config.profileIds.length > 0 && (now - lastEnqueued) > ENQUEUE_THROTTLE_MS) {
          setMonitor(id, { ...getMonitor(id)!, lastEnqueuedAt: now });
          for (const profileId of config.profileIds) {
            try {
              const jobId = await enqueueBooking({
                profileId,
                sourceCountry: config.sourceCountry,
                destination: config.destination,
                visaType: config.visaType,
                slot: {
                  date: firstSlot.date ?? '',
                  time: firstSlot.time ?? '',
                  destination: config.destination,
                  visaType: config.visaType,
                },
              });
              logEvent('info', EventType.BOOKING_ATTEMPT,
                `Auto-enqueued booking for profile ${profileId} (job ${jobId})`);
            } catch (enqueueErr: any) {
              logEvent('error', EventType.BOOKING_FAILED,
                `Failed to enqueue booking for ${profileId}: ${enqueueErr.message}`);
            }
          }
        }
      }

      const nextPoll = setTimeout(poll, config.intervalMs || env.MONITOR_DEFAULT_INTERVAL_MS);
      monitorTimeouts.set(id, nextPoll);

    } catch (err: any) {
      if (err.message.includes('CAPTCHA_MANUAL_NEEDED')) {
        logEvent('warn', EventType.IP_BLOCKED, `[Monitor] Pausing ${config.destination} for manual captcha intervention`);
        emitToAll('CAPTCHA_MANUAL_NEEDED', {
          monitorId: id,
          destination: config.destination,
          reason: err.message,
          timestamp: Date.now(),
        });
        setMonitor(id, { ...config, isRunning: false, lastCheckedAt: new Date(), lastHttpStatus: 409 });
        await getRedis().del(`monitor:${id}:heartbeat`);
        return;
      }

      const isBotDetected = err.message.includes('VFS_BOT_DETECTED');
      const isTimeout = !isBotDetected && (err.message.includes('Timeout') || err.message.includes('timeout'));
      const status = isBotDetected ? 403 : (isTimeout ? 408 : (err.response?.status || (err.message.includes('403') ? 403 : 500)));

      // 402 = VFS rejected our session (not authenticated). Invalidate cookies and retry quickly.
      if (status === 402) {
        logEvent('warn', EventType.IP_BLOCKED, `[Monitor] 402 Auth Required for ${config.destination} — session invalidated, re-warming in 30s`);
        setMonitor(id, { ...config, cookiesValid: false, cookies: undefined, lastCheckedAt: new Date(), lastHttpStatus: 402 });
        const retryPoll = setTimeout(poll, 30000);
        monitorTimeouts.set(id, retryPoll);
        return;
      }

      if (status === 403 || status === 408) {
        const typeStr = status === 403 ? 'IP BLOCKED' : 'VFS SERVER SLOW (TIMEOUT)';
        const cooldownMs = status === 403 ? 600000 : 300000; // 10m for 403, 5m for Timeout

        logEvent('warn', EventType.IP_BLOCKED, `${typeStr} for ${config.destination}. COOLDOWN: ${cooldownMs/1000}s`);
        setMonitor(id, { ...config, isRunning: false, isCoolingDown: true, lastCheckedAt: new Date(), lastHttpStatus: status });

        setTimeout(() => { if (getMonitor(id)) startMonitor(id); }, cooldownMs);
        return;
      }

      logEvent('error', EventType.BOOKING_FAILED, `Monitor poll error: ${err.message}`);
      setMonitor(id, { ...config, isRunning: false, lastCheckedAt: new Date(), lastHttpStatus: status });
      await getRedis().del(`monitor:${id}:heartbeat`);
    }
  };

  poll();
}

export async function autoStartMonitors(): Promise<void> {
  await loadPersistedCookies();
  try {
    const activeBookings = await prisma.booking.findMany({
      where: { status: { in: ['QUEUED', 'RUNNING'] } },
      include: { profile: true }
    });

    const uniqueMonitors = new Set<string>();

    for (const booking of activeBookings) {
      const key = `${booking.profileId}-${booking.destination}`;
      if (uniqueMonitors.has(key)) continue;
      uniqueMonitors.add(key);

      logEvent('info', EventType.MONITOR_STARTED, `Auto-starting monitor for ${booking.destination} (Profile: ${booking.profile.fullName}, Visa: ${booking.visaType})`);
      await createOrStartMonitor({
        id: booking.id, // Using the unique Booking ID instead of Profile ID
        sourceCountry: booking.profile.nationality || 'uzbekistan',
        destination: booking.destination.toLowerCase(),
        visaType: booking.visaType,
        intervalMs: env.MONITOR_DEFAULT_INTERVAL_MS,
        profileIds: [booking.profileId],
        mode: 'auto',
      });
    }
  } catch (err: any) {
    logEvent('error', EventType.BOOKING_FAILED, `Auto-start failed: ${err.message}`);
  }
}

export function stopMonitor(id: string): void {
  const current = getMonitor(id);
  if (current) setMonitor(id, { ...current, isRunning: false });
  getRedis().srem('monitors:running', id).catch(() => {});
  getRedis().del(`monitor:${id}:heartbeat`).catch(() => {});
  const timeout = monitorTimeouts.get(id);
  if (timeout) {
    clearTimeout(timeout);
    monitorTimeouts.delete(id);
  }
}

export async function restartMonitor(id: string): Promise<void> {
  const current = getMonitor(id);
  if (!current) return;
  stopMonitor(id);
  setMonitor(id, { ...current, isRunning: false, isCoolingDown: false });
  await startMonitor(id);
}
