import 'tsconfig-paths/register';
import * as dotenv from 'dotenv';
dotenv.config();
import { enqueueBooking } from '../src/modules/booking/booking.service';

(async () => {
  const profileId = process.argv[2] || 'cmp86n46100007hu4mxzbzdai';
  const destination = process.argv[3] || 'lva';
  const visaType = process.argv[4] || 'LNGWORK';
  const jobId = await enqueueBooking({
    profileId,
    destination,
    visaType,
    slot: { date: null, time: null, raw: 'test-trigger' },
  } as any);
  console.log(`Enqueued booking job: ${jobId}`);
  process.exit(0);
})().catch(e => { console.error('FAIL', e?.message || e); process.exit(1); });
