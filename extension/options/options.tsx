import type { ExtensionSettings } from '../shared/types';

const DEFAULTS: ExtensionSettings = {
  backendUrl: 'https://backend-production-24c3.up.railway.app',
  autoBook: true,
  soundAlerts: true,
  pollingIntervalSeconds: 30,
};

const form = document.getElementById('optionsForm') as HTMLFormElement;
const message = document.getElementById('message');

void hydrate();

form.addEventListener('submit', (event) => {
  event.preventDefault();
  void save();
});

async function hydrate(): Promise<void> {
  const settings = await chrome.storage.local.get({ ...DEFAULTS }) as unknown as ExtensionSettings;
  setInput('backendUrl', settings.backendUrl);
  setInput('setupCode', settings.setupCode ?? '');
  setChecked('autoBook', settings.autoBook);
  setChecked('soundAlerts', settings.soundAlerts);
  setInput('pollingIntervalSeconds', String(settings.pollingIntervalSeconds));
}

async function save(): Promise<void> {
  const backendUrl = getInput('backendUrl');
  const setupCode = getInput('setupCode').trim();
  const settings: Partial<ExtensionSettings> = {
    backendUrl,
    setupCode,
    autoBook: getChecked('autoBook'),
    soundAlerts: getChecked('soundAlerts'),
    pollingIntervalSeconds: Number(getInput('pollingIntervalSeconds') || 30),
  };

  if (setupCode) {
    const tokenResponse = await fetch(`${backendUrl.replace(/\/$/, '')}/api/auth/extension-token/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ setupCode }),
    });
    if (!tokenResponse.ok) {
      setMessage('Setup code was not accepted.', true);
      return;
    }
    const body = await tokenResponse.json() as { extensionToken: string; customerEmail?: string };
    settings.extensionToken = body.extensionToken;
    settings.customerEmail = body.customerEmail;
  }

  await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings });
  setMessage('Saved. Extension is connecting.');
}

function setInput(id: string, value: string): void {
  const input = document.getElementById(id) as HTMLInputElement;
  input.value = value;
}

function getInput(id: string): string {
  const input = document.getElementById(id) as HTMLInputElement;
  return input.value;
}

function setChecked(id: string, value: boolean): void {
  const input = document.getElementById(id) as HTMLInputElement;
  input.checked = value;
}

function getChecked(id: string): boolean {
  const input = document.getElementById(id) as HTMLInputElement;
  return input.checked;
}

function setMessage(value: string, error = false): void {
  if (!message) return;
  message.textContent = value;
  message.style.color = error ? '#b3261e' : '#176b55';
}
