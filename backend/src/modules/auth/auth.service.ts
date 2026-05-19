import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { Role } from '@prisma/client';
import { prisma } from '@config/database';
import { getRedis } from '@config/redis';
import { signAccessToken, signExtensionToken, signRefreshToken, verifyRefreshToken } from '@utils/jwt';
import { AppError } from '@middleware/errorHandler';

// Setup codes live in Redis (not process memory) so they survive backend
// redeploys. TTL is enforced by Redis EXPIRE; 10 minutes.
const SETUP_CODE_TTL_S = 10 * 60;
const setupCodeKey = (code: string) => `extension:setup:${code}`;

interface SetupCodeEntry {
  userId: string;
  email: string;
  role: Role;
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export async function login(email: string, password: string) {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) throw new AppError(401, 'Invalid credentials', 'INVALID_CREDENTIALS');

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) throw new AppError(401, 'Invalid credentials', 'INVALID_CREDENTIALS');

  const payload = { sub: user.id, email: user.email, role: user.role };
  const accessToken = signAccessToken(payload);
  const refreshToken = signRefreshToken(payload);

  await prisma.user.update({
    where: { id: user.id },
    data: { refreshTokenHash: hashToken(refreshToken) },
  });

  return {
    accessToken,
    refreshToken,
    user: { id: user.id, email: user.email, role: user.role },
  };
}

export async function refresh(rawRefreshToken: string) {
  let payload;
  try {
    payload = verifyRefreshToken(rawRefreshToken);
  } catch {
    throw new AppError(401, 'Invalid refresh token', 'TOKEN_INVALID');
  }

  const user = await prisma.user.findUnique({ where: { id: payload.sub } });
  if (!user?.refreshTokenHash) throw new AppError(401, 'Session expired', 'SESSION_EXPIRED');

  if (user.refreshTokenHash !== hashToken(rawRefreshToken)) {
    // Token reuse detected — invalidate all sessions
    await prisma.user.update({ where: { id: user.id }, data: { refreshTokenHash: null } });
    throw new AppError(401, 'Token reuse detected', 'TOKEN_REUSE');
  }

  const newPayload = { sub: user.id, email: user.email, role: user.role };
  const accessToken = signAccessToken(newPayload);
  const newRefreshToken = signRefreshToken(newPayload);

  await prisma.user.update({
    where: { id: user.id },
    data: { refreshTokenHash: hashToken(newRefreshToken) },
  });

  return { accessToken, refreshToken: newRefreshToken };
}

export async function logout(userId: string) {
  await prisma.user.update({
    where: { id: userId },
    data: { refreshTokenHash: null },
  });
}

export async function mintExtensionSetup(user: { id: string; email: string; role: Role }) {
  const setupCode = crypto.randomInt(100000, 999999).toString();
  const entry: SetupCodeEntry = { userId: user.id, email: user.email, role: user.role };
  await getRedis().set(setupCodeKey(setupCode), JSON.stringify(entry), 'EX', SETUP_CODE_TTL_S);
  return {
    setupCode,
    expiresAt: new Date(Date.now() + SETUP_CODE_TTL_S * 1000).toISOString(),
    extensionToken: signExtensionToken({ sub: user.id, email: user.email, role: user.role }),
  };
}

export async function exchangeExtensionSetupCode(setupCode: string) {
  const redis = getRedis();
  const key = setupCodeKey(setupCode);
  const raw = await redis.get(key);
  // One-shot: delete after first successful read.
  if (raw) await redis.del(key);
  if (!raw) {
    throw new AppError(401, 'Invalid or expired extension setup code', 'EXTENSION_SETUP_INVALID');
  }
  const entry = JSON.parse(raw) as SetupCodeEntry;
  return {
    extensionToken: signExtensionToken({ sub: entry.userId, email: entry.email, role: entry.role }),
    customerEmail: entry.email,
  };
}
