import { Router } from 'express';
import { requireAuth } from '@middleware/auth.middleware';
import { listLogs, exportLogs, getAnalytics, clearLogs, listPipelineEvents } from './logs.controller';

export const logsRouter = Router();

logsRouter.use(requireAuth);
logsRouter.get('/', listLogs);
logsRouter.delete('/', clearLogs);
logsRouter.get('/export', exportLogs);
logsRouter.get('/analytics', getAnalytics);
logsRouter.get('/pipeline-events', listPipelineEvents);
