import os from 'os';
import axios from 'axios';
import https from 'https';
import { prisma } from '@config/database';
import { env } from '@config/env';
import { logEvent } from '@modules/logs/logger';
import { EventType } from '@prisma/client';
import { decrypt } from '@utils/crypto';
import { warmSessionWithBrowser, VfsCredentials } from './session.warmer';
import { enqueueBooking } from '@modules/booking/booking.service';
import { emitToAll } from '@modules/websocket/ws.server';
import { dispatchNotification } from '@modules/notifications/notification.service';

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

// --- Helper Functions ---

function getSourceCode(name: string): string {
  const map: Record<string, string> = {
    uzbekistan: 'uzb',
    tajikistan: 'tjk',
    latvia: 'lva',
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
  return `https://visa.vfsglobal.com/${source}/${dest}/en/schedule-appointment/get-slots`;
}

async function getProxyConfig(id: string) {
    const cached = proxyCache.get(id);
    if (cached && cached.expiresAt > Date.now()) return cached.config;

    // Use ENV priority for Proxyrack
    if (env.PROXY_HOST && env.PROXY_PORT) {
        const config = {
            host: env.PROXY_HOST,
            port: Number(env.PROXY_PORT),
            auth: env.PROXY_USERNAME ? { username: env.PROXY_USERNAME, password: env.PROXY_PASSWORD } : undefined
        };
        proxyCache.set(id, { config, expiresAt: Date.now() + CACHE_TTL });
        return config;
    }
    return null;
}

/**
 * Ensures we have valid VFS session cookies. If standard Axios warming fails (403),
 * we fall back to a full stealth browser warming cycle.
 */
async function warmSession(id: string, sourceCode: string, destinationCode: string, visaType: string, credentials?: VfsCredentials): Promise<string[] | undefined> {
  const state = getMonitor(id);
  if (state?.cookiesValid && state.cookies && state.cookiesSetAt && (Date.now() - state.cookiesSetAt.getTime() < 1800000)) {
    return state.cookies;
  }

  const agent = {
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
    ch: '"Google Chrome";v="134", "Chromium";v="134", "Not:A-Brand";v="24"'
  };

  try {
    const proxyConfig = await getProxyConfig(id);
    const httpProxy = proxyConfig ? { host: proxyConfig.host, port: proxyConfig.port, auth: proxyConfig.auth } : null;

    const response = await axios.get(`https://visa.vfsglobal.com/${sourceCode}/${destinationCode}/en/login`, {
      timeout: 180000,
      headers: { 'User-Agent': agent.ua, 'sec-ch-ua': agent.ch },
      proxy: httpProxy || undefined,
      ...(httpProxy && { httpsAgent: new https.Agent({ rejectUnauthorized: false }) }),
    });

    const cookies = response.headers['set-cookie'];
    if (cookies) {
      setMonitor(id, { ...getMonitor(id)!, cookies, cookiesSetAt: new Date(), cookiesValid: true, userAgent: agent.ua, secChUa: agent.ch, lastHttpStatus: 200 });
      return cookies;
    }
  } catch (err: any) {
    const status = err.response?.status;
    if (status === 403 && credentials) {
      logEvent('warn', EventType.IP_BLOCKED, `403 Forbidden on standard fetch. Attempting Browser Warming for ${destinationCode}...`);
      const proxyConfig = await getProxyConfig(id);
      const result = await warmSessionWithBrowser(sourceCode, destinationCode, credentials, proxyConfig as any);
      if (result && result.cookies) {
         setMonitor(id, { ...getMonitor(id)!, cookies: result.cookies, cookiesSetAt: new Date(), cookiesValid: true, userAgent: result.userAgent, secChUa: result.secChUa, lastHttpStatus: 200 });
         return result.cookies;
      }
    }
    throw err;
  }
  return undefined;
}

function parseSetCookieToCookieHeader(setCookieHeaders: string[]): string {
  return setCookieHeaders.map((h) => h.split(';')[0].trim()).join('; ');
}

async function getVfsCredentials(profileIds: string[]): Promise<VfsCredentials | undefined> {
  if (!profileIds.length) return undefined;
  try {
    const profile = await prisma.profile.findUnique({ where: { id: profileIds[0] }, select: { email: true, vfsPasswordEnc: true } });
    if (profile?.email && profile?.vfsPasswordEnc) return { email: profile.email, password: decrypt(profile.vfsPasswordEnc) };
  } catch {}
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
  logEvent('info', EventType.MONITOR_STARTED, `Monitor started for ${current.sourceCountry.toUpperCase()} -> ${current.destination.toUpperCase()}`);

  const poll = async () => {
    const config = getMonitor(id);
    if (!config || !config.isRunning) return;

    try {
      const sourceCode = getSourceCode(config.sourceCountry);
      const destCode = getDestinationCode(config.destination);
      const creds = await getVfsCredentials(config.profileIds);
      
      const cookies = await warmSession(id, sourceCode, destCode, config.visaType, creds);
      if (!cookies) throw new Error('Failed to acquire VFS session.');

      const proxyConfig = await getProxyConfig(id);
      const httpProxy = proxyConfig ? { host: proxyConfig.host, port: proxyConfig.port, auth: proxyConfig.auth } : null;

      const response = await axios.post(buildAvailabilityUrl(sourceCode, destCode), 
        { visaCategory: config.visaType, country: sourceCode.toUpperCase() }, 
        {
          timeout: 180000,
          headers: {
            'Cookie': parseSetCookieToCookieHeader(cookies),
            'User-Agent': config.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
            'X-XSRF-TOKEN': cookies.find(c => c.includes('XSRF-TOKEN'))?.split('=')[1]?.split(';')[0] || '',
            'Content-Type': 'application/json',
            'Referer': `https://visa.vfsglobal.com/${sourceCode}/${destCode}/en/schedule-appointment`,
          },
          proxy: httpProxy || undefined,
          ...(httpProxy && { httpsAgent: new https.Agent({ rejectUnauthorized: false }) }),
        }
      );

      const slots = response.data || [];
      const count = Array.isArray(slots) ? slots.length : 0;
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

      const nextPoll = setTimeout(poll, config.intervalMs || 30000);
      monitorTimeouts.set(id, nextPoll);

    } catch (err: any) {
      const isTimeout = err.message.includes('Timeout') || err.message.includes('timeout');
      const status = isTimeout ? 408 : (err.response?.status || (err.message.includes('403') ? 403 : 500));
      
      if (status === 403 || status === 408) {
        const typeStr = status === 403 ? 'IP BLOCKED' : 'VFS SERVER SLOW (TIMEOUT)';
        const cooldownMs = status === 403 ? 600000 : 300000; // 10m for 403, 5m for Timeout
        
        logEvent('warn', EventType.IP_BLOCKED, `${typeStr} for ${config.destination}. COOLDOWN: ${cooldownMs/1000}s`);
        setMonitor(id, { ...config, isRunning: false, isCoolingDown: true, lastCheckedAt: new Date(), lastHttpStatus: status });
        
        setTimeout(() => { if (getMonitor(id)) startMonitor(id); }, cooldownMs);
        return;
      }

      logEvent('error', EventType.BOOKING_FAILED, `Monitor poll error: ${err.message}`);
      const retryPoll = setTimeout(poll, 60000);
      monitorTimeouts.set(id, retryPoll);
    }
  };

  poll();
}

export async function autoStartMonitors(): Promise<void> {
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
        intervalMs: 30000,
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
  const timeout = monitorTimeouts.get(id);
  if (timeout) {
    clearTimeout(timeout);
    monitorTimeouts.delete(id);
  }
}
