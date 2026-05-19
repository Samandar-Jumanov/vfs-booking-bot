import type {
  BookingCommand,
  ContentCommand,
  CustomerBookingPayload,
  ExtensionEvent,
  MonitorConfig,
  PollSlotResult,
  RegisterFormPayload,
} from '../shared/types';

const SLOT_API = 'https://lift-api.vfsglobal.com/appointment/CheckIsSlotAvailable';
const REGISTER_STEP_TIMEOUT_MS = 90_000;

let currentCorrelationId: string | undefined;
const registerWaiters = new Map<string, (value: string | null) => void>();

chrome.runtime.onMessage.addListener((message: ContentCommand, _sender, sendResponse) => {
  void handleCommand(message).then(sendResponse).catch((error: Error) => {
    sendResponse({ ok: false, error: error.message });
  });
  return true;
});

window.postMessage({ source: 'vfs-booking-extension', type: 'EXTENSION_PRESENT' }, window.location.origin);
void syncSessionToBackend();
window.setInterval(() => void syncSessionToBackend(), 60_000);

async function handleCommand(command: ContentCommand): Promise<unknown> {
  switch (command.type) {
    case 'REGISTER_FILL_FORM':
      void handleRegisterFlow(command.payload);
      return { ok: true };
    case 'REGISTER_EMAIL_LINK':
      resolveRegisterWaiter('emailLink', command.link);
      if (command.link) window.location.href = command.link;
      return { ok: true };
    case 'REGISTER_SMS_OTP':
      resolveRegisterWaiter('smsOtp', command.otp);
      void fillRegisterOtp(command.otp);
      return { ok: true };
    case 'REGISTER_CAPTCHA_TOKEN':
      resolveRegisterWaiter('captchaToken', command.token);
      void applyRegisterCaptchaToken(command.token);
      return { ok: true };
    case 'POLL_SLOT':
      return pollSlot(command.monitor);
    case 'FILL_FORM':
      return fillForm(command.payload);
    case 'SUBMIT_BOOKING':
      return clickFirst(['button[type="submit"]', 'button:has-text("Submit")', '.mat-button:has-text("Submit")']);
    case 'EXTRACT_CONFIRMATION':
      return extractConfirmation();
    default:
      throw new Error('Unsupported content command');
  }
}

async function handleRegisterFlow(payload: RegisterFormPayload): Promise<void> {
  currentCorrelationId = payload.correlationId;
  try {
    await withTimeout(runRegisterSteps(payload), REGISTER_STEP_TIMEOUT_MS, 'REGISTER_TIMEOUT');
  } catch (error) {
    await emitRegisterEvent({
      type: 'EXT_REGISTER_FAILED',
      correlationId: payload.correlationId,
      reason: (error as Error).message,
    });
  }
}

