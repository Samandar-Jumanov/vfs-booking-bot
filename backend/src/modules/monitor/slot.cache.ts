import { SlotInfo } from '@t/index';

interface CacheEntry {
  promise: Promise<SlotInfo[]>;
  expiresAt: number;
}

const slotCache = new Map<string, CacheEntry>();
const COALESCE_TTL_MS = 120_000;

export function getCachedSlots(key: string): Promise<SlotInfo[]> | undefined {
  const entry = slotCache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    slotCache.delete(key);
    return undefined;
  }
  return entry.promise;
}

export function setCachedSlots(key: string, promise: Promise<SlotInfo[]>): void {
  slotCache.set(key, { promise, expiresAt: Date.now() + COALESCE_TTL_MS });
}
