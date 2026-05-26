import type { BrowserDriver, RegisterInput, LoginInput, LogoutInput, BookInput } from './browser-driver';
import type { DriverResult } from './types';

const DEFAULT_OK: DriverResult = { ok: true, code: 'OK' };

export class MockBrowserDriver implements BrowserDriver {
  private queues: {
    register: DriverResult[];
    login: DriverResult[];
    logout: DriverResult[];
    book: DriverResult[];
    isReady: boolean[];
  } = { register: [], login: [], logout: [], book: [], isReady: [] };

  enqueueRegister(r: DriverResult): this { this.queues.register.push(r); return this; }
  enqueueLogin(r: DriverResult): this { this.queues.login.push(r); return this; }
  enqueueLogout(r: DriverResult): this { this.queues.logout.push(r); return this; }
  enqueueBook(r: DriverResult): this { this.queues.book.push(r); return this; }
  enqueueReady(v: boolean): this { this.queues.isReady.push(v); return this; }

  async register(_: RegisterInput): Promise<DriverResult> {
    return this.queues.register.shift() ?? DEFAULT_OK;
  }
  async login(_: LoginInput): Promise<DriverResult> {
    return this.queues.login.shift() ?? DEFAULT_OK;
  }
  async logout(_: LogoutInput): Promise<DriverResult> {
    return this.queues.logout.shift() ?? DEFAULT_OK;
  }
  async book(_: BookInput): Promise<DriverResult> {
    return this.queues.book.shift() ?? DEFAULT_OK;
  }
  async isReady(): Promise<boolean> {
    return this.queues.isReady.shift() ?? true;
  }
}
