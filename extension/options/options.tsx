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
  setInput('proxyUsernameBase', settings.proxyUsernameBase ?? '');
  setInput('proxyPassword', settings.proxyPassword ?? '');
}

async function save(): Promise<void> {
  console.log('[VFS-OPT] save() invoked');
  const backendUrl = getInput('backendUrl');
  const setupCode = getInput('setupCode').trim();
  console.log('[VFS-OPT] inputs — backendUrl=', backendUrl, 'setupCode=', setupCode ? `${setupCode.length} chars` : '(empty)');
  const settings: Partial<ExtensionSettings> = {
    backendUrl,
    setupCode,
    autoBook: getChecked('autoBook'),
    soundAlerts: getChecked('soundAlerts'),
    pollingIntervalSeconds: Number(getInput('pollingIntervalSeconds') || 30),
    proxyUsernameBase: getInput('proxyUsernameBase').trim(),
    proxyPassword: getInput('proxyPassword'),
  };

  if (setupCode) {
    setMessage('Exchanging setup code…');
    console.log('[VFS-OPT] exchanging setup code with backend…');
    let tokenResponse: Response;
    try {
      tokenResponse = await fetch(`${backendUrl.replace(/\/$/, '')}/api/auth/extension-token/exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ setupCode }),
      });
    } catch (err) {
      console.error('[VFS-OPT] exchange request threw:', err);
      setMessage('Could not reach backend: ' + (err as Error).message, true);
      return;
    }
    console.log('[VFS-OPT] exchange HTTP', tokenResponse.status);
    if (!tokenResponse.ok) {
      const text = await tokenResponse.text().catch(() => '');
      console.error('[VFS-OPT] exchange failed body:', text);
      setMessage(`Setup code rejected (HTTP ${tokenResponse.status}). Generate a fresh code and try again within 10 min.`, true);
      return;
    }
    const body = await tokenResponse.json() as { extensionToken: string; customerEmail?: string };
    console.log('[VFS-OPT] exchange OK — got extensionToken length=', body.extensionToken?.length, 'email=', body.customerEmail);
    settings.extensionToken = body.extensionToken;
    settings.customerEmail = body.customerEmail;
  }

  // Write directly to storage in addition to sending the message — belt and
  // suspenders so the SW always sees the new settings, even if the runtime
  // message races the SW boot.
  await chrome.storage.local.set(settings);
  console.log('[VFS-OPT] chrome.storage.local.set complete; sending SAVE_SETTINGS to SW');
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
