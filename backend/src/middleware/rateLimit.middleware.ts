import type { Request, Response, NextFunction } from 'express';

// Rate limiting removed — single operator, internal traffic only. The
// previous express-rate-limit was blocking our own dev/debug scripts which
// hit the API at machine speed.
const noop = (_req: Request, _res: Response, next: NextFunction) => next();
export const authLimiter = noop;
export const apiLimiter = noop;
