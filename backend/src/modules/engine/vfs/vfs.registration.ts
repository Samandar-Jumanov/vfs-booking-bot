/**
 * VFS Account Auto-Registration
 *
 * Automates the creation of a new VFS Global account by:
 *   1. Acquiring a temporary phone number via SMS-Activate
 *   2. Constructing a disposable email via Mailsac
 *   3. Driving the registration form with Playwright (stealth browser)
 *   4. Handling both email OTP and SMS OTP verification steps
 *   5. Persisting the encrypted credentials to the VfsAccount table
 *
 * Target URL: https://visa.vfsglobal.com/ago/en/bra/register  (Angola → Brazil)
 */

import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { createBrowserContext } from '../browser.factory';
import { prisma } from '@config/database';
import { smsActivateService } from '@modules/phone/smsActivate.service';
import { mailsacService } from '@modules/email/mailsac.service';
import { encrypt } from '@utils/crypto';
import { env } from '@config/env';
import { typeText, clickWithHover, humanDelay } from '../humanBehavior';
import { handleVfsInterstitials } from './vfs.interstitials';

// ─── Constants ────────────────────────────────────────────────────────────────

const VFS_REGISTER_URL = 'https://visa.vfsglobal.com/ago/en/bra/register';

/**
 * SMS-Activate service code for VFS Global.
 * "vfs" is the standard service key; country "0" is any/global.
 * Adjust the country code if a specific originating country is required.
 */
const SMS_SERVICE_CODE = 'vfs';
const SMS_COUNTRY_CODE = '0'; // 0 = any country; change to '7' for Russia if needed

const EMAIL_OTP_TIMEOUT_MS = 120_000; // 2 minutes

// ─── Registration form selectors ──────────────────────────────────────────────
//
// VFS uses Angular Material. The registration form is distinct from the login /
// booking forms, so we define dedicated selectors here rather than reusing
// vfs.selectors.ts (which covers the post-login booking flow).
//
// Angular formControlName attributes are the most stable hook; we fall back to
// type/placeholder selectors for resilience if VFS updates their template.

const REG_SELECTORS = {
  // Personal details
  firstNameInput: [
    'input[formcontrolname="firstName"]',
    'input[placeholder*="First Name" i]',
    'input[name="firstName"]',
    '#mat-input-0',
  ].join(', '),

  lastNameInput: [
    'input[formcontrolname="lastName"]',
    'input[placeholder*="Last Name" i]',
    'input[name="lastName"]',
    '#mat-input-1',
  ].join(', '),

  // Contact / credential fields
  emailInput: [
    'input[formcontrolname="email"]',
    'input[formcontrolname="emailAddress"]',
    'input[type="email"]',
  ].join(', '),

  // Confirm-email field that VFS sometimes includes
  confirmEmailInput: [
    'input[formcontrolname="confirmEmail"]',
    'input[formcontrolname="confirmEmailAddress"]',
    'input[placeholder*="Confirm" i][type="email"]',
  ].join(', '),

  phoneInput: [
    'input[formcontrolname="contactNumber"]',
    'input[formcontrolname="phone"]',
    'input[type="tel"]',
  ].join(', '),

  passwordInput: [
    'input[formcontrolname="password"]',
    'input[type="password"]:nth-of-type(1)',
    '#mat-input-2',
  ].join(', '),

  confirmPasswordInput: [
    'input[formcontrolname="confirmPassword"]',
    'input[type="password"]:nth-of-type(2)',
    '#mat-input-3',
  ].join(', '),

  // Terms & conditions checkbox (often required before submit)
  termsCheckbox: [
    'mat-checkbox[formcontrolname="termsAndConditions"] input',
    'input[type="checkbox"][formcontrolname="termsAndConditions"]',
    'mat-checkbox input[type="checkbox"]',
    'input[type="checkbox"]',
  ].join(', '),

  // Primary registration submit button
  submitButton: [
    'button[type="submit"]',
    'button:has-text("Register")',
    'button:has-text("Sign Up")',
    'button:has-text("Create Account")',
  ].join(', '),

  // ── Email OTP verification step ──────────────────────────────────────────
  emailOtpInput: [
    'input[formcontrolname="emailOtp"]',
    'input[formcontrolname="emailVerification"]',
    'input[placeholder*="email" i][placeholder*="code" i]',
    'input[placeholder*="OTP" i]',
    'input[placeholder*="verification" i]',
    // Generic single OTP field when there is only one visible input on page
    'input[type="text"]:visible',
  ].join(', '),

  verifyEmailButton: [
    'button:has-text("Verify")',
    'button:has-text("Confirm")',
    'button[type="submit"]',
  ].join(', '),

  // ── SMS / phone OTP verification step ────────────────────────────────────
  smsOtpInput: [
    'input[formcontrolname="smsOtp"]',
    'input[formcontrolname="mobileOtp"]',
    'input[formcontrolname="phoneVerification"]',
    'input[placeholder*="mobile" i][placeholder*="code" i]',
    'input[placeholder*="phone" i][placeholder*="code" i]',
    'input[placeholder*="SMS" i]',
    // Fallback — visible text input when we are on the phone-verify step
    'input[type="text"]:visible',
  ].join(', '),

  verifyPhoneButton: [
    'button:has-text("Verify")',
    'button:has-text("Confirm")',
    'button[type="submit"]',
  ].join(', '),
} as const;

