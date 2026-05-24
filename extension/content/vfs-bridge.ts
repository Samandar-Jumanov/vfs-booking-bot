import type {
  BookingCommand,
  ContentCommand,
  CustomerBookingPayload,
  ExtensionEvent,
  LoginFormPayload,
  MonitorConfig,
  PollSlotResult,
  RegisterFormPayload,
} from '../shared/types';

const SLOT_API = 'https://lift-api.vfsglobal.com/appointment/CheckIsSlotAvailable';
const REGISTER_STEP_TIMEOUT_MS = 180_000;
// Version marker so we can confirm in console which build is loaded.
const VFS_BRIDGE_VERSION = '2026-05-24-sniffer-document-start';
const LIFT_AUTH_HEADERS_KEY = 'liftAuthHeaders';

// VFS UZ login page email field — verified from live DOM 2026-05-23:
// id="email", formcontrolname="username", type="text" (NOT "emailid", which is
// the REGISTER page's field). The SPA "am I on the login page?" check must use
// this or it wrongly decides it's off-page and hunts for a Logout button.
const LOGIN_EMAIL_SELECTOR = '#email, input[formcontrolname="username"], input[formcontrolname="emailid"]';
// Activation page email field — cover login-style (#email/username) and
// register-style (emailid) variants since the activation form may use either.
const ACTIVATION_EMAIL_SELECTOR = '#email, input[formcontrolname="username"], input[formcontrolname="emailid"], input[name="emailid"], input[type="email"]';
const TRUSTED_CLICK_BLOCKED_BANNER = 'Bot click blocked. Close DevTools on this VFS tab and retry Auto-create. (Open DevTools on a different tab - e.g. the dashboard - instead.)';
console.log(`[VFS-REG] vfs-bridge.ts loaded version=${VFS_BRIDGE_VERSION}`);

let currentCorrelationId: string | undefined;
let liftHeaders: Record<string, string> = {};
const registerWaiters = new Map<string, (value: string | null) => void>();
type ActivationSignalValue = { ok: boolean; reason?: string };
const activationWaiters = new Map<string, (value: ActivationSignalValue) => void>();

chrome.runtime.onMessage.addListener((message: ContentCommand, _sender, sendResponse) => {
  void handleCommand(message).then(sendResponse).catch((error: Error) => {
    sendResponse({ ok: false, error: error.message });
  });
  return true;
});

window.postMessage({ source: 'vfs-booking-extension', type: 'EXTENSION_PRESENT' }, window.location.origin);
void hydrateLiftHeaders();
window.addEventListener('message', handleLiftAuthMessage);
void syncSessionToBackend();
window.setInterval(() => void syncSessionToBackend(), 60_000);

// The MAIN-world sniffer only captures after VFS itself calls lift-api, usually
// after navigating to the booking/appointment section. Operator must open that
// booking page once to seed headers before polling.
async function hydrateLiftHeaders(): Promise<void> {
  try {
    const stored = await chrome.storage.local.get(LIFT_AUTH_HEADERS_KEY);
    const headers = stored[LIFT_AUTH_HEADERS_KEY];
    if (isStringRecord(headers)) liftHeaders = headers;
  } catch (error) {
    console.warn('[VFS-REG] lift auth header hydrate failed', String((error as Error).message ?? error));
  }
}

function handleLiftAuthMessage(event: MessageEvent): void {
  try {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const data = event.data as { source?: unknown; headers?: unknown; url?: unknown; at?: unknown };
    if (data?.source !== 'vfs-lift-auth' || !isStringRecord(data.headers)) return;
    liftHeaders = data.headers;
    void chrome.storage.local.set({ [LIFT_AUTH_HEADERS_KEY]: liftHeaders });
    const authHeader = Object.entries(liftHeaders).find(([key]) => key.toLowerCase() === 'authorization')?.[1];
    console.log('[VFS-REG] captured lift-api auth headers', {
      headerCount: Object.keys(liftHeaders).length,
      hasAuthorization: Boolean(authHeader),
      authorization: authHeader ? `${authHeader.slice(0, 8)}...` : undefined,
      url: typeof data.url === 'string' ? data.url : undefined,
      at: typeof data.at === 'number' ? data.at : Date.now(),
    });
  } catch (error) {
    console.warn('[VFS-REG] lift auth message ignored', String((error as Error).message ?? error));
  }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return typeof value === 'object'
    && value !== null
    && Object.entries(value).every(([key, item]) => typeof key === 'string' && typeof item === 'string');
}

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
    case 'LOGIN_FILL_FORM':
      void handleLoginFlow(command.payload);
      return { ok: true };
    case 'LOGIN_VIA_SPA':
      void handleLoginViaSpa(command.payload);
      return { ok: true };
    case 'LOGIN_CAPTCHA_TOKEN':
      resolveRegisterWaiter('loginCaptchaToken', command.token);
      void applyRegisterCaptchaToken(command.token);
      return { ok: true };
    case 'ACTIVATE_VIA_SPA':
      void handleActivationViaSpa(command.payload);
      return { ok: true };
    case 'ACTIVATION_LINK_VISITED':
      resolveActivationWaiter('activationLinkVisited', { ok: command.ok, reason: command.reason });
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

async function handleLoginFlow(payload: LoginFormPayload): Promise<void> {
  currentCorrelationId = payload.correlationId;
  try {
    await withTimeout(runLoginSteps(payload), 90_000, 'LOGIN_TIMEOUT');
  } catch (error) {
    await emitLoginEvent({
      type: 'EXT_LOGIN_FAILED',
      correlationId: payload.correlationId,
      email: payload.email,
      reason: (error as Error).message,
    });
  }
}

async function handleLoginViaSpa(payload: LoginFormPayload): Promise<void> {
  currentCorrelationId = payload.correlationId;
  try {
    if (!document.querySelector(LOGIN_EMAIL_SELECTOR)) {
      await ensureOnLoginPage();
    }
    await withTimeout(runLoginSteps(payload), 90_000, 'LOGIN_TIMEOUT');
  } catch (error) {
    await emitLoginEvent({
      type: 'EXT_LOGIN_FAILED',
      correlationId: payload.correlationId,
      email: payload.email,
      reason: (error as Error).message,
    });
  }
}

async function ensureOnLoginPage(): Promise<void> {
  const loginSelector = LOGIN_EMAIL_SELECTOR;
  if (window.location.href.includes('/page-not-found')) throw new Error('WARM_TAB_NOT_VFS');
  if (document.querySelector(loginSelector)) return;

  const firstClick = findLogoutSpaElement();
  if (!firstClick) throw new Error('LOGOUT_BUTTON_NOT_FOUND');
  if (!(await trustedClick(firstClick))) throw new Error('LOGOUT_TRUSTED_CLICK_FAILED');

  const loginAppeared = await waitForElement(loginSelector, 2_000).then(() => true).catch(() => false);
  if (!loginAppeared) {
    const secondClick = findLogoutSpaElement(false);
    if (secondClick && secondClick !== firstClick && !(await trustedClick(secondClick))) {
      throw new Error('LOGOUT_TRUSTED_CLICK_FAILED');
    }
  }
  await waitForElement(loginSelector, 20_000).catch(() => {
    throw new Error('LOGOUT_NEVER_REACHED_LOGIN_FORM');
  });
}

