import fs from 'fs/promises';
import path from 'path';
import { Page } from 'rebrowser-playwright';
import { env } from '@config/env';
import { getProfileForBooking } from '@modules/profiles/profiles.service';
import { getSetting } from '@modules/settings/settings.service';
import { findPageForProfile, getReusableContextFor } from '@modules/monitor/playwright.fetch';
import { fillApplicantForm } from './vfs/vfs.formFiller';
import { getSelectors, applyOverrides, VfsSelectors } from './vfs/vfs.selectors';
import { clickWithHover, humanDelay } from './humanBehavior';
import { logEvent } from '@modules/logs/logger';
import { EventType } from '@prisma/client';
import { BookingJobPayload } from '@t/index';
import { sleep } from '@utils/retry';

export interface BookingResult {
  success: boolean;
  confirmationNo?: string;
  screenshotPath?: string;
  dryRun?: boolean;
  error?: string;
  errorClass?: 'transient' | 'permanent';
}

class ClassifiedBookingError extends Error {
  constructor(
    message: string,
    readonly reason: string,
    readonly errorClass: 'transient' | 'permanent',
  ) {
    super(message);
  }
}

function destinationCode(destination: string): string {
  const map: Record<string, string> = {
    latvia: 'lva',
    tajikistan: 'tjk',
    portugal: 'prt',
    brazil: 'bra',
    lva: 'lva',
    tjk: 'tjk',
    prt: 'prt',
    bra: 'bra',
  };
  return map[destination.toLowerCase()] ?? destination.toLowerCase().slice(0, 3);
}

function sourceCode(sourceCountry?: string): string {
  const map: Record<string, string> = {
    uzbekistan: 'uzb',
    tajikistan: 'tjk',
    latvia: 'lva',
    uzb: 'uzb',
    tjk: 'tjk',
    lva: 'lva',
  };
  return map[(sourceCountry ?? 'uzbekistan').toLowerCase()] ?? 'uzb';
}

function parseSlotDateTime(job: BookingJobPayload): Date | undefined {
  if (!job.slot.date) return undefined;
  const raw = job.slot.time ? `${job.slot.date} ${job.slot.time}` : job.slot.date;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? new Date(job.slot.date) : parsed;
}

function isTimeoutError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /timeout|timed out/i.test(message);
}

async function hasVisibleText(page: Page, patterns: RegExp[]): Promise<string | undefined> {
  const text = await page.locator('body').innerText({ timeout: 5_000 }).catch(() => '');
  return patterns.find((pattern) => pattern.test(text))?.source;
}

async function assertStillAuthenticated(page: Page): Promise<void> {
  const url = page.url().toLowerCase();
  const bodyMatch = await hasVisibleText(page, [/session expired/i, /sign in/i, /turnstile/i, /captcha/i]);
  if (bodyMatch && /turnstile|captcha/i.test(bodyMatch)) {
    throw new ClassifiedBookingError('Captcha appeared during booking flow', 'CAPTCHA_MANUAL_NEEDED', 'permanent');
  }
  if (url.includes('/login') || (bodyMatch && /session expired|sign in/i.test(bodyMatch))) {
    throw new ClassifiedBookingError('VFS session expired during booking flow', 'SESSION_EXPIRED', 'permanent');
  }
}

async function assertNoPermanentPageError(page: Page): Promise<void> {
  const match = await hasVisibleText(page, [
    /slot no longer available/i,
    /appointment is no longer available/i,
    /already booked/i,
    /mandatory field/i,
    /required field/i,
    /invalid/i,
  ]);
  if (!match) return;
  const reason = /slot|appointment|already/i.test(match) ? 'SLOT_NO_LONGER_AVAILABLE' : 'FORM_VALIDATION_ERROR';
  throw new ClassifiedBookingError(`Permanent booking error detected: ${reason}`, reason, 'permanent');
}

