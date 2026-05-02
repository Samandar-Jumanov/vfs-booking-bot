import { Router } from 'express';
import { requireAuth } from '@middleware/auth.middleware';
import { triggerBooking, cancelBookingHandler, bookingHistory } from './booking.controller';

export const bookingRouter = Router();

bookingRouter.use(requireAuth);
bookingRouter.get('/history', bookingHistory);
bookingRouter.post('/trigger', triggerBooking);
bookingRouter.delete('/:jobId', cancelBookingHandler);
