export type ConnectionStatus = 'connected' | 'connecting' | 'disconnected' | 'error';

export interface ExtensionSettings {
  backendUrl: string;
  extensionToken?: string;
  setupCode?: string;
  customerEmail?: string;
  autoBook: boolean;
  soundAlerts: boolean;
  pollingIntervalSeconds: number;
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
  | { type: 'EXT_LOGGED_IN'; email?: string }
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
  | { type: 'EXTRACT_CONFIRMATION' };

export interface PollSlotResult {
  loggedIn: boolean;
  status: number;
  data: unknown;
  earliestDate?: string;
}
