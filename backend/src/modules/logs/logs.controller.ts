import { Request, Response, NextFunction } from 'express';
import { getLogs, createCsvExportStream, LogFilter, clearLogs as clearLogsService } from './logs.service';
import { getOptimalPollingWindows } from './analytics.service';
import { prisma } from '@config/database';

export async function listLogs(req: Request, res: Response, next: NextFunction) {
  try {
    const filter: LogFilter = {
      from: req.query.from as string,
      to: req.query.to as string,
      profileId: req.query.profileId as string,
      eventType: req.query.eventType as LogFilter['eventType'],
      level: req.query.level as LogFilter['level'],
      limit: req.query.limit ? Number(req.query.limit) : 100,
      offset: req.query.offset ? Number(req.query.offset) : 0,
    };
    const result = await getLogs(filter);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export function exportLogs(req: Request, res: Response, next: NextFunction) {
  try {
    const filter: LogFilter = {
      from: req.query.from as string,
      to: req.query.to as string,
      profileId: req.query.profileId as string,
      eventType: req.query.eventType as LogFilter['eventType'],
    };

    const filename = `vfs-logs-${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    const stream = createCsvExportStream(filter);
    stream.pipe(res);
    stream.on('error', next);
  } catch (err) {
    next(err);
  }
}
export async function getAnalytics(req: Request, res: Response, next: NextFunction) {
  try {
    const destination = req.query.destination as string;
    const stats = await getOptimalPollingWindows(destination);
    res.json(stats);
  } catch (err) {
    next(err);
  }
}
export async function clearLogs(req: Request, res: Response, next: NextFunction) {
  try {
    await clearLogsService();
    res.json({ message: 'Logs cleared successfully' });
  } catch (err) {
    next(err);
  }
}

export async function listPipelineEvents(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const limit = Math.min(Number(req.query.limit ?? 100), 500);
    const offset = Number(req.query.offset ?? 0);
    const severity = req.query.severity as string | undefined;
    const accountId = req.query.accountId as string | undefined;

    const where = {
      ...(severity ? { severity: severity as any } : {}),
      ...(accountId ? { accountId } : {}),
    };

    const [events, total] = await Promise.all([
      (prisma as any).pipelineEvent.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      (prisma as any).pipelineEvent.count({ where }),
    ]);

    res.json({ total, events });
  } catch (err) {
    next(err);
  }
}
