import type { BrowserDriver, LoginInput, LogoutInput, BookInput, RegisterInput } from './browser-driver';
import type { DriverResult, ResultCode } from './types';

type LoginResult = { success: boolean; accountId: string; email: string; reason?: string; lastWarmedAt?: Date | null };
type LogoutResult = { success: boolean; reason?: string };
type BookResult = { success: boolean; confirmationNumber?: string; reason?: string };

export interface ExtensionDriverDeps {
  loginAccount: (accountId: string) => Promise<LoginResult>;
  logoutAccount: () => Promise<LogoutResult>;
  bookAccount: (input: {
    firstName: string; lastName: string; nationality: string; passportNumber: string;
    contact: string; email: string; subCategory: string;
  }) => Promise<BookResult>;
  isOperatorLive: () => boolean;
}

export function mapReasonToCode(reason: string): ResultCode {
  if (reason.includes('429001')) return '429001';
  if (reason.includes('429202')) return '429202';
  if (reason.includes('TURNSTILE')) return 'TURNSTILE_FAILED';
  if (reason.includes('INVALID_CRED') || reason.includes('WRONG_PASSWORD')) return 'INVALID_CREDS';
  if (reason.includes('NO_WARM_TAB') || reason.includes('NO_TAB')) return 'NO_WARM_TAB';
  if (reason.includes('OFFLINE') || reason.includes('NOT_CONNECTED')) return 'OPERATOR_OFFLINE';
  if (reason.includes('TIMEOUT')) return 'TIMEOUT';
  return 'UNKNOWN';
}

export class ExtensionDriver implements BrowserDriver {
  constructor(private readonly deps: ExtensionDriverDeps) {}

  async isReady(): Promise<boolean> {
    return this.deps.isOperatorLive();
  }

  async login(input: LoginInput): Promise<DriverResult> {
    if (!this.deps.isOperatorLive()) return { ok: false, code: 'OPERATOR_OFFLINE' };
    const result = await this.deps.loginAccount(input.email);
    if (result.success) return { ok: true, code: 'OK', data: { lastWarmedAt: result.lastWarmedAt?.toISOString() ?? null } };
    return { ok: false, code: mapReasonToCode(result.reason ?? ''), reason: result.reason };
  }

  async logout(_input: LogoutInput): Promise<DriverResult> {
    if (!this.deps.isOperatorLive()) return { ok: false, code: 'OPERATOR_OFFLINE' };
    const result = await this.deps.logoutAccount();
    if (result.success) return { ok: true, code: 'OK' };
    return { ok: false, code: mapReasonToCode(result.reason ?? ''), reason: result.reason };
  }

  async register(_input: RegisterInput): Promise<DriverResult> {
    // Register dispatch is handled via ActivatorFn in LifecycleService (accountAutoRegister flow).
    return { ok: false, code: 'UNKNOWN', reason: 'register() not wired in ExtensionDriver — use ActivatorFn' };
  }

  async book(input: BookInput): Promise<DriverResult> {
    if (!this.deps.isOperatorLive()) return { ok: false, code: 'OPERATOR_OFFLINE' };
    const result = await this.deps.bookAccount({
      firstName: input.firstName,
      lastName: input.lastName,
      nationality: input.nationality,
      passportNumber: input.passportNumber,
      contact: input.phone,
      email: input.email,
      subCategory: input.subCategory,
    });
    if (result.success) {
      return { ok: true, code: 'OK', data: { confirmationNumber: result.confirmationNumber } };
    }
    return { ok: false, code: mapReasonToCode(result.reason ?? ''), reason: result.reason };
  }
}
