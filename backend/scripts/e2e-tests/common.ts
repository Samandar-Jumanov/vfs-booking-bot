import { prisma } from '../../src/config/database';
import { encrypt } from '../../src/utils/crypto';
import { signAccessToken } from '../../src/utils/jwt';
import { createApp } from '../../src/app';
import type { Server } from 'http';

export type E2eStatus = 'PASS' | 'SKIP' | 'FAIL';

export class SkipE2e extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkipE2e';
  }
}

export function skip(reason: string): never {
  throw new SkipE2e(reason);
}

export function isDryRun(): boolean {
  return process.env.E2E_DRY_RUN === '1';
}

export function liveOnly(flag: string, reason: string): void {
  if (isDryRun()) {
    skip(`dry run: ${reason}`);
  }
  if (process.env[flag] !== '1') {
    skip(`${flag}=1 is required: ${reason}`);
  }
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@e2e.local`;
}

export function datadomeCookie(value = 'E2E_DATADOME') {
  return { name: 'datadome', value, domain: '.vfsglobal.com', path: '/', secure: true, httpOnly: true };
}

export function sessionCookie(value = 'E2E_SESSION') {
  return { name: 'session', value, domain: '.vfsglobal.com', path: '/', secure: true, httpOnly: false };
}

export async function createTestAccount(prefix: string, data: Partial<{
  email: string;
  password: string;
  status: 'ACTIVE' | 'BLOCKED' | 'COOLDOWN';
  cookieStore: unknown;
  lastWarmedAt: Date | null;
  lastUsedAt: Date | null;
}> = {}) {
  return prisma.vfsAccount.create({
    data: {
      email: data.email ?? uniqueEmail(prefix),
      encryptedPassword: encrypt(data.password ?? 'E2ePassw0rd!'),
      status: data.status ?? 'ACTIVE',
      cookieStore: data.cookieStore as never,
      lastWarmedAt: data.lastWarmedAt,
      lastUsedAt: data.lastUsedAt,
      profileIds: [],
    },
  });
}

export async function createTestProfile(prefix: string, data: Partial<{
  fullName: string;
  email: string;
  passportNumber: string;
  dob: string;
  passportExpiry: string;
  priority: 'HIGH' | 'NORMAL';
}> = {}) {
  const { createProfile } = await import('../../src/modules/profiles/profiles.service');
  return createProfile({
    fullName: data.fullName ?? `E2E ${prefix} User`,
    passportNumber: data.passportNumber ?? `P${Date.now().toString().slice(-8)}`,
    dob: data.dob ?? '1990-01-15',
    passportExpiry: data.passportExpiry ?? '2032-01-15',
    nationality: 'uzbekistan',
    email: data.email ?? uniqueEmail(`${prefix}-profile`),
    phone: '+998901234567',
    gender: 'MALE',
    priority: data.priority ?? 'NORMAL',
    vfsPassword: 'E2ePassw0rd!',
  });
}

export async function cleanupByEmailPrefix(prefix: string): Promise<void> {
  await prisma.vfsAccount.deleteMany({ where: { email: { startsWith: prefix } } });
  await prisma.profile.deleteMany({ where: { email: { startsWith: prefix } } });
}

export async function withTestServer<T>(fn: (ctx: { baseUrl: string; authHeader: Record<string, string> }) => Promise<T>): Promise<T> {
  const admin = await prisma.user.upsert({
    where: { email: 'e2e-admin@local.test' },
    update: {},
    create: {
      email: 'e2e-admin@local.test',
      passwordHash: 'not-used-by-e2e-token',
      role: 'ADMIN',
    },
  });
  const token = signAccessToken({ sub: admin.id, email: admin.email, role: admin.role });
  const app = createApp();
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const address = server.address();
  assert(address && typeof address === 'object', 'test server did not expose a TCP address');
  try {
    return await fn({
      baseUrl: `http://127.0.0.1:${address.port}`,
      authHeader: { Authorization: `Bearer ${token}` },
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
}

export async function readResponseBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function readStream(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    stream.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

export async function runE2e(name: string, fn: () => Promise<void>): Promise<void> {
  const startedAt = Date.now();
  try {
    await fn();
    console.log(`[E2E_RESULT] ${JSON.stringify({ name, status: 'PASS' satisfies E2eStatus, durationMs: Date.now() - startedAt })}`);
    process.exitCode = 0;
  } catch (err) {
    if (err instanceof SkipE2e) {
      console.log(`[E2E_RESULT] ${JSON.stringify({ name, status: 'SKIP' satisfies E2eStatus, reason: err.message, durationMs: Date.now() - startedAt })}`);
      process.exitCode = 0;
    } else {
      const message = err instanceof Error ? err.message : String(err);
      console.error(err instanceof Error && err.stack ? err.stack : message);
      console.log(`[E2E_RESULT] ${JSON.stringify({ name, status: 'FAIL' satisfies E2eStatus, reason: message, durationMs: Date.now() - startedAt })}`);
      process.exitCode = 1;
    }
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}
