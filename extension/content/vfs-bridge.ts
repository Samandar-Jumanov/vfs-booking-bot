import type { BookingCommand, ContentCommand, CustomerBookingPayload, MonitorConfig, PollSlotResult } from '../shared/types';

const SLOT_API = 'https://lift-api.vfsglobal.com/appointment/CheckIsSlotAvailable';

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

function isLoggedIn(): boolean {
  const text = document.body.innerText.toLowerCase();
  return text.includes('dashboard') || text.includes('schedule appointment') || text.includes('logout') || location.pathname.includes('dashboard');
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
  const cookies = document.cookie;
  const url = window.location.href;
  const email = await detectAccountEmailFromDashboard();
  chrome.runtime.sendMessage({
    type: 'EXT_SESSION_SYNC',
    url,
    cookies,
    email,
    timestamp: new Date().toISOString(),
  }).catch(() => {});
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
