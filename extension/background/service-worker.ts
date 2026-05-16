import { ExtensionWsClient } from '../shared/ws-client';
import type { BackendMessage, ContentCommand, ExtensionSettings, ExtensionEvent, MonitorConfig, RuntimeState } from '../shared/types';

const DEFAULT_SETTINGS: ExtensionSettings = {
  backendUrl: 'http://localhost:3001',
  autoBook: true,
  soundAlerts: true,
  pollingIntervalSeconds: 30,
};

let wsClient: ExtensionWsClient | undefined;
let runtimeState: RuntimeState = { connectionStatus: 'disconnected' };

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('vfs-extension-heartbeat', { periodInMinutes: 0.5 });
  chrome.alarms.create('vfs-extension-poll', { periodInMinutes: 0.5 });
});

chrome.runtime.onStartup.addListener(() => {
  void connectFromStoredSettings();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'vfs-extension-heartbeat') {
    sendEvent({ type: 'EXT_HEARTBEAT', at: new Date().toISOString(), state: runtimeState });
  }
  if (alarm.name === 'vfs-extension-poll') {
    void pollActiveMonitor();
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void handleRuntimeMessage(message).then(sendResponse);
  return true;
});

void connectFromStoredSettings();

async function handleRuntimeMessage(message: { type?: string; [key: string]: unknown }) {
  if (message.type === 'GET_STATE') {
    return { settings: await getSettings(), state: runtimeState };
  }
  if (message.type === 'SAVE_SETTINGS') {
    await saveSettings(message.settings as Partial<ExtensionSettings>);
    await connectFromStoredSettings();
    return { ok: true };
  }
  if (message.type === 'DISCONNECT') {
    runtimeState = { ...runtimeState, activeMonitor: undefined };
    wsClient?.disconnect();
    await saveRuntimeState();
    return { ok: true };
  }
  if (message.type === 'OPEN_VFS') {
    await chrome.tabs.create({ url: 'https://visa.vfsglobal.com/uzb/en/lva/login' });
    return { ok: true };
  }
  if (message.type === 'EXT_SESSION_SYNC') {
    // Augment with HttpOnly cookies (datadome + session) via chrome.cookies API.
    // document.cookie in the content script cannot see HttpOnly cookies, which
    // are exactly the ones Datadome uses for trust tokens.
    const allCookies: chrome.cookies.Cookie[] = await chrome.cookies.getAll({ domain: 'vfsglobal.com' }).catch(() => [] as chrome.cookies.Cookie[]);
    const serialized = allCookies
      .map((c: chrome.cookies.Cookie) => `${c.name}=${c.value}`)
      .join('; ');
    const cookieJar = allCookies.map((c: chrome.cookies.Cookie) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      sameSite: c.sameSite,
      expirationDate: c.expirationDate,
    }));
    sendEvent({
      type: 'EXT_SESSION_SYNC',
      url: String(message.url ?? ''),
      cookies: serialized || String(message.cookies ?? ''),
      cookieJar,
      email: typeof message.email === 'string' ? message.email : undefined,
      timestamp: String(message.timestamp ?? new Date().toISOString()),
    });
    return { ok: true };
  }
  return { ok: false, error: 'UNKNOWN_MESSAGE' };
}

async function connectFromStoredSettings(): Promise<void> {
  const settings = await getSettings();
  if (!settings.extensionToken) {
    runtimeState = { ...runtimeState, connectionStatus: 'disconnected', customerEmail: settings.customerEmail };
    await saveRuntimeState();
    return;
  }

  wsClient?.disconnect();
  wsClient = new ExtensionWsClient({
    backendUrl: settings.backendUrl,
    token: settings.extensionToken,
    onMessage: handleBackendMessage,
    onStatus: (connectionStatus, lastError) => {
      runtimeState = { ...runtimeState, connectionStatus, lastError, customerEmail: settings.customerEmail };
      void saveRuntimeState();
    },
  });
  wsClient.connect();
}

function handleBackendMessage(message: BackendMessage): void {
  if (message.type === 'START_MONITOR') {
    runtimeState = { ...runtimeState, activeMonitor: message.monitor };
    void saveRuntimeState();
    void pollActiveMonitor();
  }
  if (message.type === 'STOP_MONITOR') {
    runtimeState = { ...runtimeState, activeMonitor: undefined };
    void saveRuntimeState();
  }
  if (message.type === 'BOOK_SLOT') {
    void sendToVfsTab({ type: 'FILL_FORM', payload: message.payload })
      .then(() => sendToVfsTab({ type: 'SUBMIT_BOOKING' }))
      .then(() => sendToVfsTab({ type: 'EXTRACT_CONFIRMATION' }))
      .then((result) => {
        const confirmationNumber = String((result as { confirmationNumber?: string }).confirmationNumber ?? '');
        sendEvent({ type: 'EXT_BOOKING_COMPLETED', confirmationNumber });
      })
      .catch((error: Error) => sendEvent({ type: 'EXT_BOOKING_FAILED', reason: error.message }));
  }
  if (message.type === 'BOOK_FOR_CUSTOMER') {
    void handleBookForCustomer(message);
  }
  if (message.type === 'INJECT_FAKE_SLOT') {
    sendEvent({ type: 'EXT_SLOT_DETECTED', destination: message.destination, date: message.date, raw: { fake: true } });
  }
}

