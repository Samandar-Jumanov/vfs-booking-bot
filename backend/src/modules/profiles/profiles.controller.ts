import { Request, Response, NextFunction } from 'express';
import * as profilesService from './profiles.service';
import { bulkImportProfiles } from './bulkImport';

export async function listProfiles(req: Request, res: Response, next: NextFunction) {
  try {
    const { cursor, limit, search, priority } = req.query as Record<string, string>;
    const result = await profilesService.getProfiles({
      cursor,
      limit: Number(limit) || 20,
      search,
      priority: priority as 'HIGH' | 'NORMAL' | undefined,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function getProfile(req: Request, res: Response, next: NextFunction) {
  try {
    const profile = await profilesService.getProfileById(req.params.id);
    res.json(profile);
  } catch (err) {
    next(err);
  }
}

export async function createProfile(req: Request, res: Response, next: NextFunction) {
  try {
    const profile = await profilesService.createProfile(req.body);
    res.status(201).json(profile);
  } catch (err) {
    next(err);
  }
}

export async function updateProfile(req: Request, res: Response, next: NextFunction) {
  try {
    const profile = await profilesService.updateProfile(req.params.id, req.body);
    res.json(profile);
  } catch (err) {
    next(err);
  }
}

export async function deleteProfile(req: Request, res: Response, next: NextFunction) {
  try {
    await profilesService.deleteProfile(req.params.id);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

export async function bulkUpload(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded' });
      return;
    }
    const results = await bulkImportProfiles(req.file.buffer);
    const succeeded = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;
    res.json({ succeeded, failed, results });
  } catch (err) {
    next(err);
  }
}
