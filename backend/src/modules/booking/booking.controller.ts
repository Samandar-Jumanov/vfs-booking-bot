import { Request, Response, NextFunction } from 'express';
import { enqueueBooking, cancelBooking, getBookingHistory } from './booking.service';

export async function triggerBooking(req: Request, res: Response, next: NextFunction) {
  try {
    const jobId = await enqueueBooking(req.body);
    res.json({ jobId, message: 'Booking job enqueued' });
  } catch (err) { next(err); }
}

export async function cancelBookingHandler(req: Request, res: Response, next: NextFunction) {
  try {
    await cancelBooking(req.params.jobId);
    res.json({ message: 'Booking cancelled' });
  } catch (err) { next(err); }
}

export async function bookingHistory(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await getBookingHistory({
      profileId: req.query.profileId as string,
      limit: req.query.limit ? Number(req.query.limit) : 50,
      offset: req.query.offset ? Number(req.query.offset) : 0,
    });
    res.json(result);
  } catch (err) { next(err); }
}
