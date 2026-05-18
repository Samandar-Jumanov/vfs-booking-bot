import 'tsconfig-paths/register';
import * as dotenv from 'dotenv';
dotenv.config();
import { prisma } from '../src/config/database';

(async () => {
  const jobId = process.argv[2] || '5';
  const b = await prisma.booking.findFirst({
    where: { jobId },
    select: { id: true, status: true, errorMessage: true, confirmationNo: true, attempt: true, completedAt: true, jobId: true },
  });
  console.log(JSON.stringify(b, null, 2));
  await prisma.$disconnect();
  process.exit(0);
})();
