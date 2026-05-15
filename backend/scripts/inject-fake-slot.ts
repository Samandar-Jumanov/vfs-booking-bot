import 'tsconfig-paths/register';
import { prisma } from '@config/database';
import { enqueueBooking } from '@modules/booking/booking.service';

function argValue(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

async function main(): Promise<void> {
  const destination = argValue('destination') ?? 'lva';
  const date = argValue('date');
  const time = argValue('time') ?? '09:00';
  const visaType = argValue('visaType') ?? argValue('visa-type') ?? 'SCH';

  if (!date) {
    throw new Error('Missing required --date YYYY-MM-DD argument');
  }

  const profile = await prisma.profile.findFirst({
    where: { isActive: true },
    orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
    select: { id: true, fullName: true },
  });

  if (!profile) {
    throw new Error('No active profile found for fake slot injection');
  }

  const jobId = await enqueueBooking({
    profileId: profile.id,
    sourceCountry: 'uzbekistan',
    destination,
    visaType,
    slot: {
      date,
      time,
      destination,
      visaType,
      raw: { injected: true },
    },
  });

  console.log(JSON.stringify({
    ok: true,
    jobId,
    profileId: profile.id,
    profileName: profile.fullName,
    destination,
    date,
    time,
    visaType,
  }, null, 2));
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
  });
