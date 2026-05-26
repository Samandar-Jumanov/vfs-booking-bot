import { ExtensionWsClient } from '../shared/ws-client';
import { debuggerClickAt, debuggerAttach, debuggerKeyPress, debuggerTypeText } from './debugger.helper';
import type { BackendMessage, ContentCommand, ExtensionSettings, ExtensionEvent, MonitorConfig, RuntimeState } from '../shared/types';
import { evaluateActivationVisit } from '../shared/activation-heuristic';

const SW_VERSION = '2026-05-25-autonomous-booking';
const log = (...args: unknown[]) => console.log('[VFS-SW]', ...args);
const warn = (...args: unknown[]) => console.warn('[VFS-SW]', ...args);
log(`boot at ${new Date().toISOString()} version=${SW_VERSION}`);

const DEFAULT_SETTINGS: ExtensionSettings = {
  backendUrl: 'https://backend-production-24c3.up.railway.app',
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
const activeLoginTabs = new Map<string, number>();
const activeActivationTabs = new Map<string, number>();

// --- BrightData proxy auto-auth -------------------------------------------
// Answer the proxy's auth challenge automatically (no Chrome popup) and append
// a FRESH -session-<random> generated once per service-worker boot, so every
// launch exits from a fresh UZ residential IP. This sidesteps VFS per-IP rate
// limits (the 429s) and lets the bot run headless on a VPS with no human to
// type proxy creds. Credentials live only in chrome.storage.local (entered in
// the options page) — never hardcoded, never committed.
const PROXY_SESSION = `sw${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
let proxyCreds: { usernameBase?: string; password?: string } = {};

function refreshProxyCreds(s: { proxyUsernameBase?: string; proxyPassword?: string }): void {
  proxyCreds = {
    usernameBase: s.proxyUsernameBase?.trim() || undefined,
    password: s.proxyPassword || undefined,
  };
  log('proxy auto-auth', proxyCreds.usernameBase ? `enabled (session=${PROXY_SESSION})` : 'disabled (no creds)');
}

void chrome.storage.local
  .get({ proxyUsernameBase: '', proxyPassword: '' })
  .then((s) => refreshProxyCreds(s as { proxyUsernameBase?: string; proxyPassword?: string }));

chrome.webRequest.onAuthRequired.addListener(
  (details) => {
    if (!details.isProxy || !proxyCreds.usernameBase || !proxyCreds.password) return {};
    // Strip any existing -session-xxx so we control the IP via PROXY_SESSION.
    const base = proxyCreds.usernameBase.replace(/-session-[^-]*$/i, '');
    return { authCredentials: { username: `${base}-session-${PROXY_SESSION}`, password: proxyCreds.password } };
  },
  { urls: ['<all_urls>'] },
  ['blocking'],
);

// Capture the lift-api Authorization header at the NETWORK layer — no page
// tampering. Replaces the old MAIN-world fetch/XHR monkey-patching that
// Cloudflare detected and used to withhold the Turnstile widget. Observe-only.
// Writes to chrome.storage.local.liftAuthHeaders, which vfs-bridge replays for
// slot polling (same key the old sniffer used).
chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    try {
      const out: Record<string, string> = {};
      let hasAuth = false;
      for (const h of details.requestHeaders ?? []) {
        if (h.name && typeof h.value === 'string') {
          out[h.name] = h.value;
          if (h.name.toLowerCase() === 'authorization') hasAuth = true;
        }
      }
      // Only persist once we have the bearer token — avoids overwriting a good
      // capture with a pre-auth request that has no Authorization header.
      if (hasAuth) void chrome.storage.local.set({ liftAuthHeaders: out });
    } catch {
      // Never break the request.
    }
    return undefined;
  },
  { urls: ['*://lift-api.vfsglobal.com/*'] },
  ['requestHeaders', 'extraHeaders'],
);

// MV3 idle-kills service workers in ~30s. We arm two recurring alarms so
// the SW is woken on a fixed cadence — keeps the WS reconnect logic alive
// and the heartbeat flowing to the backend. chrome.alarms.create is
// idempotent (same-name re-creates are no-ops), so we run it at top-level
// EVERY boot — not just onInstalled — to survive any cold-start path.
chrome.alarms.create('vfs-extension-heartbeat', { periodInMinutes: 0.5 });
// Poll cadence: VFS lift-api rate-limits aggressively (429). 1 min is the
// floor we can do per-account without sustained 429s. With sharding across
// accounts (future) we can effectively poll more often.
chrome.alarms.create('vfs-extension-poll', { periodInMinutes: 1 });

chrome.runtime.onInstalled.addListener(() => {
  // Reconnect immediately so manifest reload doesn't leave the extension
  // disconnected until the operator clicks Save.
  void connectFromStoredSettings();
});

chrome.runtime.onStartup.addListener(() => {
  void connectFromStoredSettings();
});

// React to VFS cookie changes immediately. After a successful VFS login the
// datadome + session cookies are set; we push within ~1s of that happening
// so the backend has fresh credentials without waiting for the 30s alarm.
let cookieDebounceTimer: number | undefined;
chrome.cookies.onChanged.addListener((change) => {
  if (!change.cookie?.domain?.includes('vfsglobal.com')) return;
  if (cookieDebounceTimer) self.clearTimeout(cookieDebounceTimer);
  cookieDebounceTimer = self.setTimeout(() => {
    cookieDebounceTimer = undefined;
    void pushCookiesToBackend();
  }, 1500);
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
    // Plain HTTP cookie sync — works even when WS is down. This is the
    // single most important signal for the backend: a fresh set of VFS
    // cookies, posted directly, no service-worker WS dependency.
    void pushCookiesToBackend();
  }
  if (alarm.name === 'vfs-extension-poll') {
    void pollActiveMonitor();
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void handleRuntimeMessage(message as { type?: string; [key: string]: unknown }, sender as chrome.runtime.MessageSender).then(sendResponse);
  return true;
});

void connectFromStoredSettings();

async function handleRuntimeMessage(message: { type?: string; [key: string]: unknown }, sender?: chrome.runtime.MessageSender) {
  log(`message received: type=${message?.type ?? '(no type)'} senderTab=${sender?.tab?.id ?? 'none'}`);
  if (message.type === 'GET_STATE') {
    return { settings: await getSettings(), state: runtimeState };
  }
  if (message.type === 'SAVE_SETTINGS') {
    const incoming = message.settings as Partial<ExtensionSettings>;
    log('SAVE_SETTINGS received — backendUrl=', incoming.backendUrl, 'hasToken=', Boolean(incoming.extensionToken), 'email=', incoming.customerEmail);
    await saveSettings(incoming);
    refreshProxyCreds({ proxyUsernameBase: incoming.proxyUsernameBase, proxyPassword: incoming.proxyPassword });
    await connectFromStoredSettings();
    // Sync cookies immediately on pairing so the operator sees the account
    // appear in the pool right away instead of waiting for the 30s alarm.
    void pushCookiesToBackend();
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
  if (message.type === 'TRUSTED_CLICK') {
    // Content script asks us to perform a real OS-level mouse click at
    // the given viewport coordinates in the sender's tab. This bypasses
    // Angular Material MDC's `event.isTrusted` check.
    const tabId = sender?.tab?.id;
    if (!tabId) return { ok: false, error: 'NO_TAB_ID' };
    try {
      await debuggerAttach(tabId);
      await debuggerClickAt(tabId, Number(message.x), Number(message.y));
      return { ok: true };
    } catch (e) {
      const err = (e as Error).message;
      warn('TRUSTED_CLICK failed:', err);
      return { ok: false, error: err };
    }
  }
  if (message.type === 'TRUSTED_KEY') {
    const tabId = sender?.tab?.id;
    if (!tabId) return { ok: false, error: 'NO_TAB_ID' };
    try {
      await debuggerAttach(tabId);
      await debuggerKeyPress(tabId, String(message.key ?? ''));
      return { ok: true };
    } catch (e) {
      const err = (e as Error).message;
      warn('TRUSTED_KEY failed:', err);
      return { ok: false, error: err };
    }
  }
  if (message.type === 'TRUSTED_TYPE') {
    const tabId = sender?.tab?.id;
    if (!tabId) return { ok: false, error: 'NO_TAB_ID' };
    try {
      await debuggerAttach(tabId);
      await debuggerTypeText(tabId, String(message.text ?? ''));
      return { ok: true };
    } catch (e) {
      const err = (e as Error).message;
      warn('TRUSTED_TYPE failed:', err);
      return { ok: false, error: err };
    }
  }
  if (message.type === 'REGISTER_TRACE') {
    // HTTP-only fallback trace path so register-flow events appear in
    // backend logs even when the WS is down. Best effort, never block.
    void (async () => {
      try {
        const settings = await getSettings();
        if (!settings.extensionToken) return;
        await fetch(`${settings.backendUrl.replace(/\/$/, '')}/api/extension/trace`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + settings.extensionToken,
          },
          body: JSON.stringify({ step: message.step, meta: message.meta }),
        });
      } catch {}
    })();
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
    // Prefer the email bound to THIS tab (operator opened it for a specific
    // account from the dashboard) — it's authoritative when VFS doesn't render
    // the email in the DOM. Fall back to DOM-detected email, then settings.
    const boundEmail = sender?.tab?.id != null ? tabAccountBindings.get(sender.tab.id) : undefined;
    const resolvedEmail =
      boundEmail ||
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
    message.type === 'EXT_REGISTER_FAILED' ||
    message.type === 'EXT_LOGIN_NEED_CAPTCHA' ||
    message.type === 'EXT_LOGIN_SUCCESS' ||
    message.type === 'EXT_LOGIN_FIELDS_FILLED' ||
    message.type === 'EXT_ACCOUNT_TAB_OPENED' ||
    message.type === 'EXT_LOGIN_FAILED' ||
    message.type === 'EXT_ACTIVATION_SUBMITTED' ||
    message.type === 'EXT_ACTIVATION_SUCCESS' ||
    message.type === 'EXT_ACTIVATION_FAILED' ||
    message.type === 'EXT_LOGOUT_SUCCESS' ||
    message.type === 'EXT_LOGOUT_FAILED' ||
    message.type === 'EXT_ACTIVATION_VISIT_SUCCESS' ||
    message.type === 'EXT_ACTIVATION_VISIT_FAILED'
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
  if (message.type === 'BG_PROXY_CREDS') {
    // Proxy creds pushed from backend .env (single source of truth) → enable
    // auto-auth + fresh-IP-per-launch without the operator touching options.
    refreshProxyCreds({ proxyUsernameBase: message.usernameBase, proxyPassword: message.password });
    void chrome.storage.local.set({ proxyUsernameBase: message.usernameBase, proxyPassword: message.password });
    return;
  }
  if (message.type === 'BG_LOGIN_VFS_ACCOUNT') {
    void runLoginFlow(message);
    return;
  }
  if (message.type === 'BG_OPEN_ACCOUNT_TAB') {
    void runOpenAccountTab(message);
    return;
  }
  if (message.type === 'BG_LOGIN_CAPTCHA_TOKEN') {
    forwardToActiveLoginTab(message.correlationId, { type: 'LOGIN_CAPTCHA_TOKEN', token: message.token });
    return;
  }
  if (message.type === 'BG_ACTIVATE_VFS_ACCOUNT') {
    void runActivationFlow(message);
    return;
  }
  if (message.type === 'BG_BOOK_VFS') {
    void runBookingFlow(message);
    return;
  }
  if (message.type === 'BG_LOGOUT_VFS') {
    void runLogoutFlow(message);
    return;
  }
  if (message.type === 'BG_VISIT_ACTIVATION_LINK') {
    void runActivationVisit(message);
    return;
  }
  if (message.type === 'BG_ACTIVATION_DONE') {
    forwardToActiveActivationTab(message.correlationId, {
      type: 'ACTIVATION_LINK_VISITED',
      correlationId: message.correlationId,
      ok: message.ok,
      reason: message.reason,
    });
    return;
  }
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

async function runLoginFlow(msg: Extract<BackendMessage, { type: 'BG_LOGIN_VFS_ACCOUNT' }>): Promise<void> {
  // Mirror the proven register flow: clear any stale session, open a FRESH tab
  // straight at the login URL, give the SPA time to render, then drive it. No
  // logout, no double-navigate (that hung before reaching the content script).
  const loginUrl = msg.loginUrl || 'https://visa.vfsglobal.com/uzb/en/lva/login';
  await swTrace('runLoginFlow start', { email: msg.email, loginUrl });
  try {
    const existing = await findWarmVfsTab();
    if (existing?.id) await clearVfsSession(existing.id).catch(() => undefined);
    await swTrace('creating login tab');

    const tab = await chrome.tabs.create({ url: loginUrl, active: true });
    if (!tab.id) {
      await swTrace('TAB_OPEN_FAILED');
      sendEvent({ type: 'EXT_LOGIN_FAILED', correlationId: msg.correlationId, email: msg.email, reason: 'TAB_OPEN_FAILED' });
      return;
    }
    activeLoginTabs.set(msg.correlationId, tab.id);
    await swTrace('tab created, waiting for load', { tabId: tab.id });
    await waitForTabComplete(tab.id, 25_000);
    await new Promise((r) => setTimeout(r, 1500));
    await swTrace('sending LOGIN_VIA_SPA');
    await sendToTabEnsuringContentScript(tab.id, {
      type: 'LOGIN_VIA_SPA',
      payload: {
        email: msg.email,
        password: msg.password,
        correlationId: msg.correlationId,
        fillOnly: msg.fillOnly,
      },
    });
    await swTrace('LOGIN_VIA_SPA sent ok');
  } catch (err) {
    await swTrace('runLoginFlow ERROR', { reason: (err as Error).message });
    sendEvent({ type: 'EXT_LOGIN_FAILED', correlationId: msg.correlationId, email: msg.email, reason: (err as Error).message });
  }
}

// Send a message to a tab's content script, injecting the content script
// first if it isn't there. After an extension reload (or on a tab that
// loaded before the script registered) chrome.tabs.sendMessage throws
// "Receiving end does not exist" — we recover by injecting vfs-bridge.js
// on-demand and retrying once.
async function sendToTabEnsuringContentScript(tabId: number, message: unknown): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/lift-auth-sniffer.js'], world: 'MAIN' });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/vfs-bridge.js'] });
    await new Promise((r) => setTimeout(r, 600));
    await chrome.tabs.sendMessage(tabId, message);
  }
}

// Resolve once the tab finishes loading (status 'complete') or the timeout
// elapses — VFS is a heavy SPA, so we give it a generous window.
async function waitForTabComplete(tabId: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const t = await chrome.tabs.get(tabId);
      if (t.status === 'complete') {
        await new Promise((r) => setTimeout(r, 2500)); // let the Angular app boot + render
        return;
      }
    } catch {
      return; // tab gone
    }
    await new Promise((r) => setTimeout(r, 400));
  }
}

// Wipe the VFS session so loginUrl renders the login form (not a logged-in
// dashboard). Clears vfsglobal cookies + the tab's localStorage/sessionStorage.
async function clearVfsSession(tabId: number): Promise<void> {
  try {
    const cookies = await chrome.cookies.getAll({ domain: 'vfsglobal.com' });
    await Promise.all(
      cookies.map((c) => {
        const url = `${c.secure ? 'https' : 'http'}://${c.domain.replace(/^\./, '')}${c.path}`;
        return chrome.cookies.remove({ url, name: c.name }).catch(() => undefined);
      }),
    );
  } catch {
    /* cookies perm/edge — ignore */
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        try { localStorage.clear(); sessionStorage.clear(); } catch { /* cross-origin */ }
      },
    });
  } catch {
    /* tab not on a scriptable origin — ignore */
  }
}

