import { prisma } from '@config/database';
import { LogLevel, EventType } from '@prisma/client';
import { CsvTransform } from '@utils/csvExport';
import { Readable } from 'stream';

export interface LogFilter {
  from?: string;
  to?: string;
  profileId?: string;
  eventType?: EventType;
  level?: LogLevel;
  limit?: number;
  offset?: number;
}

export async function getLogs(filter: LogFilter) {
  const where = {
    ...(filter.from || filter.to
      ? {
          timestamp: {
            ...(filter.from && { gte: new Date(filter.from) }),
            ...(filter.to && { lte: new Date(filter.to) }),
          },
        }
      : {}),
    ...(filter.profileId && { profileId: filter.profileId }),
    ...(filter.eventType && { eventType: filter.eventType }),
    ...(filter.level && { level: filter.level }),
  };

  const [total, items] = await Promise.all([
    prisma.log.count({ where }),
    prisma.log.findMany({
      where,
      orderBy: { timestamp: 'desc' },
      take: filter.limit ?? 100,
      skip: filter.offset ?? 0,
      include: { profile: { select: { fullName: true } } },
    }),
  ]);

  return { total, items };
}

const CSV_HEADERS = [
  'timestamp', 'level', 'eventType', 'message',
  'profileId', 'destination', 'result', 'proxyUsed',
];

export function createCsvExportStream(filter: LogFilter): NodeJS.ReadableStream {
  const csvTransform = new CsvTransform(CSV_HEADERS);

  const readable = new Readable({ objectMode: true, read() {} });

  // Stream rows from DB in batches
  (async () => {
    const batchSize = 500;
    let offset = 0;

    while (true) {
      const rows = await prisma.log.findMany({
        where: {
          ...(filter.from || filter.to ? {
            timestamp: {
              ...(filter.from && { gte: new Date(filter.from) }),
              ...(filter.to && { lte: new Date(filter.to) }),
            },
          } : {}),
          ...(filter.profileId && { profileId: filter.profileId }),
          ...(filter.eventType && { eventType: filter.eventType }),
        },
        orderBy: { timestamp: 'desc' },
        take: batchSize,
        skip: offset,
      });

      for (const row of rows) {
        readable.push(row);
      }

      if (rows.length < batchSize) {
        readable.push(null);
        break;
      }
      offset += batchSize;
    }
  })().catch((err) => readable.destroy(err));

  return readable.pipe(csvTransform);
}

export async function clearLogs() {
  return prisma.log.deleteMany();
}
