import { Router } from 'express';
import { requireAuth } from '@middleware/auth.middleware';
import { triggerBooking, cancelBookingHandler, bookingHistory, bookingSummary } from './booking.controller';

export const bookingRouter = Router();

bookingRouter.use(requireAuth);
bookingRouter.get('/summary', bookingSummary);
bookingRouter.get('/history', bookingHistory);
bookingRouter.post('/trigger', triggerBooking);
bookingRouter.delete('/:jobId', cancelBookingHandler);