async function runRegisterSteps(payload: RegisterFormPayload): Promise<void> {
  console.log('[VFS-REG] runRegisterSteps starting on', location.href);
  await waitForElement('input[type="email"], input[type="password"]', 30_000);
  console.log('[VFS-REG] form fields detected, filling…');

  // VFS Uzbekistan /register form (verified from operator screenshots 2026-05-20):
  //   Email • Password • Confirm Password • Mobile Number (dial-code+number) •
  //   3 consent checkboxes • Cloudflare Turnstile • Register button.
  // NO firstName / lastName / DOB. Old code targeted non-existent fields and
  // failed silently → "Mandatory field cannot be left blank" → 5-min timeout.
  await typeIntoFirst(['input[type="email"]', 'input[formcontrolname="email"]', 'input[name="email"]'], payload.email);
  await typeIntoFirst(['input[type="password"]', 'input[formcontrolname="password"]', 'input[name="password"]'], payload.password);
  await typeIntoFirst([
    'input[type="password"][formcontrolname="confirmPassword"]',
    'input[formcontrolname="confirmPassword"]',
    'input[name="confirmPassword"]',
    // last password input that isn't the first one
  ], payload.password);
  // Phone — VFS expects the LOCAL number (without country code; dial code is
  // a separate select that defaults to 998 for UZ). Strip leading +998 if
  // someone passes the full international form.
  const localPhone = payload.phone.replace(/^\+?998/, '').replace(/^\+/, '');
  await typeIntoFirst([
    'input[formcontrolname="mobileNumber"]',
    'input[type="tel"]',
    'input[name="phone"]',
    'input[name="mobile"]',
  ], localPhone);
  // Check all 3 consent checkboxes (Privacy Notice, Data Transfer, Terms).
  await checkAllRegisterConsents();
  console.log('[VFS-REG] consents checked');

  const turnstile = document.querySelector<HTMLElement>('[data-sitekey]');
  const siteKey = turnstile?.getAttribute('data-sitekey');
  if (siteKey) {
    await emitRegisterEvent({
      type: 'EXT_REGISTER_NEED_CAPTCHA',
      correlationId: payload.correlationId,
      siteKey,
      pageUrl: window.location.href,
    });
    const token = await waitForRegisterSignal('captchaToken', 90_000);
    if (!token) throw new Error('CAPTCHA_TOKEN_MISSING');
    await applyRegisterCaptchaToken(token);
  }

  const initialUrl = window.location.href;
  await clickRegisterSubmit();
  await waitForRegisterProgress(initialUrl);

  if (isEmailVerificationStep()) {
    await emitRegisterEvent({ type: 'EXT_REGISTER_NEED_EMAIL_LINK', correlationId: payload.correlationId, email: payload.email });
    const link = await waitForRegisterSignal('emailLink', 90_000);
    if (!link) throw new Error('EMAIL_LINK_MISSING');
    window.location.href = link;
    return;
  }

  if (isPhoneOtpStep()) {
    await emitRegisterEvent({
      type: 'EXT_REGISTER_NEED_SMS_OTP',
      correlationId: payload.correlationId,
      smsActivateId: payload.smsActivateId,
    });
    const otp = await waitForRegisterSignal('smsOtp', 90_000);
    if (!otp) throw new Error('SMS_OTP_MISSING');
    await fillRegisterOtp(otp);
  }

  await waitForCompletionOrOtp(payload);
}

async function waitForCompletionOrOtp(payload: RegisterFormPayload): Promise<void> {
  await waitUntil(async () => {
    if (isRegisterComplete()) {
      await emitRegisterEvent({ type: 'EXT_REGISTER_COMPLETED', correlationId: payload.correlationId });
      return true;
    }
    if (isPhoneOtpStep()) return true;
    return false;
  }, 30_000).catch(() => undefined);

  if (isPhoneOtpStep() && !isRegisterComplete()) {
    await emitRegisterEvent({
      type: 'EXT_REGISTER_NEED_SMS_OTP',
      correlationId: payload.correlationId,
      smsActivateId: payload.smsActivateId,
    });
    const otp = await waitForRegisterSignal('smsOtp', 90_000);
    if (!otp) throw new Error('SMS_OTP_MISSING');
    await fillRegisterOtp(otp);
    await waitUntil(() => isRegisterComplete(), 30_000);
  }

  if (!isRegisterComplete()) throw new Error('REGISTER_COMPLETION_NOT_DETECTED');
  await emitRegisterEvent({ type: 'EXT_REGISTER_COMPLETED', correlationId: payload.correlationId });
}

async function fillRegisterOtp(otp: string | null): Promise<void> {
  if (!otp) return;
  const inputs = Array.from(document.querySelectorAll<HTMLInputElement>(
    'input[autocomplete="one-time-code"], input[formcontrolname*="otp" i], input[name*="otp" i], input[type="tel"], input[type="text"]',
  )).filter((input) => isVisible(input));
  const digitInputs = inputs.filter((input) => input.maxLength === 1 || input.getAttribute('maxlength') === '1');
  if (digitInputs.length > 1) {
    otp.split('').forEach((digit, index) => setInputValue(digitInputs[index], digit));
  } else {
    const target = inputs[0];
    if (target) setInputValue(target, otp);
  }
  await clickVerifyButton();
}

async function applyRegisterCaptchaToken(token: string | null): Promise<void> {
  if (!token) return;
  let textarea = document.querySelector<HTMLTextAreaElement | HTMLInputElement>('[name="cf-turnstile-response"]');
  if (!textarea) {
    textarea = document.createElement('textarea');
    textarea.name = 'cf-turnstile-response';
    textarea.style.display = 'none';
    document.body.appendChild(textarea);
  }
  setInputValue(textarea, token);
  const widget = document.querySelector<HTMLElement>('[data-callback]');
  const callbackName = widget?.getAttribute('data-callback');
  const callback = callbackName ? getWindowCallback(callbackName) : undefined;
  if (callback) callback(token);
}

