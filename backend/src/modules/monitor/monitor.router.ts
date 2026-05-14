import { Router } from 'express';
import { requireAuth } from '@middleware/auth.middleware';
import { startMonitorHandler, stopMonitorHandler, statusHandler, injectCookiesHandler, injectedCookiesStatusHandler, testEmitSlotHandler } from './monitor.controller';

export const monitorRouter = Router();

monitorRouter.use(requireAuth);
monitorRouter.get('/status', statusHandler);
monitorRouter.post('/start', startMonitorHandler);
monitorRouter.post('/stop/:id', stopMonitorHandler);
monitorRouter.post('/inject-cookies', injectCookiesHandler);
monitorRouter.get('/injected-cookies', injectedCookiesStatusHandler);
if (process.env.NODE_ENV !== 'production') {
  monitorRouter.post('/_test/emit-slot', testEmitSlotHandler);
}
