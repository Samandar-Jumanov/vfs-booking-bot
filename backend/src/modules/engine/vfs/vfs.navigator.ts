import { Page, BrowserContext } from 'rebrowser-playwright';
import { getSelectors } from './vfs.selectors';
import { fillApplicantForm } from './vfs.formFiller';
import { solveCaptcha } from '@modules/captcha/captcha.service';
import { detectBlockFromPage } from '@modules/proxy/blockDetector';
import { clickWithHover, humanDelay, randomScroll } from '../humanBehavior';
import { isSessionExpired } from '../sessionStore';
import { AppError } from '@middleware/errorHandler';
import { SlotInfo } from '@t/index';
import { handleVfsInterstitials } from './vfs.interstitials';
import { attachDiagnostics, dumpBlockDiagnostics } from './vfs.diagnostics';

const SOURCE_CODES: Record<string, { url: string; origin: string }> = {
  uzbekistan: { url: 'uzb', origin: 'UZB' },
  tajikistan: { url: 'tjk', origin: 'TJK' },
  latvia:     { url: 'lva', origin: 'LVA' },
};

interface BookingProfile {
  fullName: string;
  passportNumber: string;
  dob: string;
  passportExpiry: string | Date;
  nationality: string;
  email: string;
  phone: string;
  vfsEmail: string;
  vfsPassword: string;
}

interface NavigatorOptions {
  sessionId: string;
  sourceCountry?: string; // "uzbekistan" | "tajikistan" | "latvia"
  destination: string;    // "brazil" | "portugal"
  visaType: string;
  slot: SlotInfo;
  profile: BookingProfile;
  manualOverrideWindowMs?: number;
}

type NavState =
  | 'START'
  | 'LOGIN'
  | 'SELECT_PARAMS'
  | 'SELECT_SLOT'
  | 'FILL_FORM'
  | 'REVIEW'
  | 'SUBMIT'
  | 'DONE';

