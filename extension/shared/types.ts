export type ConnectionStatus = 'connected' | 'connecting' | 'disconnected' | 'error';

export interface ExtensionSettings {
  backendUrl: string;
  extensionToken?: string;
  setupCode?: string;
  customerEmail?: string;
  autoBook: boolean;
  soundAlerts: boolean;
  pollingIntervalSeconds: number;
  // BrightData proxy auto-auth. When set, the service worker answers the
  // proxy's auth challenge automatically (no manual Chrome popup) and appends
  // a fresh -session-<random> each launch so every run gets a fresh UZ IP —
  // which sidesteps VFS per-IP rate limits and works headless on a VPS.
  // Stored only in chrome.storage.local on the operator's machine; never
  // committed. proxyUsernameBase example:
  //   brd-customer-hl_xxxx-zone-residential_proxy2-country-uz
  proxyUsernameBase?: string;
  proxyPassword?: string;
}

export interface RuntimeState {
  connectionStatus: ConnectionStatus;
  activeMonitor?: MonitorConfig;
  lastHeartbeatAt?: string;
  customerEmail?: string;
  lastError?: string;
}

export interface MonitorConfig {
  sourceCountry: string;
  destination: string;
  visaCategoryCode: string;
  vacCode: string;
  loginUser?: string;
  roleName?: string;
}

export type BackendMessage =
  | { type: 'START_MONITOR'; monitor: MonitorConfig }
  | { type: 'STOP_MONITOR'; destination?: string }
  | { type: 'BOOK_SLOT'; payload: BookingCommand }
  | {
      type: 'BOOK_FOR_CUSTOMER';
      accountEmail: string;
      accountTabUrl?: string;
      destination: string;
      visaType: string;
      slot: { date?: string; time?: string };
      payload: CustomerBookingPayload;
      correlationId: string;
    }
  | {
      type: 'BG_REGISTER_VFS_ACCOUNT';
      email: string;
      phone: string;
      smsActivateId?: string;
      password: string;
      firstName: string;
      lastName: string;
      dob: string;
      registerUrl: string;
      correlationId: string;
    }
  | { type: 'BG_REGISTER_EMAIL_LINK'; correlationId: string; link: string | null }
  | { type: 'BG_REGISTER_SMS_OTP'; correlationId: string; otp: string | null }
  | { type: 'BG_REGISTER_CAPTCHA_TOKEN'; correlationId: string; token: string | null }
  | { type: 'BG_LOGIN_VFS_ACCOUNT'; email: string; password: string; loginUrl: string; correlationId: string }
  | { type: 'BG_LOGIN_CAPTCHA_TOKEN'; correlationId: string; token: string | null }
  | { type: 'BG_ACTIVATE_VFS_ACCOUNT'; email: string; loginUrl: string; correlationId: string }
  | { type: 'BG_ACTIVATION_DONE'; correlationId: string; ok: boolean; reason?: string }
  | { type: 'BG_PROXY_CREDS'; usernameBase: string; password: string }
  | {
      type: 'BG_BOOK_VFS';
      payload: {
        firstName: string; lastName: string; nationality: string;
        passportNumber: string; contact: string; email: string;
        subCategory: string; correlationId: string;
        confirmPauseMs?: number;
      };
    }
  | { type: 'BG_LOGOUT_VFS'; correlationId: string }
  | { type: 'BG_VISIT_ACTIVATION_LINK'; correlationId: string; link: string }
  | { type: 'INJECT_FAKE_SLOT'; destination: string; date: string };

export interface BookingCommand {
  destination: string;
  profile: Record<string, string>;
  slot: { date: string; time?: string };
}

export interface CustomerBookingPayload {
  firstName: string;
  lastName: string;
  passportNumber: string;
  dob: string;
  nationality: string;
  email: string;
  phone: string;
}