// ─── Name / password generators ───────────────────────────────────────────────

const FIRST_NAMES = [
  'James', 'Michael', 'David', 'John', 'Robert', 'William', 'Richard', 'Thomas',
  'Charles', 'Daniel', 'Matthew', 'Anthony', 'Mark', 'Donald', 'Steven', 'Paul',
  'Andrew', 'Kenneth', 'Joshua', 'George', 'Kevin', 'Brian', 'Edward', 'Ronald',
];

const LAST_NAMES = [
  'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis',
  'Wilson', 'Taylor', 'Anderson', 'Thomas', 'Jackson', 'White', 'Harris', 'Martin',
  'Thompson', 'Young', 'Robinson', 'Walker', 'Lewis', 'Allen', 'Hall', 'Wright',
];

function generateFirstName(): string {
  return FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)];
}

function generateLastName(): string {
  return LAST_NAMES[Math.floor(Math.random() * LAST_NAMES.length)];
}

/**
 * Generates a strong random password that satisfies most portal requirements:
 * - 14 characters
 * - At least one uppercase letter
 * - At least one lowercase letter
 * - At least two digits
 * - At least two special characters from a safe set
 */
function generatePassword(): string {
  const upper   = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower   = 'abcdefghjkmnpqrstuvwxyz';
  const digits  = '23456789';
  const special = '!@#$%^&*';
  const all     = upper + lower + digits + special;

  const pick = (chars: string): string => chars[crypto.randomInt(chars.length)];

  // Guarantee at least one of each category
  const mandatory = [
    pick(upper),
    pick(upper),
    pick(lower),
    pick(lower),
    pick(digits),
    pick(digits),
    pick(special),
    pick(special),
  ];

  // Fill remaining positions from the full pool
  for (let i = mandatory.length; i < 14; i++) {
    mandatory.push(pick(all));
  }

  // Fisher-Yates shuffle
  for (let i = mandatory.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [mandatory[i], mandatory[j]] = [mandatory[j], mandatory[i]];
  }

  return mandatory.join('');
}

// ─── Public interface ─────────────────────────────────────────────────────────

export interface RegistrationResult {
  accountId: string;
  email: string;
  phone: string;
}

// ─── Main function ────────────────────────────────────────────────────────────

