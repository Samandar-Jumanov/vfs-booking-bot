/**
 * Pre-solved Turnstile token pool.
 *
 * 2Captcha takes 4–15s on average to solve a Turnstile. If we ask for one only
 * after a slot drops, that's 4–15s of latency we hand to faster competitors.
 *
 * This module pre-solves tokens in the background and keeps N fresh ones ready.
 * The booking worker calls `claimToken()` — guaranteed instant return (or null
 * if the pool happens to be empty in that millisecond, in which case the worker
 * falls back to a live solve).
 *
 * Tokens have a hard TTL on 2Captcha's side (~120s). We discard them at 90s
 * to leave a safety margin.
 */
import { env } from '@config/env';
import { logger } from '@modules/logs/logger';
import { solveTurnstile } from './twoCaptcha';

interface PooledToken {
  token: string;
  siteKey: string;
  pageUrl: string;
  solvedAt: number;
}

interface PoolKey {
  siteKey: string;
  pageUrl: string;
}

// One pool per (siteKey + pageUrl) — different VFS destinations may differ.
const pools = new Map<string, PooledToken[]>();
const refilling = new Map<string, boolean>();
const desiredKeys = new Map<string, PoolKey>();

function poolKey(siteKey: string, pageUrl: string): string {
  return `${siteKey}::${pageUrl}`;
}

/**
 * Tell the pool to keep N fresh tokens warm for a given (siteKey, pageUrl).
 * Idempotent — call this once per active route at boot or when starting a monitor.
 */
export function registerPool(siteKey: string, pageUrl: string): void {
  const key = poolKey(siteKey, pageUrl);
  desiredKeys.set(key, { siteKey, pageUrl });
  void refill(key);
}

/**
 * Grab a pre-solved token. Returns null if pool is empty for this route —
 * caller should fall back to a live solve. Triggers a background refill.
 */
export function claimToken(siteKey: string, pageUrl: string): string | null {
  const key = poolKey(siteKey, pageUrl);
  desiredKeys.set(key, { siteKey, pageUrl });

  const pool = pools.get(key);
  if (!pool || pool.length === 0) {
    void refill(key);
    return null;
  }

  // Drop expired tokens off the front.
  const now = Date.now();
  while (pool.length > 0 && now - pool[0].solvedAt > env.CAPTCHA_TOKEN_MAX_AGE_MS) {
    pool.shift();
  }

  const head = pool.shift();
  void refill(key); // top up immediately
  return head ? head.token : null;
}

async function refill(key: string): Promise<void> {
  if (refilling.get(key)) return;
  const desired = desiredKeys.get(key);
  if (!desired) return;

  const pool = pools.get(key) ?? [];
  if (!pools.has(key)) pools.set(key, pool);

  if (pool.length >= env.CAPTCHA_TOKEN_POOL_SIZE) return;

  refilling.set(key, true);
  try {
    while (pool.length < env.CAPTCHA_TOKEN_POOL_SIZE) {
      try {
        const token = await solveTurnstile(desired.siteKey, desired.pageUrl);
        pool.push({ token, siteKey: desired.siteKey, pageUrl: desired.pageUrl, solvedAt: Date.now() });
        logger.info(`captcha pool: refilled ${desired.pageUrl} (now ${pool.length}/${env.CAPTCHA_TOKEN_POOL_SIZE})`);
      } catch (err) {
        logger.warn(`captcha pool refill failed for ${desired.pageUrl}: ${(err as Error).message}`);
        // Back off briefly so we don't hammer 2Captcha if it's down.
        await sleep(5_000);
        break;
      }
    }
  } finally {
    refilling.set(key, false);
  }
}

/**
 * Background sweeper — every 30s, drop expired tokens and re-trigger refill
 * for any pool that's below the watermark.
 */
let sweeperStarted = false;
export function startCaptchaPoolSweeper(): void {
  if (sweeperStarted) return;
  sweeperStarted = true;
  setInterval(() => {
    const now = Date.now();
    for (const [key, pool] of pools) {
      while (pool.length > 0 && now - pool[0].solvedAt > env.CAPTCHA_TOKEN_MAX_AGE_MS) {
        pool.shift();
      }
      void refill(key);
    }
  }, 30_000).unref();
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
