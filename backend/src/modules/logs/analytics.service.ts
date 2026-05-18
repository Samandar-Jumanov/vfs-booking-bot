import { prisma } from '@config/database';

interface PollingWindow {
  hour: number;
  detections: number;
}

/**
 * Returns slot-detection counts grouped by hour-of-day for a given destination.
 * Used by the analytics endpoint to surface the most productive polling windows.
 */
export async function getOptimalPollingWindows(destination?: string): Promise<PollingWindow[]> {
  const rows = await prisma.log.findMany({
    where: {
      eventType: 'SLOT_DETECTED',
      ...(destination && { destination }),
    },
    select: { timestamp: true },
    take: 5000,
    orderBy: { timestamp: 'desc' },
  });

  const buckets = new Map<number, number>();
  for (const r of rows) {
    const hour = new Date(r.timestamp).getUTCHours();
    buckets.set(hour, (buckets.get(hour) ?? 0) + 1);
  }

  return Array.from({ length: 24 }, (_, hour) => ({
    hour,
    detections: buckets.get(hour) ?? 0,
  }));
}
