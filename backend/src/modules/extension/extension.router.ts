import { Router } from 'express';
import { requireAuth } from '@middleware/auth.middleware';
import { getExtensionState, markExtensionHeartbeat } from './extension.state';
import { logEvent } from '@modules/logs/logger';
import { EventType } from '@prisma/client';

export const extensionRouter = Router();

extensionRouter.post('/heartbeat', requireAuth, (req, res) => {
  const state = req.user ? markExtensionHeartbeat(req.user.id) : undefined;
  res.json({ ok: true, state });
});

extensionRouter.get('/status', requireAuth, (req, res) => {
  const state = req.user ? getExtensionState(req.user.id) : undefined;
  res.json({
    connected: state?.connected ?? false,
    customerEmail: state?.customerEmail ?? req.user?.email,
    connectedAt: state?.connectedAt,
    lastHeartbeatAt: state?.lastHeartbeatAt,
  });
});

// HTTP-only trace channel used by the extension to log register-flow steps
// when the WS event path is unreliable. Surfaces every step in Activity Logs.
extensionRouter.post('/trace', requireAuth, (req, res) => {
  const step = String(req.body?.step ?? 'unknown');
  const meta = req.body?.meta ?? {};
  logEvent('info', EventType.BOOKING_ATTEMPT, `[REGISTER-TRACE] ${step} ${JSON.stringify(meta).slice(0, 200)}`);
  res.json({ ok: true });
});
