import { prisma } from '@config/database';

// In-memory cache with TTL
const cache = new Map<string, { value: unknown; expiresAt: number }>();
const CACHE_TTL_MS = 60_000;

export async function getSetting<T = unknown>(key: string): Promise<T | null> {
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value as T;
  }

  const row = await prisma.settings.findUnique({ where: { key } });
  if (!row) return null;

  cache.set(key, { value: row.value, expiresAt: Date.now() + CACHE_TTL_MS });
  return row.value as T;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await prisma.settings.upsert({
    where: { key },
    update: { value: value as never },
    create: { key, value: value as never },
  });
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

export async function getAllSettings(): Promise<Record<string, unknown>> {
  const rows = await prisma.settings.findMany();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export function invalidateCache(key?: string) {
  if (key) cache.delete(key);
  else cache.clear();
}

export async function getGlobalSettings() {
  const settings = await prisma.globalSettings.findUnique({ where: { id: 'singleton' } });
  return settings || {
    proxyHost: '',
    proxyPort: 8080,
    proxyUsername: '',
    proxyPassword: '',
  };
}

interface GlobalSettingsUpdateData {
  proxyHost?: string;
  proxyPort?: number;
  proxyUsername?: string;
  proxyPassword?: string;
}

export async function updateGlobalSettings(data: GlobalSettingsUpdateData) {
  return await prisma.globalSettings.upsert({
    where: { id: 'singleton' },
    update: {
      proxyHost: data.proxyHost,
      proxyPort: data.proxyPort,
      proxyUsername: data.proxyUsername,
      proxyPassword: data.proxyPassword,
    },
    create: {
      id: 'singleton',
      proxyHost: data.proxyHost,
      proxyPort: data.proxyPort ? Number(data.proxyPort) : 8080,
      proxyUsername: data.proxyUsername,
      proxyPassword: data.proxyPassword,
    },
  });
}
