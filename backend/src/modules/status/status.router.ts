import { Router } from 'express';
import { publicStatusHandler } from './status.controller';

export const statusRouter = Router();

statusRouter.get('/:token', publicStatusHandler);
