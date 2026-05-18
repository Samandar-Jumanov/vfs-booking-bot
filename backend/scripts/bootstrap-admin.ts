/**
 * One-shot production bootstrap. Run after first deploy to:
 *   1. Create the operator admin user (if missing)
 *   2. Print the operator's user.id so you can paste it into
 *      OPERATOR_USER_ID env on Railway/Vercel/your VPS
 *   3. Print a setup code so the operator's Chrome extension can pair
 *
 * Usage:
 *   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=strong-pw npx tsx scripts/bootstrap-admin.ts
 *
 * Or via Railway shell:
 *   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=strong-pw node dist/scripts/bootstrap-admin.js
 */
import 'tsconfig-paths/register';
import * as path from 'path';
import * as dotenv from 'dotenv';
dotenv.config({ path: path.resolve('../.env') });
dotenv.config({ path: path.resolve('.env'), override: true });
import bcrypt from 'bcryptjs';
import { prisma } from '../src/config/database';

(async () => {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) {
    console.error('Set ADMIN_EMAIL and ADMIN_PASSWORD environment variables.');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exit(1);
  }

  const hash = await bcrypt.hash(password, 10);

  const user = await prisma.user.upsert({
    where: { email },
    update: { passwordHash: hash, role: 'ADMIN' as any },
    create: { email, passwordHash: hash, role: 'ADMIN' as any },
    select: { id: true, email: true, role: true, createdAt: true },
  });

  console.log('\n=== Bootstrap complete ===');
  console.log(`Admin user: ${user.email}  (role=${user.role})`);
  console.log(`Operator user.id: ${user.id}`);
  console.log('\nNext steps:');
  console.log(`  1. Set OPERATOR_USER_ID=${user.id} in your prod env.`);
  console.log(`  2. Log into the dashboard at https://app.yourbookingbot.com with`);
  console.log(`     email=${email}  password=<the one you just set>`);
  console.log(`  3. Click "Generate setup code" on /extension-setup — paste into`);
  console.log(`     the Chrome extension Options.`);
  console.log(`  4. POST /api/accounts/auto-create to seed the first pool account.`);
  console.log('');

  await prisma.$disconnect();
  process.exit(0);
})().catch(async (e) => {
  console.error('FAIL', e?.stack || e?.message || e);
  try { await prisma.$disconnect(); } catch {}
  process.exit(1);
});
