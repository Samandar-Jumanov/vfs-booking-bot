import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { Role } from '@prisma/client';
import { prisma } from '@config/database';
import { signAccessToken, signExtensionToken, signRefreshToken, verifyRefreshToken } from '@utils/jwt';
import { AppError } from '@middleware/errorHandler';

const setupCodes = new Map<string, { userId: string; email: string; role: Role; expiresAt: number }>();

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
  const expiresAt = Date.now() + 10 * 60 * 1000;
  setupCodes.set(setupCode, { userId: user.id, email: user.email, role: user.role, expiresAt });
  return {
    setupCode,
    expiresAt: new Date(expiresAt).toISOString(),
    extensionToken: signExtensionToken({ sub: user.id, email: user.email, role: user.role }),
  };
}

export async function exchangeExtensionSetupCode(setupCode: string) {
  const entry = setupCodes.get(setupCode);
  setupCodes.delete(setupCode);
  if (!entry || entry.expiresAt < Date.now()) {
    throw new AppError(401, 'Invalid or expired extension setup code', 'EXTENSION_SETUP_INVALID');
  }
  return {
    extensionToken: signExtensionToken({ sub: entry.userId, email: entry.email, role: entry.role }),
    customerEmail: entry.email,
  };
}
