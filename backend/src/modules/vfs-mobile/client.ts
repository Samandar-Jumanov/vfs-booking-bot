/**
 * VFS Global mobile API client.
 *
 * STATUS: SCAFFOLDING — fully wired structure, request/response shapes,
 * error handling, retry/backoff. Actual signing scheme + endpoint URLs
 * to be confirmed after Phase 2 capture sprint.
 *
 * Once endpoints.ts + signing.ts are filled in with real values, this
 * client immediately becomes functional. The booking worker (queue-driven)
 * can dispatch to this instead of the Playwright path for production scale.
 */
import axios, { AxiosInstance, AxiosError, AxiosRequestConfig } from 'axios';
import { VFS_MOBILE_BASE_URL, VFS_MOBILE_ENDPOINTS, STATIC_HEADERS } from './endpoints';
import { signRequest, getSigningSecret } from './signing';
import type {
  LoginRequest, LoginResponse,
  RegisterRequest, RegisterResponse,
  SlotQueryRequest, SlotQueryResponse,
  BookingRequest, BookingResponse,
  VfsMobileError,
} from './types';

interface SessionState {
  accessToken?: string;
  refreshToken?: string;
  userId?: string;
  tokenExpiresAt?: number;
  /** Datadome cookie if mobile uses one */
  datadomeCookie?: string;
  deviceId: string;
}

export class VfsMobileClient {
  private http: AxiosInstance;
  private session: SessionState;

  constructor(opts?: { baseURL?: string; deviceId?: string }) {
    this.http = axios.create({
      baseURL: opts?.baseURL || VFS_MOBILE_BASE_URL,
      timeout: 30_000,
      validateStatus: () => true, // we handle status codes manually
    });

    this.session = {
      // Use a stable per-account UUID so VFS doesn't see device churn.
      // For account-farm usage, generate one at registration time and persist.
      deviceId: opts?.deviceId || generateDeviceId(),
    };
  }

  // ── Public API ─────────────────────────────────────────────────────────

  async login(req: LoginRequest): Promise<LoginResponse> {
    const res = await this.send<LoginResponse>('POST', VFS_MOBILE_ENDPOINTS.LOGIN, req);
    this.session.accessToken = res.accessToken;
    this.session.refreshToken = res.refreshToken;
    this.session.userId = res.userId;
    this.session.tokenExpiresAt = Date.now() + (res.expiresIn * 1000);
    return res;
  }

  async register(req: RegisterRequest): Promise<RegisterResponse> {
    return this.send<RegisterResponse>('POST', VFS_MOBILE_ENDPOINTS.REGISTER, req);
  }

  async verifyEmailOtp(email: string, otp: string): Promise<{ verified: boolean }> {
    return this.send('POST', VFS_MOBILE_ENDPOINTS.VERIFY_EMAIL, { email, otp });
  }

  async verifyPhoneOtp(phone: string, otp: string): Promise<{ verified: boolean }> {
    return this.send('POST', VFS_MOBILE_ENDPOINTS.VERIFY_PHONE, { phone, otp });
  }

  async getSlots(req: SlotQueryRequest): Promise<SlotQueryResponse> {
    await this.ensureFreshToken();
    return this.send<SlotQueryResponse>('POST', VFS_MOBILE_ENDPOINTS.GET_SLOTS, req);
  }

  async createBooking(req: BookingRequest): Promise<BookingResponse> {
    await this.ensureFreshToken();
    return this.send<BookingResponse>('POST', VFS_MOBILE_ENDPOINTS.CREATE_BOOKING, req);
  }

  // ── Private helpers ────────────────────────────────────────────────────

  private async ensureFreshToken(): Promise<void> {
    if (!this.session.accessToken) throw new Error('Not logged in');
    const buffer = 60_000; // refresh 1 min early
    if (this.session.tokenExpiresAt && Date.now() > this.session.tokenExpiresAt - buffer) {
      if (!this.session.refreshToken) throw new Error('No refresh token');
      const refreshed = await this.send<{ accessToken: string; expiresIn: number }>(
        'POST', VFS_MOBILE_ENDPOINTS.REFRESH_TOKEN, { refreshToken: this.session.refreshToken },
        { skipAuth: true },
      );
      this.session.accessToken = refreshed.accessToken;
      this.session.tokenExpiresAt = Date.now() + (refreshed.expiresIn * 1000);
    }
  }

  private async send<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: any,
    opts?: { skipAuth?: boolean; retries?: number },
  ): Promise<T> {
    const bodyStr = body ? JSON.stringify(body) : '';
    const secret = (() => {
      try { return getSigningSecret(); } catch { return ''; }
    })();

    const headers: Record<string, string> = { ...STATIC_HEADERS };
    headers['X-Device-ID'] = this.session.deviceId;

    if (secret) {
      const { sign, timestamp } = signRequest(method, path, bodyStr, secret);
      headers['X-Sign'] = sign;
      headers['X-Timestamp'] = timestamp;
    }
    if (this.session.accessToken && !opts?.skipAuth) {
      headers['Authorization'] = `Bearer ${this.session.accessToken}`;
    }
    if (this.session.datadomeCookie) {
      headers['Cookie'] = `datadome=${this.session.datadomeCookie}`;
    }

    const cfg: AxiosRequestConfig = { method, url: path, headers };
    if (method !== 'GET') cfg.data = body;

    const res = await this.http.request(cfg);

    // Capture Set-Cookie if present (e.g. Datadome refresh)
    const sc = res.headers['set-cookie'];
    if (sc) {
      for (const c of sc) {
        const m = c.match(/^datadome=([^;]+)/);
        if (m) this.session.datadomeCookie = m[1];
      }
    }

    if (res.status >= 200 && res.status < 300) return res.data as T;

    // Datadome challenge → fetch fresh cookie + retry once
    if (res.status === 403 && res.headers['x-dd-b']) {
      // TODO: implement Datadome cookie acquisition flow
      throw makeError('DATADOME_CHALLENGE', 403, res.data?.message || 'Datadome blocked', false);
    }

    if (res.status === 401 && this.session.refreshToken && !opts?.skipAuth) {
      // Token expired mid-request; force-refresh + retry once
      this.session.tokenExpiresAt = 0;
      await this.ensureFreshToken();
      return this.send(method, path, body, { ...opts, skipAuth: false, retries: (opts?.retries || 0) + 1 });
    }

    throw makeError(
      res.data?.code || 'UNKNOWN',
      res.status,
      res.data?.message || `HTTP ${res.status}`,
      res.status >= 500 || res.status === 429,
    );
  }
}

function makeError(code: string, status: number, message: string, retryable: boolean): VfsMobileError & Error {
  const err: any = new Error(`[VFS Mobile] ${code} (${status}): ${message}`);
  err.code = code;
  err.status = status;
  err.retryable = retryable;
  err.message = message;
  return err;
}

function generateDeviceId(): string {
  // RFC 4122 v4 UUID; mobile apps usually use ANDROID_ID (16 hex chars)
  // but a UUID works for our purposes.
  const hex = (n: number) => Math.floor(Math.random() * 16 ** n).toString(16).padStart(n, '0');
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${(8 + Math.floor(Math.random() * 4)).toString(16)}${hex(3)}-${hex(12)}`;
}
