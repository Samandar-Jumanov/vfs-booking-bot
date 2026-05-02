import { Router } from 'express';
import { requireAuth } from '@middleware/auth.middleware';
import { requireRole } from '@middleware/rbac.middleware';
import { Role } from '@prisma/client';
import { listProxies, addProxy, resetProxy, deleteProxy } from './proxy.controller';

export const proxyRouter = Router();

proxyRouter.use(requireAuth, requireRole(Role.ADMIN));
proxyRouter.get('/', listProxies);
proxyRouter.post('/', addProxy);
proxyRouter.post('/:id/reset', resetProxy);
proxyRouter.delete('/:id', deleteProxy);
