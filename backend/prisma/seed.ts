/**
 * Seed script — populates the DB with the bare minimum for local development.
 * Run with: npm run db:seed
 *
 * Creates:
 *  - 1 ADMIN user (admin@vfsbot.local / admin1234)
 *  - Default settings (telegram on, manual captcha, 30s poll interval)
 */

import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '../.env') });

import { PrismaClient, Role } from '@prisma/client';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';

const prisma = new PrismaClient();

// ── Encryption helper (mirrors crypto.ts) ─────────────────────────────────────

function encrypt(plaintext: string): string {
  const key = Buffer.from(process.env.PROFILE_ENCRYPTION_KEY!, 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🌱 Seeding database (Users Only)…\n');

  // ── Users ──────────────────────────────────────────────────────────────────
  const admin = await prisma.user.upsert({
    where: { email: 'admin@vfsbot.local' },
    update: {},
    create: {
      email: 'admin@vfsbot.local',
      passwordHash: await bcrypt.hash('admin1234', 12),
      role: Role.ADMIN,
    },
  });
  console.log(`  ✅ Admin user: ${admin.email}`);

  // ── Default settings ───────────────────────────────────────────────────────
  const defaultSettings: Array<{ key: string; value: unknown }> = [
    { key: 'notifications.telegram.enabled', value: true },
    { key: 'captcha.solver', value: 'manual' },
    { key: 'monitor.defaultIntervalMs', value: 30000 },
  ];

  for (const s of defaultSettings) {
    await prisma.settings.upsert({
      where: { key: s.key },
      update: {},
      create: { key: s.key, value: s.value as never },
    });
  }
  console.log(`  ✅ ${defaultSettings.length} default settings seeded`);

  console.log('\n✅ Seed complete (No dummy data)!\n');
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
