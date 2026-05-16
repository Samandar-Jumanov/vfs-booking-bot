import { Router } from 'express';
import { requireAuth } from '@middleware/auth.middleware';
import { getExtensionState, markExtensionHeartbeat } from './extension.state';

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