// tabId → bound account email. Set when the operator opens an account's login
// tab from the dashboard (BG_OPEN_ACCOUNT_TAB). Lets EXT_SESSION_SYNC tag the
// correct account even when VFS doesn't expose the email in the page DOM —
// which is what blocked the auto-booking trigger from firing.
const tabAccountBindings = new Map<number, string>();
void chrome.storage.local.get({ tabAccountBindings: {} }).then((s) => {
  const stored = (s.tabAccountBindings ?? {}) as Record<string, string>;
  for (const [tabId, email] of Object.entries(stored)) tabAccountBindings.set(Number(tabId), email);
});
function persistTabBindings(): void {
  const obj: Record<string, string> = {};
  for (const [tabId, email] of tabAccountBindings) obj[String(tabId)] = email;
  void chrome.storage.local.set({ tabAccountBindings: obj });
}
function bindTabToAccount(tabId: number, email: string): void {
  tabAccountBindings.set(tabId, email);
  persistTabBindings();
}
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabAccountBindings.delete(tabId)) persistTabBindings();
});

// Open a VFS login tab for a specific pool account and BIND it to that account's
// email. The operator then logs in manually in this tab; session-sync from it
// is tagged with the bound email so the backend knows which account it is.
async function runOpenAccountTab(msg: Extract<BackendMessage, { type: 'BG_OPEN_ACCOUNT_TAB' }>): Promise<void> {
  try {
    const tab = await chrome.tabs.create({ url: msg.loginUrl, active: true });
    if (!tab.id) {
      sendEvent({ type: 'EXT_LOGIN_FAILED', correlationId: msg.correlationId, email: msg.email, reason: 'TAB_OPEN_FAILED' });
      return;
    }
    bindTabToAccount(tab.id, msg.email);
    await swTrace('account tab opened + bound', { tabId: tab.id, email: msg.email });
    sendEvent({ type: 'EXT_ACCOUNT_TAB_OPENED', correlationId: msg.correlationId, email: msg.email, tabId: tab.id });
  } catch (err) {
    sendEvent({ type: 'EXT_LOGIN_FAILED', correlationId: msg.correlationId, email: msg.email, reason: (err as Error).message });
  }
}

