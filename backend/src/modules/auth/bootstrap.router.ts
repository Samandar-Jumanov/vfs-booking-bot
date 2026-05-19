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

  const hash = await bcrypt.hash(password, 10);
  // Upsert: if an admin already exists, RESET its password to the one in env.
  // Idempotent + lets the operator recover from "I forgot the bootstrap password".
  const user = await prisma.user.upsert({
    where: { email },
    update: { passwordHash: hash, role: 'ADMIN' as never },
    create: { email, passwordHash: hash, role: 'ADMIN' as never },
    select: { id: true, email: true, role: true },
  });
  logger.warn(`bootstrap admin upserted: ${user.email}`);

  res.json({
    upserted: true,
    userId: user.id,
    email: user.email,
    message: 'Admin password set. Use BOOTSTRAP_ADMIN_PASSWORD to log in.',
  });
});
