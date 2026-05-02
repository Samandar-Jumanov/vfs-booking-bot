import { Queue } from 'bullmq';
import { env } from '@config/env';
import { prisma } from '@config/database';
import { BookingJobPayload } from '@t/index';
import { BookingStatus, Priority } from '@prisma/client';
import { AppError } from '@middleware/errorHandler';

const QUEUE_NAME = 'booking-queue';
let queue: Queue | null = null;

function getQueue(): Queue {
  if (!queue) {
    queue = new Queue(QUEUE_NAME, {
      connection: { url: env.REDIS_URL },
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 200 },
      },
    });
  }
  return queue;
}

export async function enqueueBooking(payload: BookingJobPayload): Promise<string> {
  // Determine priority: HIGH profile = lower number = higher BullMQ priority
  const profile = await prisma.profile.findUnique({
    where: { id: payload.profileId },
    select: { priority: true },
  });
  const bullPriority = profile?.priority === Priority.HIGH ? 1 : 2;

  const job = await getQueue().add('book', payload, { priority: bullPriority });

  // Create DB booking record
  await prisma.booking.create({
    data: {
      profileId: payload.profileId,
      destination: payload.destination,
      visaType: payload.visaType,
      slotDate: payload.slot.date ? new Date(payload.slot.date) : null,
      slotTime: payload.slot.time,
      status: BookingStatus.QUEUED,
      jobId: job.id ?? null,
    },
  });

  return job.id ?? '';
}

export async function cancelBooking(jobId: string): Promise<void> {
  const job = await getQueue().getJob(jobId);
  if (!job) throw new AppError(404, 'Job not found', 'NOT_FOUND');
  await job.remove();

  await prisma.booking.updateMany({
    where: { jobId },
    data: { status: BookingStatus.CANCELLED },
  });
}

export async function getBookingHistory(opts: { profileId?: string; limit?: number; offset?: number }) {
  const where = {
    ...(opts.profileId && { profileId: opts.profileId }),
  };

  const [total, items] = await Promise.all([
    prisma.booking.count({ where }),
    prisma.booking.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: opts.limit ?? 50,
      skip: opts.offset ?? 0,
      include: { profile: { select: { fullName: true } } },
    }),
  ]);

  return { total, items };
}