async function findWarmVfsTab(): Promise<chrome.tabs.Tab | null> {
  const tabs = await chrome.tabs.query({ url: '*://*.vfsglobal.com/*' });
  const warm = tabs
    .filter((t) => t.id != null && t.url && !t.url.includes('/page-not-found'))
    .sort((a, b) => ((b as chrome.tabs.Tab & { lastAccessed?: number }).lastAccessed ?? b.id ?? 0) - ((a as chrome.tabs.Tab & { lastAccessed?: number }).lastAccessed ?? a.id ?? 0));
  // Prefer an actual login/account page over any other VFS tab (e.g. a stray
  // help/cookie page) so we drive the right one.
  const loginTab = warm.find((t) => /\/(login|account|dashboard)/i.test(t.url ?? ''));
  return loginTab ?? warm[0] ?? null;
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

function forwardToActiveLoginTab(correlationId: string, payload: { type: string; [key: string]: unknown }): void {
  const tabId = activeLoginTabs.get(correlationId);
  if (!tabId) return;
  chrome.tabs.sendMessage(tabId, payload).catch(() => undefined);
}

function forwardToActiveActivationTab(correlationId: string, payload: { type: string; [key: string]: unknown }): void {
  const tabId = activeActivationTabs.get(correlationId);
  if (!tabId) return;
  chrome.tabs.sendMessage(tabId, payload).catch(() => undefined);
}

async function runBookingFlow(msg: Extract<BackendMessage, { type: 'BG_BOOK_VFS' }>): Promise<void> {
  try {
    // Parallel multi-account booking: when the payload names a specific account,
    // book in THAT account's already-open tab instead of the single warm tab.
    const tab = msg.payload.accountEmail
      ? await findTabForAccount(msg.payload.accountEmail, msg.payload.accountTabUrl)
      : await findWarmVfsTab();
    if (!tab?.id) {
      sendEvent({ type: 'EXT_BOOKING_FAILED', reason: 'WARM_TAB_REQUIRED', correlationId: msg.payload.correlationId });
      return;
    }
    await chrome.tabs.update(tab.id, { active: true });
    await sendToTabEnsuringContentScript(tab.id, { type: 'BOOK_VIA_SPA', payload: msg.payload });
  } catch (err) {
    sendEvent({ type: 'EXT_BOOKING_FAILED', reason: (err as Error).message, correlationId: msg.payload.correlationId });
  }
}

async function runLogoutFlow(msg: Extract<BackendMessage, { type: 'BG_LOGOUT_VFS' }>): Promise<void> {
  try {
    const tab = await findWarmVfsTab();
    if (!tab?.id) {
      sendEvent({ type: 'EXT_LOGOUT_FAILED', correlationId: msg.correlationId, reason: 'NO_WARM_TAB' });
      return;
    }
    await chrome.tabs.update(tab.id, { active: true });
    await sendToTabEnsuringContentScript(tab.id, {
      type: 'LOGOUT_VIA_SPA',
      correlationId: msg.correlationId,
    });
  } catch (err) {
    sendEvent({ type: 'EXT_LOGOUT_FAILED', correlationId: msg.correlationId, reason: (err as Error).message });
  }
}

// Open a VFS account-activation link in a REAL Chrome tab on the operator's
// clean UZ IP, read the landed page, and decide success via the pure
// activation-heuristic. Replaces the BrightData HTTP visit that returned
// status=0 and falsely marked accounts ACTIVE. This is chrome.tabs.create in
// the operator browser (allowed) — never a backend page.goto.
async function runActivationVisit(msg: Extract<BackendMessage, { type: 'BG_VISIT_ACTIVATION_LINK' }>): Promise<void> {
  let createdTabId: number | undefined;
  try {
    void swTrace('activation visit start', { link: (msg.link ?? '').slice(0, 70) });
    const tab = await chrome.tabs.create({ url: msg.link, active: true });
    if (!tab.id) {
      void swTrace('activation TAB_OPEN_FAILED', {});
      sendEvent({ type: 'EXT_ACTIVATION_VISIT_FAILED', correlationId: msg.correlationId, reason: 'TAB_OPEN_FAILED' });
      return;
    }
    createdTabId = tab.id;
    void swTrace('activation tab created', { tabId: tab.id });
    await waitForTabComplete(tab.id, 30_000);
    void swTrace('activation tab load settled', { tabId: tab.id });
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ({ href: location.href, bodyText: document.body.innerText.slice(0, 400) }),
    });
    const probe = (injection?.result as { href: string; bodyText: string } | undefined) ?? { href: '', bodyText: '' };
    void swTrace('activation page probe', { href: probe.href.slice(0, 90), bodyLen: probe.bodyText.length, bodySample: probe.bodyText.slice(0, 80) });
    const verdict = evaluateActivationVisit(probe);
    void swTrace('activation verdict', { success: verdict.success, reason: verdict.reason });
    if (verdict.success) {
      sendEvent({ type: 'EXT_ACTIVATION_VISIT_SUCCESS', correlationId: msg.correlationId });
    } else {
      sendEvent({ type: 'EXT_ACTIVATION_VISIT_FAILED', correlationId: msg.correlationId, reason: verdict.reason });
    }
  } catch (err) {
    void swTrace('activation visit ERROR', { reason: (err as Error).message });
    sendEvent({ type: 'EXT_ACTIVATION_VISIT_FAILED', correlationId: msg.correlationId, reason: (err as Error).message });
  } finally {
    if (createdTabId != null) {
      await chrome.tabs.remove(createdTabId).catch(() => undefined);
    }
  }
}

