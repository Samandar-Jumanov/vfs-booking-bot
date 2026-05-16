/**
 * VFS Global interstitial handlers.
 *
 * When accessed from a non-local IP, VFS shows two blocking overlays before
 * allowing access to any country-specific route:
 *
 *   1. Cookie consent banner  — must be dismissed first
 *   2. Country selector modal — "I am a resident of" + "Going to" dropdowns
 *
 * Both overlays must be handled after every top-level navigation.
 * Call `handleVfsInterstitials(page, source, destination)` right after
 * top-level route changes in any VFS flow.
 */

import { Page } from 'rebrowser-playwright';
import { humanDelay, clickWithHover } from '../humanBehavior';

// ─── Country code maps ────────────────────────────────────────────────────────
// VFS uses ISO 3-letter codes as option values in their Angular Material
// mat-select components. We also keep text fallbacks for older deployments.

const SOURCE_COUNTRY_CODES: Record<string, string[]> = {
  angola:       ['AGO', 'Angola'],
  uzbekistan:   ['UZB', 'Uzbekistan'],
  tajikistan:   ['TJK', 'Tajikistan'],
  latvia:       ['LVA', 'Latvia'],
};

const DEST_COUNTRY_CODES: Record<string, string[]> = {
  brazil:       ['BRA', 'Brazil'],
  portugal:     ['PRT', 'Portugal'],
  france:       ['FRA', 'France'],
  germany:      ['DEU', 'Germany'],
  spain:        ['ESP', 'Spain'],
  netherlands:  ['NLD', 'Netherlands'],
};

// ─── Cookie consent ───────────────────────────────────────────────────────────

const COOKIE_SELECTORS = [
  'button:has-text("Accept All Cookies")',
  'button:has-text("Accept All")',
  'button:has-text("Accept all")',
  'button:has-text("Accept Only Necessary")',
  'button:has-text("Accept Necessary")',
  '[aria-label*="Accept"]',
  // Generic fallback for any prominent cookie accept button
  '[class*="cookie"] button:last-of-type',
  '#onetrust-accept-btn-handler',
  '.cookie-consent button[class*="accept"]',
];

async function dismissCookieConsent(page: Page): Promise<boolean> {
  for (const selector of COOKIE_SELECTORS) {
    try {
      const el = await page.$(selector);
      if (el && await el.isVisible()) {
        await el.click();
        await humanDelay(400, 800);
        return true;
      }
    } catch {
      // Try next selector
    }
  }
  return false;
}

// ─── Country selector ─────────────────────────────────────────────────────────

// These selectors target the country selector modal/dialog that VFS shows
// when the visitor's IP does not match the route's source country.
const COUNTRY_SELECTOR_HEADING = [
  'h1:has-text("Country selector")',
  'h2:has-text("Country selector")',
  '.country-selector',
  '[class*="countrySelector"]',
  'mat-dialog-container:has-text("resident of")',
  // Fallback: check for the "I am a resident of" label anywhere on the page
  'label:has-text("resident of")',
  ':text("Please confirm your travel details")',
].join(', ');

// The two mat-select dropdowns inside the country selector.
// VFS uses sequential mat-select IDs; inside a dialog they typically reset
// to mat-select-0 and mat-select-1, but we also have positional fallbacks.
const RESIDENT_DROPDOWN = [
  'mat-select[formcontrolname="residingCountry"]',
  'mat-select[formcontrolname="countryOfResidence"]',
  'mat-dialog-container mat-select:nth-of-type(1)',
  'mat-select:nth-of-type(1)',
].join(', ');

const GOING_TO_DROPDOWN = [
  'mat-select[formcontrolname="missionCountry"]',
  'mat-select[formcontrolname="destinationCountry"]',
  'mat-select[formcontrolname="goingTo"]',
  'mat-dialog-container mat-select:nth-of-type(2)',
  'mat-select:nth-of-type(2)',
].join(', ');

const CONFIRM_BUTTON = [
  'mat-dialog-container button:has-text("Confirm")',
  'button:has-text("Confirm")',
  'button[type="submit"]:visible',
].join(', ');

/**
 * Select a value in an Angular Material mat-select by trying a list of
 * candidate values (ISO codes first, then display names).
 *
 * mat-select does not behave like a native <select>; we must:
 *   1. Click the trigger to open the dropdown panel
 *   2. Wait for the option list to appear
 *   3. Click the matching option
 */
async function selectMatOption(page: Page, triggerSelector: string, candidates: string[]): Promise<boolean> {
  const trigger = await page.$(triggerSelector);
  if (!trigger || !(await trigger.isVisible())) return false;

  await trigger.click();
  await humanDelay(300, 600);

  // Wait for the mat-option panel to open
  await page.waitForSelector('mat-option', { timeout: 5_000 }).catch(() => {/* panel may already be open */});

  for (const value of candidates) {
    // Try matching by option value attribute
    const byValue = await page.$(`mat-option[value="${value}"]`);
    if (byValue && await byValue.isVisible()) {
      await byValue.click();
      await humanDelay(200, 400);
      return true;
    }

    // Try matching by visible text content (case-insensitive)
    const options = await page.$$('mat-option');
    for (const option of options) {
      const text = (await option.textContent())?.trim() ?? '';
      if (text.toLowerCase() === value.toLowerCase()) {
        await option.click();
        await humanDelay(200, 400);
        return true;
      }
    }
  }

  // Close the panel if nothing matched (press Escape)
  await page.keyboard.press('Escape');
  return false;
}

async function handleCountrySelector(
  page: Page,
  sourceCountry: string,
  destinationCountry: string,
): Promise<boolean> {
  const heading = await page.$(COUNTRY_SELECTOR_HEADING);
  if (!heading || !(await heading.isVisible())) return false;

  await humanDelay(500, 1_000);

  const sourceCodes = SOURCE_COUNTRY_CODES[sourceCountry.toLowerCase()] ?? [sourceCountry];
  const destCodes   = DEST_COUNTRY_CODES[destinationCountry.toLowerCase()] ?? [destinationCountry];

  await selectMatOption(page, RESIDENT_DROPDOWN, sourceCodes);
  await humanDelay(300, 600);
  await selectMatOption(page, GOING_TO_DROPDOWN, destCodes);
  await humanDelay(300, 600);

  await clickWithHover(page, CONFIRM_BUTTON);
  await page.waitForLoadState('domcontentloaded');
  await humanDelay(800, 1_500);

  return true;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Dismiss the cookie consent banner and handle the country selector modal
 * that VFS Global displays when the visitor's IP is outside the source country.
 *
 * Safe to call unconditionally — each step is guarded by an existence check
 * and will silently skip if the overlay is not present.
 *
 * @param page            Playwright page (after goto has completed)
 * @param sourceCountry   e.g. "angola", "uzbekistan", "tajikistan", "latvia"
 * @param destinationCountry  e.g. "brazil", "portugal"
 */
export async function handleVfsInterstitials(
  page: Page,
  sourceCountry: string,
  destinationCountry: string,
): Promise<void> {
  // Step 1: Dismiss cookie consent (must happen before interacting with any
  // Angular Material component, which may be blocked by the cookie overlay)
  await dismissCookieConsent(page);

  // Small pause — Angular needs time to destroy the cookie overlay and
  // potentially render the country selector beneath it
  await humanDelay(500, 1_000);

  // Step 2: Handle country selector if present
  await handleCountrySelector(page, sourceCountry, destinationCountry);
}
