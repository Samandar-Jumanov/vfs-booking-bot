import { prisma } from '@config/database';
import { AppError } from '@middleware/errorHandler';
import { BookingStatus, EventType } from '@prisma/client';

export type PublicCustomerStatus = 'PENDING_PAYMENT' | 'QUEUED' | 'SLOT_DETECTED' | 'CONFIRMED' | 'FAILED';

function toPublicStatus(input: {
  bookingStatus?: BookingStatus;
  hasSlot: boolean;
  hasSlotDetectedLog: boolean;
}): PublicCustomerStatus {
  if (input.bookingStatus === BookingStatus.SUCCESS) return 'CONFIRMED';
  if (input.bookingStatus === BookingStatus.FAILED || input.bookingStatus === BookingStatus.CANCELLED) return 'FAILED';
  if (input.hasSlot || input.hasSlotDetectedLog) return 'SLOT_DETECTED';
  return 'QUEUED';
}

export async function getPublicCustomerStatus(token: string) {
  const profile = await prisma.profile.findUnique({
    where: { statusToken: token },
    select: {
      id: true,
      isActive: true,
      createdAt: true,
      bookings: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: {
          id: true,
          destination: true,
          visaType: true,
          slotDate: true,
          slotTime: true,
          status: true,
          createdAt: true,
          completedAt: true,
        },
      },
    },
  });

  if (!profile) {
    throw new AppError(404, 'Status page not found', 'NOT_FOUND');
  }

  if (!profile.isActive) {
    const pendingOnboarding = await prisma.log.findFirst({
      where: {
        profileId: profile.id,
        message: 'Customer onboarding pending payment',
      },
      select: {
        destination: true,
        timestamp: true,
        metadata: true,
      },
      orderBy: { timestamp: 'desc' },
    });

    if (!pendingOnboarding) {
      throw new AppError(404, 'Status page not found', 'NOT_FOUND');
    }

    const metadata = pendingOnboarding.metadata as { preferredStartDate?: string; preferredEndDate?: string } | null;
    const preferredRange = [metadata?.preferredStartDate, metadata?.preferredEndDate].filter(Boolean).join(' to ');

    return {
      status: 'PENDING_PAYMENT' as const,
      destination: pendingOnboarding.destination,
      visaType: preferredRange || null,
      slotDate: null,
      slotTime: null,
      lastUpdatedAt: pendingOnboarding.timestamp.toISOString(),
    };
  }

  const latestBooking = profile.bookings[0];
  const hasSlotDetectedLog = await prisma.log.findFirst({
    where: {
      profileId: profile.id,
      eventType: EventType.SLOT_DETECTED,
      ...(latestBooking ? { timestamp: { gte: latestBooking.createdAt } } : {}),
    },
    select: { id: true },
    orderBy: { timestamp: 'desc' },
  });

  const status = toPublicStatus({
    bookingStatus: latestBooking?.status,
    hasSlot: Boolean(latestBooking?.slotDate || latestBooking?.slotTime),
    hasSlotDetectedLog: Boolean(hasSlotDetectedLog),
  });

  return {
    status,
    destination: latestBooking?.destination ?? null,
    visaType: latestBooking?.visaType ?? null,
    slotDate: latestBooking?.slotDate?.toISOString() ?? null,
    slotTime: latestBooking?.slotTime ?? null,
    lastUpdatedAt: (latestBooking?.completedAt ?? latestBooking?.createdAt ?? profile.createdAt).toISOString(),
  };
}
