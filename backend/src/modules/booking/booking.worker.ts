import { Worker, Job } from 'bullmq';
import { env } from '@config/env';
import { runBooking } from '@modules/engine/engine.service';
import { emitToAll } from '@modules/websocket/ws.server';
import { prisma } from '@config/database';
import { BookingStatus } from '@prisma/client';
import { BookingJobPayload } from '@t/index';
import { logEvent } from '@modules/logs/logger';
import { EventType } from '@prisma/client';
import { dispatchNotification } from '@modules/notifications/notification.service';

const QUEUE_NAME = 'booking-queue';
let worker: Worker | null = null;

export function startBookingWorker(): Worker {
  worker = new Worker<BookingJobPayload>(
    QUEUE_NAME,
    async (job: Job<BookingJobPayload>) => {
      const payload = job.data;

      // Update booking status to RUNNING
      await prisma.booking.updateMany({
        where: { jobId: job.id },
        data: { status: BookingStatus.RUNNING, attempt: job.attemptsMade + 1 },
      });

      emitToAll('BOOKING_PROGRESS', { jobId: job.id, profileId: payload.profileId, status: 'RUNNING' });

      const result = await runBooking(payload);

      if (result.success) {
        await prisma.booking.updateMany({
          where: { jobId: job.id },
          data: {
            status: BookingStatus.SUCCESS,
            confirmationNo: result.confirmationNo,
            completedAt: new Date(),
          },
        });

        emitToAll('BOOKING_SUCCESS', {
          jobId: job.id,
          profileId: payload.profileId,
          destination: payload.destination,
          confirmationNo: result.confirmationNo,
        });

        await dispatchNotification({
          event: 'BOOKING_SUCCESS',
          profileId: payload.profileId,
          destination: payload.destination,
          confirmationNo: result.confirmationNo,
          slotDate: payload.slot.date,
        });
      } else {
        await prisma.booking.updateMany({
          where: { jobId: job.id },
          data: {
            status: BookingStatus.FAILED,
            errorMessage: result.error,
            completedAt: new Date(),
          },
        });

        emitToAll('BOOKING_FAILED', {
          jobId: job.id,
          profileId: payload.profileId,
          error: result.error,
        });

        await dispatchNotification({
          event: 'BOOKING_FAILED',
          profileId: payload.profileId,
          destination: payload.destination,
          errorMessage: result.error,
        });
      }

      return result;
    },
    {
      connection: { url: env.REDIS_URL },
      concurrency: env.BOOKING_CONCURRENCY,
    }
  );

  worker.on('failed', (job, err) => {
    logEvent('error', EventType.BOOKING_FAILED, `Job ${job?.id} permanently failed: ${err.message}`);
  });

  return worker;
}

export async function stopBookingWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
}
