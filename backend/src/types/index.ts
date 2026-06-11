import { Role, Priority, BookingStatus, LogLevel, EventType } from '@prisma/client';

export { Role, Priority, BookingStatus, LogLevel, EventType };

export interface JwtPayload {
  sub: string;      // user id
  email: string;
  role: Role;
  type: 'access' | 'refresh' | 'extension';
}

export interface AuthUser {
  id: string;
  email: string;
  role: Role;
}

export interface SlotInfo {
  date: string;       // ISO date string
  time: string;
  destination: string;
  visaType: string;
  raw?: unknown;
}

export interface BookingJobPayload {
  profileId: string;
  sourceCountry?: string;
  destination: string;
  visaType: string;
  slot: SlotInfo;
  attempt?: number;
  pollerAccountEmail?: string;
}

export interface ProxyConfig {
  id: string;
  server: string;    // "host:port"
  username: string;
  password: string;
}

export interface CaptchaResult {
  token: string;
  type: 'recaptcha' | 'image';
}

export type NotificationEvent = 'SLOT_DETECTED' | 'BOOKING_SUCCESS' | 'BOOKING_FAILED';

export interface NotificationPayload {
  event: NotificationEvent;
  profileName?: string;
  destination?: string;
  slotDate?: string;
  confirmationNo?: string;
  errorMessage?: string;
  timestamp: string;
}

export interface BlockSignal {
  type: 'rate_limit' | 'account_flag' | 'ip_block' | 'session_expired' | 'unknown';
  proxyId?: string;
}