function findLogoutSpaElement(includeProfileTrigger = true): HTMLElement | null {
  const selectors = [
    'button[aria-label*="logout" i]',
    'a[href*="logout" i]',
    '[data-test-id*="logout" i]',
    ...(includeProfileTrigger ? ['button:has(svg[data-icon*="user"])'] : []),
  ];
  for (const selector of selectors) {
    const match = safeQueryVisible(selector);
    if (match) return match;
  }
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('button,a,[role="button"],mat-icon,span,div'))) {
    if (!/logout|sign out/i.test(el.textContent ?? '')) continue;
    const clickable = closestClickable(el);
    if (clickable && isEnabledVisible(clickable)) return clickable;
  }
  return null;
}

function safeQueryVisible(selector: string): HTMLElement | null {
  try {
    return Array.from(document.querySelectorAll<HTMLElement>(selector)).find(isEnabledVisible) ?? null;
  } catch {
    return null;
  }
}

function closestClickable(element: HTMLElement): HTMLElement | null {
  return element.closest<HTMLElement>('button,a,[role="button"]') ?? element;
}

function isEnabledVisible(element: HTMLElement): boolean {
  return isVisible(element) && !(element as HTMLButtonElement).disabled && element.getAttribute('aria-disabled') !== 'true';
}

async function runLoginSteps(payload: LoginFormPayload): Promise<void> {
  await waitForElement(
    'input[type="email"], input[formcontrolname="emailid"], input[name="emailid"], input[formcontrolname="username"]',
    30_000,
  ).catch(() => undefined);

  // Fill with GENUINE keystrokes (chrome.debugger), not setInputValue — VFS UZ
  // leaves the Sign In button disabled unless input arrives as real typed
  // events. The real login email field is #email / formcontrolname="username".
  const emailEl = document.querySelector<HTMLInputElement>(LOGIN_EMAIL_SELECTOR);
  const pwdEl = document.querySelector<HTMLInputElement>(
    '#password, input[formcontrolname="password"], input[type="password"]',
  );
  if (emailEl) await trustedFill(emailEl, payload.email);
  if (pwdEl) await trustedFill(pwdEl, payload.password);

  // Tab once more to ensure Angular marks the form touched/validated.
  await trustedKey('Tab');
  await new Promise((r) => setTimeout(r, 300));

  const turnstile = document.querySelector<HTMLElement>('[data-sitekey], .cf-turnstile');
  const siteKey = turnstile?.getAttribute('data-sitekey');
  if (siteKey) {
    await emitLoginEvent({
      type: 'EXT_LOGIN_NEED_CAPTCHA',
      correlationId: payload.correlationId,
      siteKey,
      pageUrl: window.location.href,
    });
    const token = await waitForRegisterSignal('loginCaptchaToken', 75_000);
    if (!token) throw new Error('LOGIN_CAPTCHA_TOKEN_MISSING');
    await applyRegisterCaptchaToken(token);
  }

  // Replicate the human gesture the operator must do for VFS to accept the
  // login: a genuine pointer click INSIDE the form before pressing Sign In.
  // Observed 2026-05-23: filling fields programmatically + Tab leaves the
  // form ng-valid and the button enabled, but VFS ignores the submit unless
  // a real in-form pointer interaction happened first ("I always click the
  // form box before Sign In"). A trusted click on the email field provides
  // that transient user activation; setInputValue/Tab does not.
  const emailField = document.querySelector<HTMLElement>('#email, input[formcontrolname="username"]');
  if (emailField) {
    await trustedClick(emailField);
    await new Promise((r) => setTimeout(r, 250));
  }

  const initialUrl = window.location.href;
  await clickLoginSubmit(initialUrl);
  await waitUntil(() => isLoginSuccess(initialUrl) || isLoginFailureVisible(), 45_000);
  if (isLoginFailureVisible()) throw new Error(readLoginFailureReason());

  await syncSessionToBackend();
  await emitLoginEvent({
    type: 'EXT_LOGIN_SUCCESS',
    correlationId: payload.correlationId,
    email: payload.email,
    url: window.location.href,
  });
}

async function handleActivationViaSpa(payload: { email: string; correlationId: string }): Promise<void> {
  currentCorrelationId = payload.correlationId;
  try {
    await withTimeout(runActivationSteps(payload), 150_000, 'ACTIVATION_TIMEOUT');
  } catch (error) {
    await emitActivationEvent({
      type: 'EXT_ACTIVATION_FAILED',
      correlationId: payload.correlationId,
      email: payload.email,
      reason: (error as Error).message,
    });
  }
}

async function runActivationSteps(payload: { email: string; correlationId: string }): Promise<void> {
  if (window.location.href.includes('/page-not-found')) throw new Error('WARM_TAB_NOT_VFS');

  // 1. Get onto the activation page if we're not already there.
  if (!window.location.href.includes('/email-activation')) {
    const link = findActivateMyAccountLink();
    if (!link) throw new Error('ACTIVATE_LINK_NOT_FOUND');
    if (!(await trustedClick(link))) throw new Error('ACTIVATE_LINK_CLICK_FAILED');
    await waitForElement(ACTIVATION_EMAIL_SELECTOR, 20_000)
      .catch(() => { throw new Error('ACTIVATION_FORM_NEVER_APPEARED'); });
  }

  // 2. Fill the email field with GENUINE keystrokes (programmatic fill leaves
  // the Activate button disabled, exactly like the login form).
  const actEmailEl = document.querySelector<HTMLInputElement>(ACTIVATION_EMAIL_SELECTOR);
  if (actEmailEl) await trustedFill(actEmailEl, payload.email);
  await trustedKey('Tab');
  await new Promise((r) => setTimeout(r, 300));

  // 3. Solve Turnstile if present on the activation page.
  const turnstile = document.querySelector<HTMLElement>('[data-sitekey], .cf-turnstile');
  const siteKey = turnstile?.getAttribute('data-sitekey');
  if (siteKey) {
    await emitLoginEvent({
      type: 'EXT_LOGIN_NEED_CAPTCHA',
      correlationId: payload.correlationId,
      siteKey,
      pageUrl: window.location.href,
    });
    const token = await waitForRegisterSignal('loginCaptchaToken', 75_000);
    if (!token) throw new Error('ACTIVATION_CAPTCHA_TOKEN_MISSING');
    await applyRegisterCaptchaToken(token);
  }

  // 4. Submit the activation form (poll for enabled + retry, mirrors login).
  const initialUrl = window.location.href;
  await clickActivationSubmit(initialUrl);

  // 5. Tell backend we submitted — it will poll Mailsac + visit the activation link.
  await emitActivationEvent({
    type: 'EXT_ACTIVATION_SUBMITTED',
    correlationId: payload.correlationId,
    email: payload.email,
  });

  // 6. Wait for backend confirmation that the activation link visit succeeded.
  const result = await waitForActivationSignal('activationLinkVisited', 150_000);
  if (!result.ok) throw new Error('ACTIVATION_LINK_VISIT_FAILED:' + (result.reason ?? 'unknown'));

  // 7. SPA-return to login form. Try "Sign in" link / button by text.
  const backToLogin = findButtonByText(['sign in', 'login', 'log in', 'back to login']);
  if (backToLogin) {
    await trustedClick(backToLogin);
    await waitForElement('input[formcontrolname="emailid"]', 20_000).catch(() => undefined);
  }

  await emitActivationEvent({
    type: 'EXT_ACTIVATION_SUCCESS',
    correlationId: payload.correlationId,
    email: payload.email,
  });
}