export async function registerVfsAccount(): Promise<RegistrationResult> {
  // ── Step 1: Acquire a temporary phone number ──────────────────────────────
  const { id: activationId, number: phoneNumber } = await smsActivateService.buyNumber(
    SMS_SERVICE_CODE,
    SMS_COUNTRY_CODE,
  );

  // Track whether we still need to release the number in the finally block.
  let activationReleased = false;

  try {
    // ── Step 2: Build a disposable email address ────────────────────────────
    const emailDomain = env.EMAIL_DOMAIN ?? 'mailsac.com';
    const email = `temp_${uuidv4()}@${emailDomain}`;

    // ── Step 3: Clear the mailbox so we receive only the new OTP ───────────
    await mailsacService.deleteMessages(email);

    // ── Step 4: Generate identity data ─────────────────────────────────────
    const firstName = generateFirstName();
    const lastName  = generateLastName();
    const password  = generatePassword();

    // ── Step 5: Launch stealth browser ─────────────────────────────────────
    const context = await createBrowserContext(null);

    try {
      const page = await context.newPage();

      try {
        // ── Step 6: Navigate to VFS registration page ─────────────────────
        await page.goto(VFS_REGISTER_URL, {
          waitUntil: 'domcontentloaded',
          timeout: 30_000,
        });

        // Dismiss cookie consent + handle country selector when accessed
        // from a non-Angola IP (VFS detects IP and shows these overlays)
        await handleVfsInterstitials(page, 'angola', 'brazil');

        await humanDelay(1_000, 2_000);

        // ── Step 7: Fill the registration form ────────────────────────────

        // First name
        const firstNameEl = await page.$(REG_SELECTORS.firstNameInput);
        if (!firstNameEl) {
          throw new Error(
            '[registration] First-name input not found — VFS may have changed their form structure',
          );
        }
        await typeText(page, REG_SELECTORS.firstNameInput, firstName);

        // Last name
        const lastNameEl = await page.$(REG_SELECTORS.lastNameInput);
        if (!lastNameEl) {
          throw new Error('[registration] Last-name input not found');
        }
        await typeText(page, REG_SELECTORS.lastNameInput, lastName);

        // Email
        await typeText(page, REG_SELECTORS.emailInput, email);

        // Confirm email (only present on some VFS deployments)
        const confirmEmailEl = await page.$(REG_SELECTORS.confirmEmailInput);
        if (confirmEmailEl) {
          await typeText(page, REG_SELECTORS.confirmEmailInput, email);
        }

        // Phone number — VFS typically wants digits only, no country prefix
        await typeText(page, REG_SELECTORS.phoneInput, phoneNumber);

        // Password
        await typeText(page, REG_SELECTORS.passwordInput, password);

        // Confirm password (required on most deployments)
        const confirmPwEl = await page.$(REG_SELECTORS.confirmPasswordInput);
        if (confirmPwEl) {
          await typeText(page, REG_SELECTORS.confirmPasswordInput, password);
        }

        // Accept terms & conditions if the checkbox is present
        const termsEl = await page.$(REG_SELECTORS.termsCheckbox);
        if (termsEl) {
          const checked = await termsEl.isChecked();
          if (!checked) {
            await termsEl.click();
            await humanDelay(300, 700);
          }
        }

        await humanDelay(800, 1_500);

        // ── Step 8: Submit the registration form ──────────────────────────
        await clickWithHover(page, REG_SELECTORS.submitButton);
        await page.waitForLoadState('domcontentloaded');
        await humanDelay(1_000, 2_000);

        // ── Step 9: Wait for email OTP ────────────────────────────────────
        const emailOtp = await mailsacService.waitForOtp(email, EMAIL_OTP_TIMEOUT_MS);

        // ── Step 10: Enter email OTP ──────────────────────────────────────
        //
        // After submitting the form VFS navigates to (or reveals) an OTP
        // verification step. We wait up to 15 s for the OTP input to appear.
        await page.waitForSelector(REG_SELECTORS.emailOtpInput, {
          timeout: 15_000,
          state: 'visible',
        });

        // Clear any pre-filled value and type the OTP
        await page.fill(REG_SELECTORS.emailOtpInput, '');
        await typeText(page, REG_SELECTORS.emailOtpInput, emailOtp);
        await humanDelay(500, 1_000);

        // Click the verify / confirm button for the email step
        await clickWithHover(page, REG_SELECTORS.verifyEmailButton);
        await page.waitForLoadState('domcontentloaded');
        await humanDelay(1_000, 2_000);

        // ── Step 11: Wait for SMS OTP ─────────────────────────────────────
        const smsOtp = await smsActivateService.getOtp(activationId);

        // ── Step 12: Enter SMS OTP ────────────────────────────────────────
        await page.waitForSelector(REG_SELECTORS.smsOtpInput, {
          timeout: 15_000,
          state: 'visible',
        });

        await page.fill(REG_SELECTORS.smsOtpInput, '');
        await typeText(page, REG_SELECTORS.smsOtpInput, smsOtp);
        await humanDelay(500, 1_000);

        // Click the verify / confirm button for the phone step
        await clickWithHover(page, REG_SELECTORS.verifyPhoneButton);
        await page.waitForLoadState('domcontentloaded');
        await humanDelay(1_000, 2_500);

        // ── Step 13: Confirm registration is complete ─────────────────────
        //
        // Positive confirmation: we expect VFS to navigate away from /register
        // to a login, dashboard, or success page. We wait up to 10 s for the
        // URL to change, then assert it no longer contains "/register".
        // If still on a registration URL, we also check for an error banner.
        try {
          await page.waitForURL((url) => !url.pathname.includes('/register'), {
            timeout: 10_000,
          });
        } catch {
          // URL did not change — check for an explicit error element first
          const errorEl = await page.$(
            '.error-message, .alert-danger, [role="alert"]:visible, mat-error:visible',
          );
          if (errorEl) {
            const errorText = await errorEl.textContent();
            throw new Error(
              `[registration] Form error after OTP submission: ${errorText?.trim() ?? 'unknown error'}`,
            );
          }
          // No error element either — unknown state, fail safe
          throw new Error(
            `[registration] Registration did not complete: still on ${page.url()} after OTP submission`,
          );
        }
      } finally {
        try { await page.close(); } catch { /* ignore close errors */ }
      }
    } finally {
      try { await context.close(); } catch { /* ignore close errors */ }
    }

    // ── Step 14: Encrypt password and persist to DB ───────────────────────
    const encryptedPassword = encrypt(password);

    const account = await prisma.vfsAccount.create({
      data: {
        email,
        encryptedPassword,
        phone: phoneNumber,
        status: 'ACTIVE',
        profileIds: [],
      },
      select: { id: true },
    });

    // ── Step 15: Release the phone number ─────────────────────────────────
    await smsActivateService.releaseNumber(activationId);
    activationReleased = true;

    return {
      accountId: account.id,
      email,
      phone: phoneNumber,
    };
  } catch (err) {
    // Re-throw with additional context so callers can log meaningfully
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`registerVfsAccount failed: ${message}`);
  } finally {
    // Always release the phone number if it was not already released
    if (!activationReleased) {
      try {
        await smsActivateService.releaseNumber(activationId);
      } catch {
        // Best-effort — do not mask the original error
      }
    }
  }
}
