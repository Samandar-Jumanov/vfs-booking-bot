import Redis from 'ioredis';
import { env } from './env';

let redisClient: Redis | null = null;

export function getRedis(): Redis {
  if (!redisClient) {
    redisClient = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: null, // Required by BullMQ
      enableReadyCheck: false,
      lazyConnect: false,
    });

    redisClient.on('connect', () => {
      console.info('Redis connected');
    });

    redisClient.on('error', (err) => {
      console.error('Redis error:', err.message);
    });
  }

  return redisClient;
}

export async function connectRedis(): Promise<void> {
  const client = getRedis();
  await client.ping();
}

export async function disconnectRedis(): Promise<void> {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
  }
}