export async function runBookingFlow(
  context: BrowserContext,
  opts: NavigatorOptions
): Promise<string> {
  const src = SOURCE_CODES[(opts.sourceCountry || 'uzbekistan').toLowerCase()] ?? SOURCE_CODES.uzbekistan;
  const destination = opts.destination.toLowerCase();
  const routePrefix = `/${src.url}/en/${destination}/`;
  const page = context.pages().find((candidate) => {
    try {
      const current = new URL(candidate.url());
      return current.hostname === 'visa.vfsglobal.com'
        && current.pathname.toLowerCase().startsWith(routePrefix);
    } catch {
      return false;
    }
  });
  if (!page) {
    throw new AppError(
      409,
      `Operator's Chrome tab must already be on ${routePrefix}login or ${routePrefix}dashboard before booking starts.`,
      'OPERATOR_NOT_ON_VFS_ROUTE',
    );
  }
  attachDiagnostics(page);
  const sel = getSelectors();
  let state: NavState = 'START';

  try {
    // ── Navigate to VFS ──────────────────────────────────────────────────────
    state = 'START';
    // Dismiss cookie consent + handle country selector when accessed from a
    // non-source-country IP (VFS detects IP and shows these overlays first)
    await handleVfsInterstitials(
      page,
      opts.sourceCountry ?? 'uzbekistan',
      opts.destination,
    );

    await humanDelay(800, 1_500);
    await checkForBlock(page, opts.sessionId);

    // ── Login (skip if session already active) ───────────────────────────────
    state = 'LOGIN';
    if (isSessionExpired(page.url())) {
      await performLogin(page, opts.profile.vfsEmail, opts.profile.vfsPassword, opts.sessionId);
    }

    await humanDelay(500, 1500);
    await randomScroll(page);

    // ── Navigate to appointment booking ──────────────────────────────────────
    state = 'SELECT_PARAMS';
    await clickWithHover(page, sel.bookAppointmentLink);
    await page.waitForLoadState('domcontentloaded');
    await humanDelay(800, 1500);

    // Select origin country
    if (await page.$(sel.countryOfResidenceDropdown)) {
      await page.selectOption(sel.countryOfResidenceDropdown, src.origin);
      await humanDelay(300, 700);
    }

    // Select destination — map UI key to VFS 3-letter code
    const DEST_CODES: Record<string, string> = {
      portugal: 'PRT', france: 'FRA', germany: 'DEU', spain: 'ESP',
      italy: 'ITA', netherlands: 'NLD', belgium: 'BEL', switzerland: 'CHE',
      sweden: 'SWE', norway: 'NOR', denmark: 'DNK', finland: 'FIN',
      austria: 'AUT', czechrepublic: 'CZE', poland: 'POL',
      tajikistan: 'TJK', latvia: 'LVA',
      brazil: 'BRA', usa: 'USA', canada: 'CAN',
      australia: 'AUS', china: 'CHN', japan: 'JPN', india: 'IND',
      southafrica: 'ZAF',
    };
    const destCode = DEST_CODES[opts.destination.toLowerCase()] ?? opts.destination.toUpperCase();
    if (await page.$(sel.destinationCountryDropdown)) {
      await page.selectOption(sel.destinationCountryDropdown, destCode);
      await humanDelay(300, 700);
    }

    // Select visa type
    if (await page.$(sel.visaCategoryDropdown)) {
      await page.selectOption(sel.visaCategoryDropdown, opts.visaType);
      await humanDelay(300, 700);
    }

    await clickWithHover(page, sel.continueButton);
    await page.waitForLoadState('domcontentloaded');
    await humanDelay(500, 1000);

    // ── Select the target slot ────────────────────────────────────────────────
    state = 'SELECT_SLOT';
    await selectSlot(page, opts.slot);
    await humanDelay(500, 1000);

    // ── Fill applicant form ──────────────────────────────────────────────────
    state = 'FILL_FORM';
    await fillApplicantForm(page, {
      ...opts.profile,
      passportExpiry: opts.profile.passportExpiry.toString(),
    });

    // ── Manual override window ────────────────────────────────────────────────
    state = 'REVIEW';
    if (opts.manualOverrideWindowMs && opts.manualOverrideWindowMs > 0) {
      await humanDelay(0, opts.manualOverrideWindowMs);
    }

    // ── Demo dry-run: stop before final submit, screenshot the review page.
    // CLAUDE.md insurance for live demos when no real slot is available — proves
    // the bot reaches the final review state without consuming a test booking.
    if (process.env.DEMO_DRY_RUN === 'true') {
      const fs = await import('fs');
      fs.mkdirSync('recordings', { recursive: true });
      const dryRunPath = `recordings/dry_run_review_${Date.now()}.png`;
      await page.screenshot({ path: dryRunPath, fullPage: true }).catch(() => {});
      state = 'DONE';
      return `DRY_RUN_OK (review screenshot: ${dryRunPath})`;
    }

    // ── Submit ────────────────────────────────────────────────────────────────
    state = 'SUBMIT';
    await checkForBlock(page, opts.sessionId);
    await solveCaptcha(page, opts.sessionId);

    await clickWithHover(page, sel.submitButton);
    await page.waitForLoadState('domcontentloaded');
    await humanDelay(500, 1000);

    // Confirm if a confirm button appears
    if (await page.$(sel.confirmButton)) {
      await clickWithHover(page, sel.confirmButton);
      await page.waitForLoadState('domcontentloaded');
      await humanDelay(500, 1000);
    }

    // ── Extract confirmation ──────────────────────────────────────────────────
    state = 'DONE';
    const confirmationNo = await extractConfirmationNumber(page);
    return confirmationNo;
  } catch (err) {
    const message = (err as Error).message;
    const diagDir = await dumpBlockDiagnostics(page, `state=${state} :: ${message}`, opts.sessionId);
    const suffix = diagDir ? ` (diagnostics: ${diagDir})` : '';
    throw new AppError(500, `Booking failed at state [${state}]: ${message}${suffix}`, 'BOOKING_FAILED');
  } finally {
    await page.close();
  }
}

