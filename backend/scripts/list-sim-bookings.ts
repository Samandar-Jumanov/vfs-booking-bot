import 'tsconfig-paths/register';
import * as path from 'path';
import * as dotenv from 'dotenv';
dotenv.config({ path: path.resolve('../.env') });
dotenv.config({ path: path.resolve('.env'), override: true });
import { prisma } from '../src/config/database';

(async () => {
  const fakes = await prisma.booking.findMany({
    where: { confirmationNo: { startsWith: 'VFS-SIM-' } },
    select: { id: true, confirmationNo: true, status: true, createdAt: true },
  });
  console.log('Fake sim bookings:');
  for (const b of fakes) console.log(' ', b);
  await prisma.$disconnect();
})();