async function clickActivationSubmit(initialUrl: string): Promise<void> {
  const findBtn = () => findButtonByText(['activate', 'submit', 'send', 'continue']) ??
    document.querySelector<HTMLElement>('button[type="submit"]');
  const isEnabled = (btn: HTMLElement): boolean => {
    const asBtn = btn as HTMLButtonElement;
    if (asBtn.disabled) return false;
    if (btn.getAttribute('aria-disabled') === 'true') return false;
    if (btn.hasAttribute('disabled')) return false;
    return true;
  };
  const hasTurnstileToken = (): boolean => {
    const sitekeyEl = document.querySelector('[data-sitekey], .cf-turnstile');
    if (!sitekeyEl) return true;
    const t = document.querySelector<HTMLTextAreaElement | HTMLInputElement>('[name="cf-turnstile-response"]');
    return Boolean(t?.value);
  };
  const isSubmitted = (): boolean => {
    const text = document.body.innerText.toLowerCase();
    return text.includes('verification email') ||
      text.includes('activation email') ||
      text.includes('check your inbox') ||
      text.includes('email has been sent') ||
      text.includes('activation link') ||
      window.location.href !== initialUrl;
  };

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const btn = findBtn();
    const tokenOk = hasTurnstileToken();
    const btnOk = btn ? isEnabled(btn) : false;
    if (btn && tokenOk && btnOk) {
      for (let attempt = 1; attempt <= 4; attempt++) {
        await trustedClick(btn);
        await new Promise((r) => setTimeout(r, 2000));
        if (isSubmitted()) return;
        const reBtn = findBtn();
        if (!reBtn) break;
        if (!isEnabled(reBtn)) {
          const reDeadline = Date.now() + 3000;
          while (Date.now() < reDeadline && !isEnabled(reBtn)) {
            await new Promise((r) => setTimeout(r, 200));
          }
        }
      }
      return;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('ACTIVATION_SUBMIT_BUTTON_NEVER_ENABLED');
}

function findActivateMyAccountLink(): HTMLElement | null {
  const candidates = Array.from(document.querySelectorAll<HTMLElement>('a, button'));
  return candidates.find((el) => isVisible(el) && /activate my account/i.test(el.textContent ?? '')) ?? null;
}

async function emitActivationEvent(event: ExtensionEvent): Promise<void> {
  await chrome.runtime.sendMessage(event).catch(() => undefined);
}

async function handleRegisterFlow(payload: RegisterFormPayload): Promise<void> {
  currentCorrelationId = payload.correlationId;
  void postRegisterTrace('handleRegisterFlow START', { url: location.href, email: payload.email });
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
  void postRegisterTrace('runRegisterSteps START', { url: location.href });
  // Wait for ALL the form controls we plan to touch, not just the early ones.
  // Mobile was failing to fill because we proceeded before the contact input
  // had rendered.
  await waitForElement('input[formcontrolname="contact"]', 30_000).catch(() => undefined);
  await waitForElement('mat-select[formcontrolname="dialcode"]', 10_000).catch(() => undefined);
  console.log('[VFS-REG] form fields detected, filling…');
  void postRegisterTrace('form fields detected', { url: location.href });

  // VFS Uzbekistan /register form (verified from operator screenshots 2026-05-20):
  //   Email • Password • Confirm Password • Mobile Number (dial-code+number) •
  //   3 consent checkboxes • Cloudflare Turnstile • Register button.
  // NO firstName / lastName / DOB. Old code targeted non-existent fields and
  // failed silently → "Mandatory field cannot be left blank" → 5-min timeout.
  // VFS Uzbekistan uses 'emailid' and 'contact' as formcontrolname (not the
  // standard 'email' / 'mobileNumber'). Verified from real trace 2026-05-20.
  // Fill email + password + confirm-password with GENUINE keystrokes
  // (chrome.debugger), exactly like runLoginSteps. Programmatic .value-setting
  // (the old typeIntoFirst path) does NOT enable VFS's Angular Register button —
  // VFS only marks the form valid when input arrives as real typed events.
  await trustedFillFirst([
    'input[formcontrolname="emailid"]',
    'input[name="emailid"]',
    'input[id*="email" i]',
    'input[type="email"]',
    'input[formcontrolname="email"]',
    'input[name="email"]',
  ], payload.email);
  await trustedFillFirst([
    'input[formcontrolname="password"]',
    'input[name="password"]',
    'input[type="password"]',
  ], payload.password);
  await trustedFillFirst([
    'input[type="password"][formcontrolname="confirmPassword"]',
    'input[formcontrolname="confirmPassword"]',
    'input[name="confirmPassword"]',
  ], payload.password);
  // Tab once to mark the form touched/validated, mirroring runLoginSteps.
  await trustedKey('Tab');
  await new Promise((r) => setTimeout(r, 300));
  // Fill Mobile FIRST so it's done before any dial-code dropdown weirdness
  // can mess with the form state. VFS expects the LOCAL number (no country code).
  const localPhone = payload.phone.replace(/^\+?998/, '').replace(/^\+/, '');
  await typeIntoFirst([
    'input[formcontrolname="contact"]',  // ← real VFS UZ field name
    'input[name="contact"]',
    'input[formcontrolname="mobileNumber"]',
    'input[type="tel"]',
    'input[name="phone"]',
    'input[name="mobile"]',
    'input[placeholder*="Mobile" i]',
  ], localPhone);
  // Check all 3 consent checkboxes (Privacy Notice, Data Transfer, Terms).
  await checkAllRegisterConsents();
  console.log('[VFS-REG] consents checked');
  // Now try dial code. If it fails, we show a banner asking the operator to
  // click it manually — the page-transition watcher catches the submit either way.
  await selectDialCode998();

  // Re-fill mobile AFTER dial code selects. Angular Material's validation chain
  // can reset the contact field when dialcode was empty at first typing, OR
  // when the dropdown clicks bubble through and steal focus. Always re-set
  // the value, verify it sticks.
  const contactEl = document.querySelector<HTMLInputElement>('input[formcontrolname="contact"]');
  if (contactEl && contactEl.value !== localPhone) {
    void postRegisterTrace('mobile field was cleared after dial code, re-filling', {
      previousValue: maskForLog(contactEl.value),
    });
    setInputValue(contactEl, localPhone);
    // Give Angular time to commit the value, then verify
    await new Promise((r) => setTimeout(r, 500));
    void postRegisterTrace('mobile re-fill result', {
      currentValue: maskForLog(contactEl.value),
      stuck: contactEl.value === localPhone,
    });
  }

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
  // Trace what's actually in the form right before submit, so we can see
  // if Angular committed the values to its FormControl.
  const formSnapshot: Record<string, string> = {};
  document.querySelectorAll<HTMLInputElement>('input').forEach((inp) => {
    const key = inp.getAttribute('formcontrolname') || inp.getAttribute('name') || inp.type;
    if (!key) return;
    formSnapshot[key] = maskForLog(inp.value);
  });
  void postRegisterTrace('pre-submit form snapshot', formSnapshot);
  // Also check if validation errors are visible on the page
  const errors = Array.from(document.querySelectorAll('.error, .mat-error, .invalid-feedback, [class*="error" i]'))
    .map(e => (e as HTMLElement).innerText?.trim())
    .filter(s => s && s.length < 200);
  if (errors.length) void postRegisterTrace('pre-submit visible errors', { errors });
  // Try to click submit. If it throws (button never enabled, etc.) we
  // DON'T bail — the operator might click manually, or Turnstile may take
  // longer than our 60s wait. We just log and proceed to page-transition
  // detection.
  let clickOk = false;
  try {
    await clickRegisterSubmit();
    clickOk = true;
    void postRegisterTrace('submit clicked by bot', { initialUrl });
  } catch (err) {
    void postRegisterTrace('submit click failed (bot) — waiting for operator', {
      reason: (err as Error).message,
    });
  }

  // Snapshot the page state RIGHT AFTER submit attempts so we can see what
  // VFS actually rendered. Helps diagnose "click fired but no transition".
  setTimeout(() => {
    const bodySample = postSubmitBodySample(document.body.innerText);
    const hasForm = Boolean(document.querySelector('input[formcontrolname="emailid"]'));
    const url = window.location.href;
    void postRegisterTrace('post-submit page snapshot', { bodyTextSample: bodySample, url, hasEmailField: hasForm });
  }, 3000);

  // Wait up to 3 minutes for page transition OR "verification email sent"
  // text. This covers both: bot clicked successfully, OR operator clicked
  // after bot gave up.
  const handoffDeadline = Date.now() + 180_000;
  while (Date.now() < handoffDeadline) {
    if (
      window.location.href !== initialUrl ||
      isEmailVerificationStep() ||
      isRegisterComplete()
    ) {
      void postRegisterTrace('submitted, handing off to backend for email link', {
        url: location.href,
        email: payload.email,
        clickByBot: clickOk,
      });
      await emitRegisterEvent({
        type: 'EXT_REGISTER_SUBMITTED',
        correlationId: payload.correlationId,
        email: payload.email,
      });
      // INSURANCE: VFS often doesn't deliver the first activation email
      // (especially to throwaway domains like mailsac). Navigate to the
      // /email-activation page and trigger an explicit resend as a backup.
      // Backend's poll loop has 240s — plenty for either email to arrive.
      void triggerActivationResend(payload).catch((err) => {
        void postRegisterTrace('activation resend failed (non-fatal)', { reason: (err as Error).message });
      });
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  // Page never transitioned in 3 min — register really didn't go through.
  throw new Error('REGISTER_PAGE_NEVER_TRANSITIONED');
}

// Navigate to VFS's /email-activation page and trigger an explicit resend
// of the activation email. Used as a fallback because VFS sometimes silently
// skips the initial activation email send.
async function triggerActivationResend(payload: RegisterFormPayload): Promise<void> {
  // Don't fire immediately — let backend's poll start first so a successful
  // first-email path can short-circuit before we even resend.
  await new Promise((r) => setTimeout(r, 10_000));

  // Build the email-activation URL from the original register URL pattern.
  const activationUrl = location.href.replace(/\/register.*$/, '/email-activation');
  void postRegisterTrace('navigating to /email-activation for resend', { url: activationUrl, email: payload.email });
  window.location.href = activationUrl;

  // Wait for the email-activation page to render its email input.
  await waitForElement('input[type="email"], input[formcontrolname="emailid"], input[name="emailid"]', 30_000).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 1500));

  // Fill the email field with the registered email.
  await typeIntoFirst([
    'input[formcontrolname="emailid"]',
    'input[name="emailid"]',
    'input[type="email"]',
    'input[id*="email" i]',
  ], payload.email);
  void postRegisterTrace('activation resend: email filled', { email: payload.email });

  // Solve Turnstile if present on this page (different site key possible).
  const turnstile = document.querySelector<HTMLElement>('[data-sitekey]');
  const siteKey = turnstile?.getAttribute('data-sitekey');
  if (siteKey) {
    await emitRegisterEvent({
      type: 'EXT_REGISTER_NEED_CAPTCHA',
      correlationId: payload.correlationId,
      siteKey,
      pageUrl: window.location.href,
    });
    const token = await waitForRegisterSignal('captchaToken', 90_000).catch(() => null);
    if (token) {
      await applyRegisterCaptchaToken(token);
      void postRegisterTrace('activation resend: captcha token injected', {});
    } else {
      void postRegisterTrace('activation resend: captcha token MISSING', {});
    }
  }

  // Wait for the Activate button to enable, then trusted-click it.
  const findActivate = () =>
    findButtonByText(['activate', 'send', 'submit', 'resend']) ?? document.querySelector<HTMLElement>('button[type="submit"]');
  const dl = Date.now() + 30_000;
  while (Date.now() < dl) {
    const btn = findActivate();
    if (btn && !(btn as HTMLButtonElement).disabled && btn.getAttribute('aria-disabled') !== 'true') {
      void postRegisterTrace('activation resend: clicking Activate', {});
      const ok = await trustedClick(btn);
      void postRegisterTrace('activation resend: Activate clicked', { ok });
      // Wait briefly for VFS's confirmation message.
      await new Promise((r) => setTimeout(r, 4000));
      const bodySample = document.body.innerText.slice(0, 400);
      void postRegisterTrace('activation resend: post-click body sample', { bodyTextSample: bodySample });
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  void postRegisterTrace('activation resend: Activate button never enabled', {});
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

  if (Object.keys(liftHeaders).length === 0) {
    console.warn('[VFS-REG] POLL_NO_AUTH_CAPTURED');
    return { loggedIn, status: 0, data: { code: 'POLL_NO_AUTH_CAPTURED' } };
  }

  const response = await fetch(SLOT_API, {
    method: 'POST',
    credentials: 'include',
    mode: 'cors',
    headers: {
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/json;charset=UTF-8',
      ...liftHeaders,
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
    void postRegisterTrace('typeIntoFirst NO MATCH', { selectors, value: maskForLog(value) });
    return;
  }
  setInputValue(element, value);
  // Verify post-write
  const actual = element.value;
  if (actual !== value) {
    void postRegisterTrace('typeIntoFirst MISMATCH', { selector: selectors[0], expected: maskForLog(value), actual: maskForLog(actual) });
  }
}

// Like typeIntoFirst, but fills via trustedFill (real chrome.debugger keystrokes)
// so VFS's Angular form actually enables its submit button. Used for the
// register email/password fields — see runLoginSteps for the same pattern.
async function trustedFillFirst(selectors: string[], value: string): Promise<void> {
  const element = selectors.map((selector) => document.querySelector<HTMLInputElement>(selector)).find(Boolean);
  if (!element) {
    console.warn('[VFS-REG] trustedFillFirst no element matched any of:', selectors);
    void postRegisterTrace('trustedFillFirst NO MATCH', { selectors });
    return;
  }
  await trustedFill(element, value);
}

function maskForLog(s: string): string {
  if (!s) return '';
  if (s.length <= 4) return '****';
  return s.slice(0, 2) + '***' + s.slice(-2);
}

// Open the Dial Code dropdown and pick "998" (Uzbekistan). VFS uses either
// a native <select> or an Angular Material mat-select component. Try native
// first (simple), then Material click pattern.
async function selectDialCode998(): Promise<void> {
  // Always emit so we know the function ran at all. Includes a count of
  // mat-select elements on the page so we can verify the trigger exists.
  const matCount = document.querySelectorAll('mat-select').length;
  const exactHit = Boolean(document.querySelector('mat-select[formcontrolname="dialcode"]'));
  void postRegisterTrace('selectDialCode998 ENTRY', {
    version: VFS_BRIDGE_VERSION,
    matSelectCount: matCount,
    exactDialcodeHit: exactHit,
    href: location.href,
  });
  console.log(`[VFS-REG] selectDialCode998 ENTRY ver=${VFS_BRIDGE_VERSION} matCount=${matCount} exactHit=${exactHit}`);

  // Native select
  const nativeSelect = document.querySelector<HTMLSelectElement>(
    'select[formcontrolname="dialCode"], select[name="dialCode"], select[name="countryCode"]'
  );
  if (nativeSelect) {
    const opt = Array.from(nativeSelect.options).find(o => o.value === '998' || /998/.test(o.textContent || ''));
    if (opt) {
      nativeSelect.value = opt.value;
      nativeSelect.dispatchEvent(new Event('change', { bubbles: true }));
      console.log('[VFS-REG] native dial-code 998 selected');
      return;
    }
  }
  // VFS UZ uses formcontrolname="dialcode" (all lowercase). Try the exact
  // name first, then fall back to fuzzy / first-mat-select heuristics.
  let trigger: HTMLElement | undefined =
    document.querySelector<HTMLElement>('mat-select[formcontrolname="dialcode"]') ??
    document.querySelector<HTMLElement>('mat-select[formcontrolname="dialCode"]') ??
    undefined;
  if (!trigger) {
    const candidates: HTMLElement[] = Array.from(document.querySelectorAll<HTMLElement>(
      'mat-select, .mat-mdc-select, [role="combobox"]',
    ));
    trigger = candidates.find((el) => {
      const fcn = el.getAttribute('formcontrolname') ?? '';
      const al = el.getAttribute('aria-label') ?? '';
      return /dial|country|code/i.test(fcn) || /dial|country|code/i.test(al);
    }) ?? candidates[0];
  }
  if (!trigger) {
    console.warn('[VFS-REG] dial-code dropdown trigger not found');
    void postRegisterTrace('dial-code trigger NOT FOUND', {});
    return;
  }

  void postRegisterTrace('dial-code trigger found', {
    tag: trigger.tagName,
    fcn: trigger.getAttribute('formcontrolname'),
    id: trigger.id,
  });

  const findOption = (): HTMLElement | undefined =>
    Array.from(document.querySelectorAll<HTMLElement>(
      'mat-option, .mat-option, .mat-mdc-option, [role="option"], .ng-option',
    )).find((el) => /\b\+?998\b|uzbekistan/i.test((el.textContent ?? '').trim()));
  const hasOpenPanel = (): boolean =>
    trigger.getAttribute('aria-expanded') === 'true' ||
    Boolean(document.querySelector('.mat-mdc-select-panel, .mat-select-panel, [role="listbox"]'));
  const isSelected = (): boolean => {
    const disp = trigger.querySelector<HTMLElement>('.mat-mdc-select-value, .mat-select-value');
    const text = ((disp?.textContent ?? '') || trigger.textContent || '').trim();
    return /998/.test(text);
  };
  const waitForOption = async (timeoutMs: number): Promise<HTMLElement | undefined> => {
    const deadline = Date.now() + timeoutMs;
    let option: HTMLElement | undefined;
    while (Date.now() < deadline && !option) {
      option = findOption();
      if (!option) await new Promise((r) => setTimeout(r, 100));
    }
    return option;
  };

  void postRegisterTrace('dial-code structure', dumpDialCodeSelectStructure(trigger));

  if (isSelected()) {
    void postRegisterTrace('dial-code already selected', {
      display: (trigger.querySelector('.mat-mdc-select-value, .mat-select-value')?.textContent ?? '').trim(),
    });
    return;
  }

  const clickTargets: Array<{ name: string; element: HTMLElement }> = [
    { name: '.mat-mdc-select-trigger', element: trigger.querySelector<HTMLElement>('.mat-mdc-select-trigger, .mat-select-trigger') ?? trigger },
    { name: '.mat-mdc-select-value', element: trigger.querySelector<HTMLElement>('.mat-mdc-select-value, .mat-select-value') ?? trigger },
    { name: '.mat-mdc-select-arrow-wrapper', element: trigger.querySelector<HTMLElement>('.mat-mdc-select-arrow-wrapper, .mat-select-arrow-wrapper') ?? trigger },
    { name: '.mat-mdc-select-arrow', element: trigger.querySelector<HTMLElement>('.mat-mdc-select-arrow, .mat-select-arrow') ?? trigger },
    { name: 'mat-select host', element: trigger },
  ];

  let clickAttempted = false;
  let debuggerBlocked = false;
  for (const target of clickTargets) {
    if (!target.element || !isVisible(target.element)) continue;
    clickAttempted = true;
    void postRegisterTrace('dial-code trying trusted click target', {
      target: target.name,
      rect: rectSummary(target.element),
      expandedBefore: trigger.getAttribute('aria-expanded'),
    });
    const clicked = await trustedClick(target.element);
    void postRegisterTrace('dial-code trusted click target result', {
      target: target.name,
      ok: clicked,
      expandedAfter: trigger.getAttribute('aria-expanded'),
      panelCount: document.querySelectorAll('.mat-mdc-select-panel, .mat-select-panel, [role="listbox"]').length,
      anyOptions: document.querySelectorAll('mat-option, .mat-mdc-option, [role="option"]').length,
    });
    if (!clicked) {
      debuggerBlocked = true;
      continue;
    }
    const option = await waitForOption(hasOpenPanel() ? 2500 : 1000);
    if (option) {
      await selectDialCodeOption(trigger, option, 'trusted click on ' + target.name);
      if (isSelected()) return;
    }
    if (hasOpenPanel()) break;
  }

  if (!findOption()) {
    const openedByAngular = await tryAngularMaterialOpen(trigger);
    void postRegisterTrace('dial-code angular open result', {
      ok: openedByAngular,
      expandedAfter: trigger.getAttribute('aria-expanded'),
      panelCount: document.querySelectorAll('.mat-mdc-select-panel, .mat-select-panel, [role="listbox"]').length,
    });
    const option = openedByAngular ? await waitForOption(2500) : undefined;
    if (option) {
      await selectDialCodeOption(trigger, option, 'angular component open');
      if (isSelected()) return;
    }
  }

  for (const key of ['Enter', 'Space', 'ArrowDown']) {
    const focusTarget = trigger.querySelector<HTMLElement>('.mat-mdc-select-trigger, .mat-select-trigger') ?? trigger;
    await trustedClick(focusTarget);
    trigger.focus();
    void postRegisterTrace('dial-code trying trusted key', {
      key,
      activeTag: document.activeElement?.tagName,
      activeId: (document.activeElement as HTMLElement | null)?.id,
      activeIsTrigger: document.activeElement === trigger,
      expandedBefore: trigger.getAttribute('aria-expanded'),
    });
    const keyOk = await trustedKey(key);
    void postRegisterTrace('dial-code trusted key result', {
      key,
      ok: keyOk,
      expandedAfter: trigger.getAttribute('aria-expanded'),
      panelCount: document.querySelectorAll('.mat-mdc-select-panel, .mat-select-panel, [role="listbox"]').length,
    });
    const option = await waitForOption(2000);
    if (option) {
      await selectDialCodeOption(trigger, option, 'trusted key ' + key);
      if (isSelected()) return;
    }
  }

  void postRegisterTrace('dial-code option not found after all open attempts', {
    clickAttempted,
    debuggerBlocked,
    panelCount: document.querySelectorAll('.mat-mdc-select-panel, .mat-select-panel, [role="listbox"]').length,
    anyOptions: document.querySelectorAll('mat-option, .mat-mdc-option, [role="option"]').length,
    expanded: trigger.getAttribute('aria-expanded'),
  });
  if (!clickAttempted || debuggerBlocked) {
    showOperatorBanner(TRUSTED_CLICK_BLOCKED_BANNER);
    return;
  }
  showOperatorBanner('Bot could not auto-select dial code. Please click the Dial Code dropdown and choose "Uzbekistan(998)", then click Register.');
  return;
  /*

  const innerTrigger = trigger!.querySelector<HTMLElement>('.mat-mdc-select-trigger, .mat-select-trigger') ?? trigger!;

  // === TRUSTED-CLICK PATH ===
  // Use chrome.debugger via the background SW to dispatch a real OS-level
  // click on the trigger. This passes Material MDC's `event.isTrusted` check,
  // which dispatched events from a content script never could.
  // IMPORTANT: chrome.debugger fails if DevTools is open on this tab.
  console.log('[VFS-REG] selectDialCode998 — about to request trusted click on trigger');
  void postRegisterTrace('dial-code trying trusted click on trigger', {});
  const triggerClicked = await trustedClick(innerTrigger);
  console.log('[VFS-REG] selectDialCode998 — trusted click on trigger returned:', triggerClicked);
  void postRegisterTrace('dial-code trusted click on trigger result', { ok: triggerClicked });
  if (!triggerClicked) {
    showOperatorBanner('Bot click blocked (likely DevTools open on this tab — close DevTools, then click Dial Code → Uzbekistan(998) → Register).');
    return;
  }

  // Wait up to 3s for the option list to render after the trusted click.
  const optDeadline = Date.now() + 3000;
  let option: HTMLElement | undefined;
  while (Date.now() < optDeadline && !option) {
    option = findOption();
    if (!option) await new Promise((r) => setTimeout(r, 100));
  }
  if (!option) {
    void postRegisterTrace('dial-code option not found after trusted open', {
      panelCount: document.querySelectorAll('.mat-mdc-select-panel, .mat-select-panel').length,
      anyOptions: document.querySelectorAll('mat-option, .mat-mdc-option, [role="option"]').length,
    });
    showOperatorBanner('Bot could not auto-select dial code. Please click the Dial Code dropdown and choose "Uzbekistan(998)", then click Register.');
    return;
  }

  void postRegisterTrace('dial-code option found, trusted-clicking', {
    text: (option!.textContent ?? '').trim().slice(0, 40),
  });
  const optionClicked = await trustedClick(option!);
  await new Promise((r) => setTimeout(r, 500));
  if (isSelected()) {
    void postRegisterTrace('dial-code 998 SELECTED via trusted click', {
      display: (trigger!.querySelector('.mat-mdc-select-value, .mat-select-value')?.textContent ?? '').trim(),
    });
    console.log('[VFS-REG] dial-code 998 selected via trusted click');
    return;
  }

  void postRegisterTrace('dial-code trusted click on option did not select', { ok: optionClicked });
  showOperatorBanner('Bot could not auto-select dial code. Please click the Dial Code dropdown and choose "Uzbekistan(998)", then click Register.');
  */
}

async function selectDialCodeOption(trigger: HTMLElement, option: HTMLElement, method: string): Promise<void> {
  void postRegisterTrace('dial-code option found, trusted-clicking', {
    method,
    text: (option.textContent ?? '').trim().slice(0, 80),
    rect: rectSummary(option),
  });
  const optionClicked = await trustedClick(option);
  await new Promise((r) => setTimeout(r, 500));
  const display = (trigger.querySelector('.mat-mdc-select-value, .mat-select-value')?.textContent ?? '').trim();
  if (/998/.test(display)) {
    void postRegisterTrace('dial-code 998 SELECTED', { method, display });
    console.log('[VFS-REG] dial-code 998 selected via', method);
    return;
  }
  void postRegisterTrace('dial-code option click did not select', { method, ok: optionClicked, display });
}

function dumpDialCodeSelectStructure(trigger: HTMLElement): Record<string, unknown> {
  const query = (selector: string) => trigger.querySelector<HTMLElement>(selector);
  return {
    outerHTML: trigger.outerHTML.slice(0, 500),
    rect: rectSummary(trigger),
    triggerRect: rectSummary(query('.mat-mdc-select-trigger, .mat-select-trigger')),
    valueRect: rectSummary(query('.mat-mdc-select-value, .mat-select-value')),
    arrowWrapperRect: rectSummary(query('.mat-mdc-select-arrow-wrapper, .mat-select-arrow-wrapper')),
    arrowRect: rectSummary(query('.mat-mdc-select-arrow, .mat-select-arrow')),
    disabled: trigger.getAttribute('aria-disabled'),
    ariaExpanded: trigger.getAttribute('aria-expanded'),
    classList: Array.from(trigger.classList),
  };
}

function rectSummary(element: HTMLElement | null | undefined): Record<string, number> | null {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    left: Math.round(rect.left),
    top: Math.round(rect.top),
    right: Math.round(rect.right),
    bottom: Math.round(rect.bottom),
  };
}

async function tryAngularMaterialOpen(trigger: HTMLElement): Promise<boolean> {
  const marker = 'vfsDialCodeOpenResult_' + Math.random().toString(36).slice(2);
  trigger.setAttribute('data-vfs-dialcode-open-marker', marker);
  return new Promise((resolve) => {
    const script = document.createElement('script');
    const timeout = window.setTimeout(() => {
      cleanup();
      resolve(false);
    }, 1000);
    const cleanup = () => {
      window.clearTimeout(timeout);
      window.removeEventListener(marker, onResult as EventListener);
      script.remove();
      trigger.removeAttribute('data-vfs-dialcode-open-marker');
    };
    const onResult = (event: Event) => {
      cleanup();
      resolve(Boolean((event as CustomEvent<{ ok?: boolean }>).detail?.ok));
    };
    window.addEventListener(marker, onResult as EventListener, { once: true });
    script.textContent = `
      (() => {
        let ok = false;
        try {
          const ms = document.querySelector('[data-vfs-dialcode-open-marker="${marker}"]');
          const cmp = ms && window.ng && typeof window.ng.getComponent === 'function' ? window.ng.getComponent(ms) : null;
          if (cmp && typeof cmp.open === 'function') {
            cmp.open();
            ok = true;
          }
        } catch {}
        window.dispatchEvent(new CustomEvent('${marker}', { detail: { ok } }));
      })();
    `;
    (document.documentElement || document.head || document.body).appendChild(script);
  });
}

function showOperatorBanner(message: string): void {
  // Idempotent: don't add duplicates.
  if (document.getElementById('vfs-bot-banner')) return;
  const banner = document.createElement('div');
  banner.id = 'vfs-bot-banner';
  banner.style.cssText = 'position:fixed;bottom:0;left:0;right:0;background:#fef3c7;color:#92400e;padding:12px 20px;font-family:sans-serif;font-size:14px;font-weight:600;z-index:2147483647;border-top:2px solid #f59e0b;text-align:center;box-shadow:0 -2px 8px rgba(0,0,0,0.1);';
  banner.textContent = `[VFS Bot] ${message}`;
  document.body.appendChild(banner);
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
  // Use the native value setter so Angular's NgModel/FormControl picks up
  // the new value. Plain `element.value = ...` updates the DOM but Angular's
  // input event handler reads via the prototype's value-tracking setter,
  // which gets bypassed when you assign directly.
  const proto = element instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (nativeSetter) {
    nativeSetter.call(element, value);
  } else {
    element.value = value;
  }
  // InputEvent (not Event) is what Angular's (input) binding listens for.
  element.dispatchEvent(new InputEvent('input', { bubbles: true, data: value }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
  element.dispatchEvent(new Event('blur', { bubbles: true }));
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
  const findBtn = () =>
    findButtonByText(['register', 'sign up', 'continue', 'create']) ?? document.querySelector<HTMLElement>('button[type="submit"]');
  const isEnabled = (btn: HTMLElement) => {
    const asBtn = btn as HTMLButtonElement;
    if (asBtn.disabled) return false;
    if (btn.getAttribute('aria-disabled') === 'true') return false;
    if (btn.hasAttribute('disabled')) return false;
    return true;
  };
  const hasTurnstileToken = () => {
    const t = document.querySelector<HTMLTextAreaElement | HTMLInputElement>('[name="cf-turnstile-response"]');
    return Boolean(t?.value);
  };
  // Wait up to 60s for both: Turnstile token present AND button enabled.
  // VFS won't accept submit without both.
  const deadline = Date.now() + 60_000;
  let lastLogAt = 0;
  while (Date.now() < deadline) {
    const btn = findBtn();
    const tokenOk = hasTurnstileToken();
    const btnOk = btn ? isEnabled(btn) : false;
    if (btn && tokenOk && btnOk) {
      // VFS sometimes enables the button momentarily during Turnstile
      // verification but rejects the first click. Click multiple times
      // with verification between each — stop as soon as the page
      // transitions to the verification-email screen.
      const initialUrl = window.location.href;
      for (let attempt = 1; attempt <= 4; attempt++) {
        const ok = await trustedClick(btn);
        void postRegisterTrace('register submit trusted-clicked', { attempt, tokenOk, btnOk, ok });
        // Wait 2s for VFS to process the click + transition.
        await new Promise((r) => setTimeout(r, 2000));
        if (
          window.location.href !== initialUrl ||
          isEmailVerificationStep() ||
          isRegisterComplete()
        ) {
          void postRegisterTrace('register submit succeeded', { attempt, url: location.href });
          return;
        }
        // Re-check button before next attempt — it may have disabled itself
        // momentarily and we should wait for it to re-enable.
        const reBtn = findBtn();
        if (!reBtn) break;
        const reEnabled = isEnabled(reBtn);
        if (!reEnabled) {
          void postRegisterTrace('register submit button disabled after click — waiting to re-enable', { attempt });
          // Wait up to 3s for the button to come back, then try again.
          const reDeadline = Date.now() + 3000;
          while (Date.now() < reDeadline && !isEnabled(reBtn)) {
            await new Promise((r) => setTimeout(r, 200));
          }
        }
      }
      void postRegisterTrace('register submit exhausted retries', {});
      return;
    }
    if (Date.now() - lastLogAt > 5000) {
      void postRegisterTrace('register submit waiting', { btnFound: Boolean(btn), tokenOk, btnEnabled: btnOk });
      lastLogAt = Date.now();
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('REGISTER_SUBMIT_BUTTON_NEVER_ENABLED');
}

async function clickLoginSubmit(initialUrl: string): Promise<void> {
  const findBtn = () => findLoginButton();
  const isEnabled = (btn: HTMLElement): boolean => {
    const asBtn = btn as HTMLButtonElement;
    if (asBtn.disabled) return false;
    if (btn.getAttribute('aria-disabled') === 'true') return false;
    if (btn.hasAttribute('disabled')) return false;
    return true;
  };
  const hasTurnstileToken = (): boolean => {
    const sitekeyEl = document.querySelector('[data-sitekey], .cf-turnstile');
    if (!sitekeyEl) return true;
    const t = document.querySelector<HTMLTextAreaElement | HTMLInputElement>('[name="cf-turnstile-response"]');
    return Boolean(t?.value);
  };

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const btn = findBtn();
    const tokenOk = hasTurnstileToken();
    const btnOk = btn ? isEnabled(btn) : false;
    if (btn && tokenOk && btnOk) {
      for (let attempt = 1; attempt <= 4; attempt++) {
        await trustedClick(btn);
        await new Promise((r) => setTimeout(r, 2000));
        if (
          window.location.href !== initialUrl ||
          isLoginSuccess(initialUrl) ||
          isLoginFailureVisible()
        ) {
          return;
        }
        const reBtn = findBtn();
        if (!reBtn) break;
        if (!isEnabled(reBtn)) {
          const reDeadline = Date.now() + 3000;
          while (Date.now() < reDeadline && !isEnabled(reBtn)) {
            await new Promise((r) => setTimeout(r, 200));
          }
        }
      }
      return;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('LOGIN_SUBMIT_BUTTON_NEVER_ENABLED');
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

function findLoginButton(): HTMLElement | null {
  return findButtonByText(['sign in', 'login', 'log in', 'continue']) ??
    document.querySelector<HTMLElement>('button[type="submit"], input[type="submit"]');
}

function isLoginSuccess(initialUrl: string): boolean {
  const url = window.location.href.toLowerCase();
  const text = document.body.innerText.toLowerCase();
  if (url !== initialUrl.toLowerCase() && !url.includes('/login')) return true;
  return url.includes('/dashboard') ||
    url.includes('/account') ||
    text.includes('dashboard') ||
    text.includes('logout') ||
    text.includes('sign out') ||
    text.includes('book an appointment') ||
    text.includes('schedule appointment');
}

function isLoginFailureVisible(): boolean {
  const text = document.body.innerText.toLowerCase();
  return text.includes('invalid') ||
    text.includes('incorrect') ||
    text.includes('login failed') ||
    text.includes('sign in failed') ||
    text.includes('mandatory field') ||
    text.includes('try again later');
}

function readLoginFailureReason(): string {
  const errors = Array.from(document.querySelectorAll<HTMLElement>(
    '.error, .mat-error, .invalid-feedback, [class*="error" i], [role="alert"]',
  ))
    .map((element) => element.innerText.trim())
    .filter((text) => text.length > 0 && text.length < 200);
  return errors[0] || 'LOGIN_FAILED';
}

function isEmailVerificationStep(): boolean {
  const text = document.body.innerText.toLowerCase();
  // Look for any signal that VFS accepted the registration and is showing
  // a confirmation/email-sent message. Several possible variants observed.
  if (
    text.includes('almost there') ||
    text.includes('verification email') ||
    text.includes('verify your email') ||
    text.includes('email sent') ||
    text.includes('email has been sent') ||
    text.includes('check your email') ||
    text.includes('check your inbox') ||
    text.includes('successfully registered') ||
    text.includes('successfully created') ||
    text.includes('thank you for registering') ||
    text.includes('thank you for signing up') ||
    text.includes('activate your account') ||
    text.includes('please activate') ||
    text.includes('confirmation email')
  ) {
    return true;
  }
  // Heuristic: if the password/confirmPassword inputs are gone from the page,
  // the form was destroyed — registration probably succeeded.
  const stillHasForm = document.querySelector('input[formcontrolname="emailid"]') &&
    document.querySelector('input[formcontrolname="password"]');
  return !stillHasForm;
}

function postSubmitBodySample(bodyText: string): string {
  const compact = bodyText.replace(/\s+/g, ' ').trim();
  const lower = compact.toLowerCase();
  const anchors = [
    'almost there',
    'verification email',
    'verify your email',
    'email sent',
    'email has been sent',
    'check your email',
    'check your inbox',
    'successfully registered',
    'confirmation email',
  ];
  const hit = anchors
    .map((anchor) => lower.indexOf(anchor))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];
  const start = hit === undefined ? 0 : Math.max(0, hit - 80);
  return compact.slice(start, start + 800);
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

function waitForActivationSignal(kind: string, timeoutMs: number): Promise<ActivationSignalValue> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      activationWaiters.delete(kind);
      reject(new Error(kind.toUpperCase() + '_TIMEOUT'));
    }, timeoutMs);
    activationWaiters.set(kind, (value) => {
      window.clearTimeout(timer);
      activationWaiters.delete(kind);
      resolve(value);
    });
  });
}

function resolveActivationWaiter(kind: string, value: ActivationSignalValue): void {
  activationWaiters.get(kind)?.(value);
}

// HTTP-only register-flow trace: POST goes via chrome.runtime to the SW which
// has the backend URL + extension token. Lets us see every step in backend
// Activity Logs even when the WS event channel is dead.
async function postRegisterTrace(step: string, meta?: Record<string, unknown>): Promise<void> {
  try {
    await chrome.runtime.sendMessage({ type: 'REGISTER_TRACE', step, meta });
  } catch {
    /* ignore */
  }
}

// Request a TRUSTED click at the given element's center coordinates. Uses
// chrome.debugger via the background service worker to send a real OS-level
// mouse event that passes Angular Material MDC's `event.isTrusted` check.
async function trustedClick(element: HTMLElement): Promise<boolean> {
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) {
    void postRegisterTrace('trustedClick element has zero size', {});
    return false;
  }
  element.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
  // Re-read rect after scroll.
  const r2 = element.getBoundingClientRect();
  const x = Math.round(r2.left + r2.width / 2);
  const y = Math.round(r2.top + r2.height / 2);
  try {
    const res = await chrome.runtime.sendMessage({ type: 'TRUSTED_CLICK', x, y });
    if (res && (res as { ok?: boolean }).ok) return true;
    void postRegisterTrace('trustedClick failed', { res });
    showOperatorBanner(TRUSTED_CLICK_BLOCKED_BANNER);
    return false;
  } catch (e) {
    void postRegisterTrace('trustedClick threw', { err: (e as Error).message });
    showOperatorBanner(TRUSTED_CLICK_BLOCKED_BANNER);
    return false;
  }
}

async function trustedKey(key: string): Promise<boolean> {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'TRUSTED_KEY', key });
    if (res && (res as { ok?: boolean }).ok) return true;
    void postRegisterTrace('trustedKey failed', { key, res });
    return false;
  } catch (e) {
    void postRegisterTrace('trustedKey threw', { key, err: (e as Error).message });
    return false;
  }
}

async function trustedType(text: string): Promise<boolean> {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'TRUSTED_TYPE', text });
    if (res && (res as { ok?: boolean }).ok) return true;
    void postRegisterTrace('trustedType failed', { res });
    return false;
  } catch (e) {
    void postRegisterTrace('trustedType threw', { err: (e as Error).message });
    return false;
  }
}

