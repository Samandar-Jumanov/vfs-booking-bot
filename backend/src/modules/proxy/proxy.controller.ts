import { Request, Response, NextFunction } from 'express';
import * as proxyService from './proxy.service';

export async function listProxies(req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await proxyService.listProxies());
  } catch (err) { next(err); }
}

export async function addProxy(req: Request, res: Response, next: NextFunction) {
  try {
    const proxy = await proxyService.addProxy(req.body);
    res.status(201).json(proxy);
  } catch (err) { next(err); }
}

export async function resetProxy(req: Request, res: Response, next: NextFunction) {
  try {
    await proxyService.resetProxy(req.params.id);
    res.json({ message: 'Proxy reset' });
  } catch (err) { next(err); }
}

export async function deleteProxy(req: Request, res: Response, next: NextFunction) {
  try {
    await proxyService.deleteProxy(req.params.id);
    res.status(204).send();
  } catch (err) { next(err); }
}
