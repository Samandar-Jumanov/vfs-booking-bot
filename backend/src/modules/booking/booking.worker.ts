import { Worker, Job } from 'bullmq';
import { env } from '@config/env';
import { runBooking } from '@modules/engine/engine.service';
import { bookViaExtension } from './extension-dispatch.service';
import { emitToAll } from '@modules/websocket/ws.server';
import { prisma } from '@config/database';
import { BookingStatus } from '@prisma/client';
import { BookingJobPayload } from '@t/index';
import { logEvent } from '@modules/logs/logger';
import { EventType } from '@prisma/client';
import { dispatchNotification } from '@modules/notifications/notification.service';
import { getRedis } from '@config/redis';

const QUEUE_NAME = 'booking-queue';
let worker: Worker | null = null;

export async function processBookingJob(job: Job<BookingJobPayload>) {
  const payload = job.data;
  const lockKey = `booking-lock:${payload.destination}`;
  const lock = await getRedis().set(lockKey, '1', 'EX', 300, 'NX');

  if (lock !== 'OK') {
    logEvent('warn', EventType.BOOKING_ATTEMPT, `Booking already running for ${payload.destination}`, {
      profileId: payload.profileId,
      destination: payload.destination,
    });
    emitToAll('BOOKING_FAILED', {
      jobId: job.id,
      profileId: payload.profileId,
      destination: payload.destination,
      reason: 'BOOKING_ALREADY_RUNNING',
    });
    return { success: false, error: 'BOOKING_ALREADY_RUNNING', errorClass: 'permanent' };
  }

  try {
    await prisma.booking.updateMany({
      where: { jobId: job.id },
      data: { status: BookingStatus.RUNNING, attempt: job.attemptsMade + 1 },
    });

    emitToAll('BOOKING_PROGRESS', { jobId: job.id, profileId: payload.profileId, status: 'RUNNING' });

    // EXTENSION_BOOKING=true → dispatch to operator's Chrome extension (Datadome-bypass via real customer session).
    // Otherwise fall through to the CDP-driven engine.runBooking() path.
    const useExtension = process.env.EXTENSION_BOOKING === 'true' || process.env.EXTENSION_BOOKING === '1';
    const result = useExtension
      ? await runViaExtensionAndAdapt(payload, String(job.id ?? payload.profileId))
      : await runBooking(payload, String(job.id ?? payload.profileId));

    if (result.success && result.dryRun) {
      await prisma.booking.updateMany({
        where: { jobId: job.id },
        data: {
          status: BookingStatus.SUCCESS,
          errorMessage: result.screenshotPath ? `DRY_RUN_OK screenshot=${result.screenshotPath}` : 'DRY_RUN_OK',
          completedAt: null,
        },
      });

      emitToAll('BOOKING_DRY_RUN_OK', {
        jobId: job.id,
        profileId: payload.profileId,
        destination: payload.destination,
        slotDateTime: payload.slot.date,
        screenshotPath: result.screenshotPath,
      });

      return result;
    }

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
        screenshotPath: result.screenshotPath,
      });

      await dispatchNotification({
        event: 'BOOKING_SUCCESS',
        profileId: payload.profileId,
        destination: payload.destination,
        confirmationNo: result.confirmationNo,
        slotDate: payload.slot.date,
      });
    } else {
      const reason = result.error ?? 'UNKNOWN';
      await prisma.booking.updateMany({
        where: { jobId: job.id },
        data: {
          status: BookingStatus.FAILED,
          errorMessage: reason,
          completedAt: null,
        },
      });

      const eventName = reason === 'CAPTCHA_MANUAL_NEEDED' ? 'CAPTCHA_MANUAL_NEEDED' : 'BOOKING_FAILED';
      emitToAll(eventName, {
        jobId: job.id,
        profileId: payload.profileId,
        destination: payload.destination,
        reason,
        errorClass: result.errorClass,
      });

      await dispatchNotification({
        event: eventName === 'CAPTCHA_MANUAL_NEEDED' ? 'CAPTCHA_MANUAL_NEEDED' : 'BOOKING_FAILED',
        profileId: payload.profileId,
        destination: payload.destination,
        reason,
        errorMessage: reason,
      });
    }

    return result;
  } finally {
    await getRedis().del(lockKey);
  }
}

export function startBookingWorker(): Worker {
  worker = new Worker<BookingJobPayload>(
    QUEUE_NAME,
    processBookingJob,
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

/**
 * Adapts bookViaExtension's ExtensionBookingResult to the BookingResult shape
 * that processBookingJob() expects (matches what engine.runBooking returns).
 */
async function runViaExtensionAndAdapt(payload: BookingJobPayload, bookingId: string) {
  const r = await bookViaExtension(payload);
  if (r.success) {
    return {
      success: true,
      confirmationNo: r.confirmationNumber ?? 'EXT-' + bookingId.slice(-8),
      dryRun: false,
      screenshotPath: r.screenshotPath,
      attempts: 1,
      durationMs: 0,
    };
  }
  return {
    success: false,
    error: r.reason ?? 'EXTENSION_BOOKING_FAILED',
    errorClass: (/STALE|NOT_CONNECTED|NO_ACTIVE/i.test(r.reason ?? '') ? 'permanent' : 'transient') as 'permanent' | 'transient',
  };
}