// Fill a field with GENUINE keystrokes via chrome.debugger. VFS UZ's Angular
// form keeps the Sign In button disabled unless input arrives as real typed
// events (programmatic .value-setting is ignored). Also clears any Chrome
// autofill first so we don't submit a stale/wrong email.
async function trustedFill(el: HTMLInputElement, value: string): Promise<void> {
  const clearField = () => {
    // Clear any Chrome autofill. setInputValue notifies Angular the field is
    // empty; the direct assignment guards against a stale DOM value.
    el.value = '';
    setInputValue(el, '');
  };

  const clicked = await trustedClick(el); // genuine focus + form-interaction gesture

  // Type with real keystrokes, then VERIFY — Chrome's password manager can
  // re-autofill a saved (wrong) email after we clear, so we re-type until the
  // field actually holds the value we want (max 3 tries).
  for (let attempt = 0; attempt < 3; attempt += 1) {
    clearField();
    await new Promise((r) => setTimeout(r, 100));
    if (clicked) {
      await trustedType(value);
    } else {
      setInputValue(el, value);
    }
    await new Promise((r) => setTimeout(r, 200));
    if (el.value === value) return; // correct value stuck — done
    void postRegisterTrace('trustedFill mismatch — retrying', {
      attempt, expected: maskForLog(value), actual: maskForLog(el.value),
    });
  }
  // Last resort: force the correct value programmatically so we never submit
  // a wrong (autofilled) email even if typing kept getting overwritten.
  setInputValue(el, value);
}

async function emitRegisterEvent(event: ExtensionEvent): Promise<void> {
  await chrome.runtime.sendMessage(event).catch(() => undefined);
}

async function emitLoginEvent(event: ExtensionEvent): Promise<void> {
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
