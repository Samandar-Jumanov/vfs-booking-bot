import { Router } from 'express';
import { validate } from '@middleware/validate.middleware';
import { requireAuth } from '@middleware/auth.middleware';
import { authLimiter } from '@middleware/rateLimit.middleware';
import { loginSchema } from './auth.schema';
import { loginHandler, refreshHandler, logoutHandler, meHandler } from './auth.controller';

export const authRouter = Router();

authRouter.post('/login', authLimiter, validate(loginSchema), loginHandler);
authRouter.post('/refresh', refreshHandler);
authRouter.post('/logout', requireAuth, logoutHandler);
authRouter.get('/me', requireAuth, meHandler);
