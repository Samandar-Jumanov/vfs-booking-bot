/**
 * VFS Global mobile API endpoints.
 *
 * STATUS: SCAFFOLDING — actual URLs and signing scheme to be filled in after
 * the Phase 2 capture sprint (run mitmproxy + Frida + VFS Android app, capture
 * happy-path traffic, document findings in MOBILE_API_FINDINGS.md, then
 * replace these placeholders).
 *
 * The web URL pattern for reference (web ≠ mobile API but gives hints):
 *   https://visa.vfsglobal.com/{source}/en/{dest}/{action}
 *
 * Mobile apps typically use a separate api.* hostname:
 *   https://api.vfsglobal.com/v1/{action}
 *   or https://mobile.vfsglobal.com/api/v1/{action}
 *
 * UPDATE THIS FILE WITH ACTUAL CAPTURED VALUES.
 */

export const VFS_MOBILE_BASE_URL =
  process.env.VFS_MOBILE_BASE_URL || 'https://api.vfsglobal.com'; // TODO: confirm from capture

export const VFS_MOBILE_ENDPOINTS = {
  // ── Auth ────────────────────────────────────────────────────────────────
  /** POST { email, password } -> { accessToken, refreshToken, userId } */
  LOGIN: '/api/v1/auth/login', // TODO: confirm path
  /** POST { refreshToken } -> { accessToken } */
  REFRESH_TOKEN: '/api/v1/auth/refresh',
  /** POST { email, password, firstName, lastName, ... } -> { userId, otpRequired: true } */
  REGISTER: '/api/v1/auth/register',
  /** POST { email, otp } -> { verified: true } */
  VERIFY_EMAIL: '/api/v1/auth/verify-email',
  /** POST { phone, otp } -> { verified: true } */
  VERIFY_PHONE: '/api/v1/auth/verify-phone',

  // ── Slot availability ───────────────────────────────────────────────────
  /** POST { sourceCountry, destination, visaCategory } -> { availableSlots: [...] } */
  GET_SLOTS: '/api/v1/appointments/slots', // TODO: confirm
  /** GET ?source=&dest=&category= -> { centres: [...] } */
  GET_CENTRES: '/api/v1/centres',
  /** GET /categories?source=&dest= -> { categories: [...] } */
  GET_CATEGORIES: '/api/v1/categories',

  // ── Booking ─────────────────────────────────────────────────────────────
  /** POST { slotId, applicantData } -> { bookingId, confirmationNumber } */
  CREATE_BOOKING: '/api/v1/appointments/book',
  /** GET /bookings/{id} -> { bookingDetails } */
  GET_BOOKING: '/api/v1/appointments/bookings/:id',
  /** DELETE /bookings/{id} */
  CANCEL_BOOKING: '/api/v1/appointments/bookings/:id',

  // ── Profile / applicant data ────────────────────────────────────────────
  GET_PROFILE: '/api/v1/users/me',
  UPDATE_PROFILE: '/api/v1/users/me',
} as const;

/**
 * Datadome bot-defence cookie endpoint. Mobile apps fetch a Datadome
 * cookie before any "real" API call — without this cookie, all API calls
 * return 403 with `x-dd-b: 1`.
 *
 * Confirm during capture whether the mobile app:
 * (a) gets Datadome cookie from a separate call (capture URL)
 * (b) ships embedded in app and pre-set in init
 * (c) doesn't use Datadome on mobile at all (best case)
 */
export const DATADOME_ENDPOINT = ''; // TODO: confirm from capture

/**
 * Headers that the mobile app sends on every request. After capture, populate
 * the actual values. Most apps include:
 *   X-API-Key: static key embedded in APK (extract via JADX)
 *   X-App-Version: e.g. "5.4.2"
 *   X-Platform: "android" or "ios"
 *   X-Device-ID: per-install UUID
 *   X-Sign: HMAC of body+timestamp+secret (see signing.ts)
 *   X-Timestamp: epoch millis
 *   User-Agent: "VFSGlobal/5.4.2 (Android 13; SM-G998B)"
 */
export const STATIC_HEADERS: Record<string, string> = {
  'X-API-Key': process.env.VFS_MOBILE_API_KEY || '', // TODO: extract from APK
  'X-App-Version': process.env.VFS_MOBILE_APP_VERSION || '5.0.0', // TODO: confirm
  'X-Platform': 'android',
  'User-Agent': 'VFSGlobal/5.0.0 (Android 13; SM-G998B Build/TQ2A.230505.002)',
  'Accept': 'application/json',
  'Content-Type': 'application/json',
};
