import 'dotenv/config';
import 'tsconfig-paths/register';
import { fetchViaScraperApi } from '../src/modules/proxy/scraperapi.provider';

async function main(): Promise<void> {
  if (!process.env.SCRAPER_API) {
    throw new Error('SCRAPER_API is required');
  }

  const cookieHeader = process.env.SCRAPERAPI_TEST_COOKIES ?? process.env.VFS_COOKIES ?? '';
  const pageUrl = 'https://visa.vfsglobal.com/uzb/en/lva/schedule-appointment';
  const slotUrl = 'https://lift-api.vfsglobal.com/appointment/CheckIsSlotAvailable';
  const commonHeaders = {
    Origin: 'https://visa.vfsglobal.com',
    Referer: pageUrl,
  };

  const getResult = await fetchViaScraperApi({
    url: pageUrl,
    method: 'GET',
    cookies: cookieHeader,
    headers: commonHeaders,
    renderJs: true,
  });
  console.log(`GET ${pageUrl} status=${getResult.status} bodyLength=${getResult.body.length}`);

  const postResult = await fetchViaScraperApi({
    url: slotUrl,
    method: 'POST',
    cookies: cookieHeader,
    headers: {
      ...commonHeaders,
      'Content-Type': 'application/json;charset=UTF-8',
      Accept: 'application/json, text/plain, */*',
    },
    body: JSON.stringify({
      countryCode: 'uzb',
      missionCode: 'lva',
      vacCode: 'TAS',
      visaCategoryCode: process.env.SCRAPERAPI_TEST_VISA_CATEGORY ?? 'SCH',
      roleName: 'Individual',
      loginUser: process.env.VFS_EMAIL ?? '',
      payCode: '',
    }),
  });
  console.log(`POST ${slotUrl} status=${postResult.status} bodyLength=${postResult.body.length}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
