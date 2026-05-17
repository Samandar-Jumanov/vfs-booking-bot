import 'tsconfig-paths/register';
import * as dotenv from 'dotenv'; dotenv.config();
import bcrypt from 'bcryptjs';
import { prisma } from '../src/config/database';

(async () => {
  const newPassword = process.argv[2] || 'admin123';
  const hash = await bcrypt.hash(newPassword, 10);

  const updated = await prisma.user.updateMany({
    where: { role: 'ADMIN' },
    data: { passwordHash: hash, refreshTokenHash: null },
  });
  console.log(`Reset password for ${updated.count} admin users → "${newPassword}"`);

  const users = await prisma.user.findMany({ where: { role: 'ADMIN' }, select: { email: true } });
  for (const u of users) console.log(`  login: ${u.email} / ${newPassword}`);
  await prisma.$disconnect();
})();
