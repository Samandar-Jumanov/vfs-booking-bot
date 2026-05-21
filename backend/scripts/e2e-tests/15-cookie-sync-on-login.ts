import path from 'path';
import { assert, liveOnly, runE2e, skip, sleep } from './common';

runE2e('15. Cookie sync after first VFS login', async () => {
  liveOnly('E2E_LIVE_VFS', 'cookie sync on login requires real VFS access and a real ACTIVE account');
  if (process.env.E2E_ALLOW_TEST_CHROME !== '1') {
    skip('E2E_ALLOW_TEST_CHROME=1 is required before this script launches its own Playwright Chrome; operator requested no Chrome relaunch by default');
  }

  const { chromium } = await import('playwright');
  const { prisma } = await import('../../src/config/database');
  const { decrypt } = await import('../../src/utils/crypto');

  const account = await prisma.vfsAccount.findFirst({
    where: { status: 'ACTIVE' },
    orderBy: { createdAt: 'desc' },
    select: { id: true, email: true, encryptedPassword: true },
  });
  assert(Boolean(account), 'no ACTIVE VfsAccount available for login cookie sync test');

  const extensionPath = path.resolve(__dirname, '../../../extension/dist');
  const userDataDir = path.resolve(__dirname, '../../.browser-profiles/e2e-cookie-sync');
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--ignore-certificate-errors',
      '--test-type',
    ],
  });

  try {
    const before = new Date();
    const page = await context.newPage();
    await page.goto(`https://visa.vfsglobal.com/uzb/en/lva/login?email=${encodeURIComponent(account!.email)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    await page.locator('input[type="email"], input[formcontrolname*="email" i], input[name*="email" i]').first().fill(account!.email, { timeout: 30_000 });
    await page.locator('input[type="password"], input[formcontrolname*="password" i], input[name*="password" i]').first().fill(decrypt(account!.encryptedPassword), { timeout: 30_000 });
    await page.locator('button[type="submit"], button:has-text("Sign In"), button:has-text("Login")').first().click({ timeout: 30_000 });
    await sleep(5_000);

    const refreshed = await prisma.vfsAccount.findUniqueOrThrow({ where: { id: account!.id } });
    const cookieText = JSON.stringify(refreshed.cookieStore ?? '');
    assert(/datadome/i.test(cookieText), 'cookieStore does not contain datadome after login');
    assert(Boolean(refreshed.lastWarmedAt), 'lastWarmedAt was not set after login');
    assert(refreshed.lastWarmedAt!.getTime() >= before.getTime() - 1_000, 'lastWarmedAt is not within the login test window');
    assert(Date.now() - refreshed.lastWarmedAt!.getTime() <= 60_000, 'lastWarmedAt is older than 60 seconds');
  } finally {
    await context.close();
  }
});
