import { Page } from 'playwright';
import { randomInt } from '@utils/crypto';
import { sleep } from '@utils/retry';

export { sleep };

/** Moves mouse along a Bezier curve path to simulate human movement */
export async function moveMouse(page: Page, x: number, y: number): Promise<void> {
  const startX = Math.floor(Math.random() * 800);
  const startY = Math.floor(Math.random() * 600);

  const steps = randomInt(15, 25);
  const cp1x = startX + (x - startX) * 0.3 + randomInt(-50, 50);
  const cp1y = startY + (y - startY) * 0.3 + randomInt(-50, 50);
  const cp2x = startX + (x - startX) * 0.7 + randomInt(-50, 50);
  const cp2y = startY + (y - startY) * 0.7 + randomInt(-50, 50);

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const mt = 1 - t;
    const px = mt * mt * mt * startX + 3 * mt * mt * t * cp1x + 3 * mt * t * t * cp2x + t * t * t * x;
    const py = mt * mt * mt * startY + 3 * mt * mt * t * cp1y + 3 * mt * t * t * cp2y + t * t * t * y;
    await page.mouse.move(px, py);
    await sleep(randomInt(8, 20));
  }
}

/** Types text character-by-character with human-like delays */
export async function typeText(page: Page, selector: string, text: string): Promise<void> {
  await page.click(selector);
  await sleep(randomInt(100, 300));

  for (let i = 0; i < text.length; i++) {
    await page.keyboard.type(text[i]);
    const delay = randomInt(80, 200);
    // Occasional longer pause after every 3-5 characters
    if (i > 0 && i % randomInt(3, 6) === 0) {
      await sleep(randomInt(300, 700));
    } else {
      await sleep(delay);
    }
  }
}

/** Clicks an element after moving the mouse to it naturally */
export async function clickWithHover(page: Page, selector: string): Promise<void> {
  const element = await page.waitForSelector(selector, { timeout: 10_000 });
  const box = await element.boundingBox();

  if (box) {
    const targetX = box.x + box.width / 2 + randomInt(-5, 5);
    const targetY = box.y + box.height / 2 + randomInt(-3, 3);
    await moveMouse(page, targetX, targetY);
    await sleep(randomInt(200, 500)); // hover before clicking
  }

  await element.click();
  await sleep(randomInt(100, 300));
}

/** Scrolls the page slightly to simulate reading */
export async function randomScroll(page: Page): Promise<void> {
  const scrollAmount = randomInt(200, 400);
  await page.mouse.wheel(0, scrollAmount);
  await sleep(randomInt(300, 800));
  await page.mouse.wheel(0, -randomInt(50, 150));
  await sleep(randomInt(200, 500));
}

/** Selects an option from a native <select> element */
export async function selectOption(page: Page, selector: string, value: string): Promise<void> {
  await sleep(randomInt(200, 500));
  await page.selectOption(selector, { value });
  await sleep(randomInt(300, 600));
}

/** Waits a random human-like delay */
export async function humanDelay(min = 500, max = 1500): Promise<void> {
  await sleep(randomInt(min, max));
}
