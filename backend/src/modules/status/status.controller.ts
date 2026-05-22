import { Request, Response, NextFunction } from 'express';
import { getPublicCustomerStatus } from './status.service';

export async function publicStatusHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const token = String(req.params.token ?? '').trim();
    if (!/^[A-Za-z0-9_-]{6,32}$/.test(token)) {
      res.status(404).json({ error: 'Status page not found', code: 'NOT_FOUND' });
      return;
    }

    res.json(await getPublicCustomerStatus(token));
  } catch (err) {
    next(err);
  }
}
