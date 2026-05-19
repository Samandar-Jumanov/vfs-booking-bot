import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { prisma } from '@config/database';
import { logger } from '@modules/logs/logger';

// One-shot bootstrap of the operator admin user. Idempotent:
//   - If no admin exists, creates one from BOOTSTRAP_ADMIN_EMAIL / _PASSWORD
//     env (must be set on Railway before first call).
//   - If an admin already exists, returns the existing id.
// Gated by BOOTSTRAP_TOKEN header so the endpoint can sit on a public URL
// without becoming an account takeover vector.
export const bootstrapRouter = Router();

bootstrapRouter.post('/admin', async (req, res) => {
  const token = req.headers['x-bootstrap-token'];
  const expected = process.env.BOOTSTRAP_TOKEN;
  if (!expected || token !== expected) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const email = process.env.BOOTSTRAP_ADMIN_EMAIL;
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!email || !password) {
    return res.status(500).json({ error: 'BOOTSTRAP_ADMIN_EMAIL or BOOTSTRAP_ADMIN_PASSWORD env not set' });
  }
  if (password.length < 8) {
    return res.status(500).json({ error: 'BOOTSTRAP_ADMIN_PASSWORD must be at least 8 characters' });
  }

  const existing = await prisma.user.findFirst({ where: { role: 'ADMIN' as never } });
  if (existing) {
    return res.json({
      created: false,
      userId: existing.id,
      email: existing.email,
      message: 'Admin already exists.',
    });
  }

  const hash = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({
    data: { email, passwordHash: hash, role: 'ADMIN' as never },
    select: { id: true, email: true, role: true },
  });
  logger.warn(`bootstrap admin created: ${user.email}`);

  res.json({
    created: true,
    userId: user.id,
    email: user.email,
    message: 'Admin created. Set OPERATOR_USER_ID=<userId> on Railway, then log in.',
  });
});