async function waitForResponseContaining(page: Page, fragments: string[], timeout = 30_000) {
  try {
    const response = await page.waitForResponse(
      (res) => fragments.some((fragment) => res.url().toLowerCase().includes(fragment.toLowerCase())),
      { timeout },
    );
    if (response.status() >= 500) {
      throw new ClassifiedBookingError(`VFS returned HTTP ${response.status()}`, 'HTTP_5XX', 'transient');
    }
    return response;
  } catch (err) {
    if (err instanceof ClassifiedBookingError) throw err;
    if (isTimeoutError(err)) {
      throw new ClassifiedBookingError('Timed out waiting for VFS network response', 'NETWORK_TIMEOUT', 'transient');
    }
    throw err;
  }
}

async function clickAndMaybeWaitForResponse(page: Page, selector: string, fragments: string[]): Promise<void> {
  const responseWait = waitForResponseContaining(page, fragments).catch((err) => {
    if (err instanceof ClassifiedBookingError && err.reason === 'NETWORK_TIMEOUT') return undefined;
    throw err;
  });
  await clickWithHover(page, selector);
  await responseWait;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function clickAndSettle(page: Page, locator: ReturnType<Page['locator']>): Promise<void> {
  await Promise.all([
    page.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => undefined),
    locator.click({ timeout: 15_000 }),
  ]);
  await humanDelay(500, 1_000);
}

async function navigateFromDashboardToCalendar(page: Page, visaType: string): Promise<void> {
  const sel = getSelectors();

  if (!page.url().toLowerCase().includes('/dashboard')) {
    throw new ClassifiedBookingError(
      `Operator's Chrome tab is on ${page.url()} - booking worker requires the tab to be on /dashboard. Open the dashboard manually in the attached Chrome and retry.`,
      'OPERATOR_NOT_ON_DASHBOARD',
      'permanent',
    );
  }

  try {
    const startBooking = page.locator('button:has-text("Start New Booking")').first();
    await clickAndSettle(page, startBooking);
  } catch (err) {
    throw new ClassifiedBookingError(
      `Dashboard navigation failed at Start New Booking: ${err instanceof Error ? err.message : String(err)}`,
      'DASHBOARD_START_BOOKING_FAILED',
      'permanent',
    );
  }

  try {
    const centerCandidates = [
      page.locator('li[class*="center"]').first(),
      page.locator('button:has-text("Tashkent")').first(),
      page.locator('[class*="center"]:has-text("Tashkent")').first(),
    ];

    let centerClicked = false;
    for (const center of centerCandidates) {
      if (await center.count()) {
        await clickAndSettle(page, center);
        centerClicked = true;
        break;
      }
    }
    if (!centerClicked) {
      throw new Error('No visible visa center option found');
    }
  } catch (err) {
    throw new ClassifiedBookingError(
      `Dashboard navigation failed at visa center selection: ${err instanceof Error ? err.message : String(err)}`,
      'DASHBOARD_CENTER_SELECTION_FAILED',
      'permanent',
    );
  }

  try {
    const category = page.getByText(new RegExp(`^\\s*${escapeRegExp(visaType)}\\s*$`, 'i')).first();
    await clickAndSettle(page, category);
  } catch (err) {
    throw new ClassifiedBookingError(
      `Dashboard navigation failed at visa category selection (${visaType}): ${err instanceof Error ? err.message : String(err)}`,
      'DASHBOARD_VISA_CATEGORY_FAILED',
      'permanent',
    );
  }

  try {
    await page.locator(sel.appointmentCalendar).first().waitFor({ state: 'visible', timeout: 30_000 });
  } catch (err) {
    throw new ClassifiedBookingError(
      `Dashboard navigation failed waiting for calendar: ${err instanceof Error ? err.message : String(err)}`,
      'DASHBOARD_CALENDAR_NOT_VISIBLE',
      'permanent',
    );
  }
}

