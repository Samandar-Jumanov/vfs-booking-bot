import { runE2e, assert, withTestServer } from './common';

runE2e('12. Logs viewer with filters and CSV export', async () => {
  const { prisma } = await import('../../src/config/database');
  const marker = `e2e-logs-${Date.now()}`;
  try {
    await prisma.log.createMany({
      data: [
        { level: 'INFO', eventType: 'SLOT_DETECTED', message: `${marker} slot`, destination: 'lva' },
        { level: 'ERROR', eventType: 'BOOKING_FAILED', message: `${marker} booking`, destination: 'prt' },
      ],
    });
    await withTestServer(async ({ baseUrl, authHeader }) => {
      const filteredRes = await fetch(`${baseUrl}/api/logs?eventType=SLOT_DETECTED&level=INFO&limit=10`, {
        headers: authHeader,
      });
      assert(filteredRes.ok, `logs list returned HTTP ${filteredRes.status}`);
      const filtered = await filteredRes.json() as { items?: Array<{ message?: string }> };
      assert(filtered.items?.some((row) => row.message === `${marker} slot`), 'filtered logs did not include expected INFO/SLOT_DETECTED row');
      assert(!filtered.items?.some((row) => row.message === `${marker} booking`), 'filtered logs included row with wrong event/level');

      const exportRes = await fetch(`${baseUrl}/api/logs/export?eventType=SLOT_DETECTED`, {
        headers: authHeader,
      });
      assert(exportRes.ok, `logs export returned HTTP ${exportRes.status}`);
      assert(exportRes.headers.get('content-type')?.includes('text/csv'), 'logs export did not return text/csv');
      const csv = await exportRes.text();
      assert(csv.startsWith('timestamp,level,eventType,message'), 'CSV export headers are missing or wrong');
      assert(csv.includes(`${marker} slot`), 'CSV export did not contain expected filtered log row');
    });
  } finally {
    await prisma.log.deleteMany({ where: { message: { startsWith: marker } } });
  }
});
