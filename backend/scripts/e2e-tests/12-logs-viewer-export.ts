import { runE2e, assert, readStream } from './common';

runE2e('12. Logs viewer with filters and CSV export', async () => {
  const { prisma } = await import('../../src/config/database');
  const { getLogs, createCsvExportStream } = await import('../../src/modules/logs/logs.service');
  const marker = `e2e-logs-${Date.now()}`;
  await prisma.log.createMany({
    data: [
      { level: 'INFO', eventType: 'SLOT_DETECTED', message: `${marker} slot`, destination: 'lva' },
      { level: 'ERROR', eventType: 'BOOKING_FAILED', message: `${marker} booking`, destination: 'prt' },
    ],
  });
  const filtered = await getLogs({ eventType: 'SLOT_DETECTED', level: 'INFO', limit: 10 });
  assert(filtered.items.some((row) => row.message === `${marker} slot`), 'filtered logs did not include expected INFO/SLOT_DETECTED row');
  assert(!filtered.items.some((row) => row.message === `${marker} booking`), 'filtered logs included row with wrong event/level');

  const csv = await readStream(createCsvExportStream({ eventType: 'SLOT_DETECTED' }));
  assert(csv.startsWith('timestamp,level,eventType,message'), 'CSV export headers are missing or wrong');
  assert(csv.includes(`${marker} slot`), 'CSV export did not contain expected filtered log row');
  await prisma.log.deleteMany({ where: { message: { startsWith: marker } } });
});