async function selectEarliestVisibleSlot(page: Page, slot: BookingJobPayload['slot']): Promise<void> {
  const sel = getSelectors();

  const exactDate = slot.date
    ? page.locator(`td[data-date="${slot.date}"]:not(.disabled):not(.unavailable)`)
    : undefined;
  if (exactDate && await exactDate.count()) {
    await exactDate.first().click();
  } else {
    const availableDates = page.locator(`td[data-date]:not(.disabled):not(.unavailable):not(.past), ${sel.slotDateCell}`);
    if (await availableDates.count() === 0) {
      throw new ClassifiedBookingError('No available date cells were visible', 'SLOT_NO_LONGER_AVAILABLE', 'permanent');
    }
    await availableDates.first().click();
  }

  const slotResponse = waitForResponseContaining(page, ['slot', 'appointment'], 30_000).catch((err) => {
    if (err instanceof ClassifiedBookingError && err.reason === 'NETWORK_TIMEOUT') return undefined;
    throw err;
  });
  await slotResponse;

  const timeButtons = page.locator(sel.slotTimeButton);
  const count = await timeButtons.count();
  if (count === 0) {
    throw new ClassifiedBookingError('No available time slots were visible', 'SLOT_NO_LONGER_AVAILABLE', 'permanent');
  }

  if (slot.time) {
    for (let i = 0; i < count; i++) {
      const button = timeButtons.nth(i);
      const text = await button.innerText().catch(() => '');
      if (text.includes(slot.time) && await button.isEnabled().catch(() => false)) {
        await button.click();
        return;
      }
    }
  }

  for (let i = 0; i < count; i++) {
    const button = timeButtons.nth(i);
    if (await button.isEnabled().catch(() => false)) {
      await button.click();
      return;
    }
  }

  throw new ClassifiedBookingError('All visible time slots were disabled', 'SLOT_NO_LONGER_AVAILABLE', 'permanent');
}

async function captureReviewScreenshot(page: Page, bookingId: string): Promise<string> {
  const recordingsDir = path.resolve(process.cwd(), 'recordings');
  await fs.mkdir(recordingsDir, { recursive: true });
  const filePath = path.join(recordingsDir, `booking_${bookingId}_review_${Date.now()}.png`);
  await page.screenshot({ path: filePath, fullPage: true });
  return filePath;
}

