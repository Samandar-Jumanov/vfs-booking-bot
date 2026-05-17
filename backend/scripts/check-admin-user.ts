import 'tsconfig-paths/register';
import * as dotenv from 'dotenv'; dotenv.config();
import { prisma } from '../src/config/database';

(async () => {
  const users = await prisma.user.findMany({ select: { id: true, email: true, role: true } });
  console.log('Users in DB:');
  for (const u of users) console.log(`  ${u.id}  ${u.email}  ${u.role}`);
  const profiles = await prisma.profile.findMany({ select: { id: true, email: true, fullName: true } });
  console.log('\nProfiles in DB:');
  for (const p of profiles) console.log(`  ${p.id}  ${p.email}  ${p.fullName}`);
  const accounts = await prisma.vfsAccount.findMany({ select: { id: true, email: true, status: true, lastWarmedAt: true } });
  console.log('\nVFS pool accounts:');
  for (const a of accounts) console.log(`  ${a.id}  ${a.email}  ${a.status}  warmed=${a.lastWarmedAt ?? 'never'}`);
  await prisma.$disconnect();
})();
