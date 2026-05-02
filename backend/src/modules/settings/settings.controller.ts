import { Request, Response, NextFunction } from 'express';
import * as settingsService from './settings.service';
import { AppError } from '@middleware/errorHandler';

export async function getAll(req: Request, res: Response, next: NextFunction) {
  try {
    const settings = await settingsService.getAllSettings();
    const global = await settingsService.getGlobalSettings();
    res.json({ ...settings, global });
  } catch (err) { next(err); }
}

export async function updateGlobal(req: Request, res: Response, next: NextFunction) {
  try {
    await settingsService.updateGlobalSettings(req.body);
    res.json({ success: true });
  } catch (err) { next(err); }
}

// Bulk update — body is { "key1": value1, "key2": value2, ... }
// Skips reserved key "global" (handled by /global endpoint).
export async function updateBulk(req: Request, res: Response, next: NextFunction) {
  try {
    const body = req.body ?? {};
    if (typeof body !== 'object' || Array.isArray(body)) {
      throw new AppError(400, 'Body must be an object of key/value pairs', 'BAD_REQUEST');
    }
    const entries = Object.entries(body).filter(([k]) => k !== 'global');
    await Promise.all(entries.map(([k, v]) => settingsService.setSetting(k, v)));
    res.json({ success: true, updated: entries.length });
  } catch (err) { next(err); }
}

// Single-key set: PUT /api/settings/:key  body: { value: <anything> }
export async function updateOne(req: Request, res: Response, next: NextFunction) {
  try {
    const key = req.params.key;
    if (!key) throw new AppError(400, 'Key required', 'BAD_REQUEST');
    if (!('value' in (req.body ?? {}))) {
      throw new AppError(400, 'Body must include "value"', 'BAD_REQUEST');
    }
    await settingsService.setSetting(key, req.body.value);
    res.json({ success: true, key });
  } catch (err) { next(err); }
}
