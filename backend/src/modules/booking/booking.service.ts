import { Queue } from 'bullmq';
import { env } from '@config/env';
import { prisma } from '@config/database';
import { BookingJobPayload } from '@t/index';
import { BookingStatus, Prisma, Priority } from '@prisma/client';
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

export interface BookingHistoryOpts {
  profileId?: string;
  status?: BookingStatus;
  destination?: string;
  from?: string;
  to?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export async function getBookingHistory(opts: BookingHistoryOpts) {
  const fromDate = opts.from ? boundaryDate(opts.from, 'start') : undefined;
  const toDate = opts.to ? boundaryDate(opts.to, 'end') : undefined;
  const where: Prisma.BookingWhereInput = {
    ...(opts.profileId && { profileId: opts.profileId }),
    ...(opts.status && { status: opts.status }),
    ...(opts.destination && { destination: { equals: opts.destination, mode: 'insensitive' } }),
    ...((opts.from || opts.to) && {
      createdAt: {
        ...(fromDate && { gte: fromDate }),
        ...(toDate && { lte: toDate }),
      },
    }),
    ...(opts.search && {
      OR: [
        { confirmationNo: { contains: opts.search, mode: 'insensitive' } },
        { errorMessage: { contains: opts.search, mode: 'insensitive' } },
        { profile: { fullName: { contains: opts.search, mode: 'insensitive' } } },
      ],
    }),
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

function boundaryDate(value: string, boundary: 'start' | 'end') {
  const date = new Date(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    date.setHours(boundary === 'start' ? 0 : 23, boundary === 'start' ? 0 : 59, boundary === 'start' ? 0 : 59, boundary === 'start' ? 0 : 999);
  }
  return date;
}

export async function getBookingSummary() {
  const now = new Date();
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [
    activeProfiles,
    totalAccounts,
    freshAccounts,
    queued,
    running,
    successToday,
    failedToday,
    bookings24h,
    latest,
  ] = await Promise.all([
    prisma.profile.count({ where: { isActive: true } }),
    prisma.vfsAccount.count(),
    prisma.vfsAccount.count({
      where: {
        status: 'ACTIVE',
        lastWarmedAt: { gte: new Date(Date.now() - 12 * 60 * 60 * 1000) },
        cookieStore: { not: Prisma.JsonNull },
      },
    }),
    prisma.booking.count({ where: { status: 'QUEUED' } }),
    prisma.booking.count({ where: { status: 'RUNNING' } }),
    prisma.booking.count({ where: { status: 'SUCCESS', completedAt: { gte: dayStart } } }),
    prisma.booking.count({ where: { status: 'FAILED', completedAt: { gte: dayStart } } }),
    prisma.booking.count({ where: { createdAt: { gte: since24h } } }),
    prisma.booking.findMany({
      orderBy: { createdAt: 'desc' },
      take: 6,
      include: { profile: { select: { fullName: true } } },
    }),
  ]);

  return {
    profiles: { active: activeProfiles },
    accounts: { total: totalAccounts, fresh: freshAccounts },
    bookings: { queued, running, successToday, failedToday, last24h: bookings24h },
    latest,
    generatedAt: now.toISOString(),
  };
}