export type ExtensionEvent =
  | { type: 'EXT_HEARTBEAT'; at: string; state: RuntimeState }
  | { type: 'EXT_SLOT_DETECTED'; destination: string; date: string; raw?: unknown }
  | {
      type: 'EXT_BOOKING_COMPLETED';
      confirmationNumber: string;
      screenshotDataUrl?: string;
      destination?: string;
      accountEmail?: string;
      correlationId?: string;
    }
  | { type: 'EXT_BOOKING_FAILED'; reason: string; destination?: string; accountEmail?: string; correlationId?: string }
  | { type: 'EXT_SESSION_LOST'; destination?: string; reason?: string }
  | { type: 'EXT_REGISTER_NEED_EMAIL_LINK'; correlationId: string; email: string }
  | { type: 'EXT_REGISTER_NEED_SMS_OTP'; correlationId: string; smsActivateId: string }
  | { type: 'EXT_REGISTER_NEED_CAPTCHA'; correlationId: string; siteKey: string; pageUrl: string }
  | { type: 'EXT_REGISTER_SUBMITTED'; correlationId: string; email: string }
  | { type: 'EXT_REGISTER_COMPLETED'; correlationId: string }
  | { type: 'EXT_REGISTER_FAILED'; correlationId: string; reason: string }
  | { type: 'EXT_LOGIN_NEED_CAPTCHA'; correlationId: string; siteKey: string; pageUrl: string }
  | { type: 'EXT_LOGIN_SUCCESS'; correlationId: string; email: string; url: string }
  | { type: 'EXT_LOGIN_FAILED'; correlationId: string; email: string; reason: string }
  | { type: 'EXT_ACTIVATION_NEED_LINK'; correlationId: string; email: string }
  | { type: 'EXT_ACTIVATION_SUBMITTED'; correlationId: string; email: string }
  | { type: 'EXT_ACTIVATION_SUCCESS'; correlationId: string; email: string }
  | { type: 'EXT_ACTIVATION_FAILED'; correlationId: string; email: string; reason: string }
  | { type: 'EXT_LOGGED_IN'; email?: string }
  | { type: 'EXT_LOGOUT_SUCCESS'; correlationId: string; email?: string }
  | { type: 'EXT_LOGOUT_FAILED'; correlationId: string; reason: string }
  | { type: 'EXT_ACTIVATION_VISIT_SUCCESS'; correlationId: string }
  | { type: 'EXT_ACTIVATION_VISIT_FAILED'; correlationId: string; reason: string }
  | { type: 'EXT_POLL_RESULT'; destination: string; status: number; data?: unknown }
  | {
      type: 'EXT_SESSION_SYNC';
      url: string;
      cookies: string;
      cookieJar?: Array<{
        name: string;
        value: string;
        domain: string;
        path: string;
        secure: boolean;
        httpOnly: boolean;
        sameSite?: chrome.cookies.SameSiteStatus;
        expirationDate?: number;
      }>;
      email?: string;
      timestamp: string;
    };

export type ContentCommand =
  | { type: 'POLL_SLOT'; monitor: MonitorConfig }
  | { type: 'FILL_FORM'; payload: BookingCommand | CustomerBookingPayload }
  | { type: 'SUBMIT_BOOKING' }
  | { type: 'EXTRACT_CONFIRMATION' }
  | { type: 'REGISTER_FILL_FORM'; payload: RegisterFormPayload }
  | { type: 'REGISTER_EMAIL_LINK'; link: string | null }
  | { type: 'REGISTER_SMS_OTP'; otp: string | null }
  | { type: 'REGISTER_CAPTCHA_TOKEN'; token: string | null }
  | { type: 'LOGIN_FILL_FORM'; payload: LoginFormPayload }
  | { type: 'LOGIN_VIA_SPA'; payload: LoginFormPayload }
  | { type: 'LOGIN_CAPTCHA_TOKEN'; token: string | null }
  | { type: 'ACTIVATE_VIA_SPA'; payload: { email: string; correlationId: string } }
  | { type: 'ACTIVATION_LINK_VISITED'; correlationId: string; ok: boolean; reason?: string }
  | {
      type: 'BOOK_VIA_SPA';
      payload: {
        firstName: string; lastName: string; nationality: string;
        passportNumber: string; contact: string; email: string;
        subCategory: string; correlationId: string;
        confirmPauseMs?: number;
      };
    }
  | { type: 'LOGOUT_VIA_SPA'; correlationId: string };

export interface RegisterFormPayload {
  email: string;
  phone: string;
  smsActivateId: string;
  password: string;
  firstName: string;
  lastName: string;
  dob: string;
  correlationId: string;
}

export interface LoginFormPayload {
  email: string;
  password: string;
  correlationId: string;
}

export interface PollSlotResult {
  loggedIn: boolean;
  status: number;
  data: unknown;
  earliestDate?: string;
}