async function runActivationFlow(msg: Extract<BackendMessage, { type: 'BG_ACTIVATE_VFS_ACCOUNT' }>): Promise<void> {
  try {
    let tab = await findWarmVfsTab();
    if (!tab?.id) {
      const loginUrl = msg.loginUrl || 'https://visa.vfsglobal.com/uzb/en/lva/login';
      tab = await chrome.tabs.create({ url: loginUrl, active: true });
      await waitForTabComplete(tab.id!, 30_000);
    }
    if (!tab?.id) {
      sendEvent({ type: 'EXT_ACTIVATION_FAILED', correlationId: msg.correlationId, email: msg.email, reason: 'TAB_OPEN_FAILED' });
      return;
    }
    await chrome.tabs.update(tab.id, { active: true });
    activeActivationTabs.set(msg.correlationId, tab.id);
    await sendToTabEnsuringContentScript(tab.id, {
      type: 'ACTIVATE_VIA_SPA',
      payload: { email: msg.email, correlationId: msg.correlationId },
    });
  } catch (err) {
    sendEvent({ type: 'EXT_ACTIVATION_FAILED', correlationId: msg.correlationId, email: msg.email, reason: (err as Error).message });
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

// Backoff state when VFS returns 429. Persisted to chrome.storage so SW
// idle-kill doesn't reset it (otherwise we'd keep hammering at 1/min while
// the rate-limit hasn't cleared).
let pollBackoffUntil = 0;
let pollBackoffMs = 60_000;
void chrome.storage.local.get({ pollBackoffUntil: 0, pollBackoffMs: 60_000 }).then((stored) => {
  pollBackoffUntil = (stored.pollBackoffUntil as number) ?? 0;
  pollBackoffMs = (stored.pollBackoffMs as number) ?? 60_000;
});

async function pollActiveMonitor(): Promise<void> {
  if (Date.now() < pollBackoffUntil) {
    log('pollActiveMonitor: 429 backoff, next attempt at', new Date(pollBackoffUntil).toISOString());
    return;
  }
  // Re-hydrate runtimeState from storage so a SW cold-boot race doesn't drop
  // the activeMonitor we just stored from a START_MONITOR message.
  if (!runtimeState.activeMonitor) {
    try {
      const stored = (await chrome.storage.local.get(null)) as { runtimeState?: RuntimeState };
      if (stored.runtimeState?.activeMonitor) {
        runtimeState = { ...runtimeState, activeMonitor: stored.runtimeState.activeMonitor };
        log('pollActiveMonitor: rehydrated activeMonitor from storage');
      }
    } catch { /* ignore */ }
  }

  const monitor = runtimeState.activeMonitor;
  if (!monitor) {
    log('pollActiveMonitor: no activeMonitor — skipping');
    return;
  }
  // Don't gate the poll on WS status — the actual VFS fetch happens via
  // chrome.tabs.sendMessage (no WS dependency). If WS is down, kick a
  // reconnect in background but still attempt the poll. If reporting back
  // via sendEvent fails (WS still down), the result is just lost; next
  // poll tries again. Heartbeat alarm will reconnect WS independently.
  if (runtimeState.connectionStatus !== 'connected') {
    void connectFromStoredSettings();
  }

  try {
    const result = await sendToVfsTab({ type: 'POLL_SLOT', monitor });
    const typed = result as { loggedIn?: boolean; status?: number; earliestDate?: string; data?: unknown };
    if (!typed.loggedIn) {
      sendEvent({ type: 'EXT_SESSION_LOST', destination: monitor.destination, reason: 'VFS session not detected' });
      return;
    }
    sendEvent({ type: 'EXT_POLL_RESULT', destination: monitor.destination, status: typed.status ?? 0, data: typed.data });
    if (typed.status === 429) {
      pollBackoffUntil = Date.now() + pollBackoffMs;
      pollBackoffMs = Math.min(pollBackoffMs * 2, 5 * 60_000);
      log('VFS 429 — backing off for', pollBackoffMs / 1000, 's');
      void chrome.storage.local.set({ pollBackoffUntil, pollBackoffMs });
    } else if (typed.status === 200) {
      pollBackoffMs = 60_000; // reset
      pollBackoffUntil = 0;
      void chrome.storage.local.set({ pollBackoffUntil: 0, pollBackoffMs: 60_000 });
    }
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
  try {
    return await chrome.tabs.sendMessage(tab.id, command);
  } catch (err) {
    const msg = String((err as Error).message ?? err);
    // "Receiving end does not exist" = content script not injected (tab loaded
    // before extension was installed/reloaded). Inject it programmatically.
    if (msg.includes('Receiving end does not exist') || msg.includes('Could not establish connection')) {
      log('sendToVfsTab: injecting content script into tab', tab.id, '(missing)');
      try {
        await (chrome as unknown as { scripting: { executeScript: (opts: { target: { tabId: number }; files: string[]; world?: 'MAIN' | 'ISOLATED' }) => Promise<unknown> } })
          .scripting.executeScript({ target: { tabId: tab.id }, files: ['content/lift-auth-sniffer.js'], world: 'MAIN' });
        await (chrome as unknown as { scripting: { executeScript: (opts: { target: { tabId: number }; files: string[] }) => Promise<unknown> } })
          .scripting.executeScript({ target: { tabId: tab.id }, files: ['content/vfs-bridge.js'] });
        // Tiny delay so the listener registers.
        await new Promise((r) => self.setTimeout(r, 250));
        return await chrome.tabs.sendMessage(tab.id, command);
      } catch (inject) {
        throw new Error('Content script injection failed: ' + String((inject as Error).message ?? inject));
      }
    }
    throw err;
  }
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
  if (event.type === 'EXT_LOGIN_SUCCESS' || event.type === 'EXT_LOGIN_FAILED') {
    activeLoginTabs.delete(event.correlationId);
  }
  if (event.type === 'EXT_ACTIVATION_SUCCESS' || event.type === 'EXT_ACTIVATION_FAILED') {
    activeActivationTabs.delete(event.correlationId);
  }
  wsClient?.send(event);
}

// Service-worker-side trace → backend logs (same endpoint the content script
// uses). Lets us see what runLoginFlow does even when the content script never
// runs. Best-effort, never throws.
async function swTrace(step: string, meta?: unknown): Promise<void> {
  try {
    const settings = await getSettings();
    if (!settings.extensionToken) return;
    await fetch(`${settings.backendUrl.replace(/\/$/, '')}/api/extension/trace`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + settings.extensionToken },
      body: JSON.stringify({ step: '[SW] ' + step, meta: meta ?? {} }),
    });
  } catch {
    /* ignore */
  }
}

async function getSettings(): Promise<ExtensionSettings> {
  // IMPORTANT: passing an object to chrome.storage.local.get only returns
  // keys present in the object. Passing null returns EVERYTHING stored,
  // including extensionToken/customerEmail/setupCode which are not part of
  // DEFAULT_SETTINGS.
  const stored = (await chrome.storage.local.get(null)) as Record<string, unknown>;
  // Filter out empty/undefined values so they don't override DEFAULT_SETTINGS.
  // A failed auto-pair could have stored backendUrl='' which then makes
  // `new URL('')` throw and crash the entire SW on boot.
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(stored)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'string' && v.trim() === '') continue;
    cleaned[k] = v;
  }
  return { ...DEFAULT_SETTINGS, ...cleaned } as ExtensionSettings;
}

