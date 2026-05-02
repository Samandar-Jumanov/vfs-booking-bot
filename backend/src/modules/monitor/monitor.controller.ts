import { Request, Response, NextFunction } from 'express';
import { createOrStartMonitor, stopMonitor, getMonitorStatus } from './monitor.service';

export async function startMonitorHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const {
      sourceCountry, destination, visaType, intervalMs, profileIds, mode,
    } = req.body;

    const id = await createOrStartMonitor({
      id: req.body.id, // Use existing ID if provided
      sourceCountry: sourceCountry || 'uzbekistan',
      destination,
      visaType,
      intervalMs: intervalMs ?? 30000,
      profileIds: profileIds ?? [],
      mode: mode === 'manual' ? 'manual' : 'auto',
    });

    res.json({ monitorId: id, message: 'Monitor started' });
  } catch (err) { next(err); }
}

export function stopMonitorHandler(req: Request, res: Response, next: NextFunction) {
  try {
    stopMonitor(req.params.id);
    res.json({ message: 'Monitor stopped' });
  } catch (err) { next(err); }
}

export function statusHandler(_req: Request, res: Response) {
  res.json(getMonitorStatus());
}
