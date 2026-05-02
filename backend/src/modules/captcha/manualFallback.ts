import { Page } from 'playwright';
import { getIo } from '@modules/websocket/ws.server';
import { sleep } from '@utils/retry';

const MANUAL_TIMEOUT_MS = 120_000;

/**
 * Screenshots the captcha element, sends it to the frontend via WebSocket,
 * and waits for the operator to submit the solution.
 */
export async function solveManually(page: Page, sessionId: string): Promise<string> {
  const io = getIo();

  // Capture captcha screenshot
  let imageBase64: string | undefined;
  try {
    const captchaEl = await page.$('.g-recaptcha, iframe[src*="recaptcha"], #captcha');
    if (captchaEl) {
      const screenshotBuffer = await captchaEl.screenshot();
      imageBase64 = screenshotBuffer.toString('base64');
    }
  } catch {
    // Element screenshot failed — send full page screenshot instead
    const screenshotBuffer = await page.screenshot({ fullPage: false });
    imageBase64 = screenshotBuffer.toString('base64');
  }

  // Emit to frontend dashboard
  io.emit('CAPTCHA_REQUIRED', { sessionId, image: imageBase64 });

  // Wait for solution from frontend
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      io.off(`CAPTCHA_SOLVED:${sessionId}`, handler);
      reject(new Error('Manual captcha timeout — operator did not respond within 120s'));
    }, MANUAL_TIMEOUT_MS);

    function handler(token: string) {
      clearTimeout(timer);
      resolve(token);
    }

    io.once(`CAPTCHA_SOLVED:${sessionId}`, handler);
  });
}
