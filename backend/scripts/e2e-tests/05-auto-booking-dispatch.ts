import { randomUUID } from 'crypto';
import { runE2e, liveOnly, assert, skip } from './common';

runE2e('5. Auto-booking dispatch when slot detected', async () => {
  liveOnly('E2E_LIVE_EXTENSION', 'booking dispatch needs the operator Chrome extension connected');
  liveOnly('E2E_LIVE_VFS', 'booking dispatch submits against the real VFS booking path');

  const slotDate = process.env.E2E_VFS_SLOT_DATE;
  const slotTime = process.env.E2E_VFS_SLOT_TIME;
  if (!slotDate || !slotTime) {
    skip('blocked-on-real-slot: set E2E_VFS_SLOT_DATE and E2E_VFS_SLOT_TIME for a known bookable VFS slot');
  }

  const { prisma } = await import('../../src/config/database');
  const staleCutoff = new Date(Date.now() - 12 * 60 * 60 * 1000);
  const destination = process.env.E2E_VFS_DESTINATION ?? 'lva';
  const visaType = process.env.E2E_VFS_VISA_CATEGORY_CODE ?? 'SCH';

  const accounts = await prisma.vfsAccount.findMany({
    where: {
      status: 'ACTIVE',
      lastWarmedAt: { gte: staleCutoff },
    },
    orderBy: [{ lastUsedAt: 'asc' }, { lastWarmedAt: 'desc' }],
    take: 20,
  });
  const account = accounts.find((candidate) => /datadome/i.test(JSON.stringify(candidate.cookieStore)));
  assert(Boolean(account), 'no ACTIVE cookieFresh account is available; run 15-cookie-sync-on-login first');

  const profile = await prisma.profile.findFirst({
    where: { isActive: true },
    orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
  });
  assert(Boolean(profile), 'no active Profile is available for live booking dispatch');

  const previousExtensionBooking = process.env.EXTENSION_BOOKING;
  process.env.EXTENSION_BOOKING = '1';

  const jobId = `e2e-book-dispatch-${randomUUID()}`;
  await prisma.booking.create({
    data: {
      profileId: profile!.id,
      destination,
      visaType,
      slotDate: new Date(slotDate),
      slotTime,
      status: 'QUEUED',
      jobId,
    },
  });

  try {
    const { processBookingJob } = await import('../../src/modules/booking/booking.worker');
    const result = await processBookingJob({
      id: jobId,
      attemptsMade: 0,
      data: {
        profileId: profile!.id,
        destination,
        visaType,
        slot: { date: slotDate, time: slotTime, destination, visaType },
      },
    } as never);

    const booking = await prisma.booking.findFirst({
      where: { jobId },
      select: { status: true, confirmationNo: true, errorMessage: true },
    });

    assert(booking?.status === 'SUCCESS', `booking did not reach SUCCESS; status=${booking?.status ?? 'missing'} reason=${booking?.errorMessage ?? (result as { error?: string }).error ?? 'unknown'}`);
    assert(Boolean(booking.confirmationNo), 'booking SUCCESS did not persist a confirmation number');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/SLOT_NO_LONGER_AVAILABLE|NO_AVAILABLE|no slots|slot/i.test(message)) {
      throw new Error(`blocked-on-real-slot: live dispatch reached VFS but no real bookable slot was available (${message})`);
    }
    throw err;
  } finally {
    if (previousExtensionBooking === undefined) {
      delete process.env.EXTENSION_BOOKING;
    } else {
      process.env.EXTENSION_BOOKING = previousExtensionBooking;
    }
  }
});
