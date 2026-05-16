import { Page } from 'rebrowser-playwright';
import { logEvent } from '@modules/logs/logger';
import { EventType } from '@prisma/client';

const WATCH_INTERVAL_MS = 30_000;
const watchedPages = new WeakSet<Page>();

async function clickStayConnected(page: Page, profileId: string): Promise<void> {
  const candidates = [
    'button:has-text("Stay Connected")',
    'button:has-text("Stay connected")',
    'button:has-text("Continue")',
    '[role="button"]:has-text("Stay Connected")',
  ];

  for (const selector of candidates) {
    const button = page.locator(selector).first();
    if ((await button.count().catch(() => 0)) === 0) continue;
    if (!(await button.isVisible().catch(() => false))) continue;

    await button.click({ timeout: 5_000 }).catch((err: Error) => {
      logEvent('warn', EventType.MONITOR_STARTED, `[Keepalive] Failed to click ${selector} for ${profileId}: ${err.message}`);
    });
    logEvent('info', EventType.MONITOR_STARTED, `[Keepalive] Dismissed timeout modal for ${profileId}`);
    return;
  }
}

export function startKeepAliveWatcher(page: Page, profileId: string): void {
  if (watchedPages.has(page)) return;
  watchedPages.add(page);

  const tick = async (): Promise<void> => {
    if (page.isClosed()) return;
    await clickStayConnected(page, profileId).catch((err: Error) => {
      logEvent('warn', EventType.MONITOR_STARTED, `[Keepalive] Watcher error for ${profileId}: ${err.message}`);
    });
    if (!page.isClosed()) setTimeout(tick, WATCH_INTERVAL_MS);
  };

  setTimeout(tick, WATCH_INTERVAL_MS);
}
