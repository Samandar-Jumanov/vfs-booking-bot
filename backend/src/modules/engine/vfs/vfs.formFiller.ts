import { Page } from 'playwright';
import { typeText, selectOption, humanDelay } from '../humanBehavior';
import { getSelectors } from './vfs.selectors';

interface ApplicantData {
  fullName: string;
  passportNumber: string;
  dob: string;
  passportExpiry: string;
  nationality: string;
  email: string;
  phone: string;
}

function splitName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/);
  const firstName = parts[0];
  const lastName = parts.slice(1).join(' ') || parts[0];
  return { firstName, lastName };
}

export async function fillApplicantForm(page: Page, applicant: ApplicantData): Promise<void> {
  const sel = getSelectors();
  const { firstName, lastName } = splitName(applicant.fullName);

  await humanDelay(500, 1000);

  // Name fields
  if (await page.$(sel.firstNameInput)) {
    await typeText(page, sel.firstNameInput, firstName);
  }
  if (await page.$(sel.lastNameInput)) {
    await typeText(page, sel.lastNameInput, lastName);
  }

  // Passport number
  if (await page.$(sel.passportNumberInput)) {
    await typeText(page, sel.passportNumberInput, applicant.passportNumber);
  }

  // Date of birth — format as DD/MM/YYYY for VFS
  const dobFormatted = formatDateForVfs(applicant.dob);
  if (await page.$(sel.dobInput)) {
    await typeText(page, sel.dobInput, dobFormatted);
  }

  // Passport expiry
  const expiryFormatted = formatDateForVfs(applicant.passportExpiry.toString());
  if (await page.$(sel.passportExpiryInput)) {
    await typeText(page, sel.passportExpiryInput, expiryFormatted);
  }

  // Nationality dropdown
  if (await page.$(sel.nationalityDropdown)) {
    await selectOption(page, sel.nationalityDropdown, applicant.nationality);
  }

  // Contact
  if (await page.$(sel.emailInput)) {
    await typeText(page, sel.emailInput, applicant.email);
  }
  if (await page.$(sel.phoneInput)) {
    await typeText(page, sel.phoneInput, applicant.phone);
  }

  await humanDelay(300, 800);
}

function formatDateForVfs(isoDate: string): string {
  // Convert "YYYY-MM-DD" or ISO datetime to "DD/MM/YYYY"
  const d = new Date(isoDate);
  const day = String(d.getUTCDate()).padStart(2, '0');
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const year = d.getUTCFullYear();
  return `${day}/${month}/${year}`;
}
