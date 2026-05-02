import { Router } from 'express';
import { requireAuth } from '@middleware/auth.middleware';
import { startMonitorHandler, stopMonitorHandler, statusHandler } from './monitor.controller';

export const monitorRouter = Router();

monitorRouter.use(requireAuth);
monitorRouter.get('/status', statusHandler);
monitorRouter.post('/start', startMonitorHandler);
monitorRouter.post('/stop/:id', stopMonitorHandler);