function isLoggedIn(): boolean {
  // Always trust the API call to be the source of truth. If we're not really
  // logged in, the /Slot/Get POST will return 401/403 and bubble up as a
  // regular EXT_POLL_RESULT with that status — no need to second-guess the
  // session locally. Local heuristics keep being wrong due to VFS UI quirks
  // (path is /uzb/en/lva/account vs /dashboard vs /home; multi-language text).
  return true;
}

async function pollSlot(monitor: MonitorConfig): Promise<PollSlotResult> {
  const loggedIn = isLoggedIn();
  const body = {
    countryCode: monitor.sourceCountry,
    missionCode: monitor.destination,
    vacCode: monitor.vacCode,
    visaCategoryCode: monitor.visaCategoryCode,
    roleName: monitor.roleName ?? 'Individual',
    loginUser: monitor.loginUser ?? '',
    payCode: '',
  };

  const response = await fetch(SLOT_API, {
    method: 'POST',
    credentials: 'include',
    mode: 'cors',
    headers: {
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/json;charset=UTF-8',
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {
    data = { rawText: text };
  }

  const earliestDate = typeof data === 'object' && data !== null && 'earliestDate' in data
    ? String((data as { earliestDate?: string | null }).earliestDate ?? '')
    : undefined;

  return { loggedIn, status: response.status, data, earliestDate: earliestDate || undefined };
}

async function fillForm(command: BookingCommand | CustomerBookingPayload): Promise<{ ok: true }> {
  const profile: Record<string, string> = 'profile' in command ? command.profile : { ...command };
  const selectors: Record<string, string[]> = {
    firstName: ['input[name="firstName"]', '#mat-input-0'],
    lastName: ['input[name="lastName"]', '#mat-input-1'],
    passportNumber: ['input[name="passportNumber"]', 'input[formcontrolname="passportNumber"]'],
    email: ['input[type="email"]', 'input[formcontrolname="email"]'],
    phone: ['input[type="tel"]', 'input[formcontrolname="phone"]'],
  };

  for (const [field, candidates] of Object.entries(selectors)) {
    const value = profile[field];
    if (!value) continue;
    await typeIntoFirst(candidates, value);
  }
  return { ok: true };
}

async function syncSessionToBackend(): Promise<void> {
  // Defensive: if the extension was reloaded since this content script attached,
  // chrome.runtime is invalidated and sendMessage will throw synchronously.
  // Swallow the error — the next page navigation will load a fresh content
  // script that talks to the live service worker.
  try {
    const cookies = document.cookie;
    const url = window.location.href;
    const email = await detectAccountEmailFromDashboard();
    await chrome.runtime.sendMessage({
      type: 'EXT_SESSION_SYNC',
      url,
      cookies,
      email,
      timestamp: new Date().toISOString(),
    });
  } catch {
    // Extension context invalidated, service worker dead, etc — silently ignore.
  }
}

function detectAccountEmailFromDashboard(): Promise<string | undefined> {
  return new Promise((resolve) => {
    const text = document.body.innerText || '';
    const m = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    resolve(m?.[0]);
  });
}

async function typeIntoFirst(selectors: string[], value: string): Promise<void> {
  const element = selectors.map((selector) => document.querySelector<HTMLInputElement>(selector)).find(Boolean);
  if (!element) {
    console.warn('[VFS-REG] no element matched any of:', selectors);
    return;
  }
  setInputValue(element, value);
}

// Check every consent checkbox on the VFS register form. There are 3:
//   1. Privacy Notice / processing of personal data
//   2. Data Transfer / international transfer
//   3. Terms & Conditions
// Skip the Cloudflare Turnstile checkbox — that one is handled by 2Captcha.
async function checkAllRegisterConsents(): Promise<void> {
  const boxes = Array.from(document.querySelectorAll<HTMLInputElement>(
    'input[type="checkbox"]'
  ));
  console.log('[VFS-REG] found', boxes.length, 'checkboxes on page');
  for (const box of boxes) {
    // Skip Turnstile widget's internal checkbox if any.
    const inTurnstile = box.closest('[data-sitekey], iframe, .cf-turnstile');
    if (inTurnstile) continue;
    if (!box.checked) {
      box.click();
      box.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }
}

function setInputValue(element: HTMLInputElement | HTMLTextAreaElement | undefined, value: string): void {
  if (!element) return;
  element.focus();
  element.value = value;
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

async function clickFirst(selectors: string[]): Promise<{ ok: true }> {
  const button = selectors.map(findElement).find(Boolean);
  if (!button) throw new Error('Submit button not found');
  button.click();
  return { ok: true };
}

function findElement(selector: string): HTMLElement | null {
  if (selector.includes(':has-text(')) {
    const text = selector.match(/:has-text\("(.+)"\)/)?.[1]?.toLowerCase();
    const tag = selector.split(':')[0] || 'button';
    return Array.from(document.querySelectorAll<HTMLElement>(tag))
      .find((element) => !text || element.innerText.toLowerCase().includes(text)) ?? null;
  }
  return document.querySelector<HTMLElement>(selector);
}

async function extractConfirmation(): Promise<{ confirmationNumber: string }> {
  const text = document.body.innerText;
  const confirmationNumber = text.match(/[A-Z0-9]{8,}/)?.[0] ?? '';
  return { confirmationNumber };
}

async function clickRegisterSubmit(): Promise<void> {
  const button = findButtonByText(['register', 'sign up', 'continue', 'create']) ?? document.querySelector<HTMLElement>('button[type="submit"]');
  if (!button) throw new Error('REGISTER_SUBMIT_BUTTON_NOT_FOUND');
  button.click();
}

async function clickVerifyButton(): Promise<void> {
  const button = findButtonByText(['verify', 'submit', 'continue']);
  if (button) button.click();
}

function findButtonByText(words: string[]): HTMLElement | null {
  return Array.from(document.querySelectorAll<HTMLElement>('button, input[type="submit"]'))
    .filter(isVisible)
    .find((element) => {
      const text = (element.innerText || element.getAttribute('value') || '').toLowerCase();
      return words.some((word) => text.includes(word));
    }) ?? null;
}

function isEmailVerificationStep(): boolean {
  const text = document.body.innerText.toLowerCase();
  return text.includes('verification email') || text.includes('verify your email') || text.includes('email sent');
}

function isPhoneOtpStep(): boolean {
  const text = document.body.innerText.toLowerCase();
  return text.includes('otp') || text.includes('one time password') || text.includes('verification code');
}

function isRegisterComplete(): boolean {
  const text = document.body.innerText.toLowerCase();
  return location.href.toLowerCase().includes('dashboard') ||
    text.includes('account created') ||
    text.includes('welcome') ||
    text.includes('registration successful');
}

async function waitForRegisterProgress(initialUrl: string): Promise<void> {
  await waitUntil(() => (
    window.location.href !== initialUrl ||
    isEmailVerificationStep() ||
    isPhoneOtpStep() ||
    isRegisterComplete()
  ), 30_000);
}

function waitForElement(selector: string, timeoutMs: number): Promise<Element> {
  return waitUntil(() => document.querySelector(selector), timeoutMs);
}

function waitUntil<T>(predicate: () => T | Promise<T>, timeoutMs: number): Promise<NonNullable<T>> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const result = await predicate();
        if (result) {
          resolve(result as NonNullable<T>);
          return;
        }
        if (Date.now() - startedAt >= timeoutMs) {
          reject(new Error('WAIT_TIMEOUT'));
          return;
        }
        window.setTimeout(tick, 500);
      } catch (error) {
        reject(error);
      }
    };
    void tick();
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, reason: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(reason)), timeoutMs);
    promise.then((value) => {
      window.clearTimeout(timer);
      resolve(value);
    }).catch((error: Error) => {
      window.clearTimeout(timer);
      reject(error);
    });
  });
}

function waitForRegisterSignal(kind: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      registerWaiters.delete(kind);
      reject(new Error(kind.toUpperCase() + '_TIMEOUT'));
    }, timeoutMs);
    registerWaiters.set(kind, (value) => {
      window.clearTimeout(timer);
      registerWaiters.delete(kind);
      resolve(value);
    });
  });
}

function resolveRegisterWaiter(kind: string, value: string | null): void {
  registerWaiters.get(kind)?.(value);
}

async function emitRegisterEvent(event: ExtensionEvent): Promise<void> {
  await chrome.runtime.sendMessage(event).catch(() => undefined);
}

function isVisible(element: HTMLElement): boolean {
  return Boolean(element.offsetParent || element.getClientRects().length);
}

function getWindowCallback(callbackName: string): ((token: string) => void) | undefined {
  const value = callbackName.split('.').reduce<unknown>((target, key) => {
    if (target && typeof target === 'object' && key in target) {
      return (target as Record<string, unknown>)[key];
    }
    return undefined;
  }, window);
  return typeof value === 'function' ? value as (token: string) => void : undefined;
}
