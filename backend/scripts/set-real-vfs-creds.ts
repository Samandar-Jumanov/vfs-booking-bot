/**
 * Update test profile to use the REAL existing VFS account creds for auto-login testing.
 */
import 'tsconfig-paths/register';
import * as dotenv from 'dotenv'; dotenv.config();
import { PrismaClient } from '@prisma/client';
import { encrypt } from '../src/utils/crypto';

const prisma = new PrismaClient();
const PROFILE_ID = process.argv[2] || 'cmp86n46100007hu4mxzbzdai';
const REAL_EMAIL = process.env.VFS_EMAIL || 'jumanovsamandar84@gmail.com';
const REAL_PASSWORD = process.env.VFS_PASSWORD;

async function main() {
  if (!REAL_PASSWORD) {
    console.error('VFS_PASSWORD not set in .env — cannot proceed');
    process.exit(1);
  }
  const updated = await prisma.profile.update({
    where: { id: PROFILE_ID },
    data: { email: REAL_EMAIL, vfsPasswordEnc: encrypt(REAL_PASSWORD) },
  });
  console.log(`Profile ${updated.id} updated to email=${updated.email} (vfsPasswordEnc now set)`);
  await prisma.$disconnect();
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1); });
