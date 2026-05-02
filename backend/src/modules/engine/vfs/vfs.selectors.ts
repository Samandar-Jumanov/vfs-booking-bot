/**
 * VFS Global CSS selectors.
 *
 * IMPORTANT: These are overridable at runtime via the Settings table key "vfs.selectors".
 * On engine startup, DB overrides are merged with these defaults.
 * If VFS changes their DOM, update via the Settings UI — no redeploy required.
 */

export interface VfsSelectors {
  // Login page
  loginEmail: string;
  loginPassword: string;
  loginSubmit: string;

  // Country / visa selection
  countryOfResidenceDropdown: string;
  destinationCountryDropdown: string;
  visaCategoryDropdown: string;
  continueButton: string;

  // Appointment availability
  appointmentCalendar: string;
  availableSlot: string;
  slotDateCell: string;
  slotTimeButton: string;
  noSlotsMessage: string;

  // Applicant form
  firstNameInput: string;
  lastNameInput: string;
  passportNumberInput: string;
  dobInput: string;
  passportExpiryInput: string;
  nationalityDropdown: string;
  emailInput: string;
  phoneInput: string;

  // Booking confirmation
  submitButton: string;
  confirmButton: string;
  confirmationNumber: string;

  // Navigation
  bookAppointmentLink: string;
  logoutLink: string;
}

export const DEFAULT_SELECTORS: VfsSelectors = {
  // Login — Angular Material mat-input sequential IDs (confirmed across VFS global deployments)
  loginEmail:    'input[id="mat-input-0"]',
  loginPassword: 'input[id="mat-input-1"]',
  loginSubmit:   'button[type="submit"]',

  // Country / visa selection — Angular Material mat-select
  countryOfResidenceDropdown: 'mat-select#mat-select-0, mat-select:nth-of-type(1)',
  destinationCountryDropdown: 'mat-select#mat-select-1, mat-select:nth-of-type(2)',
  visaCategoryDropdown:       'mat-select#mat-select-2, mat-select:nth-of-type(3)',
  continueButton: 'button:has-text("Continue"), button.mat-raised-button:has-text("Next")',

  // Appointment calendar — Angular Material calendar
  appointmentCalendar: 'mat-calendar, .mat-calendar',
  availableSlot:   'td.mat-calendar-body-cell:not(.mat-calendar-body-disabled)',
  slotDateCell:    'td.mat-calendar-body-cell:not(.mat-calendar-body-disabled)',
  slotTimeButton:  'mat-radio-button:not(.mat-radio-disabled), .time-slot-option',
  noSlotsMessage:  ':text("there are no appointments available"), .no-slots-message',

  // Applicant form — formControlName attributes are stable across VFS Angular versions
  firstNameInput:      'input[formcontrolname="firstName"], input[id*="firstName"]',
  lastNameInput:       'input[formcontrolname="lastName"], input[id*="lastName"]',
  passportNumberInput: 'input[formcontrolname="passportNumber"], input[id*="passport"]',
  dobInput:            'input[formcontrolname="dateOfBirth"], input[placeholder*="DD/MM/YYYY"]',
  passportExpiryInput: 'input[formcontrolname="passportExpiry"], input[id*="expiry"]',
  nationalityDropdown: 'mat-select[formcontrolname="nationality"]',
  emailInput:          'input[formcontrolname="email"], input[type="email"]:visible',
  phoneInput:          'input[formcontrolname="contactNumber"], input[type="tel"]',

  // Booking confirmation
  submitButton:      'button:has-text("Submit"), button:has-text("Book Appointment")',
  confirmButton:     'button:has-text("Confirm")',
  confirmationNumber: '.confirmation-number, strong:has-text("Booking Reference"), [class*="confirm"]',

  // Navigation
  bookAppointmentLink: 'a:has-text("Book Appointment"), a:has-text("New Appointment")',
  logoutLink:          'a:has-text("Logout"), a:has-text("Sign Out"), button:has-text("Sign Out")',
};

// Runtime selectors (merged with DB overrides on engine startup)
let activeSelectors: VfsSelectors = { ...DEFAULT_SELECTORS };

export function getSelectors(): VfsSelectors {
  return activeSelectors;
}

export function applyOverrides(overrides: Partial<VfsSelectors>): void {
  activeSelectors = { ...DEFAULT_SELECTORS, ...overrides };
}
