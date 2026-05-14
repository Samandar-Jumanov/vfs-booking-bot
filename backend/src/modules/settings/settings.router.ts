import { Router } from 'express';
import { requireAuth } from '@middleware/auth.middleware';
import * as settingsController from './settings.controller';

const router = Router();

router.post('/notifications/test', settingsController.testNotifications);
router.use(requireAuth);
router.get('/', settingsController.getAll);
router.post('/global', settingsController.updateGlobal);
router.patch('/', settingsController.updateBulk);
router.put('/:key', settingsController.updateOne);

export const settingsRouter = router;
