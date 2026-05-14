export const WS_EVENTS = {
  SLOT_DETECTED: 'SLOT_DETECTED',
  BOOKING_SUCCESS: 'BOOKING_SUCCESS',
  BOOKING_FAILED: 'BOOKING_FAILED',
  BOOKING_PROGRESS: 'BOOKING_PROGRESS',
  CAPTCHA_REQUIRED: 'CAPTCHA_REQUIRED',
  CAPTCHA_MANUAL_NEEDED: 'CAPTCHA_MANUAL_NEEDED',
  COOKIE_EXPIRING_SOON: 'COOKIE_EXPIRING_SOON',
  MONITOR_CRASHED: 'MONITOR_CRASHED',
  MONITOR_DEAD: 'MONITOR_DEAD',
  LOG_ENTRY: 'LOG_ENTRY',
  MONITOR_STATUS: 'MONITOR_STATUS',
  CAPTCHA_SOLVED: 'CAPTCHA_SOLVED',
} as const;

export type WebSocketEventType = typeof WS_EVENTS[keyof typeof WS_EVENTS];

export type DestinationCode = 'lva' | 'tjk' | 'prt' | 'bra' | string;

export interface SlotInfo {
  date?: string;
  time?: string;
  destination?: DestinationCode;
  visaType?: string;
}

export interface SlotDetectedPayload {
  monitorId?: string;
  sourceCountry?: string;
  destination?: DestinationCode;
  visaType?: string;
  count?: number;
  firstSlot?: SlotInfo;
  slots?: SlotInfo[];
}

export interface BookingSuccessPayload {
  jobId?: string | number;
  profileId?: string;
  destination?: DestinationCode;
  confirmationNo?: string;
}

export interface BookingFailedPayload {
  jobId?: string | number;
  profileId?: string;
  destination?: DestinationCode;
  error?: string;
  errorMessage?: string;
}

export interface BookingProgressPayload {
  jobId?: string | number;
  profileId?: string;
  status?: string;
}

export interface CaptchaManualNeededPayload {
  sessionId?: string;
  monitorId?: string;
  destination?: DestinationCode;
  message?: string;
}

export interface CookieExpiringSoonPayload {
  destination?: DestinationCode;
  minutesRemaining?: number;
  expiresAt?: string;
}

export interface MonitorCrashedPayload {
  monitorId?: string;
  destination?: DestinationCode;
  attempt?: number;
  error?: string;
}

export interface MonitorDeadPayload {
  monitorId?: string;
  destination?: DestinationCode;
  error?: string;
}

export interface LogEntryPayload {
  id?: string;
  timestamp: string;
  level: 'INFO' | 'WARN' | 'ERROR';
  eventType: WebSocketEventType | string;
  message: string;
  destination?: DestinationCode;
}

export interface MonitorStatusPayload {
  id: string;
  sourceCountry?: string;
  destination: DestinationCode;
  visaType: string;
  isRunning: boolean;
  isCoolingDown?: boolean;
  lastCheckedAt?: string | null;
  slotDetectedCount: number;
  mode?: string;
  interval?: number;
  intervalMs?: number;
}
