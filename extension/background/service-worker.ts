import { ExtensionWsClient } from '../shared/ws-client';
import type { BackendMessage, ContentCommand, ExtensionSettings, ExtensionEvent, MonitorConfig, RuntimeState } from '../shared/types';

const log = (...args: unknown[]) => console.log('[VFS-SW]', ...args);
const warn = (...args: unknown[]) => console.warn('[VFS-SW]', ...args);
log('boot at', new Date().toISOString());

const DEFAULT_SETTINGS: ExtensionSettings = {
  backendUrl: 'http://localhost:3001',
  autoBook: true,
  soundAlerts: true,
  pollingIntervalSeconds: 30,
};

let wsClient: ExtensionWsClient | undefined;
let runtimeState: RuntimeState = { connectionStatus: 'disconnected' };

// Hydrate runtimeState from storage on cold boot so the popup doesn't
// briefly show stale 'disconnected' between SW restart and WS reconnect.
void chrome.storage.local.get({ runtimeState: null }).then((stored) => {
  const persisted = (stored as { runtimeState?: RuntimeState }).runtimeState;
  if (persisted) {
    // Don't trust the persisted 'connected' as fact — WS will re-confirm.
    // But we keep activeMonitor + customerEmail + lastHeartbeatAt so the
    // popup shows continuity instead of resetting.
    runtimeState = { ...persisted, connectionStatus: 'connecting' };
  }
});
const activeRegisterTabs = new Map<string, number>();

// MV3 idle-kills service workers in ~30s. We arm two recurring alarms so
// the SW is woken on a fixed cadence — keeps the WS reconnect logic alive
// and the heartbeat flowing to the backend. chrome.alarms.create is
// idempotent (same-name re-creates are no-ops), so we run it at top-level
// EVERY boot — not just onInstalled — to survive any cold-start path.
chrome.alarms.create('vfs-extension-heartbeat', { periodInMinutes: 0.5 });
chrome.alarms.create('vfs-extension-poll', { periodInMinutes: 0.5 });

chrome.runtime.onInstalled.addListener(() => {
  // Reconnect immediately so manifest reload doesn't leave the extension
  // disconnected until the operator clicks Save.
  void connectFromStoredSettings();
});

chrome.runtime.onStartup.addListener(() => {
  void connectFromStoredSettings();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  log('alarm fired:', alarm.name, 'connectionStatus=', runtimeState.connectionStatus);
  // Every alarm wake-up: make sure the WS is alive. If the SW was idle-killed
  // its WS is gone. Reconnect if disconnected. Idempotent if already up.
  if (runtimeState.connectionStatus !== 'connected') {
    void connectFromStoredSettings();
  }
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
    // Fall back to settings.customerEmail when content script can't extract
    // the email from VFS DOM. In the account-pool model, customerEmail is the
    // VFS account email being managed by this Chrome profile.
    const settings = await getSettings();
    const resolvedEmail =
      (typeof message.email === 'string' && message.email) ||
      settings.customerEmail ||
      undefined;
    sendEvent({
      type: 'EXT_SESSION_SYNC',
      url: String(message.url ?? ''),
      cookies: serialized || String(message.cookies ?? ''),
      cookieJar,
      email: resolvedEmail,
      timestamp: String(message.timestamp ?? new Date().toISOString()),
    });
    return { ok: true };
  }
  if (
    message.type === 'EXT_REGISTER_NEED_EMAIL_LINK' ||
    message.type === 'EXT_REGISTER_NEED_SMS_OTP' ||
    message.type === 'EXT_REGISTER_NEED_CAPTCHA' ||
    message.type === 'EXT_REGISTER_COMPLETED' ||
    message.type === 'EXT_REGISTER_FAILED'
  ) {
    sendEvent(message as ExtensionEvent);
    return { ok: true };
  }
  return { ok: false, error: 'UNKNOWN_MESSAGE' };
}

async function connectFromStoredSettings(): Promise<void> {
  const settings = await getSettings();
  log('connectFromStoredSettings — backendUrl=', settings.backendUrl, 'hasToken=', Boolean(settings.extensionToken), 'customerEmail=', settings.customerEmail);
  if (!settings.extensionToken) {
    warn('no extensionToken in storage — pair via Options first');
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
      log('WS status →', connectionStatus, lastError ? '(error: ' + lastError + ')' : '');
      runtimeState = { ...runtimeState, connectionStatus, lastError, customerEmail: settings.customerEmail };
      void saveRuntimeState();
    },
  });
  log('opening WS to', settings.backendUrl, '/extension');
  wsClient.connect();
}

function handleBackendMessage(message: BackendMessage): void {
  if (message.type === 'BG_REGISTER_VFS_ACCOUNT') {
    void runRegisterFlow(message);
    return;
  }
  if (message.type === 'BG_REGISTER_EMAIL_LINK') {
    forwardToActiveRegisterTab(message.correlationId, { type: 'REGISTER_EMAIL_LINK', link: message.link });
    return;
  }
  if (message.type === 'BG_REGISTER_SMS_OTP') {
    forwardToActiveRegisterTab(message.correlationId, { type: 'REGISTER_SMS_OTP', otp: message.otp });
    return;
  }
  if (message.type === 'BG_REGISTER_CAPTCHA_TOKEN') {
    forwardToActiveRegisterTab(message.correlationId, { type: 'REGISTER_CAPTCHA_TOKEN', token: message.token });
    return;
  }
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

async function runRegisterFlow(msg: Extract<BackendMessage, { type: 'BG_REGISTER_VFS_ACCOUNT' }>): Promise<void> {
  try {
    const tab = await chrome.tabs.create({ url: msg.registerUrl, active: true } as { url: string });
    if (!tab.id) {
      sendEvent({ type: 'EXT_REGISTER_FAILED', correlationId: msg.correlationId, reason: 'TAB_CREATE_FAILED' });
      return;
    }
    activeRegisterTabs.set(msg.correlationId, tab.id);
    setTimeout(() => {
      chrome.tabs.sendMessage(tab.id!, {
        type: 'REGISTER_FILL_FORM',
        payload: {
          email: msg.email,
          phone: msg.phone,
          smsActivateId: msg.smsActivateId ?? '',
          password: msg.password,
          firstName: msg.firstName,
          lastName: msg.lastName,
          dob: msg.dob,
          correlationId: msg.correlationId,
        },
      }).catch((err: Error) => {
        sendEvent({
          type: 'EXT_REGISTER_FAILED',
          correlationId: msg.correlationId,
          reason: 'CONTENT_SCRIPT_UNREACHABLE: ' + err.message,
        });
      });
    }, 6000);
  } catch (err) {
    sendEvent({ type: 'EXT_REGISTER_FAILED', correlationId: msg.correlationId, reason: (err as Error).message });
  }
}

function forwardToActiveRegisterTab(correlationId: string, payload: { type: string; [key: string]: unknown }): void {
  const tabId = activeRegisterTabs.get(correlationId);
  if (!tabId) return;
  chrome.tabs.sendMessage(tabId, payload).catch(() => undefined);
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
  if (event.type === 'EXT_REGISTER_COMPLETED' || event.type === 'EXT_REGISTER_FAILED') {
    activeRegisterTabs.delete(event.correlationId);
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
