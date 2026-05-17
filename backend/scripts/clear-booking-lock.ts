import 'tsconfig-paths/register';
import * as path from 'path';
import * as dotenv from 'dotenv';
dotenv.config({ path: path.resolve('../.env') });
dotenv.config({ path: path.resolve('.env'), override: true });
import { getRedis } from '../src/config/redis';

(async () => {
  const r = getRedis();
  const dest = process.argv[2] || 'lva';
  await r.del(`booking-lock:${dest}`);
  console.log(`cleared booking-lock:${dest}`);
  process.exit(0);
})();