async function saveSettings(settings: Partial<ExtensionSettings>): Promise<void> {
  await chrome.storage.local.set(settings);
}

async function saveRuntimeState(): Promise<void> {
  await chrome.storage.local.set({ runtimeState });
}

// Push current vfsglobal.com cookies to the backend via plain HTTP. This is
// the resilient sync path — works even when the WS is down. Backend stores
// the cookies on the VfsAccount row so monitor.service can poll directly
// through the IPRoyal UZ proxy.
async function pushCookiesToBackend(): Promise<void> {
  try {
    const settings = await getSettings();
    if (!settings.extensionToken) {
      log('pushCookies: no extensionToken; skipping');
      return;
    }
    const cookies = await chrome.cookies.getAll({ domain: 'vfsglobal.com' });
    if (cookies.length === 0) {
      log('pushCookies: no vfsglobal.com cookies yet — operator needs to log into VFS');
      return;
    }
    const tabs = await chrome.tabs.query({ url: 'https://*.vfsglobal.com/*' });
    // Prefer the account bound to an open VFS tab (operator used "Open login
    // (bind)") so BOTH the email AND the tabUrl come from that same tab — not a
    // stale other VFS tab. Cookies are domain-wide (one logged-in account per
    // Chrome profile), so pick the first bound VFS tab.
    const boundTab = tabs.find((t) => t.id != null && tabAccountBindings.get(t.id));
    const boundEmail = boundTab?.id != null ? tabAccountBindings.get(boundTab.id) : undefined;
    const tabUrl = boundTab?.url ?? tabs[0]?.url;
    const body = {
      email: boundEmail || settings.customerEmail || 'jumanovsamandar84@gmail.com',
      cookies: cookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
        sameSite: c.sameSite,
        expirationDate: c.expirationDate,
      })),
      tabUrl,
    };
    const url = `${settings.backendUrl.replace(/\/$/, '')}/api/accounts/inject-cookies`;
    log('pushCookies: POST', url, 'count=', cookies.length);
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + settings.extensionToken,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      warn('pushCookies failed HTTP', res.status, text.slice(0, 200));
      return;
    }
    log('pushCookies OK');
  } catch (e) {
    warn('pushCookies threw:', (e as Error).message);
  }
}