async function handleBookForCustomer(message: Extract<BackendMessage, { type: 'BOOK_FOR_CUSTOMER' }>): Promise<void> {
  const tab = await findTabForAccount(message.accountEmail, message.accountTabUrl, message.destination);
  if (!tab.id) {
    sendEvent({
      type: 'EXT_BOOKING_FAILED',
      reason: 'No tab found for account ' + message.accountEmail,
      correlationId: message.correlationId,
    });
    return;
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'FILL_FORM', payload: message.payload });
    await chrome.tabs.sendMessage(tab.id, { type: 'SUBMIT_BOOKING' });
    const result = await chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_CONFIRMATION' }) as { confirmationNumber?: string };
    sendEvent({
      type: 'EXT_BOOKING_COMPLETED',
      confirmationNumber: String(result.confirmationNumber ?? ''),
      destination: message.destination,
      accountEmail: message.accountEmail,
      correlationId: message.correlationId,
    });
  } catch (e) {
    sendEvent({
      type: 'EXT_BOOKING_FAILED',
      reason: (e as Error).message,
      destination: message.destination,
      accountEmail: message.accountEmail,
      correlationId: message.correlationId,
    });
  }
}

async function pollActiveMonitor(): Promise<void> {
  const monitor = runtimeState.activeMonitor;
  if (!monitor || runtimeState.connectionStatus !== 'connected') return;

  try {
    const result = await sendToVfsTab({ type: 'POLL_SLOT', monitor });
    const typed = result as { loggedIn?: boolean; status?: number; earliestDate?: string; data?: unknown };
    if (!typed.loggedIn) {
      sendEvent({ type: 'EXT_SESSION_LOST', destination: monitor.destination, reason: 'VFS session not detected' });
      return;
    }
    sendEvent({ type: 'EXT_POLL_RESULT', destination: monitor.destination, status: typed.status ?? 0, data: typed.data });
    if (typed.earliestDate) {
      sendEvent({ type: 'EXT_SLOT_DETECTED', destination: monitor.destination, date: typed.earliestDate, raw: typed.data });
      const settings = await getSettings();
      if (settings.soundAlerts) {
        chrome.notifications.create({
          type: 'basic',
          iconUrl: 'icons/icon128.png',
          title: 'VFS slot detected',
          message: `${monitor.destination.toUpperCase()} slot: ${typed.earliestDate}`,
        });
      }
    }
  } catch (error) {
    sendEvent({ type: 'EXT_SESSION_LOST', destination: monitor.destination, reason: String((error as Error).message ?? error) });
  }
}

async function sendToVfsTab(command: ContentCommand): Promise<unknown> {
  const tab = await findVfsTab(command.type === 'POLL_SLOT' ? command.monitor : undefined);
  if (!tab.id) throw new Error('No VFS tab is open');
  return chrome.tabs.sendMessage(tab.id, command);
}

async function findVfsTab(monitor?: MonitorConfig): Promise<chrome.tabs.Tab> {
  const destination = monitor?.destination ?? 'lva';
  const tabs = await chrome.tabs.query({ url: 'https://*.vfsglobal.com/*' });
  const existing = tabs.find((tab) => tab.url?.includes(`/en/${destination}/`)) ?? tabs[0];
  if (existing) return existing;
  return chrome.tabs.create({ url: `https://visa.vfsglobal.com/${monitor?.sourceCountry ?? 'uzb'}/en/${destination}/login` });
}

async function findTabForAccount(accountEmail: string, preferredUrl?: string, destination?: string): Promise<chrome.tabs.Tab> {
  const tabs = await chrome.tabs.query({ url: 'https://*.vfsglobal.com/*' });
  if (preferredUrl) {
    const exact = tabs.find((t) => t.url === preferredUrl);
    if (exact) return exact;
  }
  for (const t of tabs) {
    const title = (t as { title?: string }).title;
    if (title?.toLowerCase().includes(accountEmail.toLowerCase())) return t;
  }
  if (destination) {
    const destMatch = tabs.find((t) => t.url?.includes(`/en/${destination}/`));
    if (destMatch) return destMatch;
  }
  return chrome.tabs.create({ url: `https://visa.vfsglobal.com/uzb/en/${destination ?? 'lva'}/login` });
}

function sendEvent(event: ExtensionEvent): void {
  if (event.type === 'EXT_HEARTBEAT') {
    runtimeState = { ...runtimeState, lastHeartbeatAt: event.at };
    void saveRuntimeState();
  }
  wsClient?.send(event);
}

async function getSettings(): Promise<ExtensionSettings> {
  const stored = await chrome.storage.local.get({ ...DEFAULT_SETTINGS });
  return { ...DEFAULT_SETTINGS, ...stored } as ExtensionSettings;
}

async function saveSettings(settings: Partial<ExtensionSettings>): Promise<void> {
  await chrome.storage.local.set(settings);
}

async function saveRuntimeState(): Promise<void> {
  await chrome.storage.local.set({ runtimeState });
}