async function performLogin(page: Page, email: string, password: string, sessionId: string) {
  const sel = getSelectors();
  await page.waitForSelector(sel.loginEmail, { timeout: 15_000 });

  await clickWithHover(page, sel.loginEmail);
  await humanDelay(200, 500);

  const { typeText } = await import('../humanBehavior');
  await typeText(page, sel.loginEmail, email);
  await typeText(page, sel.loginPassword, password);

  await solveCaptcha(page, sessionId);
  await humanDelay(300, 700);

  await clickWithHover(page, sel.loginSubmit);
  await page.waitForLoadState('domcontentloaded');
  await humanDelay(1000, 2000);
}

async function selectSlot(page: Page, slot: SlotInfo) {
  const sel = getSelectors();

  // ── Try the exact requested date ──────────────────────────────────────────
  let dateClicked = false;
  if (slot.date) {
    // Try explicit data-date attribute first, then the generic selector
    const exactCell = await page.$(`td[data-date="${slot.date}"]:not(.disabled):not(.unavailable)`);
    if (exactCell) {
      await exactCell.click();
      await humanDelay(400, 800);
      dateClicked = true;
    }
  }

  // ── Fallback: first available date on the calendar ────────────────────────
  if (!dateClicked) {
    const availableCells = await page.$$(
      `td[data-date]:not(.disabled):not(.unavailable):not(.past), ${sel.slotDateCell}`
    );
    if (availableCells.length > 0) {
      await availableCells[0].click();
      await humanDelay(400, 800);
    }
  }

  // Wait for time slots to render after date selection
  await page.waitForTimeout(600);

  // ── Try the exact requested time ──────────────────────────────────────────
  const timeButtons = await page.$$(sel.slotTimeButton);
  let timeClicked = false;

  if (slot.time) {
    for (const btn of timeButtons) {
      const text = await btn.textContent();
      const isDisabled = await btn.getAttribute('disabled');
      if (text?.includes(slot.time) && isDisabled === null) {
        await btn.click();
        await humanDelay(300, 700);
        timeClicked = true;
        break;
      }
    }
  }

  // ── Fallback: first non-disabled time slot ────────────────────────────────
  if (!timeClicked) {
    for (const btn of timeButtons) {
      const isDisabled = await btn.getAttribute('disabled');
      const classList = await btn.getAttribute('class') ?? '';
      const isUnavailable = classList.includes('disabled') || classList.includes('unavailable') || classList.includes('taken');
      if (isDisabled === null && !isUnavailable) {
        await btn.click();
        await humanDelay(300, 700);
        timeClicked = true;
        break;
      }
    }
  }

  if (!timeClicked && timeButtons.length === 0) {
    throw new Error('No available time slots found on page — slot may have been taken');
  }
}

async function extractConfirmationNumber(page: Page): Promise<string> {
  const sel = getSelectors();
  try {
    const el = await page.waitForSelector(sel.confirmationNumber, { timeout: 10_000 });
    const text = await el.textContent();
    const match = text?.match(/(?:booking\s+reference|confirmation\s+(?:number|no\.?|#)|appointment\s+(?:id|number)|reference|confirmation|booking)[^\w]*([A-Z0-9-]{6,30})/i);
    return match?.[1] ?? text?.trim() ?? 'UNKNOWN';
  } catch {
    // Try to extract from page text
    const body = await page.evaluate(() => document.body.innerText);
    const match = body.match(/(?:booking\s+reference|confirmation\s+(?:number|no\.?|#)|appointment\s+(?:id|number)|reference|confirmation|booking)[^\w]*([A-Z0-9-]{6,30})/i);
    return match?.[1] ?? 'UNKNOWN';
  }
}

async function checkForBlock(page: Page, _sessionId: string) {
  const signal = await detectBlockFromPage(page);
  if (signal) {
    throw new AppError(503, `Blocked: ${signal.type}`, 'IP_BLOCKED');
  }
}