async function extractConfirmationNumber(page: Page): Promise<string> {
  const sel = getSelectors();
  const selectorText = await page.locator(sel.confirmationNumber).first().innerText({ timeout: 10_000 }).catch(() => '');
  const text = selectorText || await page.locator('body').innerText({ timeout: 10_000 }).catch(() => '');
  const match = text.match(/(?:booking\s+reference|confirmation\s+(?:number|no\.?|#)|appointment\s+(?:id|number)|reference|confirmation|booking)[^\w]*([A-Z0-9-]{6,30})/i);
  return match?.[1] ?? (text.trim().slice(0, 64) || 'UNKNOWN');
}

async function runBookingAttempt(job: BookingJobPayload, bookingId: string): Promise<BookingResult> {
  const selectorOverrides = await getSetting<Partial<VfsSelectors>>('vfs.selectors');
  if (selectorOverrides) applyOverrides(selectorOverrides);

  const dest = destinationCode(job.destination);
  const source = sourceCode(job.sourceCountry);
  const profile = await getProfileForBooking(job.profileId);
  let closePageOnFinish = true;
  let page: Page;

  if (env.CDP_ENDPOINT) {
    const cdpPage = await findPageForProfile(job.profileId, source, dest);
    if (!cdpPage) {
      throw new ClassifiedBookingError(
        `No reusable monitor browser context found for ${dest}`,
        'NO_REUSABLE_CONTEXT',
        'permanent',
      );
    }

    page = cdpPage;
    closePageOnFinish = false;
    logEvent('info', EventType.BOOKING_ATTEMPT, `[Booking] Using CDP page for ${job.profileId} on the CDP branch`, {
      profileId: job.profileId,
      destination: job.destination,
    });
  } else {
    const context = getReusableContextFor(dest);
    if (!context) {
      throw new ClassifiedBookingError(
        `No reusable monitor browser context found for ${dest}`,
        'NO_REUSABLE_CONTEXT',
        'permanent',
      );
    }

    page = await context.newPage();
  }

  const sel = getSelectors();

  try {
    await assertStillAuthenticated(page);

    if (await page.locator(sel.bookAppointmentLink).count()) {
      await clickAndMaybeWaitForResponse(page, sel.bookAppointmentLink, ['schedule-appointment', 'appointment']);
    }

    await navigateFromDashboardToCalendar(page, job.visaType);
    await selectEarliestVisibleSlot(page, job.slot);
    await assertNoPermanentPageError(page);

    await clickAndMaybeWaitForResponse(page, sel.continueButton, ['slot-hold', 'applicant', 'appointment']);
    await assertStillAuthenticated(page);

    await fillApplicantForm(page, {
      fullName: profile.fullName,
      passportNumber: profile.passportNumber,
      dob: profile.dob,
      passportExpiry: profile.passportExpiry.toISOString(),
      nationality: profile.nationality,
      email: profile.email,
      phone: profile.phone,
    });
    await assertNoPermanentPageError(page);

    await clickAndMaybeWaitForResponse(page, sel.continueButton, ['review', 'applicant', 'appointment']);
    await assertNoPermanentPageError(page);

    const screenshotPath = await captureReviewScreenshot(page, bookingId);
    if (process.env.DEMO_DRY_RUN === '1') {
      logEvent('info', EventType.BOOKING_ATTEMPT, `[DryRun] Review screenshot captured: ${screenshotPath}`);
      return {
        success: true,
        confirmationNo: `DRYRUN-${bookingId.slice(-8)}`,
        dryRun: true,
        screenshotPath,
      };
    }

    if (env.BOOKING_DRY_RUN) {
      logEvent('info', EventType.BOOKING_ATTEMPT, `Dry-run booking reached review screen for ${profile.fullName}`, {
        profileId: profile.id,
        destination: job.destination,
        result: screenshotPath,
      });
      return { success: true, dryRun: true, screenshotPath };
    }

    await assertStillAuthenticated(page);
    const confirmResponse = waitForResponseContaining(page, ['confirm', 'appointment-detail'], 30_000);
    await clickWithHover(page, sel.submitButton);
    await confirmResponse;

    if (await page.locator(sel.confirmButton).count()) {
      const finalResponse = waitForResponseContaining(page, ['confirm', 'appointment-detail'], 30_000);
      await clickWithHover(page, sel.confirmButton);
      await finalResponse;
    }

    const confirmationNo = await extractConfirmationNumber(page);
    return { success: true, confirmationNo, screenshotPath };
  } catch (err) {
    if (err instanceof ClassifiedBookingError) throw err;
    if (isTimeoutError(err)) {
      throw new ClassifiedBookingError('Network timeout during booking flow', 'NETWORK_TIMEOUT', 'transient');
    }
    throw err;
  } finally {
    if (closePageOnFinish) {
      await page.close().catch(() => {});
    }
  }
}

export async function runBooking(job: BookingJobPayload, bookingId = job.profileId): Promise<BookingResult> {
  const maxAttempts = Math.max(1, env.BOOKING_MAX_RETRIES);
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await runBookingAttempt(job, bookingId);
    } catch (err) {
      lastError = err;
      const classified = err instanceof ClassifiedBookingError
        ? err
        : new ClassifiedBookingError(err instanceof Error ? err.message : String(err), 'UNKNOWN', 'permanent');

      logEvent(
        classified.errorClass === 'transient' ? 'warn' : 'error',
        EventType.BOOKING_ATTEMPT,
        `Booking attempt ${attempt}/${maxAttempts} failed (${classified.errorClass}): ${classified.reason}`,
        {
          profileId: job.profileId,
          destination: job.destination,
          result: classified.message,
        },
      );

      if (classified.errorClass === 'permanent' || attempt >= maxAttempts) {
        return {
          success: false,
          error: classified.reason,
          errorClass: classified.errorClass,
        };
      }

      await sleep(1000 * Math.pow(2, attempt - 1));
    }
  }

  return {
    success: false,
    error: lastError instanceof Error ? lastError.message : String(lastError),
    errorClass: 'permanent',
  };
}

export { parseSlotDateTime };
