import winston from 'winston';
import Transport from 'winston-transport';
import { prisma } from '@config/database';
import { EventType, LogLevel, Prisma } from '@prisma/client';
import { env } from '@config/env';

interface LogInfo {
  level: string;
  message: string;
  metadata?: Record<string, unknown>;
}

// Custom transport that writes structured logs to the DB
class PrismaTransport extends Transport {
  log(info: LogInfo, callback: () => void) {
    setImmediate(async () => {
      try {
        const meta = info.metadata as Record<string, unknown> | undefined;
        await prisma.log.create({
          data: {
            level: (info.level.toUpperCase() as LogLevel),
            eventType: (meta?.eventType as EventType) ?? EventType.MONITOR_STARTED,
            message: info.message,
            profileId: (meta?.profileId as string) ?? null,
            destination: (meta?.destination as string) ?? null,
            result: (meta?.result as string) ?? null,
            proxyUsed: (meta?.proxyUsed as string) ?? null,
            metadata: meta ? (meta as Prisma.InputJsonValue) : undefined,
          },
        });
      } catch {
        // Never crash the app due to a logging failure
      }
    });
    callback();
  }
}

const transports: Transport[] = [
  new winston.transports.Console({
    format:
      env.NODE_ENV === 'development'
        ? winston.format.combine(
            winston.format.colorize(),
            winston.format.simple()
          )
        : winston.format.json(),
  }),
  new PrismaTransport(),
];

export const logger = winston.createLogger({
  level: env.NODE_ENV === 'production' ? 'info' : 'debug',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.metadata({ fillExcept: ['message', 'level', 'timestamp'] }),
    winston.format.json()
  ),
  transports,
});

/** Typed log helper for VFS bot events */
export function logEvent(
  level: 'info' | 'warn' | 'error',
  eventType: EventType,
  message: string,
  meta?: Record<string, unknown>
) {
  logger[level](message, { eventType, ...meta });
}
