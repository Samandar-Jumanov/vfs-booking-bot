import { Request, Response, NextFunction } from 'express';
import { createOrStartMonitor, stopMonitor, getMonitorStatus, injectManualCookies, getInjectedCookiesStatus } from './monitor.service';
import { dispatchNotification } from '@modules/notifications/notification.service';
import { emitToAll } from '@modules/websocket/ws.server';

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

/**
 * POST /api/monitor/inject-cookies
 * Body: { destination: 'prt' | 'tjk' | 'lva', cookies: '<full cookie header string>', userAgent?: string }
 *
 * How to get cookies from your browser:
 *   1. Log into https://visa.vfsglobal.com/uzb/prt/en/schedule-appointment in Chrome/Firefox
 *   2. Open DevTools → Network tab → click any request to visa.vfsglobal.com
 *   3. In Request Headers, find the "cookie:" line — copy its entire value
 *   4. Paste it into the `cookies` field here
 */
export function injectCookiesHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { destination, cookies, userAgent } = req.body;
    if (!destination || typeof destination !== 'string') {
      return res.status(400).json({ error: 'destination is required (e.g. "prt", "tjk", "lva")' });
    }
    if (!cookies || typeof cookies !== 'string' || cookies.trim().length === 0) {
      return res.status(400).json({ error: 'cookies string is required' });
    }
    injectManualCookies(destination, cookies, userAgent);
    const status = getInjectedCookiesStatus();
    return res.json({ message: 'Cookies injected — monitors will use them immediately', injectedCookies: status });
  } catch (err) { next(err); }
}

export function injectedCookiesStatusHandler(_req: Request, res: Response) {
  res.json(getInjectedCookiesStatus());
}

export async function testEmitSlotHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { destination } = req.body;
    if (!destination || typeof destination !== 'string') {
      return res.status(400).json({ error: 'destination is required' });
    }

    const defaultDate = new Date();
    defaultDate.setDate(defaultDate.getDate() + 7);

    const date = typeof req.body.date === 'string'
      ? req.body.date
      : defaultDate.toISOString().slice(0, 10);
    const time = typeof req.body.time === 'string' ? req.body.time : '10:00';
    const firstSlot = { date, time, destination, visaType: 'SCH' };

    emitToAll('SLOT_DETECTED', {
      monitorId: 'test',
      sourceCountry: 'uzbekistan',
      destination,
      visaType: 'SCH',
      count: 1,
      firstSlot,
    });

    await dispatchNotification({
      event: 'SLOT_DETECTED',
      sourceCountry: 'uzbekistan',
      destination,
      visaType: 'SCH',
      monitorId: 'test',
      slotDate: date,
    });

    return res.json({ ok: true, emitted: true, destination, date, time });
  } catch (err) { next(err); }
}
